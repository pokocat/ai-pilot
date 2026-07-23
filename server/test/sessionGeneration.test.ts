import test from 'node:test';
import assert from 'node:assert/strict';
import { isSessionGenerating, trackSessionGeneration } from '../src/services/sessionGeneration.ts';

test('会话生成态按并发计数，最后一轮结束后才清除', () => {
  const sid = `session-generation-${Date.now()}`;
  const finishFirst = trackSessionGeneration(sid);
  const finishSecond = trackSessionGeneration(sid);

  assert.equal(isSessionGenerating(sid), true);
  finishFirst();
  assert.equal(isSessionGenerating(sid), true, '仍有一轮在途时不能提前清状态');

  finishSecond();
  assert.equal(isSessionGenerating(sid), false);

  finishSecond();
  assert.equal(isSessionGenerating(sid), false, '结束句柄重复调用必须幂等');
});
