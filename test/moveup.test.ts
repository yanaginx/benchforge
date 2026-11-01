import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { applyOps } from '../src/core/edit.ts';
import { loadModelText } from '../src/core/check.ts';

const src = fs.readFileSync(new URL('../examples/axi.yaml', import.meta.url), 'utf8');

test('move-up lifts a node out of its parent and rewrites its paths', () => {
  const r = applyOps(src, [{ op: 'move-up', path: 'tb.sub_env.agent' }]);
  assert.ok(r.ok, JSON.stringify(r.diags));
  const m = loadModelText(r.text);
  assert.deepEqual(m.diags, []);
  assert.ok(r.text.includes('name: agent'));
  assert.ok(!r.text.includes('tb.sub_env.agent'));
});

test('move-up refuses a top-level node and a name clash', () => {
  assert.equal(applyOps(src, [{ op: 'move-up', path: 'tb.sb' }]).ok, false);
  assert.equal(applyOps(src, [{ op: 'move-up', path: 'tb' }]).ok, false);
  const clash = applyOps(src, [{ op: 'move-up', path: 'tb.m_agent.mon' }, { op: 'move-up', path: 'tb.s_agent.mon' }]);
  assert.equal(clash.ok, false);
  assert.match(clash.diags[0].message, /already has a child/);
});

test('move-up drops wires that would skip a boundary but keeps inner ones', () => {
  const r = applyOps(src, [{ op: 'move-up', path: 'tb.m_agent.mon' }]);
  assert.ok(r.ok, JSON.stringify(r.diags));
  assert.ok(/tb\.mon:ap/.test(r.text), 'the wire out of the agent is spliced to the scoreboard');
  assert.deepEqual(loadModelText(r.text).diags, []);
});
