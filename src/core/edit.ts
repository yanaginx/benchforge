import { parseDocument, isMap, isSeq, YAMLMap, YAMLSeq } from 'yaml';
import type { Document } from 'yaml';
import type { Diag } from './check.ts';
import { loadModelText } from './check.ts';
import { hops, splitEndpoint } from './index.ts';
import type { Entry } from './index.ts';
import { COMPAT, effPtype } from './types-builtin.ts';
import type { PortDef } from './types.ts';

export type Op =
  | { op: 'add'; parent: string; name: string; type: string; ports?: { name: string; kind: string; dir?: 'in' | 'out'; ptype?: string }[] }
  | { op: 'rm'; path: string }
  | { op: 'move-up'; path: string }
  | { op: 'set'; path: string; field: 'name' | 'type'; value: string }
  | { op: 'port-add'; path: string; port: { name: string; kind: string; dir?: 'in' | 'out'; ptype?: string } }
  | { op: 'port-rm'; path: string; name: string }
  | { op: 'obj-add'; name: string; base?: 'uvm_object' | 'uvm_sequence_item' }
  | { op: 'obj-rm'; name: string }
  | { op: 'wire'; from: string; to: string }
  | { op: 'unwire'; from: string; to: string };

export class EditError extends Error {
  diag: Diag;
  constructor(diag: Diag) { super(diag.message); this.diag = diag; }
}
const fail = (code: string, path: string, message: string, options?: string[]): never => { throw new EditError({ code, path, message, options }); };

function rootMap(doc: Document): YAMLMap {
  const r = doc.get('root', true);
  if (!isMap(r)) return fail('bad_model', 'root', 'model has no root map');
  return r;
}
const nameOf = (m: YAMLMap) => String(m.get('name'));
function childSeq(m: YAMLMap): YAMLSeq | undefined {
  const c = m.get('children', true);
  return isSeq(c) ? c : undefined;
}
function childMaps(m: YAMLMap): YAMLMap[] {
  return (childSeq(m)?.items ?? []).filter(isMap) as YAMLMap[];
}
function findNode(doc: Document, path: string): { map: YAMLMap; parent?: YAMLMap } {
  const segs = path.split('.');
  let cur = rootMap(doc), parent: YAMLMap | undefined;
  if (nameOf(cur) !== segs[0]) fail('no_node', path, `no node '${path}'`, [nameOf(cur)]);
  for (const s of segs.slice(1)) {
    const next = childMaps(cur).find(c => nameOf(c) === s);
    if (!next) return fail('no_node', path, `no node '${path}' ('${s}' not found)`, childMaps(cur).map(nameOf));
    parent = cur; cur = next;
  }
  return { map: cur, parent };
}
function connSeq(doc: Document, create: boolean): YAMLSeq | undefined {
  const c = doc.get('connections', true);
  if (isSeq(c)) return c;
  if (!create) return undefined;
  const s = doc.createNode([]) as YAMLSeq;
  doc.set('connections', s);
  return s;
}
const touches = (ep: string, path: string) => ep === path || ep.startsWith(path + '.') || ep.startsWith(path + ':');

function addPort(doc: Document, path: string, port: Omit<PortDef, 'dir'> & { dir?: 'in' | 'out' }): void {
  const { map } = findNode(doc, path);
  let seq = map.get('ports', true);
  if (!isSeq(seq)) { seq = doc.createNode([]) as YAMLSeq; map.set('ports', seq); }
  (seq as YAMLSeq).add(doc.createNode(port, { flow: true } as never));
}

// Boundary ports (tool-made, flagged) live only while a connection passes through them in both directions.
function pruneBoundary(doc: Document): void {
  for (let round = 0; round < 64; round++) {
    const conns = connSeq(doc, false), list = (conns?.items ?? []).filter(isMap) as YAMLMap[];
    let changed = false;
    const walk = (m: YAMLMap, path: string) => {
      const ports = m.get('ports', true);
      if (isSeq(ports)) {
        for (const p of [...ports.items]) {
          if (!isMap(p) || p.get('boundary') !== true) continue;
          const ep = `${path}:${p.get('name')}`;
          if (list.some(c => c.get('from') === ep) && list.some(c => c.get('to') === ep)) continue;
          ports.items.splice(ports.items.indexOf(p), 1); changed = true;
          if (conns) conns.items = conns.items.filter(c => !(isMap(c) && (c.get('from') === ep || c.get('to') === ep)));
        }
        if (!ports.items.length) m.delete('ports');
      }
      for (const c of childMaps(m)) walk(c, `${path}.${nameOf(c)}`);
    };
    walk(rootMap(doc), nameOf(rootMap(doc)));
    if (!changed) return;
  }
}

