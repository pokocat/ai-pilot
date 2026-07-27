import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  effectiveThinkingTemperature,
  maxTokensForThinking,
  normalizeThinkingBudget,
  normalizeThinkingMode,
  thinkingRequestTuning,
} from '../src/llm/thinking.js';

const claude = {
  provider: 'openai' as const,
  model: 'dj-claude-4.6-opus',
  temperature: 0.7,
  thinkingMode: 'disabled' as const,
  thinkingBudget: 1024,
};

describe('Thinking request controls', () => {
  test('OpenAI 兼容协议默认关闭时不注入非标准 thinking 字段', () => {
    assert.deepEqual(thinkingRequestTuning(claude), {
      temperature: 0.7,
    });
  });

  test('手动思考自动锁温度 1 并规范预算', () => {
    assert.deepEqual(thinkingRequestTuning({ ...claude, thinkingMode: 'enabled', thinkingBudget: 10 }), {
      temperature: 1,
      thinking: { type: 'enabled', budget_tokens: 1024 },
    });
    assert.equal(maxTokensForThinking(700, { ...claude, thinkingMode: 'enabled', thinkingBudget: 2048 }), 2560);
  });

  test('自适应思考不发送预算；工具请求强制关闭思考', () => {
    assert.deepEqual(thinkingRequestTuning({ ...claude, thinkingMode: 'adaptive' }), {
      temperature: 1,
      thinking: { type: 'adaptive' },
    });
    assert.deepEqual(thinkingRequestTuning({ ...claude, thinkingMode: 'adaptive' }, { allowThinking: false }), {
      temperature: 0.7,
      thinking: { type: 'disabled' },
    });
    assert.deepEqual(
      thinkingRequestTuning({ ...claude, thinkingMode: 'enabled', temperature: 0.3 }, { allowThinking: false }),
      { temperature: 0.3, thinking: { type: 'disabled' } },
      '关闭思考的成果/工具请求必须使用保存的运营温度，而不是沿用思考请求的 1',
    );
  });

  test('非 Claude 模型不下发 thinking 字段', () => {
    assert.deepEqual(thinkingRequestTuning({ ...claude, model: 'deepseek-chat', thinkingMode: 'enabled' }), {
      temperature: 0.7,
    });
  });

  test('Anthropic 官方直连关闭思考时省略 thinking，第三方网关显式 disabled', () => {
    const official = { ...claude, provider: 'claude' as const, model: 'claude-opus-4-6', baseUrl: '' };
    assert.deepEqual(thinkingRequestTuning(official), { temperature: 0.7 });
    assert.deepEqual(thinkingRequestTuning({ ...official, baseUrl: 'https://api.qnaigc.com/bypass/anthropic' }), {
      temperature: 0.7,
      thinking: { type: 'disabled' },
    });
  });

  test('OpenAI Claude 扩展只有显式开启后才发送 thinking，强制关闭时保留原温度', () => {
    const enabled = { ...claude, thinkingMode: 'enabled' as const, temperature: 0.3 };
    assert.deepEqual(thinkingRequestTuning(enabled), {
      temperature: 1,
      thinking: { type: 'enabled', budget_tokens: 1024 },
    });
    assert.deepEqual(thinkingRequestTuning(enabled, { allowThinking: false }), {
      temperature: 0.3,
      thinking: { type: 'disabled' },
    });
  });

  test('配置归一化锁住合法范围', () => {
    assert.equal(normalizeThinkingMode('wat'), 'disabled');
    assert.equal(normalizeThinkingBudget(1), 1024);
    assert.equal(normalizeThinkingBudget(99999), 7000);
    assert.equal(effectiveThinkingTemperature(0.2, 'enabled'), 1);
    assert.equal(effectiveThinkingTemperature(0.2, 'disabled'), 0.2);
  });
});
