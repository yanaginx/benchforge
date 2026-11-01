import type { Entry } from '../core/index.ts';
import { clsName, rootBuiltin, UVM_BASE, isNativePort, family, uvmClass, isSocket, socketClass, socketMethod, portTypes, reqRsp, HEADER } from './util.ts';
import type { Ctx, Chains } from './util.ts';

interface PortDecl { name: string; decl: string; build: string; method?: string; mkey?: string; macro?: string }

function portDecls(ctx: Ctx, e: Entry, chains: Chains, cls: string): PortDecl[] {
  const T = ctx.item, out: PortDecl[] = [];
  for (const p of e.ports) {
    if (isNativePort(ctx, e, p.name)) continue;
    const PT = portTypes(ctx, p), [T, R] = reqRsp(PT); // T: transaction or request; R: response
    if (isSocket(p.kind)) {
      const fwd = e.children.length > 0; // a container forwards sockets; only leaves implement transport
      out.push({ name: p.name, decl: `${socketClass(p.kind, cls + '_base', fwd, PT)} ${p.name};`, build: `${p.name} = new("${p.name}", this);`, method: fwd ? undefined : socketMethod(p.kind, PT)?.text, mkey: socketMethod(p.kind, PT) && `${socketMethod(p.kind)!.key}:${PT}` });
      continue;
    }
    const fam = family(p.kind);
    if (p.dir === 'out') {
      out.push({ name: p.name, decl: `${uvmClass(fam, 'port', PT)} ${p.name};`, build: `${p.name} = new("${p.name}", this);` });
    } else if (p.kind.endsWith('_export')) {
      out.push({ name: p.name, decl: `${uvmClass(fam, 'export', PT)} ${p.name};`, build: `${p.name} = new("${p.name}", this);` });
    } else if (fam === 'analysis') {
      const suffix = `_${cls}_${p.name}`;
      out.push({
        name: p.name, macro: `\`uvm_analysis_imp_decl(${suffix})`,
        decl: `${uvmClass(fam, 'imp', PT, cls + '_base', suffix)} ${p.name};`,
        build: `${p.name} = new("${p.name}", this);`,
        method: `  virtual function void write${suffix}(${T} t);\n    // TODO: handle ${p.name}\n  endfunction`,
      });
    } else {
      const method = fam === 'blocking_put' ? `  virtual task put(${T} t);\n    // TODO\n  endtask`
        : fam === 'blocking_get' ? `  virtual task get(output ${T} t);\n    // TODO\n  endtask`
        : fam === 'blocking_transport' ? `  virtual task transport(${T} req, output ${R} rsp);\n    // TODO\n  endtask` : undefined;
      out.push({ name: p.name, decl: `${uvmClass(fam, 'imp', PT, cls + '_base')} ${p.name};`, build: `${p.name} = new("${p.name}", this);`, method });
    }
  }
  for (const b of chains.bports.get(e.path) ?? []) {
    if (isSocket(b.kind)) { out.push({ name: b.name, decl: `${socketClass(b.kind.replace(/initiator|target/, b.dir === 'out' ? 'initiator' : 'target'), cls + '_base', true)} ${b.name};`, build: `${b.name} = new("${b.name}", this);` }); continue; }
    const fam = family(b.kind), role = b.dir === 'out' ? 'port' : 'export';
    out.push({ name: b.name, decl: `${uvmClass(fam, role, T)} ${b.name};`, build: `${b.name} = new("${b.name}", this);` });
  }
  return out;
}

const guardWrap = (lines: string[], guard: boolean) =>
  guard ? ['    if (get_is_active() == UVM_ACTIVE) begin', ...lines.map(l => '  ' + l), '    end'] : lines;

