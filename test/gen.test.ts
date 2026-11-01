import test from 'node:test';
import assert from 'node:assert/strict';
import { loadModelFile } from '../src/core/check.ts';
import { generate } from '../src/gen/index.ts';

const load = () => loadModelFile(new URL('../examples/axi.yaml', import.meta.url).pathname);
const get = (name: string) => {
  const { model, index } = load();
  return generate(model, index).find(f => f.path === name)!.content;
};

test('agent chains monitor port to boundary port and guards active-only children', () => {
  const agent = get('gen/axi_vip_tb_m_agent_base.sv');
  assert.match(agent, /mon\.ap\.connect\(ap_out\);/);
  assert.match(agent, /if \(get_is_active\(\) == UVM_ACTIVE\) begin\s+drv\.seq_item_port\.connect\(sqr\.seq_item_export\);/);
});

test('env connects boundary port to scoreboard imp', () => {
  assert.match(get('gen/axi_vip_tb_base.sv'), /m_agent\.ap_out\.connect\(sb\.m_imp\);/);
});

test('connection crossing two hierarchy levels chains through sub_env', () => {
  assert.match(get('gen/axi_vip_tb_sub_env_base.sv'), /agent\.ap_out\.connect\(ap_out\);/);
  assert.match(get('gen/axi_vip_tb_base.sv'), /sub_env\.ap_out\.connect\(sb\.s_imp\);/);
});

test('user files are marked user-owned, base files are generated', () => {
  const { model, index } = load();
  const files = generate(model, index);
  assert.ok(files.filter(f => f.path.startsWith('user/')).every(f => f.owner === 'user'));
  assert.ok(files.filter(f => f.path.startsWith('gen/')).every(f => f.owner === 'gen'));
});

test('package includes children before parents', () => {
  const pkg = get('gen/axi_vip_pkg.sv');
  assert.ok(pkg.indexOf('axi_vip_tb_m_agent_mon.sv') < pkg.indexOf('axi_vip_tb_m_agent_base.sv'));
  assert.ok(pkg.indexOf('axi_vip_tb_m_agent.sv') < pkg.indexOf('axi_vip_tb_base.sv'));
});
