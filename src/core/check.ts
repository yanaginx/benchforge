import fs from 'node:fs';
import { parse } from 'yaml';
import Ajv from 'ajv';
import type { Model } from './types.ts';
import { buildIndex, splitEndpoint, hops } from './index.ts';
import type { Entry } from './index.ts';
import { COMPAT, BUILTIN, ALL_KINDS, kindDir, effPtype, twoParam, isSocketKind, knownPtypes } from './types-builtin.ts';

const schema = JSON.parse(fs.readFileSync(new URL('../../schema/model.schema.json', import.meta.url), 'utf8'));
const validateShape = new Ajv({ allErrors: true }).compile(schema);

export interface Diag { code: string; path: string; message: string; options?: string[] }
export interface Loaded { model: Model; index: Map<string, Entry>; diags: Diag[]; errors: string[] }

export function loadModelFile(file: string): Loaded {
  return loadModelText(fs.readFileSync(file, 'utf8'));
}

const done = (model: Model, index: Map<string, Entry>, diags: Diag[]): Loaded =>
  ({ model, index, diags, errors: diags.map(d => (d.path ? `${d.path}: ` : '') + d.message) });

export function loadModelText(text: string): Loaded {
  let raw: unknown;
  try { raw = parse(text); } catch (e) { return done({} as Model, new Map(), [{ code: 'yaml', path: '', message: (e as Error).message }]); }
  if (!validateShape(raw)) {
    const diags = (validateShape.errors ?? []).map(e => ({ code: 'schema', path: e.instancePath || '/', message: e.message ?? 'invalid' }));
    return done(raw as Model, new Map(), diags);
  }
  const model = raw as Model;
  const diags: Diag[] = [];
  const err = (code: string, path: string, message: string, options?: string[]) => diags.push({ code, path, message, options });
  let index = new Map<string, Entry>();
  try {
    index = buildIndex(model);
  } catch (e) {
    const m = (e as Error).message;
    const bad = /unknown type '([^']+)'/.exec(m);
    err(bad ? 'unknown_type' : 'type', '', m, bad ? [...Object.keys(BUILTIN), ...Object.keys(model.types ?? {})] : undefined);
    return done(model, index, diags);
  }
  const checkSiblings = (e: Entry) => {
    const seen = new Set<string>();
    for (const c of e.children) {
      if (seen.has(c.node.name)) err('duplicate_name', e.path, `duplicate child name '${c.node.name}'`);
      seen.add(c.node.name);
    }
    e.children.forEach(checkSiblings);
  };
  checkSiblings(index.get(model.root.name)!);
  for (const e of index.values()) {
    const seen = new Set<string>();
    for (const q of e.node.ports ?? []) {
      if (seen.has(q.name)) err('duplicate_port', e.path, `duplicate port '${q.name}'`);
      seen.add(q.name);
    }
  }
  const objSeen = new Set<string>();
  for (const o of model.objects ?? []) {
    if (objSeen.has(o.name)) err('duplicate_object', `objects.${o.name}`, `duplicate object '${o.name}'`);
    objSeen.add(o.name);
  }
  for (const e of index.values()) for (const p of e.ports) {
    const at = `${e.path}:${p.name}`, want = kindDir(p.kind), given = (e.node.ports ?? []).find(q => q.name === p.name)?.dir;
    if (!want) err('unknown_kind', at, `unknown port kind '${p.kind}'`, ALL_KINDS);
    else if (given && given !== want) err('kind_direction', at, `'${p.kind}' is an ${want} kind but port '${p.name}' is declared ${given}; drop 'dir', the kind decides it`, [want]);
    if (p.ptype !== undefined && want) {
      const n = p.ptype.split(',').length;
      if (n > (twoParam(p.kind) ? 2 : 1)) err('bad_ptype', at, `'${p.kind}' takes ${twoParam(p.kind) ? 'at most two types (request, response)' : 'one type'}, got '${p.ptype}'`);
      else if (isSocketKind(p.kind) && p.ptype.includes(',')) err('bad_ptype', at, `'${p.kind}' takes one payload class`);
      else for (const t of p.ptype.replace(/\s+/g, '').split(','))
        if (!knownPtypes(model).includes(t)) err('unknown_ptype', at, `parameter type '${t}' is not declared; add it under 'objects:'`, knownPtypes(model));
    }
  }
  for (const e of index.values())
    if (e.rtype.shape === 'leaf' && e.children.length) err('leaf_children', e.path, `leaf type '${e.rtype.name}' has children`);
  (model.connections ?? []).forEach((c, i) => {
    const at = `connections[${i}]`;
    const a = splitEndpoint(c.from), b = splitEndpoint(c.to);
    const ea = index.get(a.path), eb = index.get(b.path);
    if (!ea) return void err('no_node', `${at}.from`, `no node '${a.path}'`, [...index.keys()]);
    if (!eb) return void err('no_node', `${at}.to`, `no node '${b.path}'`, [...index.keys()]);
    const pa = ea.ports.find(p => p.name === a.port), pb = eb.ports.find(p => p.name === b.port);
    if (!pa) return void err('no_port', `${at}.from`, `'${a.path}' has no port '${a.port}'`, ea.ports.map(p => p.name));
    if (!pb) return void err('no_port', `${at}.to`, `'${b.path}' has no port '${b.port}'`, eb.ports.map(p => p.name));
    const h = hops(ea, eb);
    if (h.up.length || h.down.length) {
      const need = [...h.up, ...h.down].map(x => x.path);
      return void err('boundary', at, `connection crosses container boundaries; wire it hop by hop through ports on: ${need.join(', ')} (the wire command adds them)`, need);
    }
    if (eb === ea.parent) { // child -> parent: port forwarded out of the container
      if (pa.dir !== 'out') err('wrong_direction', `${at}.from`, `port '${c.from}' is not an output`);
      if (pb.dir !== 'out') err('wrong_direction', `${at}.to`, `port '${c.to}' must be an out port of the container`);
      if (pa.kind !== pb.kind) err('incompatible', at, `${pa.kind} must forward as the same kind, not ${pb.kind}`, [pa.kind]);
    } else if (ea === eb.parent) { // parent -> child: port forwarded into the container
      if (pa.dir !== 'in') err('wrong_direction', `${at}.from`, `port '${c.from}' must be an in port of the container`);
      if (pb.dir !== 'in') err('wrong_direction', `${at}.to`, `port '${c.to}' is not an input`);
      if (!Object.entries(COMPAT).some(([, ks]) => ks.includes(pa.kind) && ks.includes(pb.kind)) && pa.kind !== pb.kind)
        err('incompatible', at, `${pa.kind} cannot forward to ${pb.kind}`);
    } else {
      if (pa.dir !== 'out') err('wrong_direction', `${at}.from`, `port '${c.from}' is not an output`);
      if (pb.dir !== 'in') err('wrong_direction', `${at}.to`, `port '${c.to}' is not an input`);
      if (pa.dir === 'out' && pb.dir === 'in' && !(COMPAT[pa.kind] ?? []).includes(pb.kind))
        err('incompatible', at, `${pa.kind} cannot connect to ${pb.kind}`, COMPAT[pa.kind]);
    }
    const ta = effPtype(model, pa), tb = effPtype(model, pb);
    if (ta !== tb) err('ptype_mismatch', at, `parameter types differ: ${c.from} carries #(${ta}) but ${c.to} carries #(${tb})`, [ta]);
  });
  return done(model, index, diags);
}
