import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadModelFile } from '../src/core/check.ts';
import { generate } from '../src/gen/index.ts';

const NON_ASCII = /[^\x00-\x7F]/;

function walk(dir: string, out: string[] = []): string[] {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) walk(p, out);
    else if (/\.(ts|mjs|json|yaml|html)$/.test(f.name)) out.push(p);
  }
  return out;
}

test('source, schema and examples are ASCII only', () => {
  const root = new URL('..', import.meta.url).pathname;
  const bad = ['src', 'test', 'schema', 'examples'].flatMap(d => walk(path.join(root, d)))
    .filter(f => NON_ASCII.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(bad, []);
});

test('generated SystemVerilog is ASCII only', () => {
  const file = new URL('../examples/axi.yaml', import.meta.url).pathname;
  const { model, index } = loadModelFile(file);
  const bad = generate(model, index).filter(f => NON_ASCII.test(f.content)).map(f => f.path);
  assert.deepEqual(bad, []);
});
