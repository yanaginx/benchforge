import type { Model, PortDef } from '../core/types.ts';
import { BUILTIN, effPtype, GENERIC_PAYLOAD } from '../core/types-builtin.ts';
import { ancestors, splitEndpoint } from '../core/index.ts';
import type { Entry } from '../core/index.ts';

export interface Ctx {
  model: Model;
  index: Map<string, Entry>;
  project: string;
  item: string; // transaction class name
  uvm: '1.2' | '1.1d';
}

export const clsName = (ctx: Ctx, e: Entry): string => `${ctx.project}_${e.path.replace(/\./g, '_')}`;

/** Follow `extends` until a built-in type name. */
export function rootBuiltin(model: Model, type: string): string {
  let t = type;
  for (let i = 0; i < 32; i++) {
    if (BUILTIN[t] && !model.types?.[t]) return t;
    const next = model.types?.[t]?.extends;
    if (!next) return BUILTIN[t] ? t : 'component';
    t = next;
  }
  return 'component';
}

export const UVM_BASE: Record<string, (item: string) => string> = {
  component: () => 'uvm_component',
  env: () => 'uvm_env',
  agent: () => 'uvm_agent',
  sequencer: i => `uvm_sequencer #(${i})`,
  driver: i => `uvm_driver #(${i})`,
  monitor: () => 'uvm_monitor',
  scoreboard: () => 'uvm_scoreboard',
  subscriber: i => `uvm_subscriber #(${i})`,
};

/** Ports that the UVM base class already provides. */
const NATIVE_PORTS: Record<string, string[]> = {
  driver: ['seq_item_port'],
  sequencer: ['seq_item_export'],
  subscriber: ['analysis_export'],
};
export const isNativePort = (ctx: Ctx, e: Entry, port: string): boolean =>
  (NATIVE_PORTS[rootBuiltin(ctx.model, e.rtype.name)] ?? []).includes(port);

export const family = (kind: string): string => kind.replace(/_(port|imp|export|fifo)$/, '');

export type Role = 'port' | 'export' | 'imp';
/** `types` is the port's normalized ptype: "T", or "REQ,RSP" on the two-parameter kinds. */
export const reqRsp = (types: string): [string, string] => { const [a, b] = types.split(','); return [a, b ?? a]; };
export const portTypes = (ctx: Ctx, p: PortDef): string => effPtype(ctx.model, p);
export function uvmClass(fam: string, role: Role, types: string, cls?: string, suffix?: string): string {
  const [item, rsp] = reqRsp(types);
  if (fam === 'analysis' && role === 'imp') return `uvm_analysis_imp${suffix} #(${item}, ${cls})`;
  if (fam === 'seq_item') return role === 'imp' ? `uvm_seq_item_pull_imp #(${item}, ${rsp}, ${cls})` : `uvm_seq_item_pull_${role} #(${item}${rsp === item ? '' : ', ' + rsp})`;
  if (fam === 'blocking_transport') return role === 'imp' ? `uvm_blocking_transport_imp #(${item}, ${rsp}, ${cls})` : `uvm_blocking_transport_${role} #(${item}, ${rsp})`;
  return role === 'imp' ? `uvm_${fam}_imp #(${item}, ${cls})` : `uvm_${fam}_${role} #(${item})`;
}

export const isSocket = (kind: string): boolean => /^tlm_(b|nb)_(initiator|target)_socket$/.test(kind);

