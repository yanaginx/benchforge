import test from 'node:test';
import assert from 'node:assert/strict';
import { loadModelFile } from '../src/core/check.ts';
import { generate } from '../src/gen/index.ts';
import { layoutModel } from '../src/core/layout.ts';

const load = () => loadModelFile(new URL('../examples/tlm2.yaml', import.meta.url).pathname);

test('uvm_component is a container and may hold children', () => {
  const r = load();
  assert.deepEqual(r.diags, []);
  assert.equal(r.index.get('tb.cpu')!.rtype.shape, 'container');
});

test('TLM-2.0 sockets chain through passthrough sockets', () => {
  const { model, index } = load();
  const f = Object.fromEntries(generate(model, index).map(x => [x.path, x.content]));
  const text = Object.values(f).join('\n');
  assert.match(text, /uvm_tlm_b_initiator_socket #\(uvm_tlm_generic_payload\) bus;/);
  assert.match(text, /uvm_tlm_b_passthrough_initiator_socket #\(uvm_tlm_generic_payload\) bus_out;/);
  assert.match(text, /uvm_tlm_b_passthrough_target_socket #\(uvm_tlm_generic_payload\) tgt_in;/);
  assert.match(text, /uvm_tlm_b_target_socket #\(tlm2_demo_tb_mem_bank_base, uvm_tlm_generic_payload\) tgt;/);
  assert.match(text, /virtual task b_transport\(uvm_tlm_generic_payload t, uvm_tlm_time delay\)/);
  assert.match(text, /core\.bus\.connect\(bus_out\);/);
  assert.match(text, /tgt_in\.connect\(bank\.tgt\);/);
});

test('empty container still gets a body', async () => {
  const { model, index } = load();
  const { laid } = await layoutModel(model, index, { root: 'tb.cpu' });
  assert.ok(laid.children[0].width! >= 120);
});
