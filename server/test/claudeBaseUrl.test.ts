import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeRawRequest, normalizeClaudeBaseUrl } from '../src/llm/providers/claude.js';
import type { ResolvedAiConfig } from '../src/services/aiConfig.js';

describe('Claude custom gateway baseUrl', () => {
  test('保留 Anthropic 网关根路径', () => {
    assert.equal(
      normalizeClaudeBaseUrl('https://api.qnaigc.com/bypass/anthropic/'),
      'https://api.qnaigc.com/bypass/anthropic',
    );
  });

  test('去掉 SDK 会自动补齐的 /v1 与 /v1/messages', () => {
    assert.equal(normalizeClaudeBaseUrl('https://gateway.example.com/v1'), 'https://gateway.example.com');
    assert.equal(normalizeClaudeBaseUrl('https://gateway.example.com/v1/messages/'), 'https://gateway.example.com');
  });

  test('官方直连空地址保持为空', () => {
    assert.equal(normalizeClaudeBaseUrl('  '), '');
    assert.equal(normalizeClaudeBaseUrl(), '');
  });

  test('轻量探活携带当前 temperature，与真实聊天参数一致', () => {
    const cfg = {
      provider: 'claude',
      label: 'test',
      baseUrl: 'https://gateway.example.com',
      model: 'claude-opus-test',
      apiKey: 'sk-test',
      embeddingModel: '',
      temperature: 0.7,
      timeoutMs: 60_000,
      embeddingEnabled: false,
      embeddingBaseUrl: '',
      embeddingApiKey: '',
      rerankEnabled: false,
      rerankModel: '',
      rerankBaseUrl: '',
      rerankApiKey: '',
    } satisfies ResolvedAiConfig;

    assert.equal(claudeRawRequest(cfg, 'system', 'ping').temperature, 0.7);
    assert.equal(claudeRawRequest({ ...cfg, temperature: 1 }, 'system', 'ping').temperature, 1);
  });
});
