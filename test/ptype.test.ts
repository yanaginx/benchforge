import test from 'node:test';
import assert from 'node:assert/strict';
import { loadModelText } from '../src/core/check.ts';
import { applyOps } from '../src/core/edit.ts';
import { generate } from '../src/gen/index.ts';

const mk = (pt1: string, pt2: string, extra = '') => `
project: p
objects: [{ name: foo_txn }, { name: bar_txn }]
root:
  name: top
  type: env
  children:
    - { name: m, type: monitor, ports: [{ name: ap, kind: analysis_port, dir: out${pt1} }] }
    - name: sb
      type: scoreboard
      ports: [{ name: imp, kind: analysis_imp, dir: in${pt2} }]
connections:
  - { from: "top.m:ap", to: "top.sb:imp" }
${extra}`;

test('same explicit type connects; omitted equals uvm_object', () => {
  assert.deepEqual(loadModelText(mk(', ptype: foo_txn', ', ptype: foo_txn')).errors, []);
  assert.deepEqual(loadModelText(mk('', ', ptype: uvm_object')).errors, []);
  assert.ok(loadModelText(mk('', ', ptype: p_item')).diags.some(x => x.code === 'ptype_mismatch'));
});
test('different parameter types are rejected', () => {
  const { diags } = loadModelText(mk(', ptype: foo_txn', ', ptype: bar_txn'));
  const d = diags.find(x => x.code === 'ptype_mismatch');
  assert.ok(d && d.message.includes('foo_txn') && d.message.includes('bar_txn'));
});
test('explicit type vs default item mismatch', () => {
  assert.ok(loadModelText(mk(', ptype: foo_txn', '')).diags.some(x => x.code === 'ptype_mismatch'));
});
test('kind decides direction', () => {
  const t = (kind: string, dir: string) => loadModelText(`project: p\nroot: { name: top, type: env, ports: [{ name: x, kind: ${kind}, dir: ${dir} }] }\n`);
  assert.ok(t('analysis_port', 'in').diags.some(d => d.code === 'kind_direction'));
  assert.ok(t('analysis_export', 'out').diags.some(d => d.code === 'kind_direction'));
  assert.ok(t('tlm_b_initiator_socket', 'in').diags.some(d => d.code === 'kind_direction'));
  assert.ok(t('tlm_b_target_socket', 'out').diags.some(d => d.code === 'kind_direction'));
  assert.deepEqual(t('tlm_b_target_socket', 'in').errors, []);
  assert.ok(t('bogus_port', 'out').diags.some(d => d.code === 'unknown_kind'));
});
test('too many types on a one-parameter kind', () => {
  const { diags } = loadModelText(`project: p\nroot: { name: top, type: env, ports: [{ name: x, kind: analysis_port, dir: out, ptype: "a, b" }] }\n`);
  assert.ok(diags.some(d => d.code === 'bad_ptype'));
});
test('transport takes request,response; single type means both', () => {
  const y = (a: string, b: string) => `project: p
objects: [{ name: rq }, { name: rs }]
root:
  name: top
  type: env
  children:
    - { name: a, type: component, ports: [{ name: o, kind: blocking_transport_port, dir: out, ptype: "${a}" }] }
    - { name: b, type: component, ports: [{ name: i, kind: blocking_transport_imp, dir: in, ptype: "${b}" }] }
connections: [{ from: "top.a:o", to: "top.b:i" }]
`;
  assert.deepEqual(loadModelText(y('rq', 'rq, rq')).errors, []);
  assert.ok(loadModelText(y('rq', 'rq, rs')).diags.some(d => d.code === 'ptype_mismatch'));
});
test('wire refuses mismatched types across containers and forwards the type', () => {
  const src = `project: p
objects: [{ name: foo }, { name: bar }]
root:
  name: top
  type: env
  children:
    - name: a
      type: agent
      children: [{ name: m, type: monitor, ports: [{ name: ap, kind: analysis_port, dir: out, ptype: foo }] }]
    - name: e
      type: env
      children: [{ name: sb, type: scoreboard, ports: [{ name: imp, kind: analysis_imp, dir: in, ptype: __T__ }] }]
`;
  const bad = applyOps(src.replace('__T__', 'bar'), [{ op: 'wire', from: 'top.a.m:ap', to: 'top.e.sb:imp' }]);
  assert.equal(bad.ok, false);
  const ok = applyOps(src.replace('__T__', 'foo'), [{ op: 'wire', from: 'top.a.m:ap', to: 'top.e.sb:imp' }]);
  assert.equal(ok.ok, true);
  assert.ok(ok.ok && ok.text.includes('ptype: foo, boundary: true'));
});
test('codegen parameterizes ports with their type', () => {
  const l = loadModelText(mk(', ptype: foo_txn', ', ptype: foo_txn'));
  const files = generate(l.model, l.index);
  const all = files.map(f => f.content).join('\n');
  assert.ok(all.includes('uvm_analysis_port #(foo_txn) ap;'));
  assert.ok(all.includes('write_p_top_sb_imp(foo_txn t)'));
});
test('dir may be omitted: the kind decides it; port-add and wire write no dir', () => {
  const src = `project: p
root:
  name: top
  type: env
  children:
    - { name: m, type: monitor }
    - { name: sb, type: scoreboard, ports: [{ name: imp, kind: analysis_imp }] }
`;
  const r = applyOps(src, [{ op: 'port-add', path: 'top.m', port: { name: 'ap2', kind: 'analysis_port' } }, { op: 'wire', from: 'top.m:ap2', to: 'top.sb:imp' }]);
  assert.ok(r.ok, JSON.stringify(r.diags));
  assert.ok(!r.text.includes('dir:'));
  const l = loadModelText(r.text);
  assert.deepEqual(l.errors, []);
  assert.equal(l.index.get('top.sb')!.ports[0].dir, 'in');
});

test('ptype must be a declared object; obj-add / obj-rm and codegen', () => {
  const src = `project: p\nroot: { name: top, type: env, ports: [{ name: x, kind: analysis_port, ptype: my_obj }] }\n`;
  const bad = loadModelText(src);
  const d = bad.diags.find(x => x.code === 'unknown_ptype');
  assert.ok(d && d.options!.includes('p_item'));
  const r = applyOps(src, [{ op: 'obj-add', name: 'my_obj', base: 'uvm_object' }]);
  assert.ok(r.ok, JSON.stringify(r.diags));
  const l = loadModelText(r.text);
  const f = generate(l.model, l.index).find(x => x.path === 'user/my_obj.sv')!;
  assert.ok(f.owner === 'user' && f.content.includes('class my_obj extends uvm_object;'));
  assert.equal(applyOps(r.text, [{ op: 'obj-rm', name: 'my_obj' }]).ok, false, 'removing a used object is rejected');
});
