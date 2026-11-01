import type { LNode } from './layout.ts';

// Flat Notion-like palette: white page, warm greys, one orange for the focal box.
const C = {
  paper: '#ffffff', ink: '#37352f', muted: '#787774', soft: '#9b9a97',
  rule: '#dfdedb', accent: '#d9730d', accentTint: '#fbf3db', box: '#f7f6f3', boxNested: '#fbfbfa', edge: '#787774',
};
// One color per connection (index modulo 8); the page repeats these in CSS for the highlight.
export const PALETTE = ['#d9730d', '#0f9d58', '#9065b0', '#c14c8a', '#0b8a8f', '#e03e3e', '#8a6d3b', '#2383e2'];
// Thin role stripe on leaf boxes: pure fill, no extra cost beyond one rect.
const ROLE: Record<string, string> = { driver: '#2383e2', sequencer: '#9065b0', monitor: '#0f9d58', scoreboard: '#d9730d', subscriber: '#0b8a8f', predictor: '#c14c8a' };
const HEAD = 14; // straight run an arrowhead needs before the line may start to curve
const HOP = 4;   // radius of the little bridge a wire makes where it crosses another
type Pt = { x: number; y: number };
// Orthogonal polyline as a path whose bends are rounded by radius r (clamped to half of each adjacent segment).
// hops: segment index -> x positions where a horizontal run bridges over a crossing vertical wire.
function rounded(pts: Pt[], r = 5, arrow = true, hops?: Map<number, number[]>): string {
  const run = (a: Pt, b: Pt, seg: number): string => {
    const hs = hops?.get(seg); if (!hs || Math.abs(a.y - b.y) > 0.01) return `L${b.x},${b.y}`;
    const east = b.x > a.x, lo = Math.min(a.x, b.x) + HOP + 1, hi = Math.max(a.x, b.x) - HOP - 1;
    let d = '';
    for (const x of [...hs].sort((p, q) => east ? p - q : q - p)) if (x > lo && x < hi) d += `L${x - (east ? HOP : -HOP)},${a.y}A${HOP},${HOP} 0 0 ${east ? 1 : 0} ${x + (east ? HOP : -HOP)},${a.y}`;
    return d + `L${b.x},${b.y}`;
  };
  let d = `M${pts[0].x},${pts[0].y}`, cur = pts[0];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1], b = pts[i], c = pts[i + 1];
    const l1 = Math.hypot(b.x - a.x, b.y - a.y), l2 = Math.hypot(c.x - b.x, c.y - b.y);
    const last = i === pts.length - 2, k = Math.min(r, l1 / 2, last && arrow ? l2 - HEAD : l2 / 2);
    if (k < 1) { d += run(cur, b, i - 1); cur = b; continue; }
    const p1 = { x: b.x + (a.x - b.x) / l1 * k, y: b.y + (a.y - b.y) / l1 * k };
    const p2 = { x: b.x + (c.x - b.x) / l2 * k, y: b.y + (c.y - b.y) / l2 * k };
    d += run(cur, p1, i - 1) + `Q${b.x},${b.y} ${p2.x},${p2.y}`; cur = p2;
  }
  return d + run(cur, pts[pts.length - 1], pts.length - 2);
}
const FONT = 'ui-sans-serif,-apple-system,"Segoe UI",Helvetica,Arial,sans-serif';
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function renderSvg(laid: { width: number; height: number; children: LNode[] }): string {
  const out: string[] = [];
  const walk = (n: LNode, ox: number, oy: number) => {
    const x = ox + (n.x ?? 0), y = oy + (n.y ?? 0), w = n.width!, h = n.height!;
    const box = !!n.children && !n.collapsed;
    let fill = C.paper, stroke = C.rule, rx = 5, dash = '';
    if (box) { fill = n.nested ? C.boxNested : C.box; stroke = C.rule; rx = 8; }
    else if (n.collapsed) { fill = C.box; stroke = C.soft; rx = 6; dash = ' stroke-dasharray="4 3"'; }
    else if (n.focal) { fill = C.accentTint; stroke = C.accent; }
    out.push(`<rect data-p="${esc(n.id)}" x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" stroke="${stroke}"${dash}/>`);
    if (!box && !n.collapsed && ROLE[n.type]) out.push(`<rect x="${x + 1}" y="${y + 6}" width="3" height="${h - 12}" rx="1.5" fill="${ROLE[n.type]}"/>`);
    if (box) out.push(`<text x="${x + 10}" y="${y + 17}" font-size="11" font-family="${FONT}" fill="${C.ink}" font-weight="600">${esc(n.name)}<tspan fill="${C.soft}" font-weight="400" dx="6" font-size="10">${esc(n.type)}</tspan></text>`);
    else {
      const col = n.focal ? C.accent : C.ink;
      out.push(`<text x="${x + w / 2}" y="${y + h / 2 - 1}" font-size="12" text-anchor="middle" font-family="${FONT}" fill="${col}">${esc(n.name)}</text>`);
      out.push(`<text x="${x + w / 2}" y="${y + h / 2 + 12}" font-size="10" text-anchor="middle" font-family="${FONT}" fill="${C.soft}">${esc(n.collapsed ? `${n.type} ${n.extra}` : n.type)}</text>`);
    }
    for (const p of n.ports ?? []) {
      out.push(`<rect x="${x + p.x!}" y="${y + p.y!}" width="${p.width}" height="${p.height}" rx="1" fill="${p.model?.dir === 'in' ? C.paper : C.ink}" stroke="${p.model?.dir === 'in' ? C.ink : 'none'}" stroke-width="1"${p.model ? ` data-pv="${esc(p.model.path + ':' + p.model.name)}"` : ''}><title>${esc(p.title)}</title></rect>`);
      // larger invisible hit target for mouse wiring; only for ports declared in the model
      if (p.model) out.push(`<rect data-port="${esc(p.model.path + ':' + p.model.name)}" data-dir="${p.model.dir}" data-kind="${esc(p.model.kind)}" data-pt="${esc(p.model.pt)}" x="${x + p.x! - 4}" y="${y + p.y! - 4}" width="${p.width + 8}" height="${p.height + 8}" fill="${C.accent}" fill-opacity="0" stroke="none" pointer-events="all"><title>${esc(p.title)}</title></rect>`);
    }
    for (const c of n.children ?? []) walk(c, x, y);
  };
  // wires: collect absolute polylines first, so crossings (bridges) and joins (dots) can be found across containers
  const wires: { conn: number; kind: string; head: boolean; pts: Pt[] }[] = [];
  const edges = (n: LNode, ox: number, oy: number) => {
    for (const e of n.edges ?? []) for (const s of e.sections ?? [])
      wires.push({ conn: e.conn, kind: e.kind, head: e.head !== false, pts: [s.startPoint, ...(s.bendPoints ?? []), s.endPoint].map(p => ({ x: ox + p.x, y: oy + p.y })) });
    for (const c of n.children ?? []) edges(c, ox + (c.x ?? 0), oy + (c.y ?? 0));
  };
  for (const c of laid.children) walk(c, 0, 0);
  for (const c of laid.children) edges(c, c.x ?? 0, c.y ?? 0);
  const hops = wires.map(() => new Map<number, number[]>()), over = wires.map(() => new Set<number>()), dots: { x: number; y: number; cs: number[] }[] = [];
  const horiz = (a: Pt, b: Pt) => Math.abs(a.y - b.y) < 0.01;
  wires.forEach((w, wi) => w.pts.slice(0, -1).forEach((a, si) => {
    const b = w.pts[si + 1]; if (!horiz(a, b)) return;
    const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
    wires.forEach((v, vi) => { if (v.conn === w.conn) return; v.pts.slice(0, -1).forEach((c, vs) => {
      const d = v.pts[vs + 1]; if (horiz(c, d)) return;
      const y0 = Math.min(c.y, d.y), y1 = Math.max(c.y, d.y);
      if (c.x > x0 + HOP + 1 && c.x < x1 - HOP - 1 && a.y > y0 + 1 && a.y < y1 - 1) {
        const l = hops[wi].get(si) ?? []; if (!l.some(x => Math.abs(x - c.x) < 2 * HOP + 2)) { l.push(c.x); hops[wi].set(si, l); over[wi].add(v.conn); }
      }
    }); });
  }));
  // a wire that bends or ends on the side of another one (several outputs into one input, or one output fanning out) gets a dot
  wires.forEach((w, wi) => w.pts.forEach((p, pi) => {
    if (pi === 0 || pi === w.pts.length - 1) return;
    for (const v of wires) { if (v.conn === w.conn) continue; for (let vs = 0; vs + 1 < v.pts.length; vs++) {
      const c = v.pts[vs], d = v.pts[vs + 1], h = horiz(c, d);
      const on = h ? Math.abs(p.y - c.y) < 0.5 && p.x > Math.min(c.x, d.x) + 1 && p.x < Math.max(c.x, d.x) - 1 : Math.abs(p.x - c.x) < 0.5 && p.y > Math.min(c.y, d.y) + 1 && p.y < Math.max(c.y, d.y) - 1;
      if (on && !dots.some(q => Math.hypot(q.x - p.x, q.y - p.y) < 1)) dots.push({ x: p.x, y: p.y, cs: [w.conn, v.conn] });
    } }
  }));
  wires.forEach((w, wi) => {
    const seq = w.kind === 'seq_item_port';
    out.push(`<path class="w" d="${rounded(w.pts, 5, w.head, hops[wi])}" data-c="${w.conn}"${over[wi].size ? ` data-hop="${[...over[wi]].join(' ')}"` : ''} fill="none" stroke="${C.edge}" stroke-width="1.4" stroke-linejoin="round"${seq ? ' stroke-dasharray="4 3"' : ''} ${w.head ? ' marker-end="url(#a)"' : ' data-nh="1"'}/>`);
  });
  for (const p of dots) out.push(`<circle data-c="${p.cs.join(' ')}" cx="${p.x}" cy="${p.y}" r="2.6" fill="${C.edge}"/>`);
  const W = laid.width + 24, H = laid.height + 24;
  const defs = `<defs><marker id="a" viewBox="0 0 8 8" refX="7" refY="4" markerUnits="userSpaceOnUse" markerWidth="9" markerHeight="9" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z" fill="${C.edge}"/></marker>${PALETTE.map((c, i) => `<marker id="ah${i}" viewBox="0 0 8 8" refX="7" refY="4" markerUnits="userSpaceOnUse" markerWidth="9" markerHeight="9" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z" fill="${c}"/></marker>`).join('')}</defs>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="-12 -12 ${W} ${H}">${defs}<rect x="-12" y="-12" width="${W}" height="${H}" fill="${C.paper}"/>${out.join('')}</svg>\n`;
}
