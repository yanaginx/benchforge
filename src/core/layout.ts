import ELK from 'elkjs/lib/elk.bundled.js';
import type { Model, PortDef } from './types.ts';
import { ancestors, descendantCount, splitEndpoint } from './index.ts';
import type { Entry } from './index.ts';
import { effPtype } from './types-builtin.ts';
import { routeAll } from './route.ts';

const CW = 6.6; // glyph width at 11px mono
const PAD = '[top=28,left=12,bottom=12,right=12]';
const CONT = {
  'elk.padding': PAD, 'elk.algorithm': 'layered', 'elk.direction': 'DOWN',
  'elk.aspectRatio': '1.6', 'elk.layered.wrapping.strategy': 'MULTI_EDGE',
  'elk.layered.wrapping.correctionFactor': '1.0', 'elk.spacing.nodeNode': '14',
  'elk.layered.spacing.nodeNodeBetweenLayers': '24',
  // orthogonal routes with explicit gaps keep separate arrows from sharing a lane
  'elk.edgeRouting': 'ORTHOGONAL', 'elk.spacing.edgeEdge': '10', 'elk.spacing.edgeNode': '12',
  'elk.layered.spacing.edgeEdgeBetweenLayers': '12', 'elk.layered.spacing.edgeNodeBetweenLayers': '14',
  'elk.spacing.portPort': '10',
};
// containers of containers: ports are out-east and in-west, so the flow runs left to right and wires never wrap around a box
const FLOW = { ...CONT, 'elk.direction': 'RIGHT', 'elk.layered.wrapping.strategy': 'OFF', 'elk.aspectRatio': '1.6' };
const ROW = { ...CONT, 'elk.direction': 'RIGHT', 'elk.layered.wrapping.strategy': 'OFF', 'elk.separateConnectedComponents': 'true', 'elk.aspectRatio': '4' };

// Positions (relative to the parent) and the winning candidate of the previous layout. With a hint the layout keeps
// the old layering and order (ELK interactive strategies) so adding a connection or changing the level does not
// reshuffle the picture; it also runs one candidate instead of four.
export interface LayoutHint { pos: Map<string, [number, number]>; cand: number }
export interface LayoutOpts { root?: string; depth?: number; hint?: LayoutHint }
const INTERACTIVE = {
  'elk.layered.wrapping.strategy': 'OFF', // the old coordinates already encode the wrapping
  'elk.layered.layering.strategy': 'INTERACTIVE', 'elk.layered.crossingMinimization.strategy': 'INTERACTIVE', 'elk.layered.cycleBreaking.strategy': 'INTERACTIVE',
};

export interface LNode {
  id: string;
  name: string;
  type: string;
  collapsed: boolean;
  focal: boolean;
  nested: boolean; // container that holds other containers
  width?: number; height?: number; x?: number; y?: number;
  layoutOptions?: Record<string, string>;
  children?: LNode[];
  ports?: LPort[];
  edges?: LEdge[];
  extra?: string; // "+N" badge text
}
export interface LPort { id: string; title: string; model?: { path: string; name: string; kind: string; dir: string; pt: string }; side: 'EAST' | 'WEST'; width: number; height: number; x?: number; y?: number; layoutOptions: Record<string, string> }
export interface LEdge { id: string; sources: string[]; targets: string[]; kind: string; conn: number; head: boolean; sections?: { startPoint: P; endPoint: P; bendPoints?: P[] }[] }
interface P { x: number; y: number }

type PortMode = 'fixed' | 'free';
type Place = 'BRANDES_KOEPF' | 'NETWORK_SIMPLEX';
// Each extra candidate costs one more layout run, so small views try more of them.
export const CANDIDATES: [PortMode, Place][] = [['fixed', 'BRANDES_KOEPF'], ['free', 'NETWORK_SIMPLEX'], ['fixed', 'NETWORK_SIMPLEX'], ['free', 'BRANDES_KOEPF']];
const BEND_COST = 25;
const tries = (nodes: number) => (nodes <= 25 ? 4 : nodes <= 60 ? 2 : 1);

/** Total arrow length plus a penalty per bend, so detours with many corners lose. */
export const edgeCost = (laid: { children: LNode[] }): number => {
  let sum = 0;
  const walk = (n: LNode) => {
    for (const e of n.edges ?? []) for (const s of e.sections ?? []) {
      const pts = [s.startPoint, ...(s.bendPoints ?? []), s.endPoint];
      sum += BEND_COST * (pts.length - 2);
      for (let i = 0; i + 1 < pts.length; i++) sum += Math.abs(pts[i].x - pts[i + 1].x) + Math.abs(pts[i].y - pts[i + 1].y);
    }
    n.children?.forEach(walk);
  };
  laid.children.forEach(walk);
  return sum;
};

