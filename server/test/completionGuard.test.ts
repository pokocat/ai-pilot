import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { assertChatOutputComplete, CHAT_MAX_TOKENS } from '../src/llm/providers/completionGuard.js';

describe('chat completion guard', () => {
  test('普通长对话允许 8000 token 输出', () => {
    assert.equal(CHAT_MAX_TOKENS, 8000);
  });

  test('正常结束原因直接放行', () => {
    assert.doesNotThrow(() => assertChatOutputComplete('Claude', 'end_turn', 3200));
    assert.doesNotThrow(() => assertChatOutputComplete('OpenAI', 'stop', 3200));
  });

  test('达到 provider 输出上限时标记为未完成', () => {
    for (const [provider, reason] of [['Claude', 'max_tokens'], ['OpenAI', 'length']] as const) {
      assert.throws(
        () => assertChatOutputComplete(provider, reason, 8000),
        (err: Error & { code?: string; statusCode?: number; finishReason?: string }) => {
          assert.equal(err.code, 'AI_OUTPUT_TRUNCATED');
          assert.equal(err.statusCode, 503);
          assert.equal(err.finishReason, reason);
          return true;
        },
      );
    }
  });
});
