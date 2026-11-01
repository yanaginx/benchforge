import ELK from 'elkjs/lib/elk.bundled.js';
import fs from 'node:fs';

// Palette + roles from diagram-design style-guide (light skin). Flat only: no shadow/gradient/blur.
const C = {
  paper: '#f5f5f5', ink: '#2d3142', muted: '#4f5d75', soft: '#5a6580',
  rule: '#bfc0c0', accent: '#bf4520', accentTint: 'rgba(191,69,32,0.08)',
};
const FONT = `ui-monospace,SFMono-Regular,Menlo,Consolas,monospace`;
const CW = 6.6; // approx glyph width at 11px mono
const textW = s => Math.ceil(s.length * CW);

const elk = new ELK();
let id = 0;
const PAD = '[top=28,left=12,bottom=12,right=12]';
const cont = { 'elk.padding': PAD, 'elk.algorithm': 'layered', 'elk.direction': 'DOWN',
  'elk.aspectRatio': '1.6', 'elk.layered.wrapping.strategy': 'MULTI_EDGE',
  'elk.layered.wrapping.correctionFactor': '1.0', 'elk.spacing.nodeNode': '14',
  'elk.layered.spacing.nodeNodeBetweenLayers': '24' };

const leaf = (nid, kind, text, h = 28, ports = []) => ({
  id: nid, kind, labels: [{ text }], width: Math.max(64, textW(text) + 20), height: h, ports,
});
const agent = n => ({ id: n, kind: 'agent', labels: [{ text: n.split('.').pop() + ' [agent]' }],
  layoutOptions: { ...cont, 'elk.direction': 'RIGHT', 'elk.layered.wrapping.strategy': 'OFF' },
  children: ['sqr', 'drv', 'mon'].map(k => leaf(`${n}.${k}`, k, k)),
  ports: [{ id: `${n}.ap`, width: 6, height: 6, layoutOptions: { 'port.side': 'EAST' } }],
  edges: [{ id: `e${id++}`, sources: [`${n}.sqr`], targets: [`${n}.drv`], kind: 'seq' },
          { id: `e${id++}`, sources: [`${n}.mon`], targets: [`${n}.ap`], kind: 'tlm' }] });
const MAXLVL = 3;
const countDesc = (d, na) => d <= 0 ? 0 : 1 + (3 * na + 1 + na) + 2 * countDesc(d - 1, na);
const env = (n, d, na, lvl = 1) => {
  const name = n.split('.').pop();
  const subs = d > 1 ? [0, 1].map(i => lvl >= MAXLVL
    ? { id: `${n}.sub${i}`, kind: 'collapsed', labels: [{ text: `sub${i} [env] +${countDesc(d - 1, na)}` }], width: 150, height: 32 }
    : env(`${n}.sub${i}`, d - 1, na, lvl + 1)) : [];
  return { id: n, kind: 'env', labels: [{ text: name + ' [env]' }], layoutOptions: cont,
    children: [...Array.from({ length: na }, (_, i) => agent(`${n}.ag${i}`)),
      leaf(`${n}.sb`, 'sb', 'sb [scoreboard]', 40,
        Array.from({ length: na }, (_, i) => ({ id: `${n}.sb.imp${i}`, width: 6, height: 6, layoutOptions: { 'port.side': 'WEST' } }))),
      ...(subs.length ? [{ id: `${n}.row`, kind: 'row', children: subs,
        layoutOptions: { 'elk.algorithm': 'rectpacking', 'elk.aspectRatio': lvl >= MAXLVL ? '8' : '1.6', 'elk.padding': '[top=0,left=0,bottom=0,right=0]', 'elk.spacing.nodeNode': '14' } }] : [])],
    edges: Array.from({ length: na }, (_, i) => ({ id: `e${id++}`, sources: [`${n}.ag${i}.ap`], targets: [`${n}.sb.imp${i}`], kind: 'tlm' })) };
};

const root = env('top', 4, 3);
root.layoutOptions = { ...cont, 'elk.hierarchyHandling': 'SEPARATE_CHILDREN' };
const t = performance.now();
const r = await elk.layout(root);
console.log('layout ms', (performance.now() - t).toFixed(0), 'size', r.width.toFixed(0), r.height.toFixed(0), 'ratio', (r.width / r.height).toFixed(2));