const positions = (laid: { children: LNode[] }): Map<string, [number, number]> => {
  const m = new Map<string, [number, number]>();
  const walk = (n: LNode) => { m.set(n.id, [n.x ?? 0, n.y ?? 0]); n.children?.forEach(walk); };
  laid.children.forEach(walk);
  return m;
};

/** Lay out a few ways (port sides, node placement) and keep the one with the least total arrow length. */
export async function layoutModel(model: Model, index: Map<string, Entry>, opts: LayoutOpts = {}) {
  const t0 = performance.now();
  if (opts.hint) { // keep the previous arrangement: same candidate, old positions as hints
    const r = await layoutOnce(model, index, opts, ...CANDIDATES[opts.hint.cand]);
    if (!routeAll(r.laid)) return { ...r, cand: opts.hint.cand, pos: positions(r.laid), ms: performance.now() - t0 };
    opts = { ...opts, hint: undefined }; // the old arrangement cannot be drawn without crossings: lay out afresh (one visible shift, then clean wires)
  }
  let best = await layoutOnce(model, index, opts, ...CANDIDATES[0]), bestI = 0;
  let bestLen = edgeCost(best.laid);
  const n = tries(best.nodeCount);
  for (let i = 1; i < n; i++) {
    const r = await layoutOnce(model, index, opts, ...CANDIDATES[i]), len = edgeCost(r.laid);
    if (len < bestLen) { best = r; bestLen = len; bestI = i; }
  }
  let left = routeAll(best.laid); // placement is decided by the layout engine; the connectors are routed afterwards
  // crossings left: try the other arrangements too and keep the one with the fewest (then the shortest)
  for (let i = 0; i < CANDIDATES.length && left > 0 && performance.now() - t0 < 700; i++) {
    if (i === bestI) continue;
    const r = await layoutOnce(model, index, opts, ...CANDIDATES[i]), c = routeAll(r.laid), len = edgeCost(r.laid);
    if (c < left || (c === left && len < bestLen)) { best = r; bestI = i; left = c; bestLen = len; }
  }
  return { ...best, cand: bestI, pos: positions(best.laid), ms: performance.now() - t0 };
}

