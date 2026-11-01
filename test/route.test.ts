import test from 'node:test';
import assert from 'node:assert/strict';
import { loadModelFile } from '../src/core/check.ts';
import { layoutModel } from '../src/core/layout.ts';
import { renderSvg } from '../src/core/svg.ts';

interface Seg { c: number; a: { x: number; y: number }; b: { x: number; y: number } }

test('arrows of unrelated connections never share a lane', async () => {
  const { model, index } = loadModelFile(new URL('../examples/axi.yaml', import.meta.url).pathname);
  const conns = model.connections!;
  for (const depth of [2, 3, 4]) {
    const { laid } = await layoutModel(model, index, { depth });
    const segs: Seg[] = [];
    const walk = (n: any, ox: number, oy: number) => {
      for (const e of n.edges ?? []) for (const s of e.sections ?? []) {
        const pts = [s.startPoint, ...(s.bendPoints ?? []), s.endPoint];
        for (let i = 0; i + 1 < pts.length; i++) segs.push({ c: e.conn, a: { x: ox + pts[i].x, y: oy + pts[i].y }, b: { x: ox + pts[i + 1].x, y: oy + pts[i + 1].y } });
      }
      for (const c of n.children ?? []) walk(c, ox + (c.x ?? 0), oy + (c.y ?? 0));
    };
    for (const c of laid.children) walk(c, c.x ?? 0, c.y ?? 0);
    for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
      const p = segs[i], q = segs[j];
      // fan-out from one port or fan-in to one port may share a trunk
      if (p.c === q.c || conns[p.c].from === conns[q.c].from || conns[p.c].to === conns[q.c].to) continue;
      const hp = p.a.y === p.b.y, hq = q.a.y === q.b.y;
      if (hp !== hq) continue;
      const k = hp ? 'y' : 'x', m = hp ? 'x' : 'y';
      if (Math.abs(p.a[k] - q.a[k]) > 1) continue;
      const lo = Math.max(Math.min(p.a[m], p.b[m]), Math.min(q.a[m], q.b[m]));
      const hi = Math.min(Math.max(p.a[m], p.b[m]), Math.max(q.a[m], q.b[m]));
      assert.ok(hi - lo <= 1, `depth ${depth}: connections ${p.c} and ${q.c} overlap on ${k}=${p.a[k]}`);
    }
  }
});

test('every arrow carries its connection index for highlighting', async () => {
  const { model, index } = loadModelFile(new URL('../examples/axi.yaml', import.meta.url).pathname);
  const { laid } = await layoutModel(model, index, { depth: 5 });
  const svg = renderSvg(laid);
  for (let i = 0; i < model.connections!.length; i++) assert.match(svg, new RegExp(`<path[^>]*data-c="${i}"`));
});

test('every routed wire is orthogonal and never doubles back (short hops included)', async () => {
  for (const f of ['axi', 'play', 'tlm2']) {
    const { model, index } = loadModelFile(new URL(`../examples/${f}.yaml`, import.meta.url).pathname);
    for (const depth of [1, 2, 3, 4]) {
      const { laid } = await layoutModel(model, index, { depth });
      const walk = (n: any) => {
        for (const e of n.edges ?? []) for (const s of e.sections ?? []) {
          const pts = [s.startPoint, ...(s.bendPoints ?? []), s.endPoint];
          assert.ok(pts.length <= 5, `${f} d${depth} conn ${e.conn}: ${pts.length} points`);
          for (let i = 0; i + 1 < pts.length; i++) assert.ok(Math.abs(pts[i].x - pts[i + 1].x) < 0.05 || Math.abs(pts[i].y - pts[i + 1].y) < 0.05, `${f} d${depth} conn ${e.conn}: diagonal`);
        }
        for (const c of n.children ?? []) walk(c);
      };
      for (const c of laid.children) walk(c);
    }
  }
});

