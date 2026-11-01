import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';
import { startServer } from '../src/web/server.ts';

const post = (port: number, url: string, body: unknown) =>
  fetch(`http://127.0.0.1:${port}${url}`, { method: 'POST', headers: { 'x-bf': '1', 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json()) as Promise<any>;

test('undo and redo restore the file text, and a new edit clears redo', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-hist-'));
  const file = path.join(dir, 'm.yaml');
  fs.copyFileSync(new URL('../examples/play.yaml', import.meta.url).pathname, file);
  const original = fs.readFileSync(file, 'utf8');
  const srv: http.Server = startServer({ file, port: 0 });
  await new Promise(r => srv.once('listening', r));
  const port = (srv.address() as { port: number }).port;
  try {
    const add = (name: string) => post(port, '/api/ops', { ops: [{ op: 'add', parent: 'tb', name, type: 'monitor' }], layout: false });
    const r1 = await add('mon_x');
    assert.ok(r1.ok, JSON.stringify(r1.diags));
    assert.equal(r1.undo, 'add'); assert.equal(r1.redo, null);
    const afterAdd = fs.readFileSync(file, 'utf8');
    assert.notEqual(afterAdd, original);

    const u = await post(port, '/api/undo', {});
    assert.ok(u.ok); assert.equal(fs.readFileSync(file, 'utf8'), original);
    assert.equal(u.undo, null); assert.equal(u.redo, 'add');

    const re = await post(port, '/api/redo', {});
    assert.ok(re.ok); assert.equal(fs.readFileSync(file, 'utf8'), afterAdd);

    await post(port, '/api/undo', {});
    await add('mon_y'); // a fresh edit after an undo drops the redo branch
    const none = await post(port, '/api/redo', {});
    assert.equal(none.ok, false);
    assert.equal((await post(port, '/api/undo', {})).ok, true);
    assert.equal((await post(port, '/api/undo', {})).ok, false); // nothing left
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  } finally { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