interface WirePlan { ports: { path: string; port: Omit<PortDef, 'dir'> }[]; conns: { from: string; to: string }[] }

/** A connection that crosses container borders becomes a chain of hops through boundary ports on each container. */
function planWire(doc: Document, op: { from: string; to: string }): WirePlan {
  const plain: WirePlan = { ports: [], conns: [{ from: op.from, to: op.to }] };
  const { model, index } = loadModelText(doc.toString());
  if (!index.size) return plain;
  const a = splitEndpoint(op.from), b = splitEndpoint(op.to);
  const ea = index.get(a.path), eb = index.get(b.path);
  const pa = ea?.ports.find(p => p.name === a.port), pb = eb?.ports.find(p => p.name === b.port);
  if (!ea || !eb || !pa || !pb || pa.dir !== 'out' || pb.dir !== 'in') return plain;
  const h = hops(ea, eb);
  if ((!h.up.length && !h.down.length) || h.lca === ea || h.lca === eb) return plain;

  const ta = effPtype(model, pa), tb = effPtype(model, pb);
  if (ta !== tb) fail('ptype_mismatch', `${op.from} -> ${op.to}`, `parameter types differ: ${op.from} carries #(${ta}) but ${op.to} carries #(${tb})`, [ta]);
  const fwd = pa.ptype ? { ptype: pa.ptype } : {}; // forwarded ports carry the source's explicit type
  const existing = model.connections ?? [], plan: WirePlan = { ports: [], conns: [] };
  const used = new Map<string, Set<string>>();
  const fresh = (c: Entry, base: string): string => {
    const taken = used.get(c.path) ?? used.set(c.path, new Set(c.ports.map(p => p.name))).get(c.path)!;
    let n = base, k = 2;
    while (taken.has(n)) n = `${base}${k++}`;
    taken.add(n);
    return n;
  };
  const isBoundary = (c: Entry, port: string, dir: 'in' | 'out') => c.ports.some(p => p.name === port && p.dir === dir && p.boundary);

  // source side: nearest container first, each forwards the same kind outward
  let cur = op.from;
  for (const c of h.up) {
    const reuse = existing.find(x => x.from === cur && splitEndpoint(x.to).path === c.path && isBoundary(c, splitEndpoint(x.to).port, 'out'));
    if (reuse) { cur = reuse.to; continue; }
    const name = fresh(c, `${pa.name}_out`);
    plan.ports.push({ path: c.path, port: { name, kind: pa.kind, ...fwd, boundary: true } });
    plan.conns.push({ from: cur, to: `${c.path}:${name}` });
    cur = `${c.path}:${name}`;
  }
  // target side: build from the innermost container outward so each knows what it forwards to
  const cand = COMPAT[pa.kind] ?? [];
  const inKind = cand.includes(pb.kind) && /_(export|socket)$/.test(pb.kind) ? pb.kind : cand.find(k => k.endsWith('_export')) ?? pb.kind;
  let next = op.to;
  for (const c of h.down) {
    const reuse = existing.find(x => x.to === next && splitEndpoint(x.from).path === c.path && isBoundary(c, splitEndpoint(x.from).port, 'in'));
    if (reuse) { next = reuse.from; continue; }
    const name = fresh(c, `${pb.name}_in`);
    plan.ports.push({ path: c.path, port: { name, kind: inKind, ...fwd, boundary: true } });
    plan.conns.push({ from: `${c.path}:${name}`, to: next });
    next = `${c.path}:${name}`;
  }
  plan.conns.push({ from: cur, to: next });
  return plan;
}

