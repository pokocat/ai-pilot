import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeClaudeBaseUrl } from '../src/llm/providers/claude.js';

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
});
