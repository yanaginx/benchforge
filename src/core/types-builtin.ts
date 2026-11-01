import type { TypeDef, ResolvedType, Model, PortDef } from './types.ts';

export const BUILTIN: Record<string, TypeDef> = {
  component: { shape: 'container' },
  env: { shape: 'container' },
  agent: { shape: 'container' },
  sequencer: { shape: 'leaf', ports: [{ name: 'seq_item_export', kind: 'seq_item_export', dir: 'in' }] },
  driver: { shape: 'leaf', ports: [{ name: 'seq_item_port', kind: 'seq_item_port', dir: 'out' }] },
  monitor: { shape: 'leaf', ports: [{ name: 'ap', kind: 'analysis_port', dir: 'out' }] },
  scoreboard: { shape: 'leaf', focal: true },
  subscriber: { shape: 'leaf', ports: [{ name: 'analysis_export', kind: 'analysis_imp', dir: 'in' }] },
};

// out kind -> kinds it may connect to (in direction). Boundary hops reuse the source kind.
export const COMPAT: Record<string, string[]> = {
  analysis_port: ['analysis_imp', 'analysis_export', 'analysis_fifo'],
  seq_item_port: ['seq_item_export', 'seq_item_imp'],
  blocking_put_port: ['blocking_put_imp', 'blocking_put_export'],
  blocking_get_port: ['blocking_get_imp', 'blocking_get_export'],
  blocking_transport_port: ['blocking_transport_imp', 'blocking_transport_export'],
  // TLM-2.0 sockets; passthrough sockets are made automatically where a connection crosses a hierarchy boundary
  tlm_b_initiator_socket: ['tlm_b_target_socket'],
  tlm_nb_initiator_socket: ['tlm_nb_target_socket'],
};

export function resolveType(model: Model, name: string, seen: string[] = []): ResolvedType {
  const def = model.types?.[name] ?? BUILTIN[name];
  if (!def) throw new Error(`unknown type '${name}'`);
  if (seen.includes(name)) throw new Error(`type cycle: ${[...seen, name].join(' -> ')}`);
  const base = def.extends ? resolveType(model, def.extends, [...seen, name]) : null;
  const ports = new Map<string, PortDef>();
  for (const p of base?.ports ?? []) ports.set(p.name, p);
  for (const p of def.ports ?? []) ports.set(p.name, { ...p, dir: p.dir ?? kindDir(p.kind) ?? 'in' });
  return {
    name,
    shape: def.shape ?? base?.shape ?? 'leaf',
    focal: def.focal ?? base?.focal ?? false,
    ports: [...ports.values()],
    template: def.template ?? base?.template,
  };
}

// ---- port kinds: direction and parameter type ----
export const GENERIC_PAYLOAD = 'uvm_tlm_generic_payload';
export const ALL_KINDS: string[] = [...new Set(Object.entries(COMPAT).flatMap(([k, v]) => [k, ...v]))];
/** Direction a kind implies: ports and initiator sockets initiate (out); exports, imps, fifos and target sockets receive (in). */
export function kindDir(kind: string): 'in' | 'out' | undefined {
  if (!ALL_KINDS.includes(kind)) return undefined;
  return /_(port|initiator_socket)$/.test(kind) ? 'out' : 'in';
}
export const isSocketKind = (kind: string): boolean => /^tlm_(b|nb)_(initiator|target)_socket$/.test(kind);
/** seq_item and transport kinds take a request and a response type; the rest take one. */
export const twoParam = (kind: string): boolean => /^(seq_item|blocking_transport)_/.test(kind);
/** The parameter a port gets when ptype is omitted: uvm_object, the payload for sockets, and the project item only where a sequence item is required. */
export const defaultPtype = (model: Model, kind: string): string => isSocketKind(kind) ? GENERIC_PAYLOAD : /^seq_item_/.test(kind) ? `${model.project}_item` : 'uvm_object';
/** Normalized parameter list: no spaces, and a single type on a two-parameter kind means request == response. */
export function effPtype(model: Model, p: PortDef): string {
  const raw = (p.ptype ?? defaultPtype(model, p.kind)).replace(/\s+/g, '');
  const parts = raw.split(',');
  return twoParam(p.kind) && parts.length === 1 ? `${raw},${raw}` : raw;
}

/** Every class a port may be parameterized with: uvm_object, the project item, declared objects, and the TLM-2 payload. */
export function knownPtypes(model: Model): string[] {
  return [...new Set([`${model.project}_item`, 'uvm_object', ...(model.objects ?? []).map(o => o.name), GENERIC_PAYLOAD])];
}