export function componentBase(ctx: Ctx, e: Entry, chains: Chains): string {
  const cls = clsName(ctx, e), kind = rootBuiltin(ctx.model, e.rtype.name), T = ctx.item;
  const ports = portDecls(ctx, e, chains, cls);
  const base = (UVM_BASE[kind] ?? UVM_BASE.component)(T);
  const hasVif = kind === 'driver' || kind === 'monitor';
  const l: string[] = [HEADER(`regenerated on every run. Extend ${cls} in user/${cls}.sv instead.`)];
  for (const m of new Set(ports.map(p => p.macro).filter(Boolean))) l.push(m!);
  l.push(`class ${cls}_base extends ${base};`, '');
  if (e.children.length) for (const c of e.children) l.push(`  ${clsName(ctx, c)} ${c.node.name};`);
  for (const p of ports) l.push(`  ${p.decl}`);
  if (hasVif) l.push(`  virtual ${ctx.project}_if vif;`);
  l.push('', '  function new(string name, uvm_component parent);', '    super.new(name, parent);', '  endfunction', '');

  l.push('  virtual function void build_phase(uvm_phase phase);', '    super.build_phase(phase);');
  if (hasVif) l.push(`    if (!uvm_config_db#(virtual ${ctx.project}_if)::get(this, "", "vif", vif))`, `      \`uvm_fatal("NOVIF", {"virtual interface not set for ", get_full_name(), ".vif"})`);
  for (const p of ports) l.push(`    ${p.build}`);
  const isAgent = kind === 'agent';
  for (const c of e.children) {
    const ck = rootBuiltin(ctx.model, c.rtype.name);
    const guard = isAgent && (ck === 'driver' || ck === 'sequencer');
    l.push(...guardWrap([`    ${c.node.name} = ${clsName(ctx, c)}::type_id::create("${c.node.name}", this);`], guard));
  }
  l.push('  endfunction', '');

  const stmts = chains.stmts.get(e.path) ?? [];
  if (stmts.length) {
    l.push('  virtual function void connect_phase(uvm_phase phase);', '    super.connect_phase(phase);');
    for (const s of stmts) l.push(...guardWrap([`    ${s.text}`], s.guard && isAgent));
    l.push('  endfunction', '');
  }

  if (kind === 'driver') {
    l.push('  virtual task run_phase(uvm_phase phase);', '    forever begin', '      seq_item_port.get_next_item(req);',
      '      // TODO: drive req onto vif', '      seq_item_port.item_done();', '    end', '  endtask', '');
  } else if (kind === 'monitor') {
    const ap = e.ports.find(p => p.dir === 'out' && family(p.kind) === 'analysis');
    const clk = ctx.model.dut?.clock?.name ?? 'clk';
    l.push('  virtual task run_phase(uvm_phase phase);', '    forever begin', `      @(posedge vif.${clk});`,
      '      // TODO: sample vif; when a transaction completes:',
      `      //   ${ctx.item} t = ${ctx.item}::type_id::create("t");`,
      ap ? `      //   ${ap.name}.write(t);` : '      //   publish t on an analysis port', '    end', '  endtask', '');
  } else if (kind === 'subscriber') {
    l.push(`  virtual function void write(${T} t);`, '    // TODO: sample coverage or log', '  endfunction', '');
  }
  const seen = new Set<string>();
  for (const p of ports) if (p.method && !(p.mkey && seen.has(p.mkey))) { if (p.mkey) seen.add(p.mkey); l.push(p.method, ''); }
  l.push('endclass', '');
  return l.join('\n');
}

export function componentUser(ctx: Ctx, e: Entry): string {
  const cls = clsName(ctx, e);
  return [
    '// User-owned: created once by benchforge, never overwritten (unless --force).',
    `class ${cls} extends ${cls}_base;`, `  \`uvm_component_utils(${cls})`, '',
    '  function new(string name, uvm_component parent);', '    super.new(name, parent);', '  endfunction', '',
    '  // Add or override behaviour here.', '', 'endclass', '',
  ].join('\n');
}

export function baseTest(ctx: Ctx, root: Entry): string {
  const rc = clsName(ctx, root), n = root.node.name, t = `${ctx.project}_base_test`;
  return [
    HEADER('regenerated on every run. Extend this test in your own files.'),
    `class ${t} extends uvm_test;`, `  \`uvm_component_utils(${t})`, '', `  ${rc} ${n};`, '',
    '  function new(string name = "' + t + '", uvm_component parent = null);', '    super.new(name, parent);', '  endfunction', '',
    '  virtual function void build_phase(uvm_phase phase);', '    super.build_phase(phase);',
    `    ${n} = ${rc}::type_id::create("${n}", this);`, '  endfunction', '',
    '  virtual function void end_of_elaboration_phase(uvm_phase phase);', '    uvm_top.print_topology();', '  endfunction', '',
    '  virtual task run_phase(uvm_phase phase);', '    phase.raise_objection(this);', '    // TODO: start sequences', '    phase.drop_objection(this);', '  endtask', '',
    'endclass', '',
  ].join('\n');
}

export function itemStub(ctx: Ctx): string {
  const n = ctx.item;
  return [
    HEADER('placeholder; replace with the transaction generated from the object editor.'),
    `class ${n} extends uvm_sequence_item;`, `  \`uvm_object_utils(${n})`, '',
    '  // TODO: add fields', '',
    '  function new(string name = "' + n + '");', '    super.new(name);', '  endfunction', '', 'endclass', '',
  ].join('\n');
}

export function objectStub(name: string, base: string): string {
  return [
    '// User-owned: created once by benchforge, never overwritten (unless --force).',
    `class ${name} extends ${base};`, `  \`uvm_object_utils(${name})`, '',
    '  // TODO: add fields', '',
    `  function new(string name = "${name}");`, '    super.new(name);', '  endfunction', '', 'endclass', '',
  ].join('\n');
}
