import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertChatBodyProduced,
  assertChatOutputComplete,
  continuationPrompt,
  dedupeContinuation,
  isTruncatedFinish,
  joinContinuation,
  CHAT_MAX_TOKENS,
  CHAT_TOTAL_MAX_TOKENS,
  CONTINUE_DEADLINE_MS,
  CONTINUE_STREAM_TIMEOUT_MS,
  MAX_CHAT_CONTINUATIONS,
} from '../src/llm/providers/completionGuard.js';
import { chatMaxTokens, MAX_THINKING_BUDGET } from '../src/llm/thinking.js';
import type { ThinkingConfigLike } from '../src/llm/thinking.js';

const claude: ThinkingConfigLike = {
  provider: 'claude', model: 'claude-sonnet-4-6', temperature: 0.6,
  thinkingMode: 'disabled', thinkingBudget: 1024,
};

describe('chat completion guard', () => {
  test('普通长对话单轮正文预算 8000，续写后累计上界 24000', () => {
    assert.equal(CHAT_MAX_TOKENS, 8000);
    assert.equal(MAX_CHAT_CONTINUATIONS, 2);
    assert.equal(CHAT_TOTAL_MAX_TOKENS, 24000);
  });

  // 客户端只等 180s（小程序 Taro.request 显式 180000、nginx proxy_read_timeout 同为 180s）。
  // 顶穿的后果比截断更糟：clientGone 会退预留、不落库，用户连已经看完的半篇都拿不到。
  test('续写墙钟预算 + 单轮续写超时必须留在客户端 180s 之内', () => {
    assert.ok(
      CONTINUE_DEADLINE_MS + CONTINUE_STREAM_TIMEOUT_MS < 180_000,
      `最坏 ${CONTINUE_DEADLINE_MS + CONTINUE_STREAM_TIMEOUT_MS}ms 必须小于客户端 180000ms`,
    );
  });

  test('正常结束原因不算截断', () => {
    assert.equal(isTruncatedFinish('end_turn'), false);
    assert.equal(isTruncatedFinish('stop'), false);
    assert.equal(isTruncatedFinish(null), false);
    assert.equal(isTruncatedFinish(undefined), false);
  });

  test('两个 provider 的截断原因都能识别', () => {
    assert.equal(isTruncatedFinish('max_tokens'), true); // Claude
    assert.equal(isTruncatedFinish('length'), true); // OpenAI
  });

  test('结构化成果撞上限仍按失败抛（半份报告不能出厂）', () => {
    assert.doesNotThrow(() => assertChatOutputComplete('Claude', 'end_turn', 3200));
    assert.doesNotThrow(() => assertChatOutputComplete('OpenAI', 'stop', 3200));
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

  test('一个字正文都没写就撞上限 → 报错指向预算，不伪装成空响应', () => {
    assert.doesNotThrow(() => assertChatBodyProduced('Claude', 'end_turn', 0));
    assert.throws(
      () => assertChatBodyProduced('Claude', 'max_tokens', 8000),
      (err: Error & { code?: string }) => {
        assert.equal(err.code, 'AI_OUTPUT_TRUNCATED');
        assert.match(err.message, /思考预算/, '排查的人要能一眼看到该查什么');
        return true;
      },
    );
  });
});

describe('续写指令', () => {
  test('残文进指令、且明确要求不要复述与过渡语', () => {
    const p = continuationPrompt('前面写了很多，最后一句是毛利率大约是 3');
    assert.match(p, /毛利率大约是 3/, '断点尾巴要带进去，模型才知道从哪接');
    assert.match(p, /不要重复/);
    assert.match(p, /不要写「接上文」/);
  });

  test('只带尾巴，不把整篇正文重发一遍（省 input token）', () => {
    const long = '甲'.repeat(5000);
    assert.ok(continuationPrompt(long).length < 800, '指令长度必须与正文长度无关');
  });
});

describe('续写拼接去重', () => {
  test('模型复述最后一句时剪掉重叠', () => {
    const prev = '第一步先看现金流，第二步看毛利结构。';
    const next = '第二步看毛利结构。第三步看人效。';
    assert.equal(dedupeContinuation(prev, next), '第三步看人效。');
    assert.equal(joinContinuation(prev, next), '第一步先看现金流，第二步看毛利结构。第三步看人效。');
  });

  test('没有重叠时原样保留', () => {
    assert.equal(dedupeContinuation('abc', 'def'), 'def');
    assert.equal(joinContinuation('abc', 'def'), 'abcdef');
  });

  test('截在词中间时无缝贴上，不补任何分隔符（补了就写坏数字）', () => {
    assert.equal(joinContinuation('毛利率大约是 3', '8%，低于同业。'), '毛利率大约是 38%，低于同业。');
  });

  test('空输入不炸', () => {
    assert.equal(dedupeContinuation('', 'abc'), 'abc');
    assert.equal(dedupeContinuation('abc', ''), '');
    assert.equal(joinContinuation('', 'abc'), 'abc');
  });

  test('整段续写与已有正文完全重复时全部剪掉（不给用户看两遍）', () => {
    assert.equal(dedupeContinuation('结论是要收缩', '结论是要收缩'), '');
  });
});

describe('思考预算不得抢占正文预算', () => {
  test('关闭思考时 max_tokens 就是正文预算', () => {
    assert.equal(chatMaxTokens(CHAT_MAX_TOKENS, claude), CHAT_MAX_TOKENS);
  });

  test('开启手动思考时思考预算整个叠加，正文净额恒为 8000', () => {
    const cfg = { ...claude, thinkingMode: 'enabled' as const, thinkingBudget: 7000 };
    assert.equal(chatMaxTokens(CHAT_MAX_TOKENS, cfg), CHAT_MAX_TOKENS + 7000);
  });

  test('adaptive 无预算可查 → 按手动档上限保守预留', () => {
    const cfg = { ...claude, thinkingMode: 'adaptive' as const };
    assert.equal(chatMaxTokens(CHAT_MAX_TOKENS, cfg), CHAT_MAX_TOKENS + MAX_THINKING_BUDGET);
  });

  test('续写轮显式关思考 → 整个预算让给正文', () => {
    const cfg = { ...claude, thinkingMode: 'enabled' as const, thinkingBudget: 7000 };
    assert.equal(chatMaxTokens(CHAT_MAX_TOKENS, cfg, false), CHAT_MAX_TOKENS);
  });

  test('非 Claude 模型不下发思考，预算不叠加', () => {
    const cfg = { ...claude, provider: 'openai' as const, model: 'gpt-4o', thinkingMode: 'enabled' as const, thinkingBudget: 7000 };
    assert.equal(chatMaxTokens(CHAT_MAX_TOKENS, cfg), CHAT_MAX_TOKENS);
  });
});
