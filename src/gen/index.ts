import fs from 'node:fs';
import path from 'node:path';
import type { Model } from '../core/types.ts';
import type { Entry } from '../core/index.ts';
import { buildChains, clsName, HEADER } from './util.ts';
import type { Ctx } from './util.ts';
import { baseTest, componentBase, componentUser, itemStub, objectStub } from './components.ts';
import { filelist, interfaceSv, topSv } from './top.ts';

export interface GenFile { path: string; content: string; owner: 'gen' | 'user' }
export interface WriteResult { path: string; status: 'new' | 'overwrite' | 'unchanged' | 'keep' }

export function generate(model: Model, index: Map<string, Entry>): GenFile[] {
  const project = model.project;
  const ctx: Ctx = { model, index, project, item: `${project}_item`, uvm: model.uvm ?? '1.2' };
  const chains = buildChains(ctx);
  const root = index.get(model.root.name)!;
  const files: GenFile[] = [];
  const inc: string[] = [];

  files.push({ path: `gen/${project}_if.sv`, content: interfaceSv(ctx), owner: 'gen' });
  files.push({ path: `gen/${ctx.item}.sv`, content: itemStub(ctx), owner: 'gen' });
  inc.push(`gen/${ctx.item}.sv`);
  for (const o of model.objects ?? []) {
    if (o.name === ctx.item) continue;
    files.push({ path: `user/${o.name}.sv`, content: objectStub(o.name, o.extends ?? 'uvm_sequence_item'), owner: 'user' });
    inc.push(`user/${o.name}.sv`);
  }

  // children before parents so every class is declared before use
  const walk = (e: Entry) => {
    e.children.forEach(walk);
    const cls = clsName(ctx, e);
    files.push({ path: `gen/${cls}_base.sv`, content: componentBase(ctx, e, chains), owner: 'gen' });
    files.push({ path: `user/${cls}.sv`, content: componentUser(ctx, e), owner: 'user' });
    inc.push(`gen/${cls}_base.sv`, `user/${cls}.sv`);
  };
  walk(root);
  files.push({ path: `gen/${project}_base_test.sv`, content: baseTest(ctx, root), owner: 'gen' });
  inc.push(`gen/${project}_base_test.sv`);

  const pkg = [
    HEADER('regenerated on every run.'), `package ${project}_pkg;`, '  import uvm_pkg::*;', '  `include "uvm_macros.svh"', '',
    ...inc.map(f => `  \`include "${path.basename(f)}"`), '', 'endpackage', '',
  ].join('\n');
  files.push({ path: `gen/${project}_pkg.sv`, content: pkg, owner: 'gen' });
  files.push({ path: `gen/${project}_tb_top.sv`, content: topSv(ctx), owner: 'gen' });
  files.push({ path: 'filelist.f', content: filelist(ctx, `${project}_pkg.sv`), owner: 'gen' });
  return files;
}

export function writeFiles(files: GenFile[], dir: string, opts: { dryRun?: boolean; force?: boolean } = {}): WriteResult[] {
  return files.map(f => {
    const full = path.join(dir, f.path);
    const exists = fs.existsSync(full);
    let status: WriteResult['status'];
    if (!exists) status = 'new';
    else if (f.owner === 'user' && !opts.force) status = 'keep';
    else status = fs.readFileSync(full, 'utf8') === f.content ? 'unchanged' : 'overwrite';
    if (!opts.dryRun && (status === 'new' || status === 'overwrite')) {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, f.content);
    }
    return { path: f.path, status };
  });
}
