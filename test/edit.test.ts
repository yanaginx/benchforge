import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOps } from '../src/core/edit.ts';

const SRC = `# keep this comment
project: p
root:
  name: top
  type: env
  children:
    - { name: m, type: monitor }
    - { name: sb, type: scoreboard, ports: [{ name: imp, kind: analysis_imp, dir: in }] }
connections:
  - { from: "top.m:ap", to: "top.sb:imp" }
`;

test('rename updates connections and keeps comments', () => {
  const r = applyOps(SRC, [{ op: 'set', path: 'top.m', field: 'name', value: 'mon' }]);
  assert.ok(r.ok);
  assert.match(r.text, /# keep this comment/);
  assert.match(r.text, /top\.mon:ap/);
});

test('rm drops connections touching the node', () => {
  const r = applyOps(SRC, [{ op: 'rm', path: 'top.m' }]);
  assert.ok(r.ok);
  assert.doesNotMatch(r.text, /top\.m:ap/);
});

test('invalid edit returns diags and leaves text untouched', () => {
  const r = applyOps(SRC, [{ op: 'add', parent: 'top', name: 'x', type: 'nope' }]);
  assert.equal(r.ok, false);
  assert.equal(r.text, SRC);
  assert.equal(r.diags[0].code, 'unknown_type');
});

test('batch is atomic: later failure discards earlier ops', () => {
  const r = applyOps(SRC, [
    { op: 'add', parent: 'top', name: 'cov', type: 'subscriber' },
    { op: 'rm', path: 'top.ghost' },
  ]);
  assert.equal(r.ok, false);
  assert.equal(r.text, SRC);
});

test('wire is idempotent', () => {
  const op = { op: 'wire' as const, from: 'top.m:ap', to: 'top.sb:imp' };
  const r = applyOps(SRC, [op]);
  assert.equal(r.text.match(/top\.m:ap/g)?.length, 1);
});

test('port-add then port-rm round trip, rm also drops connections', () => {
  const added = applyOps(SRC, [{ op: 'port-add', path: 'top.sb', port: { name: 'imp2', kind: 'analysis_imp', dir: 'in' } }]);
  assert.ok(added.ok);
  assert.match(added.text, /imp2/);
  const wired = applyOps(added.text, [{ op: 'wire', from: 'top.m:ap', to: 'top.sb:imp2' }]);
  assert.ok(wired.ok);
  const removed = applyOps(wired.text, [{ op: 'port-rm', path: 'top.sb', name: 'imp2' }]);
  assert.ok(removed.ok);
  assert.doesNotMatch(removed.text, /imp2/);
});

test('port-rm of a type-provided port is rejected with own-port options', () => {
  const r = applyOps(SRC, [{ op: 'port-rm', path: 'top.m', name: 'ap' }]);
  assert.equal(r.ok, false);
  assert.equal(r.diags[0].code, 'no_port');
});

test('duplicate own port names are rejected', () => {
  const r = applyOps(SRC, [{ op: 'port-add', path: 'top.sb', port: { name: 'imp', kind: 'analysis_imp', dir: 'in' } }]);
  assert.equal(r.ok, false);
  assert.equal(r.diags[0].code, 'duplicate_port');
});
