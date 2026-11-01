import test from 'node:test';
import assert from 'node:assert/strict';
import { loadModelText } from '../src/core/check.ts';
import { layoutModel } from '../src/core/layout.ts';
import { renderSvg } from '../src/core/svg.ts';

// many-to-one, one-to-many and all-to-all wiring inside one env
const head = 'project: stress\nuvm: "1.2"\ndut:\n  name: d\n  clock: { name: clk, period_ns: 10 }\n  reset: { name: rst, active: low }\n  ports:\n    - { name: a, dir: in }\nroot:\n  name: tb\n  type: env\n  children:\n';
const mons = (n: number) => Array.from({ length: n }, (_, i) => `    - { name: mon${i}, type: monitor }\n`).join('');
const subs = (n: number) => Array.from({ length: n }, (_, i) => `    - { name: cov${i}, type: subscriber }\n`).join('');
const sbs = (n: number, ports: number) => Array.from({ length: n }, (_, i) => `    - name: sb${i}\n      type: scoreboard\n      ports:\n${Array.from({ length: ports }, (_, k) => `        - { name: imp${k}, kind: analysis_imp, dir: in }\n`).join('')}`).join('');
const conn = (from: string, to: string) => `  - { from: ${from}, to: ${to} }\n`;
const range = (n: number) => Array.from({ length: n }, (_, i) => i);

const CASES: Record<string, { yaml: string; crossings: boolean }> = {
  'six outputs into one input': { yaml: head + mons(6) + sbs(1, 1) + 'connections:\n' + range(6).map(i => conn(`tb.mon${i}:ap`, 'tb.sb0:imp0')).join(''), crossings: false },
  'one output to six subscribers and two scoreboards': { yaml: head + mons(1) + subs(6) + sbs(2, 1) + 'connections:\n' + range(6).map(i => conn('tb.mon0:ap', `tb.cov${i}:analysis_export`)).join('') + range(2).map(i => conn('tb.mon0:ap', `tb.sb${i}:imp0`)).join(''), crossings: false },
  'three monitors to three scoreboards, all to all': { yaml: head + mons(3) + sbs(3, 1) + 'connections:\n' + range(3).flatMap(i => range(3).map(j => conn(`tb.mon${i}:ap`, `tb.sb${j}:imp0`))).join(''), crossings: true },
  'mixed fan-in and fan-out': { yaml: head + mons(4) + sbs(3, 2) + subs(3) + 'connections:\n' + range(4).flatMap(i => range(2).map(j => conn(`tb.mon${i}:ap`, `tb.sb${(i + j) % 3}:imp${j % 2}`))).join('') + range(4).map(i => conn(`tb.mon${i}:ap`, `tb.cov${i % 3}:analysis_export`)).join(''), crossings: true },
};

for (const [name, c] of Object.entries(CASES)) test(`fan wiring: ${name}`, async () => {
  const { model, index, diags } = loadModelText(c.yaml);
  assert.deepEqual(diags, []);
  for (const depth of [2, 3]) {
    const { laid } = await layoutModel(model, index, { depth });
    const svg = renderSvg(laid);
    assert.equal((svg.match(/<path class="w"/g) ?? []).length >= model.connections!.length, true, 'every connection is drawn');
    assert.ok(svg.includes('<circle'), 'branches and merges carry a junction dot');
    // wires from different connections never run on top of each other except exactly shared trunks
    const segs: { c: number; a: { x: number; y: number }; b: { x: number; y: number } }[] = [];
    const boxes: { x: number; y: number; w: number; h: number }[] = [];
    const walk = (n: any, ox: number, oy: number) => {
      for (const e of n.edges ?? []) for (const s of e.sections ?? []) {
        const p = [s.startPoint, ...(s.bendPoints ?? []), s.endPoint];
        for (let i = 0; i + 1 < p.length; i++) segs.push({ c: e.conn, a: { x: ox + p[i].x, y: oy + p[i].y }, b: { x: ox + p[i + 1].x, y: oy + p[i + 1].y } });
      }
      for (const k of n.children ?? []) { if (!k.children?.length) boxes.push({ x: ox + (k.x ?? 0), y: oy + (k.y ?? 0), w: k.width, h: k.height }); walk(k, ox + (k.x ?? 0), oy + (k.y ?? 0)); }
    };
    for (const k of laid.children) { if (!k.children?.length) boxes.push({ x: k.x ?? 0, y: k.y ?? 0, w: k.width, h: k.height }); walk(k, k.x ?? 0, k.y ?? 0); }
    let crossings = 0;
    for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
      const p = segs[i], q = segs[j]; if (p.c === q.c) continue;
      const hp = Math.abs(p.a.y - p.b.y) < 0.01, hq = Math.abs(q.a.y - q.b.y) < 0.01;
      if (hp === hq) { // parallel and a few px apart reads as a doubled line
        const k = hp ? 'y' : 'x', m = hp ? 'x' : 'y', d = Math.abs(p.a[k] - q.a[k]);
        if (d >= 0.01 && d < 9) assert.ok(Math.min(Math.max(p.a[m], p.b[m]), Math.max(q.a[m], q.b[m])) - Math.max(Math.min(p.a[m], p.b[m]), Math.min(q.a[m], q.b[m])) <= 4, `${name} d${depth}: ${p.c} and ${q.c} run ${d.toFixed(1)}px apart`);
        continue;
      }
      const [h, v] = hp ? [p, q] : [q, p];
      if (v.a.x > Math.min(h.a.x, h.b.x) + 1 && v.a.x < Math.max(h.a.x, h.b.x) - 1 && h.a.y > Math.min(v.a.y, v.b.y) + 1 && h.a.y < Math.max(v.a.y, v.b.y) - 1) crossings++;
    }
    for (const s of segs) for (const b of boxes) {
      const x0 = Math.min(s.a.x, s.b.x), x1 = Math.max(s.a.x, s.b.x), y0 = Math.min(s.a.y, s.b.y), y1 = Math.max(s.a.y, s.b.y);
      assert.ok(!(x1 > b.x + 1 && x0 < b.x + b.w - 1 && y1 > b.y + 1 && y0 < b.y + b.h - 1), `${name} d${depth}: connection ${s.c} runs through a box`);
    }
    if (crossings) assert.ok(svg.includes(' 0 0 1 ') || svg.includes(' 0 0 0 '), `${name} d${depth}: ${crossings} crossing(s) are drawn without a bridge`);
    if (!c.crossings) assert.equal(crossings, 0, `${name} d${depth}: a pure fan needs no crossing`);
  }
});