test('two ports on one side in the wrong order are swapped so their wires do not cross', async () => {
  const { routeAll } = await import('../src/core/route.ts');
  const port = (id: string, x: number, y: number) => ({ id, x, y, width: 6, height: 6 });
  const mk = (id: string, x: number, y: number, w: number, h: number, ports: any[]) => ({ id, x, y, width: w, height: h, ports });
  // sb has its two inputs on the bottom; A is upper right, B is straight below: A->left port and B->right port would cross
  const host: any = {
    id: 'h', x: 0, y: 0, width: 400, height: 300, ports: [],
    children: [
      mk('h.sb', 100, 100, 100, 40, [port('h.sb:p1', 20, 37), port('h.sb:p2', 70, 37)]),
      mk('h.A', 300, 20, 40, 30, [port('h.A:o', 17, 27)]),
      mk('h.B', 125, 220, 40, 30, [port('h.B:o', 17, -3)]),
    ],
    edges: [
      { id: 'e0', sources: ['h.A:o'], targets: ['h.sb:p1'], conn: 0, kind: 'analysis_port' },
      { id: 'e1', sources: ['h.B:o'], targets: ['h.sb:p2'], conn: 1, kind: 'analysis_port' },
    ],
  };
  routeAll({ children: [host] } as any);
  const segs = host.edges.map((e: any) => { const s = e.sections[0]; const p = [s.startPoint, ...(s.bendPoints ?? []), s.endPoint]; return p.slice(1).map((q: any, i: number) => [p[i], q]); });
  let cross = 0;
  for (const [a, b] of segs[0]) for (const [c, d] of segs[1]) {
    const ah = a.y === b.y, ch = c.y === d.y; if (ah === ch) continue;
    const [h0, h1, v0, v1] = ah ? [a, b, c, d] : [c, d, a, b];
    if (v0.x > Math.min(h0.x, h1.x) + 0.5 && v0.x < Math.max(h0.x, h1.x) - 0.5 && h0.y > Math.min(v0.y, v1.y) + 0.5 && h0.y < Math.max(v0.y, v1.y) - 0.5) cross++;
  }
  assert.equal(cross, 0);
});

test('no wires run a few px beside each other, and none is left to cut through a box (reused and fresh layouts)', async () => {
  for (const f of ['axi', 'play', 'tlm2']) {
    const { model, index } = loadModelFile(new URL(`../examples/${f}.yaml`, import.meta.url).pathname);
    for (const d1 of [1, 2, 3, 4]) {
      const fresh = await layoutModel(model, index, { depth: d1 });
      for (const d2 of [1, 2, 3, 4]) {
        const { laid } = await layoutModel(model, index, { depth: d2, hint: { pos: fresh.pos, cand: fresh.cand } });
        const segs: Seg[] = [], boxes: { x: number; y: number; w: number; h: number }[] = [];
        const walk = (n: any, ox: number, oy: number) => {
          for (const e of n.edges ?? []) for (const s of e.sections ?? []) {
            const p = [s.startPoint, ...(s.bendPoints ?? []), s.endPoint];
            for (let i = 0; i + 1 < p.length; i++) segs.push({ c: e.conn, a: { x: ox + p[i].x, y: oy + p[i].y }, b: { x: ox + p[i + 1].x, y: oy + p[i + 1].y } });
          }
          for (const c of n.children ?? []) { if (!c.children?.length) boxes.push({ x: ox + (c.x ?? 0), y: oy + (c.y ?? 0), w: c.width, h: c.height }); walk(c, ox + (c.x ?? 0), oy + (c.y ?? 0)); }
        };
        for (const c of laid.children) { if (!c.children?.length) boxes.push({ x: c.x ?? 0, y: c.y ?? 0, w: c.width, h: c.height }); walk(c, c.x ?? 0, c.y ?? 0); }
        const tag = `${f} d${d1}->d${d2}`;
        for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
          const p = segs[i], q = segs[j]; if (p.c === q.c) continue;
          const hp = Math.abs(p.a.y - p.b.y) < 0.01, hq = Math.abs(q.a.y - q.b.y) < 0.01; if (hp !== hq) continue;
          const k = hp ? 'y' : 'x', m = hp ? 'x' : 'y', dist = Math.abs(p.a[k] - q.a[k]);
          if (dist < 0.01 || dist >= 9) continue;
          const span = Math.min(Math.max(p.a[m], p.b[m]), Math.max(q.a[m], q.b[m])) - Math.max(Math.min(p.a[m], p.b[m]), Math.min(q.a[m], q.b[m]));
          assert.ok(span <= 4, `${tag}: connections ${p.c} and ${q.c} run ${dist.toFixed(1)}px apart for ${span.toFixed(0)}px`);
        }
        for (const s of segs) for (const b of boxes) {
          const x0 = Math.min(s.a.x, s.b.x), x1 = Math.max(s.a.x, s.b.x), y0 = Math.min(s.a.y, s.b.y), y1 = Math.max(s.a.y, s.b.y);
          assert.ok(!(x1 > b.x + 1 && x0 < b.x + b.w - 1 && y1 > b.y + 1 && y0 < b.y + b.h - 1), `${tag}: connection ${s.c} runs through a box`);
        }
      }
    }
  }
});
