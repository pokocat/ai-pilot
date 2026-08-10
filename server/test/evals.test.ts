// P1-A2：评测定价档建议——分档正确，且「无分（未配模型/全部失败）」不给档（不再误落 standard）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COACH_QUALITY_RUBRIC, effectiveEvalRubric, evalJudgeInput, suggestTier } from '../src/services/evals.js';

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

test('真人教练质量标准是所有评测的默认基线，自定义标准只追加不覆盖', () => {
  assert.match(COACH_QUALITY_RUBRIC, /真人教练/);
  assert.match(COACH_QUALITY_RUBRIC, /清晰立场/);
  assert.match(COACH_QUALITY_RUBRIC, /人情味/);
  assert.match(COACH_QUALITY_RUBRIC, /洞见或惊喜/);
  const rubric = effectiveEvalRubric('必须给出三天内可验证的动作');
  assert.match(rubric, /真人教练/);
  assert.match(rubric, /三天内可验证/);
});

test('评委输入带上历史、记忆与既往脉络，理解感有事实可核对', () => {
  const input = evalJudgeInput('那我现在应该怎么做？', {
    companyName: '北辰咖啡', industry: '连锁咖啡', stage: '10 家店', pain: '复购下滑',
    memories: ['老板不接受降价换量'],
    history: [{ role: 'user', text: '上次已经决定先改会员日。' }],
    digestItems: [{ kind: 'decision', text: '先验证会员日，不扩新店', sourceMessageIds: ['m1'], at: '2026-08-01T00:00:00.000Z' }],
  });
  assert.match(input, /北辰咖啡/);
  assert.match(input, /不接受降价换量/);
  assert.match(input, /先验证会员日，不扩新店/);
  assert.match(input, /最近对话-客户/);
});
