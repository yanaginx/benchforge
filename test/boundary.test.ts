import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadModelText } from '../src/core/check.ts';
import { applyOps } from '../src/core/edit.ts';

const base = fs.readFileSync(new URL('../examples/axi.yaml', import.meta.url), 'utf8');
const ports = (text: string, path: string) => {
  const { index } = loadModelText(text);
  return index.get(path)!.ports;
};

test('a direct connection across containers is rejected and names the containers to pass through', () => {
  const bad = base.replace('from: tb.sub_env.agent:ap_out, to: tb.sub_env:ap_out', 'from: tb.sub_env.agent.mon:ap, to: tb.sb:m_imp');
  const r = loadModelText(bad);
  const d = r.diags.find(x => x.code === 'boundary')!;
  assert.ok(d, 'expected a boundary diag');
  assert.ok(d.options!.includes('tb.sub_env.agent') && d.options!.includes('tb.sub_env'));
});

test('wire across containers writes boundary ports and hops; fan-out reuses them', () => {
  const r1 = applyOps(base, [{ op: 'wire', from: 'tb.sub_env.agent.mon:ap', to: 'tb.cov:analysis_export' }]);
  assert.ok(r1.ok, JSON.stringify(r1.diags));
  const conns = loadModelText(r1.text).model.connections!.map(c => `${c.from}>${c.to}`);
  assert.ok(conns.includes('tb.sub_env:ap_out>tb.cov:analysis_export'));
  // the existing forward ports are reused, no ap_out2 appears
  assert.ok(!ports(r1.text, 'tb.sub_env').some(p => p.name === 'ap_out2'));
  assert.ok(ports(r1.text, 'tb.sub_env').find(p => p.name === 'ap_out')!.boundary);
});

test('wiring into a nested container declares an in-port chain with an export kind', () => {
  const r = applyOps(base, [{ op: 'wire', from: 'tb.m_agent.mon:ap', to: 'tb.sub_env.sb:imp' }]);
  assert.ok(r.ok, JSON.stringify(r.diags));
  const p = ports(r.text, 'tb.sub_env').find(x => x.boundary && x.dir === 'in')!;
  assert.equal(p.kind, 'analysis_export');
  const conns = loadModelText(r.text).model.connections!.map(c => `${c.from}>${c.to}`);
  assert.ok(conns.includes(`tb.sub_env:${p.name}>tb.sub_env.sb:imp`));
});

test('unwire of one hop removes the whole forwarded chain and its boundary ports', () => {
  const r0 = applyOps(base, [{ op: 'wire', from: 'tb.m_agent.mon:ap', to: 'tb.sub_env.sb:imp' }]);
  const r = applyOps(r0.text, [{ op: 'unwire', from: 'tb.m_agent:ap_out', to: 'tb.sub_env:imp_in' }]);
  assert.ok(r.ok, JSON.stringify(r.diags));
  assert.ok(!ports(r.text, 'tb.sub_env').some(p => p.dir === 'in' && p.boundary));
  // the original forwards that other connections still use survive
  assert.ok(ports(r.text, 'tb.m_agent').some(p => p.name === 'ap_out'));
});