export async function layoutOnce(model: Model, index: Map<string, Entry>, opts: LayoutOpts, mode: PortMode, place: Place) {
  const depth = opts.depth ?? 3;
  const viewRoot = index.get(opts.root ?? model.root.name);
  if (!viewRoot) throw new Error(`no node '${opts.root}'`);
  const nodes = new Map<string, LNode>(); // by path
  const collapsedOf = new Map<string, Entry>(); // path of hidden entry -> collapsed ancestor

  const ensurePort = (n: LNode, p: PortDef, id: string, title: string, model?: LPort['model']) => {
    if (n.ports!.some(q => q.id === id)) return;
    const side = p.dir === 'out' ? 'EAST' : 'WEST';
    n.ports!.push({ id, title, model, side, width: 6, height: 6, layoutOptions: mode === 'fixed' || n.children ? { 'port.side': side } : {} });
  };

  const build = (e: Entry, level: number): LNode => {
    const collapsed = e.children.length > 0 && level >= depth;
    const label = collapsed ? `${e.node.name} [${e.rtype.name}]` : e.node.name;
    const n: LNode = {
      id: e.path, name: e.node.name, type: e.rtype.name, collapsed, focal: e.rtype.focal,
      nested: false, ports: [], edges: [],
    };
    nodes.set(e.path, n);
    const hp = opts.hint?.pos.get(e.path); if (hp) { n.x = hp[0]; n.y = hp[1]; }
    if (collapsed) {
      n.extra = `+${descendantCount(e)}`;
      n.width = Math.max(100, Math.ceil(Math.max(e.node.name.length, e.rtype.name.length + n.extra.length + 4) * CW) + 24); n.height = 56; // squarish: name over [type] +N
      markHidden(e, e);
    } else if (e.rtype.shape === 'container' || e.children.length) {
      n.children = e.children.map(c => build(c, level + 1));
      n.nested = e.children.some(c => c.children.length > 0);
      n.layoutOptions = { ...(n.nested ? FLOW : ROW), ...(opts.hint ? INTERACTIVE : {}) };
      // an empty container (e.g. a fresh uvm_component) still needs a visible body
      n.layoutOptions['elk.nodeSize.constraints'] = 'MINIMUM_SIZE'; n.layoutOptions['elk.nodeSize.minimum'] = '(120,56)';
      if (!e.parent || e === viewRoot) n.layoutOptions['elk.hierarchyHandling'] = 'SEPARATE_CHILDREN';
    } else {
      n.width = Math.max(64, Math.ceil(Math.max(e.node.name.length, e.rtype.name.length + 2) * CW) + 20);
      n.height = 36;
    }
    for (const p of e.ports) if (!collapsed) ensurePort(n, p, `${e.path}:${p.name}`, `${p.name} (${p.kind} #(${effPtype(model, p)}))`, { path: e.path, name: p.name, kind: p.kind, dir: p.dir, pt: effPtype(model, p) });
    return n;
  };
  const markHidden = (c: Entry, top: Entry) => { for (const k of c.children) { collapsedOf.set(k.path, top); markHidden(k, top); } };
  const rootNode = build(viewRoot, 1);

  const inView = (e: Entry) => ancestors(e).some(a => a === viewRoot);
  let eid = 0;
  (model.connections ?? []).forEach((c, i) => {
    const a = splitEndpoint(c.from), b = splitEndpoint(c.to);
    let ea = index.get(a.path)!, eb = index.get(b.path)!;
    if (!inView(ea) || !inView(eb)) return;
    const pa = ea.ports.find(p => p.name === a.port)!, pb = eb.ports.find(p => p.name === b.port)!;
    let srcId = `${ea.path}:${a.port}`, dstId = `${eb.path}:${b.port}`;
    const ca = collapsedOf.get(ea.path), cb = collapsedOf.get(eb.path);
    if ((ca ?? ea) === (cb ?? eb)) return; // both ends hidden inside one collapsed box: draw nothing, and add no stray port
    // a collapsed box has no declared ports drawn, so its own endpoints get a synthetic port too
    const oa = ca ?? (nodes.get(ea.path)!.collapsed ? ea : undefined), ob = cb ?? (nodes.get(eb.path)!.collapsed ? eb : undefined);
    if (oa) { ea = oa; srcId = `${ea.path}:~o${i}`; ensurePort(nodes.get(ea.path)!, pa, srcId, `${c.from} (${pa.kind})`); }
    if (ob) { eb = ob; dstId = `${eb.path}:~i${i}`; ensurePort(nodes.get(eb.path)!, pb, dstId, `${c.to} (${pb.kind})`); }
    if (ea === eb) return;
    const chainA = ancestors(ea), chainB = ancestors(eb);
    const lca = chainA.find(x => chainB.includes(x))!;
    const edge = (host: Entry, s: string, t: string) =>
      nodes.get(host.path)!.edges!.push({ id: `e${eid++}`, sources: [s], targets: [t], kind: pa.kind, conn: i, head: !pb.boundary });
    // climb out of A to a direct child of lca
    let x = ea, cur = srcId;
    while (x !== lca && x.parent !== lca) {
      const par = x.parent!, bp = `${par.path}:~o${i}`;
      ensurePort(nodes.get(par.path)!, pa, bp, `${c.from} -> ${c.to}`);
      edge(par, cur, bp);
      x = par; cur = bp;
    }
    let y = eb, cur2 = dstId;
    while (y !== lca && y.parent !== lca) {
      const par = y.parent!, bp = `${par.path}:~i${i}`;
      ensurePort(nodes.get(par.path)!, pb, bp, `${c.from} -> ${c.to}`);
      edge(par, bp, cur2);
      y = par; cur2 = bp;
    }
    edge(lca, cur, cur2);
  });

  const addFixed = (n: LNode) => {
    if (n.ports!.length) (n.layoutOptions ??= {})['elk.portConstraints'] = mode === 'fixed' || n.children ? 'FIXED_SIDE' : 'FREE'; // container borders keep in-left/out-right so chained arrows do not loop
    if (n.children) n.layoutOptions['elk.layered.nodePlacement.strategy'] = place;
    n.children?.forEach(addFixed);
  };
  addFixed(rootNode);

  const graph = { id: '__g', layoutOptions: { ...CONT, ...(opts.hint ? INTERACTIVE : {}), 'elk.layered.nodePlacement.strategy': place, 'elk.hierarchyHandling': 'SEPARATE_CHILDREN', 'elk.padding': '[top=0,left=0,bottom=0,right=0]' }, children: [rootNode], edges: [] };
  const t0 = performance.now();
  const laid = await new ELK().layout(graph as never) as unknown as { width: number; height: number; children: LNode[] };
  return { laid, ms: performance.now() - t0, viewRoot, nodeCount: nodes.size };
}
