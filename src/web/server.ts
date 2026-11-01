import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { asset } from '../assets.ts';
import { loadModelFile } from '../core/check.ts';
import type { Diag } from '../core/check.ts';
import { applyOps } from '../core/edit.ts';
import type { Op } from '../core/edit.ts';
import { layoutModel } from '../core/layout.ts';
import type { LayoutHint } from '../core/layout.ts';
import { renderSvg } from '../core/svg.ts';
import { BUILTIN, COMPAT, GENERIC_PAYLOAD, effPtype, resolveType } from '../core/types-builtin.ts';
import type { Model } from '../core/types.ts';
import type { Entry } from '../core/index.ts';
import { generate, writeFiles } from '../gen/index.ts';

interface TreeNode {
  path: string; name: string; type: string; shape: string; focal: boolean;
  ports: { name: string; kind: string; dir: string; ptype?: string; pt: string; own: boolean }[]; children: TreeNode[];
}
const toTree = (e: Entry, model: Model): TreeNode => ({
  path: e.path, name: e.node.name, type: e.rtype.name, shape: e.rtype.shape, focal: e.rtype.focal,
  ports: e.ports.map(p => ({ ...p, pt: effPtype(model, p), own: (e.node.ports ?? []).some(q => q.name === p.name) })), children: e.children.map(c => toTree(c, model)),
});

export interface ServerOpts { file: string; port: number; outDir?: string }

interface Snap { text: string; label: string }
// Undo/redo keep whole file texts: every edit is a text rewrite anyway, so a snapshot is exact and cheap.
interface Memo { hint?: LayoutHint; past: Snap[]; future: Snap[] }
const HISTORY = 200;
async function state(file: string, memo: Memo, root?: string, depth?: number, layout = true, relayout = false) {
  const { model, index, diags } = loadModelFile(file);
  if (diags.length) return { ok: false, diags };
  const view = root && index.has(root) ? root : model.root.name;
  const r = layout ? await layoutModel(model, index, { root: view, depth, hint: relayout ? undefined : memo.hint }) : null;
  if (r) memo.hint = { pos: r.pos, cand: r.cand }; // the next layout keeps this arrangement
  const laid = r?.laid ?? null, ms = r?.ms ?? 0, nodeCount = r?.nodeCount ?? 0;
  const types = Object.fromEntries([...Object.keys(BUILTIN), ...Object.keys(model.types ?? {})].map(n => [n, typeInfo(model, n)]));
  return {
    ok: true, diags: [] as Diag[], file: path.basename(file), project: model.project, uvm: model.uvm ?? '1.2',
    tree: toTree(index.get(model.root.name)!, model), item: `${model.project}_item`, payload: GENERIC_PAYLOAD, objects: model.objects ?? [], connections: model.connections ?? [],
    undo: memo.past.at(-1)?.label ?? null, redo: memo.future.at(-1)?.label ?? null,
    svg: laid ? renderSvg(laid) : null, view, layoutMs: Math.round(ms), nodeCount, types, compat: COMPAT,
  };
}

