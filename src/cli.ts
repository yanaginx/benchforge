#!/usr/bin/env node
import fs from 'node:fs';
import { loadModelFile } from './core/check.ts';
import type { Diag } from './core/check.ts';
import { layoutModel } from './core/layout.ts';
import { renderSvg } from './core/svg.ts';
import { applyOps } from './core/edit.ts';
import type { Op } from './core/edit.ts';
import { BUILTIN, COMPAT } from './core/types-builtin.ts';
import type { Entry } from './core/index.ts';

const USAGE = `benchforge <command> [args]   (add --json for machine output)

 read
  check <model>                          validate, print errors
  tree <model>                           outline with ports and connections
  svg <model> [-o f.svg] [--root path] [--depth n]
  schema                                 model JSON schema + built-in types
 edit (validated first, file untouched on error)
  add <model> --parent P --name N --type T
  rm <model> <path>
  set <model> <path> --name X | --type X
  object <model> add <name> [--base uvm_object|uvm_sequence_item] | rm <name>   (classes ports can be parameterized with)
  port <model> add <path> --name N --kind K [--ptype T]   (direction comes from the kind)
  port <model> rm <path> <name>
  wire <model> <from path:port> <to path:port>
  unwire <model> <from> <to>
  apply <model> [ops.json]               batch ops from file or stdin
 codegen
  gen <model> [--out dir] [--dry-run] [--force]   (default dir: <project>_tb)
 ui
  ui <model> [--port 8765] [--out dir]    local web UI (http://127.0.0.1:port)

exit codes: 0 ok, 1 validation/edit error, 2 usage`;

const json = process.argv.includes('--json');
const args = process.argv.slice(2).filter(a => a !== '--json');

function out(obj: unknown, text: string): void { console.log(json ? JSON.stringify(obj, null, 2) : text); }
function usage(msg: string): never { console.error(`${msg}\n\n${USAGE}`); process.exit(2); }
function fail(diags: Diag[]): never {
  if (json) console.log(JSON.stringify({ ok: false, diags }, null, 2));
  else for (const d of diags) console.error(`error: ${d.path ? d.path + ': ' : ''}${d.message}${d.options ? `\n  options: ${d.options.join(', ')}` : ''}`);
  process.exit(1);
}
function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
function positional(): string[] {
  const res: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('-') && args[i].length > 1) { if (!['--dry-run', '--force'].includes(args[i])) i++; } else res.push(args[i]);
  }
  return res;
}

