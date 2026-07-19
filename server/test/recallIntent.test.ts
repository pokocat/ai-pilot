import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { isRecallIntent, sessionRecallScore } from '../src/services/recallIntent.js';

describe('回忆意图识别与同会话重排', () => {
  test('识别此前对话/忘记类表达，不误判普通业务提问', () => {
    assert.equal(isRecallIntent('我之前跟你聊过付费社群，你忘了吗？'), true);
    assert.equal(isRecallIntent('今天跟你说过的服务还记得吗'), true);
    assert.equal(isRecallIntent('接着上次的定价方案往下做'), true);
    assert.equal(isRecallIntent('付费社群应该怎么定价？'), false);
  });

  test('业务关键词相同的旧消息得分高于无关日常消息', () => {
    const q = '之前说过从公域引流卖99元付费社群，你忘了吗？';
    const related = sessionRecallScore(q, '从公域引流，销售99元或几百元的付费社群服务');
    const unrelated = sessionRecallScore(q, '明天安排团队开会并检查本周排班');
    assert.ok(related > unrelated, `${related} 应高于 ${unrelated}`);
    assert.ok(related >= 0.1, `相关旧消息应达到有效分，实际 ${related}`);
  });
});
