import type { Model, ModelNode, PortDef, ResolvedType } from './types.ts';
import { resolveType, kindDir } from './types-builtin.ts';

export interface Entry {
  path: string;
  node: ModelNode;
  parent?: Entry;
  rtype: ResolvedType;
  ports: PortDef[];
  children: Entry[];
}

export function buildIndex(model: Model): Map<string, Entry> {
  const idx = new Map<string, Entry>();
  const walk = (node: ModelNode, parent: Entry | undefined): void => {
    const path = parent ? `${parent.path}.${node.name}` : node.name;
    const rtype = resolveType(model, node.type);
    const ports = new Map<string, PortDef>();
    for (const p of rtype.ports) ports.set(p.name, p);
    for (const p of node.ports ?? []) ports.set(p.name, { ...p, dir: p.dir ?? kindDir(p.kind) ?? 'in' });
    const e: Entry = { path, node, parent, rtype, ports: [...ports.values()], children: [] };
    idx.set(path, e);
    parent?.children.push(e);
    for (const c of node.children ?? []) walk(c, e);
  };
  walk(model.root, undefined);
  return idx;
}

export function ancestors(e: Entry): Entry[] {
  const out: Entry[] = [];
  for (let c: Entry | undefined = e; c; c = c.parent) out.push(c);
  return out; // self first, root last
}

/** Containers a connection must pass through. `up`: below the common ancestor on the source side (nearest source first);
 *  `down`: same on the target side (nearest target first). Both empty means a direct hop (siblings, child->parent, parent->child). */
export function hops(ea: Entry, eb: Entry): { lca: Entry; up: Entry[]; down: Entry[] } {
  const chainB = ancestors(eb);
  const lca = ancestors(ea).find(x => chainB.includes(x))!;
  const up: Entry[] = [], down: Entry[] = [];
  if (lca !== ea) for (let x = ea.parent; x && x !== lca; x = x.parent) up.push(x);
  if (lca !== eb) for (let y = eb.parent; y && y !== lca; y = y.parent) down.push(y);
  return { lca, up, down };
}

export function descendantCount(e: Entry): number {
  return e.children.reduce((s, c) => s + 1 + descendantCount(c), 0);
}

export function splitEndpoint(ep: string): { path: string; port: string } {
  const i = ep.lastIndexOf(':');
  return { path: ep.slice(0, i), port: ep.slice(i + 1) };
}