/** TLM-2.0 socket class. `boundary` picks the passthrough variant; `cls` is the class that implements the transport methods. */
export function socketClass(kind: string, cls: string, boundary: boolean, payload = GENERIC_PAYLOAD): string {
  const m = /^tlm_(b|nb)_(initiator|target)_socket$/.exec(kind)!, mode = m[1], side = m[2], P = payload;
  const ph = mode === 'nb' ? ', uvm_tlm_phase_e' : '';
  if (boundary) return `uvm_tlm_${mode}_passthrough_${side}_socket #(${P}${ph})`;
  return side === 'initiator' && mode === 'b' ? `uvm_tlm_b_initiator_socket #(${P})` : `uvm_tlm_${mode}_${side}_socket #(${cls}, ${P}${ph})`;
}
/** Transport method the owning class must provide, if any. Keyed so a class with several sockets gets it once. */
export function socketMethod(kind: string, payload = GENERIC_PAYLOAD): { key: string; text: string } | undefined {
  const P = payload;
  if (kind === 'tlm_b_target_socket') return { key: 'b_transport', text: `  virtual task b_transport(${P} t, uvm_tlm_time delay);\n    // TODO\n  endtask` };
  if (kind === 'tlm_nb_target_socket') return { key: 'nb_fw', text: `  virtual function uvm_tlm_sync_e nb_transport_fw(${P} t, ref uvm_tlm_phase_e p, input uvm_tlm_time delay);\n    // TODO\n    return UVM_TLM_COMPLETED;\n  endfunction` };
  if (kind === 'tlm_nb_initiator_socket') return { key: 'nb_bw', text: `  virtual function uvm_tlm_sync_e nb_transport_bw(${P} t, ref uvm_tlm_phase_e p, input uvm_tlm_time delay);\n    // TODO\n    return UVM_TLM_COMPLETED;\n  endfunction` };
  return undefined;
}

export interface BPort { name: string; kind: string; dir: 'in' | 'out' }
export interface Stmt { text: string; guard: boolean }
export interface Chains { bports: Map<string, BPort[]>; stmts: Map<string, Stmt[]> } // keyed by container path

const activeOnly = (ctx: Ctx, e: Entry): boolean =>
  !!e.parent && rootBuiltin(ctx.model, e.parent.rtype.name) === 'agent' && ['driver', 'sequencer'].includes(rootBuiltin(ctx.model, e.rtype.name));

/** Same chaining rule as the layout: every hierarchy crossing goes through a port on the boundary container. */
export function buildChains(ctx: Ctx): Chains {
  const bports = new Map<string, BPort[]>(), stmts = new Map<string, Stmt[]>();
  const addB = (path: string, b: BPort) => { (bports.get(path) ?? bports.set(path, []).get(path)!).push(b); };
  const addS = (path: string, text: string, guard: boolean) => { (stmts.get(path) ?? stmts.set(path, []).get(path)!).push({ text, guard }); };

  (ctx.model.connections ?? []).forEach((c, i) => {
    const a = splitEndpoint(c.from), b = splitEndpoint(c.to);
    const ea = ctx.index.get(a.path)!, eb = ctx.index.get(b.path)!;
    const pa = ea.ports.find(p => p.name === a.port) as PortDef;
    const chainA = ancestors(ea), chainB = ancestors(eb);
    const lca = chainA.find(x => chainB.includes(x))!;

    let x = ea, curA = a.port;
    while (x !== lca && x.parent !== lca) {
      const par = x.parent!, bp = `bnd_out_${i}`;
      addB(par.path, { name: bp, kind: pa.kind, dir: 'out' });
      addS(par.path, `${x.node.name}.${curA}.connect(${bp});`, activeOnly(ctx, x));
      x = par; curA = bp;
    }
    let y = eb, curB = b.port;
    while (y !== lca && y.parent !== lca) {
      const par = y.parent!, bp = `bnd_in_${i}`;
      addB(par.path, { name: bp, kind: pa.kind, dir: 'in' });
      addS(par.path, `${bp}.connect(${y.node.name}.${curB});`, activeOnly(ctx, y));
      y = par; curB = bp;
    }
    const left = x === lca ? curA : `${x.node.name}.${curA}`;
    const right = y === lca ? curB : `${y.node.name}.${curB}`;
    addS(lca.path, `${left}.connect(${right});`, (x !== lca && activeOnly(ctx, x)) || (y !== lca && activeOnly(ctx, y)));
  });
  return { bports, stmts };
}

export const HEADER = (what: string) =>
  `// Generated by benchforge. DO NOT EDIT: ${what}\n`;
