import test from 'node:test';
import assert from 'node:assert/strict';
import { loadModelFile } from '../src/core/check.ts';
import { layoutModel } from '../src/core/layout.ts';
import { renderSvg } from '../src/core/svg.ts';

test('model ports get clickable hit targets, boundary ports do not', async () => {
  const { model, index } = loadModelFile(new URL('../examples/axi.yaml', import.meta.url).pathname);
  const { laid } = await layoutModel(model, index);
  const svg = renderSvg(laid);
  assert.match(svg, /data-port="tb\.m_agent\.mon:ap" data-dir="out" data-kind="analysis_port"/);
  assert.match(svg, /data-port="tb\.sb:m_imp" data-dir="in"/);
  assert.doesNotMatch(svg, /data-port="[^"]*~/);
});
