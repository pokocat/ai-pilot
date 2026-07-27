import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { modelGatewayField, modelSupportsThinking } from './modelGateway';

describe('model gateway field', () => {
  test('Claude 自主定义必须显示 baseUrl，并提示 Anthropic 协议', () => {
    const field = modelGatewayField('claude');
    assert.equal(field.visible, true);
    assert.match(field.label, /Anthropic/);
    assert.match(field.note || '', /\/v1\/messages/);
  });

  test('OpenAI 兼容模式显示 /v1 提示，mock 不显示', () => {
    assert.match(modelGatewayField('openai').label, /OpenAI/);
    assert.equal(modelGatewayField('mock').visible, false);
  });

  test('Anthropic 原生与 OpenAI 兼容 Claude 别名都显示 Thinking 配置', () => {
    assert.equal(modelSupportsThinking('claude', 'claude-opus-4-6'), true);
    assert.equal(modelSupportsThinking('openai', 'dj-claude-4.6-opus'), true);
    assert.equal(modelSupportsThinking('openai', 'deepseek-chat'), false);
  });
});
