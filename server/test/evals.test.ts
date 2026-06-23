// P1-A2：评测定价档建议——分档正确，且「无分（未配模型/全部失败）」不给档（不再误落 standard）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestTier } from '../src/services/evals.js';

test('P1-A2 suggestTier 分档', () => {
  assert.equal(suggestTier(9).tier?.id, 'flagship');
  assert.equal(suggestTier(8.5).tier?.id, 'flagship');
  assert.equal(suggestTier(7.5).tier?.id, 'pro');
  assert.equal(suggestTier(3).tier?.id, 'standard');
});

test('P1-A2 suggestTier(null) 不给定价档', () => {
  const r = suggestTier(null);
  assert.equal(r.tier, null, 'score 为空时 tier 必须为 null，避免把「无结论」误读成「标准档」');
  assert.equal(r.score, null);
});