function printTree(e: Entry, prefix = '', last = true, top = true): string[] {
  const ports = e.ports.map(p => `${p.name}${p.dir === 'out' ? '>' : '<'}`).join(' ');
  const lines = [`${top ? '' : prefix + (last ? '`- ' : '|- ')}${e.node.name} [${e.rtype.name}]${ports ? '  ' + ports : ''}`];
  const next = top ? '' : prefix + (last ? '   ' : '|  ');
  e.children.forEach((c, i) => lines.push(...printTree(c, next, i === e.children.length - 1, false)));
  return lines;
}

function editModel(file: string, ops: Op[]): void {
  const text = fs.readFileSync(file, 'utf8');
  const r = applyOps(text, ops);
  if (!r.ok) fail(r.diags);
  fs.writeFileSync(file, r.text);
  out({ ok: true, ops: ops.length }, `ok: ${ops.length} op(s) applied`);
}

async function main() {
  const [cmd, ...rest] = args;
  if (!cmd || cmd === '-h' || cmd === '--help') { console.log(USAGE); process.exit(cmd ? 0 : 2); }
  const pos = positional().slice(2);

  if (cmd === 'schema') {
    const schema = JSON.parse(fs.readFileSync(new URL('../schema/model.schema.json', import.meta.url), 'utf8'));
    const types = Object.fromEntries(Object.entries(BUILTIN).map(([k, v]) => [k, { shape: v.shape, focal: !!v.focal, ports: v.ports ?? [] }]));
    out({ schema, builtinTypes: types, compat: COMPAT }, JSON.stringify({ builtinTypes: types, compat: COMPAT }, null, 2));
    return;
  }

  const file = rest[0];
  if (!file) usage('missing model file');
  if (!fs.existsSync(file)) usage(`no such file: ${file}`);

  if (['add', 'rm', 'set', 'port', 'object', 'wire', 'unwire', 'apply'].includes(cmd)) {
    let ops: Op[];
    if (cmd === 'add') {
      const parent = flag('--parent'), name = flag('--name'), type = flag('--type');
      if (!parent || !name || !type) usage('add needs --parent, --name, --type');
      ops = [{ op: 'add', parent, name, type }];
    } else if (cmd === 'rm') {
      if (!pos[0]) usage('rm needs a path');
      ops = [{ op: 'rm', path: pos[0] }];
    } else if (cmd === 'set') {
      const name = flag('--name'), type = flag('--type');
      if (!pos[0] || (!name && !type)) usage('set needs <path> and --name or --type');
      ops = [];
      if (type) ops.push({ op: 'set', path: pos[0], field: 'type', value: type });
      if (name) ops.push({ op: 'set', path: pos[0], field: 'name', value: name });
    } else if (cmd === 'object') {
      if (pos[0] === 'add' && pos[1]) { const base = flag('--base'); ops = [{ op: 'obj-add', name: pos[1], ...(base ? { base: base as 'uvm_object' } : {}) }]; }
      else if (pos[0] === 'rm' && pos[1]) ops = [{ op: 'obj-rm', name: pos[1] }];
      else usage('object needs add <name> | rm <name>');
    } else if (cmd === 'port') {
      if (pos[0] === 'add') {
        const name = flag('--name'), kind = flag('--kind'), dir = flag('--dir'), ptype = flag('--ptype');
        if (!pos[1] || !name || !kind || (dir && dir !== 'in' && dir !== 'out')) usage('port add needs <path> --name --kind');
        ops = [{ op: 'port-add', path: pos[1], port: { name, kind, ...(dir ? { dir } : {}), ...(ptype ? { ptype } : {}) } }];
      } else if (pos[0] === 'rm') {
        if (!pos[1] || !pos[2]) usage('port rm needs <path> <name>');
        ops = [{ op: 'port-rm', path: pos[1], name: pos[2] }];
      } else usage('port needs add|rm');
    } else if (cmd === 'wire' || cmd === 'unwire') {
      if (!pos[0] || !pos[1]) usage(`${cmd} needs <from> <to>`);
      ops = [{ op: cmd, from: pos[0], to: pos[1] }];
    } else {
      const src = pos[0] ? fs.readFileSync(pos[0], 'utf8') : fs.readFileSync(0, 'utf8');
      try { ops = JSON.parse(src); } catch { usage('apply: ops must be a JSON array'); }
      if (!Array.isArray(ops)) usage('apply: ops must be a JSON array');
    }
    editModel(file, ops);
    return;
  }

  const { model, index, diags, errors } = loadModelFile(file);
  if (diags.length) fail(diags);

  if (cmd === 'check') {
    out({ ok: true, nodes: index.size, connections: (model.connections ?? []).length, errors }, `ok: ${index.size} nodes, ${(model.connections ?? []).length} connections`);
  } else if (cmd === 'tree') {
    out(model, [...printTree(index.get(model.root.name)!), ...(model.connections ?? []).map(c => `  ${c.from} -> ${c.to}`)].join('\n'));
  } else if (cmd === 'svg') {
    const depth = flag('--depth');
    const { laid, ms, nodeCount } = await layoutModel(model, index, { root: flag('--root'), depth: depth ? Number(depth) : undefined });
    const outFile = flag('-o') ?? `${model.project}.svg`;
    fs.writeFileSync(outFile, renderSvg(laid));
    out({ ok: true, file: outFile, nodes: nodeCount, layoutMs: Math.round(ms) }, `wrote ${outFile} (${nodeCount} nodes, layout ${ms.toFixed(0)}ms)`);
  } else if (cmd === 'gen') {
    const { generate, writeFiles } = await import('./gen/index.ts');
    const files = generate(model, index);
    const dir = flag('--out') ?? `${model.project}_tb`;
    const res = writeFiles(files, dir, { dryRun: args.includes('--dry-run'), force: args.includes('--force') });
    out({ ok: true, dir, files: res }, res.map(f => `${f.status.padEnd(9)} ${f.path}`).join('\n'));
  } else if (cmd === 'ui') {
    const { startServer } = await import('./web/server.ts');
    const port = Number(flag('--port') ?? 8765);
    startServer({ file, port, outDir: flag('--out') });
    console.log(`benchforge ui: http://127.0.0.1:${port}  (model: ${file})  Ctrl+C to stop`);
    return;
  } else usage(`unknown command '${cmd}'`);
}

main().catch(e => { console.error((e as Error).message); process.exit(1); });
