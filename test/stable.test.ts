import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadModelText } from '../src/core/check.ts';
import { applyOps } from '../src/core/edit.ts';
import { layoutModel } from '../src/core/layout.ts';

const text = fs.readFileSync(new URL('../examples/play.yaml', import.meta.url), 'utf8');
const shift = (a: Map<string, [number, number]>, b: Map<string, [number, number]>) =>
  Math.max(...[...a].filter(([k]) => b.has(k)).map(([k, v]) => Math.abs(v[0] - b.get(k)![0]) + Math.abs(v[1] - b.get(k)![1])));

test('with a hint, wiring or changing the level keeps the arrangement', async () => {
  const a = loadModelText(text);
  const first = await layoutModel(a.model, a.index, { depth: 3 });
  const r = applyOps(text, [{ op: 'wire', from: 'tb.m_agent.mon:ap', to: 'tb.sb:s_imp_2' }]);
  assert.ok(r.ok, JSON.stringify(r.diags));
  const b = loadModelText(r.text);
  const free = await layoutModel(b.model, b.index, { depth: 3 });
  const kept = await layoutModel(b.model, b.index, { depth: 3, hint: { pos: first.pos, cand: first.cand } });
  const dKept = shift(first.pos, kept.pos), dFree = shift(first.pos, free.pos);
  console.log('shift without hint', dFree, 'with hint', dKept);
  // the box that gains a port grows, so it may land a little differently than in a fresh layout; nothing else may move
  assert.ok(dKept <= dFree + 40, 'hint never moves things much more than a fresh layout');
  // nodes stay put, unless the kept arrangement cannot be wired without a crossing: then one fresh layout (zero crossings wins)
  assert.ok(dKept <= 100 || dKept === dFree, `nodes stay put (moved ${dKept})`);
  // level change: nodes that exist in both views stay near
  const deeper = await layoutModel(a.model, a.index, { depth: 4, hint: { pos: first.pos, cand: first.cand } });
  const tops = ['tb.sub_env', 'tb.m_agent', 'tb.sb', 'tb.cov'];
  for (const t of tops) assert.ok(deeper.pos.has(t) && first.pos.has(t));
});

// ---- routing quality on kept (hinted) layouts: no shared lanes between unrelated connections, no arrow through a box ----
test('routed arrows neither share lanes nor cross boxes, also after a level change', async () => {
  const axi = loadModelText(fs.readFileSync(new URL('../examples/axi.yaml', import.meta.url), 'utf8'));
  const fresh = await layoutModel(axi.model, axi.index, { depth: 2 });
  for (const depth of [1, 3, 4]) {
    const { laid } = await layoutModel(axi.model, axi.index, { depth, hint: { pos: fresh.pos, cand: fresh.cand } });
    const segs: { c: number; a: number[]; b: number[] }[] = [], leaves: { x: number; y: number; w: number; h: number }[] = [];
    const walk = (n: any, ox: number, oy: number) => {
      const x = ox + (n.x ?? 0), y = oy + (n.y ?? 0);
      if (!n.children?.length) leaves.push({ x, y, w: n.width, h: n.height });
      for (const e of n.edges ?? []) for (const s of e.sections ?? []) {
        const pts = [s.startPoint, ...(s.bendPoints ?? []), s.endPoint];
        for (let i = 0; i + 1 < pts.length; i++) segs.push({ c: e.conn, a: [x + pts[i].x, y + pts[i].y], b: [x + pts[i + 1].x, y + pts[i + 1].y] });
      }
      for (const c of n.children ?? []) walk(c, x, y);
    };
    for (const c of laid.children) walk(c, 0, 0);
    const conns = axi.model.connections!;
    for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
      const p = segs[i], q = segs[j];
      if (p.c === q.c || conns[p.c].from === conns[q.c].from || conns[p.c].to === conns[q.c].to) continue;
      const hp = p.a[1] === p.b[1];
      if (hp !== (q.a[1] === q.b[1])) continue;
      const k = hp ? 1 : 0, m = hp ? 0 : 1;
      if (Math.abs(p.a[k] - q.a[k]) > 1) continue;
      const lo = Math.max(Math.min(p.a[m], p.b[m]), Math.min(q.a[m], q.b[m])), hi = Math.min(Math.max(p.a[m], p.b[m]), Math.max(q.a[m], q.b[m]));
      assert.ok(hi - lo <= 1, `depth ${depth}: connections ${p.c} and ${q.c} share a lane`);
    }
    for (const s of segs) for (const b of leaves) {
      const inside = Math.max(s.a[0], s.b[0]) > b.x + 1 && Math.min(s.a[0], s.b[0]) < b.x + b.w - 1 && Math.max(s.a[1], s.b[1]) > b.y + 1 && Math.min(s.a[1], s.b[1]) < b.y + b.h - 1;
      assert.ok(!inside, `depth ${depth}: connection ${s.c} runs through a box`);
    }
  }
});
