import type { LNode, LEdge } from './layout.ts';

// Orthogonal connector router that runs after node placement (the approach of Wybrow, Marriott and Stuckey, simplified):
// every container is a small routing problem. A grid whose lines pass through obstacle borders and port stubs is searched
// with A*; the cost is length + a penalty per bend + a big penalty for running on a lane another connector already uses
// (+ a small one for crossing). Connectors from the same output port or into the same input port may share a trunk (a bus), but running right next to another connector, a few px apart, costs as much as a bend.
// Edges are routed shortest first, then each is ripped up and routed once more with all the others in place.

const MARGINS = [5, 2, 0]; // clearance around boxes; tight gaps retry with less
const STUB = 16;    // straight run before the first turn when entering a port: the arrowhead needs room before any corner
const OUT = 8;      // leaving a port may turn sooner, so it can line up with a destination whose port is a few px off
const PORT = 3;     // half a port square
const BEND = 28, OVERLAP = 40, SHARE = 0.4, MERGE = 6, ADJ = 14, NEAR = 9, CROSS = 10;
const MAX_NODES = 90000;
const r2 = (v: number) => Math.round(v * 100) / 100; // grid lines and port centers share this rounding, so a port at x=97.33 is not nudged
const DX = [1, -1, 0, 0], DY = [0, 0, 1, -1], OPP = [1, 0, 3, 2]; // 0 E, 1 W, 2 S, 3 N

interface End { x0: number; y0: number; x1: number; y1: number; leave: number; id: string }
interface Path { units: number[]; gn: number[]; pts: [number, number][] } // units: grid unit keys; gn: grid nodes in order

// drop repeated and collinear points
function simplify(raw: [number, number][]): [number, number][] {
  const pts: [number, number][] = [];
  for (const pt of raw) {
    const n = pts.length;
    if (n && pts[n - 1][0] === pt[0] && pts[n - 1][1] === pt[1]) continue;
    if (n >= 2 && ((pts[n - 2][0] === pts[n - 1][0] && pts[n - 1][0] === pt[0]) || (pts[n - 2][1] === pts[n - 1][1] && pts[n - 1][1] === pt[1]))) pts.pop();
    pts.push(pt);
  }
  return pts;
}

/** Routes every container; returns how many wire crossings are left. */
export function routeAll(laid: { children: LNode[] }): number {
  let x = 0;
  for (const n of laid.children) x += routeHost(n);
  return x;
}

const SWAP_MS = 150; // time one container may spend trying port swaps
function routeHost(h: LNode): number {
  let inner = 0;
  for (const c of h.children ?? []) inner += routeHost(c);
  if (!(h.edges ?? []).length || !h.width || !h.height) return inner;
  const score = (r: { fail: number; cross: number }) => r.fail * 1000 + r.cross;
  const evalHost = () => {
    let best: ReturnType<typeof routeHostWith> | undefined;
    for (const m of MARGINS) {
      const r = routeHostWith(h, m);
      if (!best || score(r) < score(best)) best = r;
      if (!r.fail) break;
    }
    return best!;
  };
  let cur = evalHost();
  // Crossings usually come from the order of ports along one box side (the layout engine does not see the final wires):
  // try swapping two ports of the same side and keep a swap that removes crossings.
  if (cur.cross) {
    const used = new Set<string>();
    for (const e of h.edges ?? []) { used.add(e.sources[0]); used.add(e.targets[0]); }
    let budget = 30;
    const stop = performance.now() + SWAP_MS; // some crossings cannot be removed; do not search for them forever
    for (const n of [h, ...(h.children ?? [])]) {
      const ps = (n.ports ?? []).filter(p => used.has(p.id));
      for (let i = 0; i < ps.length && cur.cross && budget > 0; i++) for (let j = i + 1; j < ps.length && cur.cross && budget > 0 && performance.now() < stop; j++) {
        const a = ps[i], b = ps[j];
        const sameCol = Math.abs((a.x ?? 0) - (b.x ?? 0)) < 1, sameRow = Math.abs((a.y ?? 0) - (b.y ?? 0)) < 1;
        if (!sameCol && !sameRow) continue; // not on the same side
        if (sameCol && sameRow) continue;
        budget--;
        [a.x, b.x] = [b.x, a.x]; [a.y, b.y] = [b.y, a.y];
        const r = evalHost();
        if (score(r) < score(cur)) cur = r;
        else { [a.x, b.x] = [b.x, a.x]; [a.y, b.y] = [b.y, a.y]; }
      }
    }
  }
  cur.apply();
  return inner + cur.cross;
}

