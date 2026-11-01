import ELK from 'elkjs/lib/elk.bundled.js';

const elk = new ELK();
let id = 0;
const edges = [];

// env > N agents (drv/mon/sqr) + scoreboards; monitor.ap -> sb imps; nested sub-envs
function agent(name) {
  const a = `${name}`;
  return {
    id: a, labels: [{ text: a }],
    layoutOptions: { 'elk.padding': '[top=24,left=10,bottom=10,right=10]' },
    children: ['drv', 'mon', 'sqr'].map(k => ({
      id: `${a}.${k}`, width: 70, height: 30, labels: [{ text: k }],
      ports: k === 'mon' ? [{ id: `${a}.mon.ap`, width: 6, height: 6, layoutOptions: { 'port.side': 'EAST' } }] : [],
    })),
    edges: [{ id: `e${id++}`, sources: [`${a}.sqr`], targets: [`${a}.drv`] }],
  };
}

function env(name, depth, nAgents) {
  const sb = {
    id: `${name}.sb`, width: 90, height: 40, labels: [{ text: 'sb' }],
    ports: Array.from({ length: nAgents }, (_, i) => ({
      id: `${name}.sb.imp${i}`, width: 6, height: 6, layoutOptions: { 'port.side': 'WEST' },
    })),
  };
  const agents = Array.from({ length: nAgents }, (_, i) => agent(`${name}.ag${i}`));
  const subs = depth > 1 ? [env(`${name}.sub0`, depth - 1, nAgents), env(`${name}.sub1`, depth - 1, nAgents)] : [];
  const e = {
    id: name, labels: [{ text: name }],
    layoutOptions: { 'elk.padding': '[top=24,left=10,bottom=10,right=10]' },
    children: [...agents, sb, ...subs],
    edges: agents.map((a, i) => ({
      id: `e${id++}`, sources: [`${a.id}.mon.ap`], targets: [`${name}.sb.imp${i}`],
    })),
  };
  return e;
}

function count(n) { return 1 + (n.children || []).reduce((s, c) => s + count(c), 0); }

for (const [depth, agents] of [[2, 3], [3, 3], [3, 4], [4, 3]]) {
  const root = env('top', depth, agents);
  root.layoutOptions = {
    'elk.algorithm': 'layered', 'elk.direction': 'RIGHT',
    'elk.hierarchyHandling': 'INCLUDE_CHILDREN', 'elk.padding': '[top=24,left=10,bottom=10,right=10]',
    'elk.spacing.nodeNode': '12', 'elk.layered.spacing.nodeNodeBetweenLayers': '20',
  };
  const t0 = performance.now();
  const r = await elk.layout(root);
  const t1 = performance.now();
  const r2 = await elk.layout(structuredClone(root));
  const t2 = performance.now();
  console.log(`depth=${depth} agents=${agents} nodes=${count(root)} cold=${(t1 - t0).toFixed(0)}ms warm=${(t2 - t1).toFixed(0)}ms size=${r.width.toFixed(0)}x${r.height.toFixed(0)}`);
}
