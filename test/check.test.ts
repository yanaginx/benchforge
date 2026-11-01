import test from 'node:test';
import assert from 'node:assert/strict';
import { loadModelText } from '../src/core/check.ts';

const base = (conn: string) => `
project: p
root:
  name: top
  type: env
  children:
    - { name: m, type: monitor }
    - name: sb
      type: scoreboard
      ports: [{ name: imp, kind: analysis_imp, dir: in }]
connections:
  - ${conn}
`;

test('valid analysis connection', () => {
  assert.deepEqual(loadModelText(base('{ from: "top.m:ap", to: "top.sb:imp" }')).errors, []);
});
test('reversed direction rejected', () => {
  const { errors } = loadModelText(base('{ from: "top.sb:imp", to: "top.m:ap" }'));
  assert.ok(errors.some(e => e.includes('not an output')));
});
test('unknown port reports valid options', () => {
  const { diags } = loadModelText(base('{ from: "top.m:nope", to: "top.sb:imp" }'));
  const d = diags.find(x => x.code === 'no_port');
  assert.ok(d);
  assert.deepEqual(d.options, ['ap']);
});
test('unknown type rejected', () => {
  const { diags } = loadModelText('project: p\nroot: { name: top, type: bogus }\n');
  assert.equal(diags[0].code, 'unknown_type');
  assert.ok(diags[0].options?.includes('monitor'));
});
test('leaf with children rejected', () => {
  const { errors } = loadModelText('project: p\nroot: { name: top, type: env, children: [{ name: m, type: monitor, children: [{ name: x, type: monitor }] }] }\n');
  assert.ok(errors.some(e => e.includes('leaf type')));
});