function routeHostWith(h: LNode, MARGIN: number): { fail: number; cross: number; apply: () => void } {
  const edges = h.edges ?? [];
  const noop = { fail: 0, cross: 0, apply: () => undefined };
  const W = h.width!, H = h.height!;
  const kids = new Map<string, LNode>();
  for (const c of h.children ?? []) kids.set(c.id, c);

  const endOf = (portId: string, stub: number): End | undefined => {
    const owner = portId.slice(0, portId.lastIndexOf(':'));
    const host = owner === h.id, node = host ? h : kids.get(owner);
    const p = node?.ports?.find(q => q.id === portId);
    if (!node || !p) return undefined;
    const bx = host ? 0 : node.x ?? 0, by = host ? 0 : node.y ?? 0, bw = node.width ?? 0, bh = node.height ?? 0;
    const cx = r2(bx + (p.x ?? 0) + (p.width ?? 6) / 2), cy = r2(by + (p.y ?? 0) + (p.height ?? 6) / 2);
    const dist = [Math.abs(cx - (bx + bw)), Math.abs(cx - bx), Math.abs(cy - (by + bh)), Math.abs(cy - by)]; // E W S N sides
    let out = 0;
    for (let k = 1; k < 4; k++) if (dist[k] < dist[out]) out = k;
    const leave = host ? OPP[out] : out; // a container's own port feeds inwards, a child's port leaves outwards
    const x0 = cx + DX[leave] * PORT, y0 = cy + DY[leave] * PORT;
    // a tight gap between boxes cannot hold the full stub: use the longest one that still ends in free space
    const clear = (x: number, y: number) => ![...kids.values()].some(c => x > (c.x ?? 0) - MARGIN && x < (c.x ?? 0) + (c.width ?? 0) + MARGIN && y > (c.y ?? 0) - MARGIN && y < (c.y ?? 0) + (c.height ?? 0) + MARGIN);
    const len = [stub, 12, 9, 6].find(l => l <= stub && clear(x0 + DX[leave] * l, y0 + DY[leave] * l)) ?? stub;
    return { x0, y0, x1: x0 + DX[leave] * len, y1: y0 + DY[leave] * len, leave, id: portId };
  };

  interface Job { e: LEdge; a: End; b: End; src: string; dst: string; len: number }
  const jobs: Job[] = [];
  for (const e of edges) {
    const a = endOf(e.sources[0], OUT), b = endOf(e.targets[0], STUB);
    if (a && b) jobs.push({ e, a, b, src: a.id, dst: b.id, len: Math.abs(a.x1 - b.x1) + Math.abs(a.y1 - b.y1) });
  }
  if (!jobs.length) return noop;

  // ---- grid ----
  let step = 6;
  while ((W / step) * (H / step) > MAX_NODES) step += 2;
  const xsSet = new Set<number>(), ysSet = new Set<number>();
  const q = r2;
  const clampX = (v: number) => q(Math.max(0, Math.min(W, v))), clampY = (v: number) => q(Math.max(0, Math.min(H, v)));
  for (let x = 0; x <= W; x += step) xsSet.add(q(x));
  for (let y = 0; y <= H; y += step) ysSet.add(q(y));
  xsSet.add(q(W)); ysSet.add(q(H));
  for (const j of jobs) for (const p of [j.a, j.b]) { xsSet.add(clampX(p.x1)); ysSet.add(clampY(p.y1)); }
  const boxes = [...kids.values()].map(c => ({
    x0: clampX((c.x ?? 0) - MARGIN), x1: clampX((c.x ?? 0) + (c.width ?? 0) + MARGIN),
    y0: clampY((c.y ?? 0) - MARGIN), y1: clampY((c.y ?? 0) + (c.height ?? 0) + MARGIN),
  }));
  for (const b of boxes) { xsSet.add(b.x0); xsSet.add(b.x1); ysSet.add(b.y0); ysSet.add(b.y1); }
  const xs = [...xsSet].sort((a, b) => a - b), ys = [...ysSet].sort((a, b) => a - b);
  const nx = xs.length, ny = ys.length;
  const xi = new Map(xs.map((v, i) => [v, i])), yi = new Map(ys.map((v, i) => [v, i]));
  const blockedN = new Uint8Array(nx * ny), blockedH = new Uint8Array(nx * ny), blockedV = new Uint8Array(nx * ny);
  for (const b of boxes) {
    const i0 = xi.get(b.x0)!, i1 = xi.get(b.x1)!, j0 = yi.get(b.y0)!, j1 = yi.get(b.y1)!;
    for (let j = j0 + 1; j < j1; j++) for (let i = i0 + 1; i < i1; i++) blockedN[j * nx + i] = 1;
    for (let j = j0 + 1; j < j1; j++) for (let i = i0; i < i1; i++) blockedH[j * nx + i] = 1;
    for (let j = j0; j < j1; j++) for (let i = i0 + 1; i < i1; i++) blockedV[j * nx + i] = 1;
  }

  // ---- occupancy of grid units and straight-through nodes ----
  const occ = new Map<number, number[]>();          // unit key -> job indices
  const passH = new Map<number, number[]>(), passV = new Map<number, number[]>(); // node -> jobs passing straight
  const unitKey = (i: number, j: number, axis: number) => (j * nx + i) * 2 + axis;
  const add = (m: Map<number, number[]>, k: number, v: number) => { const l = m.get(k); if (l) l.push(v); else m.set(k, [v]); };
  const del = (m: Map<number, number[]>, k: number, v: number) => { const l = m.get(k); if (l) { const n = l.indexOf(v); if (n >= 0) l.splice(n, 1); if (!l.length) m.delete(k); } };
  const related = (a: number, b: number) => jobs[a].src === jobs[b].src || jobs[a].dst === jobs[b].dst;
  const unitCost = (k: number, me: number): number => {
    let c = 0;
    const l = occ.get(k);
    if (l) for (const o of l) if (o !== me) c = Math.max(c, jobs[o].src === jobs[me].src ? SHARE : jobs[o].dst === jobs[me].dst ? MERGE : OVERLAP);
    // a lane a few px from a busy one reads as a doubled line: worse than sharing it exactly, or keeping clear
    const axis = k & 1, node = k >> 1, i = node % nx, j = (node - i) / nx;
    for (const d of [-1, 1]) { // every parallel grid line closer than NEAR px (several lines can lie within a few px)
      let hit = false;
      for (let t = 1; !hit; t++) {
        const ii = axis === 0 ? i : i + d * t, jj = axis === 0 ? j + d * t : j;
        if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) break;
        if ((axis === 0 ? Math.abs(ys[jj] - ys[j]) : Math.abs(xs[ii] - xs[i])) >= NEAR) break;
        const m = occ.get(unitKey(ii, jj, axis));
        if (m && m.some(o => o !== me)) hit = true;
      }
      if (hit) c += ADJ;
    }
    return c;
  };
  const crossCost = (n: number, axis: number, me: number): number => {
    const l = (axis === 0 ? passV : passH).get(n); if (!l) return 0;
    return l.some(o => o !== me && !related(o, me)) ? CROSS : 0;
  };

  // ---- A* ----
  const S = nx * ny * 4, g = new Float64Array(S).fill(Infinity), prev = new Int32Array(S), closed = new Uint8Array(S);
  let touched: number[] = [];
  const heapK: number[] = [], heapV: number[] = [];
  const push = (k: number, v: number) => {
    let i = heapK.length; heapK.push(k); heapV.push(v);
    while (i > 0) { const p = (i - 1) >> 1; if (heapK[p] <= k) break; heapK[i] = heapK[p]; heapV[i] = heapV[p]; i = p; }
    heapK[i] = k; heapV[i] = v;
  };
  const pop = (): number => {
    const top = heapV[0], k = heapK.pop()!, v = heapV.pop()!, n = heapK.length;
    if (n) {
      let i = 0;
      for (;;) { let c = 2 * i + 1; if (c >= n) break; if (c + 1 < n && heapK[c + 1] < heapK[c]) c++; if (heapK[c] >= k) break; heapK[i] = heapK[c]; heapV[i] = heapV[c]; i = c; }
      heapK[i] = k; heapV[i] = v;
    }
    return top;
  };

  const route = (me: number): Path | null => {
    const { a, b } = jobs[me];
    // Ports facing each other across a gap too small for two stubs (child port next to its container's own port):
    // a plain Z through the middle of the gap instead of a U-turn.
    const gap = (b.x0 - a.x0) * DX[a.leave] + (b.y0 - a.y0) * DY[a.leave];
    if (b.leave === OPP[a.leave] && gap >= 3 && gap < OUT + STUB + 2 * PORT) {
      const horiz = a.leave < 2, m = horiz ? (a.x0 + b.x0) / 2 : (a.y0 + b.y0) / 2;
      const pts: [number, number][] = horiz ? [[a.x0, a.y0], [m, a.y0], [m, b.y0], [b.x0, b.y0]] : [[a.x0, a.y0], [a.x0, m], [b.x0, m], [b.x0, b.y0]];
      return { units: [], gn: [], pts };
    }
    const si = xi.get(clampX(a.x1)), sj = yi.get(clampY(a.y1)), ei = xi.get(clampX(b.x1)), ej = yi.get(clampY(b.y1));
    if (si === undefined || sj === undefined || ei === undefined || ej === undefined) { if (process.env.BF_ROUTE_DEBUG) console.error('off grid', h.id, jobs[me].src, '->', jobs[me].dst); return null; }
    const need = OPP[b.leave], tx = xs[ei], ty = ys[ej];
    for (const t of touched) { g[t] = Infinity; closed[t] = 0; }
    touched = []; heapK.length = 0; heapV.length = 0;
    const s0 = (sj * nx + si) * 4 + a.leave;
    g[s0] = 0; prev[s0] = -1; touched.push(s0);
    push(Math.abs(xs[si] - tx) + Math.abs(ys[sj] - ty), s0);
    let goal = -1;
    while (heapK.length) {
      const s = pop(); if (closed[s]) continue; closed[s] = 1;
      const d = s & 3, node = s >> 2, i = node % nx, j = (node - i) / nx;
      if (i === ei && j === ej) {
        if (d === need) { goal = s; break; }
        const t = node * 4 + need, c = g[s] + BEND;
        if (c < g[t]) { g[t] = c; prev[t] = s; touched.push(t); push(c, t); }
        continue;
      }
      for (let nd = 0; nd < 4; nd++) {
        if (nd === OPP[d]) continue;
        const ni = i + DX[nd], nj = j + DY[nd];
        if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue;
        const nn = nj * nx + ni;
        const unit = nd === 0 ? blockedH[node] : nd === 1 ? blockedH[nn] : nd === 2 ? blockedV[node] : blockedV[nn];
        if (unit) continue;
        if (blockedN[nn] && !(ni === ei && nj === ej)) continue;
        const axis = nd < 2 ? 0 : 1;
        const uk = nd === 0 ? unitKey(i, j, 0) : nd === 1 ? unitKey(ni, nj, 0) : nd === 2 ? unitKey(i, j, 1) : unitKey(ni, nj, 1);
        const len = Math.abs(xs[ni] - xs[i]) + Math.abs(ys[nj] - ys[j]);
        const c = g[s] + len + (nd !== d ? BEND : 0) + unitCost(uk, me) + crossCost(nn, axis, me);
        const t = nn * 4 + nd;
        if (c < g[t]) { g[t] = c; prev[t] = s; touched.push(t); push(c + Math.abs(xs[ni] - tx) + Math.abs(ys[nj] - ty), t); }
      }
    }
    if (goal < 0) { if (process.env.BF_ROUTE_DEBUG) console.error('no route', h.id, jobs[me].src, '->', jobs[me].dst, [a.x1, a.y1], [b.x1, b.y1], 'blockedStart', blockedN[sj * nx + si], 'blockedEnd', blockedN[ej * nx + ei]); return null; }
    const seq: number[] = [];
    for (let s = goal; s >= 0; s = prev[s]) seq.push(s);
    seq.reverse();
    const units: number[] = [], gn: number[] = [sj * nx + si], pts: [number, number][] = [[a.x0, a.y0], [xs[si], ys[sj]]];
    for (let k = 1; k < seq.length; k++) {
      const n0 = seq[k - 1] >> 2, n1 = seq[k] >> 2;
      if (n0 === n1) continue;
      const i0 = n0 % nx, j0 = (n0 - i0) / nx, i1 = n1 % nx, j1 = (n1 - i1) / nx;
      units.push(j0 === j1 ? unitKey(Math.min(i0, i1), j0, 0) : unitKey(i0, Math.min(j0, j1), 1));
      gn.push(n1);
      pts.push([xs[i1], ys[j1]]);
    }
    pts.push([b.x0, b.y0]);
    return { units, gn, pts };
  };

  const paths: (Path | null)[] = jobs.map(() => null);
  const place = (me: number, p: Path) => {
    for (const u of p.units) add(occ, u, me);
    for (let k = 1; k + 1 < p.gn.length; k++) { // nodes the path runs straight through can be crossed by others
      const row = (n: number) => Math.floor(n / nx);
      const hIn = row(p.gn[k - 1]) === row(p.gn[k]), hOut = row(p.gn[k]) === row(p.gn[k + 1]);
      if (hIn === hOut) add(hIn ? passH : passV, p.gn[k], me);
    }
  };
  const unplace = (me: number, p: Path) => {
    for (const u of p.units) del(occ, u, me);
    for (const m of [passH, passV]) for (const [k, l] of m) if (l.includes(me)) del(m, k, me);
  };

  // the straight stub in front of every port is reserved for its own connectors: others must keep clear (they pay the overlap and adjacency costs)
  jobs.forEach((jb, me) => { for (const e of [jb.a, jb.b]) {
    if (e.leave < 2) {
      const j = yi.get(clampY(e.y1)), lo = Math.min(e.x0, e.x1) - 0.01, hi = Math.max(e.x0, e.x1) + 0.01;
      if (j !== undefined) for (let i = 0; i + 1 < nx; i++) if (xs[i] >= lo && xs[i + 1] <= hi) add(occ, unitKey(i, j, 0), me);
    } else {
      const i = xi.get(clampX(e.x1)), lo = Math.min(e.y0, e.y1) - 0.01, hi = Math.max(e.y0, e.y1) + 0.01;
      if (i !== undefined) for (let j = 0; j + 1 < ny; j++) if (ys[j] >= lo && ys[j + 1] <= hi) add(occ, unitKey(i, j, 1), me);
    }
  } });

  const order = jobs.map((_, i) => i).sort((p, q) => jobs[p].len - jobs[q].len);
  for (const me of order) { const p = route(me); paths[me] = p; if (p) place(me, p); }
  if (jobs.length <= 60) for (const me of order) { // rip up and reroute with everything else in place
    const old = paths[me]; if (old) unplace(me, old);
    const p = route(me) ?? old; paths[me] = p; if (p) place(me, p);
  }

  const fail = paths.filter(p => !p).length;
  let cross = 0; // proper crossings between wires that share neither end
  for (let a = 0; a < jobs.length; a++) for (let b = a + 1; b < jobs.length; b++) {
    const pa = paths[a], pb = paths[b]; if (!pa || !pb || jobs[a].src === jobs[b].src || jobs[a].dst === jobs[b].dst) continue;
    const A = simplify(pa.pts), B = simplify(pb.pts);
    for (let i = 0; i + 1 < A.length; i++) for (let k = 0; k + 1 < B.length; k++) {
      const [p0, p1, q0, q1] = [A[i], A[i + 1], B[k], B[k + 1]];
      const ph = Math.abs(p0[1] - p1[1]) < 0.01, qh = Math.abs(q0[1] - q1[1]) < 0.01;
      if (ph === qh) continue;
      const [hs, he, vs, ve] = ph ? [p0, p1, q0, q1] : [q0, q1, p0, p1];
      if (vs[0] > Math.min(hs[0], he[0]) + 0.5 && vs[0] < Math.max(hs[0], he[0]) - 0.5 && hs[1] > Math.min(vs[1], ve[1]) + 0.5 && hs[1] < Math.max(vs[1], ve[1]) - 0.5) cross++;
    }
  }
  const apply = () => { for (let m = 0; m < jobs.length; m++) {
    const p = paths[m]; if (!p) continue; // keep the layout engine's route when no clear path exists
    const pts = simplify(p.pts);
    if (pts.length < 2) continue;
    const P = (v: [number, number]) => ({ x: v[0], y: v[1] });
    jobs[m].e.sections = [{ startPoint: P(pts[0]), endPoint: P(pts[pts.length - 1]), bendPoints: pts.slice(1, -1).map(P) }];
  } };
  return { fail, cross, apply };
}
