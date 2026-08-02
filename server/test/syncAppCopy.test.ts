import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateAgentMirrorSource, updateDeliverableMirrorSource } from '../scripts/syncAppCopy.js';

const repoRoot = path.resolve(process.cwd(), '..');

test('文案镜像与服务端 seed 一致，且同步器幂等', async () => {
  const agentPath = path.join(repoRoot, 'app/src/data/agents.ts');
  const deliverablePath = path.join(repoRoot, 'app/src/data/deliverables.ts');
  const [agents, deliverables] = await Promise.all([
    readFile(agentPath, 'utf8'),
    readFile(deliverablePath, 'utf8'),
  ]);
  assert.equal(updateAgentMirrorSource(agents), agents);
  assert.equal(updateDeliverableMirrorSource(deliverables), deliverables);
});

test('同步器修正文案时保留行为字段', async () => {
  const source = await readFile(path.join(repoRoot, 'app/src/data/agents.ts'), 'utf8');
  const drifted = source
    .replace('"enabled": true', '"enabled": false')
    .replace('"greet": "坐下来聊聊。生意要看，人也要看。先说说——你做什么生意？眼下最难拿主意的是哪件事？"', '"greet": "旧开场白"');
  const updated = updateAgentMirrorSource(drifted);
  assert.match(updated, /"enabled": false/, '产品行为差异必须保留');
  assert.doesNotMatch(updated, /旧开场白/, '文案字段应回到服务端 seed');
});