// Container style by kind. Depth = stroke/fill step (outer faint -> inner stronger).
const style = {
  env:   { fill: 'rgba(45,49,66,0.02)', stroke: C.rule, rx: 8 },
  agent: { fill: 'rgba(45,49,66,0.04)', stroke: C.muted, rx: 6 },
  sb:    { fill: C.accentTint, stroke: C.accent, rx: 4 },   // the 1 focal kind
  collapsed: { fill: C.paper, stroke: C.muted, rx: 6, dash: '4 3' },
  sqr:   { fill: C.paper, stroke: C.ink, rx: 4 },
  drv:   { fill: C.paper, stroke: C.ink, rx: 4 },
  mon:   { fill: C.paper, stroke: C.ink, rx: 4 },
};
const out = [];
const walk = (n, ox, oy, top) => {
  const x = ox + (n.x || 0), y = oy + (n.y || 0);
  if (!top) {
    const s = style[n.kind] || style.sqr, l = n.labels?.[0]?.text, box = !!n.children;
    if (n.kind === 'row') { for (const c of n.children || []) walk(c, x, y); return; }
    out.push(`<rect data-k="${n.kind}" x="${x}" y="${y}" width="${n.width}" height="${n.height}" rx="${s.rx}" fill="${s.fill}" stroke="${s.stroke}" stroke-width="1"${s.dash ? ` stroke-dasharray="${s.dash}"` : ""}/>`);
    if (l) {
      if (box) out.push(`<text x="${x + 10}" y="${y + 16}" font-size="9" letter-spacing="1.3" font-family="${FONT}" fill="${C.soft}">${l.toUpperCase()}</text>`);
      else out.push(`<text x="${x + n.width / 2}" y="${y + n.height / 2 + 4}" font-size="11" text-anchor="middle" font-family="${FONT}" fill="${n.kind === 'sb' ? C.accent : C.ink}">${l}</text>`);
    }
    for (const p of n.ports || []) out.push(`<rect x="${x + p.x}" y="${y + p.y}" width="${p.width}" height="${p.height}" fill="${C.ink}"><title>${p.id.split('.').pop().replace(/\d+$/, '')}</title></rect>`);
  }
  for (const c of n.children || []) walk(c, top ? 0 : x, top ? 0 : y);
};
walk(r, 0, 0, true);

const edgeOut = (n, ox, oy) => {
  for (const e of n.edges || []) for (const s of e.sections || []) {
    const pts = [s.startPoint, ...(s.bendPoints || []), s.endPoint].map(p => `${ox + p.x},${oy + p.y}`);
    const tlm = e.kind === 'tlm';
    out.push(`<polyline points="${pts.join(' ')}" fill="none" stroke="${tlm ? C.ink : C.muted}" stroke-width="${tlm ? 1.2 : 1}" ${tlm ? '' : 'stroke-dasharray="4 3"'} marker-end="url(#a)"/>`);
  }
  for (const c of n.children || []) edgeOut(c, ox + (c.x || 0), oy + (c.y || 0));
};
edgeOut(r, 0, 0);

const W = r.width + 24, H = r.height + 24;
const defs = `<defs><marker id="a" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z" fill="${C.ink}"/></marker></defs>`;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="-12 -12 ${W} ${H}">${defs}<rect x="-12" y="-12" width="${W}" height="${H}" fill="${C.paper}"/>${out.join('')}</svg>`;
fs.writeFileSync('out.svg', svg);

// Feel test. Simulates fixed input->pixel RTT: every key/button action is applied after DELAY ms.
fs.writeFileSync('feel.html', `<!doctype html><meta charset=utf-8><title>feel test</title>
<body style="margin:0;background:${C.paper};font:12px ${FONT};color:${C.ink}">
<div id=bar style="position:fixed;top:0;left:0;right:0;background:#ff0;padding:3px 6px">
 <button data-a=in>+</button> <button data-a=out>-</button> <button data-a=col>recolor</button> <button data-a=re>rerender</button> <button data-a=dly>delay: <span id=dv>200</span>ms</button>
 <span id=hud>click page first, then keys: + - zoom | c recolor | r rerender | d toggle delay (0/200) | arrows scroll</span></div>
<div id=v style="padding-top:34px">${svg}</div>
<script>
let z=1,flip=0,DELAY=200;
const v=document.getElementById('v'),hud=document.getElementById('hud');
const cur=()=>v.querySelector('svg');
const W0=+cur().getAttribute('width'),H0=+cur().getAttribute('height');
const acts={
 in(){z*=1.25;const s=cur();s.setAttribute('width',W0*z);s.setAttribute('height',H0*z)},
 out(){z/=1.25;const s=cur();s.setAttribute('width',W0*z);s.setAttribute('height',H0*z)},
 col(){flip^=1;cur().querySelectorAll('rect[data-k=env],rect[data-k=agent]').forEach(r=>r.setAttribute('fill',flip?'rgba(191,69,32,0.18)':'rgba(45,49,66,0.03)'))},
 re(){const h=cur().outerHTML;v.innerHTML=h},
 dly(){DELAY=DELAY?0:200;document.getElementById('dv').textContent=DELAY}
};
function fire(a){const t0=performance.now();
 setTimeout(()=>{const t1=performance.now();acts[a]();
  hud.textContent='"'+a+'" delay '+DELAY+'ms | handler '+(performance.now()-t1).toFixed(1)+'ms | key->applied '+(performance.now()-t0).toFixed(0)+'ms'},DELAY)}
const map={'+':'in','=':'in','-':'out','_':'out',c:'col',r:'re',d:'dly'};
addEventListener('keydown',e=>{
 const a=map[e.key]||({Equal:'in',Minus:'out',NumpadAdd:'in',NumpadSubtract:'out'})[e.code];
 if(a){e.preventDefault();a=='dly'?acts.dly():fire(a)} else hud.textContent='key not mapped: key='+e.key+' code='+e.code});
document.getElementById('bar').addEventListener('click',e=>{const a=e.target.dataset&&e.target.dataset.a;if(a)a=='dly'?acts.dly():fire(a)});
</script>`);