function applyOp(doc: Document, op: Op): void {
  switch (op.op) {
    case 'add': {
      const { map } = findNode(doc, op.parent);
      let seq = childSeq(map);
      if (!seq) { seq = doc.createNode([]) as YAMLSeq; map.set('children', seq); }
      const node: Record<string, unknown> = { name: op.name, type: op.type };
      if (op.ports?.length) node.ports = op.ports;
      seq.add(doc.createNode(node));
      return;
    }
    case 'rm': {
      const { map, parent } = findNode(doc, op.path);
      if (!parent) return fail('rm_root', op.path, 'cannot remove root');
      const seq = childSeq(parent)!;
      seq.items.splice(seq.items.indexOf(map), 1);
      if (!seq.items.length) parent.delete('children');
      const conns = connSeq(doc, false);
      if (conns) conns.items = conns.items.filter(c => isMap(c) && !touches(String(c.get('from')), op.path) && !touches(String(c.get('to')), op.path));
      return;
    }
    case 'move-up': {
      // the node leaves its parent and lands right after it, inside the grandparent
      const { map, parent } = findNode(doc, op.path);
      const segs = op.path.split('.');
      if (!parent) return fail('move_root', op.path, 'the root cannot move');
      if (segs.length < 3) return fail('move_top', op.path, `'${op.path}' is already directly under the root`);
      const gpPath = segs.slice(0, -2).join('.'), name = segs[segs.length - 1], newPath = `${gpPath}.${name}`;
      const { map: gp } = findNode(doc, gpPath);
      if (childMaps(gp).some(c => nameOf(c) === name)) return fail('name_taken', newPath, `'${gpPath}' already has a child named '${name}'; rename it first`);
      const from = childSeq(parent)!;
      from.items.splice(from.items.indexOf(map), 1);
      if (!from.items.length) parent.delete('children');
      let to = childSeq(gp);
      if (!to) { to = doc.createNode([]) as YAMLSeq; gp.set('children', to); }
      const at = to.items.findIndex(c => c === parent);
      to.items.splice(at < 0 ? to.items.length : at + 1, 0, map);
      // a wire that left through the old parent's boundary port is spliced straight to where that port led; other wires that
      // would now skip a boundary go. Wires to the new siblings or the new parent stay.
      const oldPar = segs.slice(0, -1).join('.'), ownerOf = (ep: string) => ep.split(':')[0];
      const conns = connSeq(doc, false), list = (conns?.items ?? []).filter(isMap) as YAMLMap[];
      const gone = new Set<YAMLMap>(), spliced: { from: string; to: string }[] = [];
      const ends = (c: YAMLMap) => [String(c.get('from')), String(c.get('to'))] as const;
      for (const c of list) {
        const [x, y] = ends(c), ix = touches(x, op.path), iy = touches(y, op.path);
        if (ix === iy) continue;
        const oe = ix ? y : x;
        if (ownerOf(oe) !== oldPar) continue;
        gone.add(c);
        const near = list.filter(d => String(d.get(ix ? 'to' : 'from')) === oe);
        for (const d of list) {
          if (d === c || String(d.get(ix ? 'from' : 'to')) !== oe) continue;
          spliced.push(ix ? { from: x, to: String(d.get('to')) } : { from: String(d.get('from')), to: y });
          if (near.every(n => gone.has(n) || n === c)) gone.add(d);
        }
      }
      const keep = (f: string, t: string) => {
        const i1 = touches(f, op.path), i2 = touches(t, op.path);
        if (i1 === i2) return true;
        const other = ownerOf(i1 ? t : f), up = other.slice(0, Math.max(0, other.lastIndexOf('.')));
        return other === gpPath || up === gpPath;
      };
      if (conns) {
        conns.items = conns.items.filter(c => !isMap(c) || (!gone.has(c) && keep(String(c.get('from')), String(c.get('to')))));
        for (const n of spliced) if (keep(n.from, n.to) && !conns.items.some(c => isMap(c) && c.get('from') === n.from && c.get('to') === n.to)) conns.items.push(doc.createNode(n, { flow: true } as never));
      }
      for (const c of conns?.items ?? []) if (isMap(c)) for (const k of ['from', 'to']) {
        const v = String(c.get(k));
        if (touches(v, op.path)) c.set(k, newPath + v.slice(op.path.length));
      }
      return;
    }
    case 'set': {
      const { map } = findNode(doc, op.path);
      if (op.field === 'type') { map.set('type', op.value); return; }
      const oldPath = op.path, segs = oldPath.split('.');
      segs[segs.length - 1] = op.value;
      const newPath = segs.join('.');
      map.set('name', op.value);
      const conns = connSeq(doc, false);
      for (const c of conns?.items ?? []) if (isMap(c)) for (const k of ['from', 'to']) {
        const v = String(c.get(k));
        if (touches(v, oldPath)) c.set(k, newPath + v.slice(oldPath.length));
      }
      return;
    }
    case 'port-add': addPort(doc, op.path, op.port); return;
    case 'port-rm': {
      const { map } = findNode(doc, op.path);
      const seq = map.get('ports', true);
      const own = isSeq(seq) ? (seq as YAMLSeq) : undefined;
      const before = own?.items.length ?? 0;
      if (own) own.items = own.items.filter(p => !(isMap(p) && p.get('name') === op.name));
      if (!own || own.items.length === before) return fail('no_port', op.path, `node '${op.path}' has no own port '${op.name}'`, own ? own.items.filter(isMap).map(p => String(p.get('name'))) : []);
      if (!own.items.length) map.delete('ports');
      const conns = connSeq(doc, false);
      const ep = `${op.path}:${op.name}`;
      if (conns) conns.items = conns.items.filter(c => !(isMap(c) && (c.get('from') === ep || c.get('to') === ep)));
      return;
    }
    case 'obj-add': {
      let seq = doc.get('objects', true);
      if (!isSeq(seq)) { seq = doc.createNode([]) as YAMLSeq; doc.set('objects', seq); }
      (seq as YAMLSeq).add(doc.createNode(op.base && op.base !== 'uvm_sequence_item' ? { name: op.name, extends: op.base } : { name: op.name }, { flow: true } as never));
      return;
    }
    case 'obj-rm': {
      const seq = doc.get('objects', true);
      const before = isSeq(seq) ? seq.items.length : 0;
      if (isSeq(seq)) seq.items = seq.items.filter(o => !(isMap(o) && o.get('name') === op.name));
      if (!isSeq(seq) || seq.items.length === before) return fail('no_object', op.name, `no object '${op.name}'`);
      if (!seq.items.length) doc.delete('objects');
      return;
    }
    case 'wire': {
      const s = connSeq(doc, true)!;
      const plan = planWire(doc, op);
      for (const p of plan.ports) addPort(doc, p.path, p.port);
      for (const c of plan.conns) {
        if (s.items.some(x => isMap(x) && x.get('from') === c.from && x.get('to') === c.to)) continue;
        s.add(doc.createNode({ from: c.from, to: c.to }, { flow: true } as never));
      }
      return;
    }
    case 'unwire': {
      const s = connSeq(doc, false);
      if (!s) return fail('no_conn', op.from, 'no connections');
      const n = s.items.length;
      s.items = s.items.filter(c => !(isMap(c) && c.get('from') === op.from && c.get('to') === op.to));
      if (s.items.length === n) fail('no_conn', op.from, `no connection ${op.from} -> ${op.to}`);
      return;
    }
    default:
      return fail('bad_op', '', `unknown op '${(op as { op: string }).op}'`, ['add', 'rm', 'move-up', 'set', 'port-add', 'port-rm', 'obj-add', 'obj-rm', 'wire', 'unwire']);
  }
}

// Apply ops in memory, validate the result; caller writes `text` only when ok.
export function applyOps(text: string, ops: Op[]): { ok: boolean; text: string; diags: Diag[] } {
  const doc = parseDocument(text);
  try {
    for (const op of ops) applyOp(doc, op);
    pruneBoundary(doc);
  } catch (e) {
    if (e instanceof EditError) return { ok: false, text, diags: [e.diag] };
    throw e;
  }
  const out = doc.toString();
  const { diags } = loadModelText(out);
  return { ok: diags.length === 0, text: diags.length ? text : out, diags };
}