function typeInfo(model: Model, name: string) {
  return { shape: resolveType(model, name).shape };
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => { n += c.length; if (n > 1 << 20) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function startServer(opts: ServerOpts): http.Server {
  const html = asset('src/web/index.html');
  const send = (res: http.ServerResponse, code: number, body: unknown, type = 'application/json') => {
    res.writeHead(code, { 'content-type': type + '; charset=utf-8', 'cache-control': 'no-store' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  const memo: Memo = { past: [], future: [] };
  const cur = { file: path.resolve(opts.file) }; // the model being edited; Open and Save as switch it
  const isYaml = (f: string) => /\.ya?ml$/i.test(f);
  const target = (f: unknown) => path.resolve(path.dirname(cur.file), String(f ?? '').replace(/^~(?=\/)/, process.env.HOME ?? '~'));
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/') return send(res, 200, html, 'text/html');
      if (req.method === 'GET' && url.pathname === '/api/state') {
        const d = url.searchParams.get('depth');
        return send(res, 200, await state(cur.file, memo, url.searchParams.get('root') ?? undefined, d ? Number(d) : undefined, true, url.searchParams.get('relayout') === '1'));
      }
      if (req.method === 'GET' && url.pathname === '/api/files') {
        const dir = path.dirname(cur.file);
        return send(res, 200, { ok: true, dir, current: path.basename(cur.file), files: fs.readdirSync(dir).filter(isYaml).sort() });
      }
      if (req.method === 'GET' && url.pathname === '/api/model.yaml') {
        res.writeHead(200, { 'content-type': 'text/yaml; charset=utf-8', 'content-disposition': `attachment; filename="${path.basename(cur.file)}"`, 'cache-control': 'no-store' });
        return res.end(fs.readFileSync(cur.file, 'utf8'));
      }
      if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
        // custom header forces a CORS preflight, so other web pages cannot write files through this server
        if (req.headers['x-bf'] !== '1') return send(res, 403, { ok: false, diags: [{ code: 'forbidden', path: '', message: 'missing x-bf header' }] });
        const body = JSON.parse((await readBody(req)) || '{}');
        if (url.pathname === '/api/ops') {
          const before = fs.readFileSync(cur.file, 'utf8');
          const r = applyOps(before, body.ops as Op[]);
          if (!r.ok) return send(res, 200, { ok: false, diags: r.diags });
          if (r.text !== before) {
            memo.past.push({ text: before, label: [...new Set((body.ops as Op[]).map(o => o.op))].join(', ') });
            if (memo.past.length > HISTORY) memo.past.shift();
            memo.future = [];
          }
          fs.writeFileSync(cur.file, r.text);
          return send(res, 200, await state(cur.file, memo, body.root, body.depth, body.layout !== false, !!body.relayout));
        }
        const bad = (message: string) => send(res, 200, { ok: false, diags: [{ code: 'file', path: '', message }] });
        if (url.pathname === '/api/open') {
          const f = target(body.file);
          if (!isYaml(f)) return bad('pick a .yaml or .yml file');
          if (!fs.existsSync(f)) return bad(`no such file: ${f}`);
          const probe = loadModelFile(f); // a model with errors is refused, so the open one stays usable
          if (probe.diags.length) return send(res, 200, { ok: false, diags: probe.diags });
          cur.file = f; memo.past = []; memo.future = []; memo.hint = undefined;
          return send(res, 200, await state(cur.file, memo, undefined, body.depth));
        }
        if (url.pathname === '/api/saveas') {
          const f = target(body.file);
          if (!isYaml(f)) return bad('name must end in .yaml or .yml');
          if (fs.existsSync(f) && f !== cur.file && !body.force) return bad(`${path.basename(f)} exists; tick overwrite to replace it`);
          fs.mkdirSync(path.dirname(f), { recursive: true });
          fs.writeFileSync(f, fs.readFileSync(cur.file, 'utf8'));
          cur.file = f;
          return send(res, 200, await state(cur.file, memo, body.root, body.depth, false));
        }
        if (url.pathname === '/api/undo' || url.pathname === '/api/redo') {
          const undo = url.pathname === '/api/undo', from = undo ? memo.past : memo.future, to = undo ? memo.future : memo.past;
          const snap = from.pop();
          if (!snap) return send(res, 200, { ok: false, diags: [{ code: 'history', path: '', message: `nothing to ${undo ? 'undo' : 'redo'}` }] });
          to.push({ text: fs.readFileSync(cur.file, 'utf8'), label: snap.label }); // the label of an edit follows it in both directions
          fs.writeFileSync(cur.file, snap.text);
          return send(res, 200, { ...(await state(cur.file, memo, body.root, body.depth, true, false)), did: snap.label });
        }
        if (url.pathname === '/api/gen') {
          const { model, index, diags } = loadModelFile(cur.file);
          if (diags.length) return send(res, 200, { ok: false, diags });
          const dir = opts.outDir ?? path.join(path.dirname(cur.file), `${model.project}_tb`);
          const files = writeFiles(generate(model, index), dir, { dryRun: !!body.dryRun, force: !!body.force });
          return send(res, 200, { ok: true, dir, dryRun: !!body.dryRun, files });
        }
      }
      send(res, 404, { ok: false, diags: [{ code: 'not_found', path: url.pathname, message: 'not found' }] });
    } catch (e) {
      send(res, 500, { ok: false, diags: [{ code: 'server', path: '', message: (e as Error).message }] });
    }
  });
  server.listen(opts.port, '127.0.0.1');
  return server;
}
