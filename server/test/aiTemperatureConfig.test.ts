import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { publicModel } from '../src/services/aiConfig.js';

describe('AI temperature configuration', () => {
  test('Thinking 开启时对外模型配置仍保留运营温度原值', () => {
    const model = publicModel({
      id: 'thinking-model',
      provider: 'claude',
      label: 'Claude',
      baseUrl: 'https://gateway.example.com',
      model: 'claude-opus-4-6',
      apiKey: 'sk-test',
      embeddingModel: '',
      temperature: 0.3,
      thinkingMode: 'enabled',
      thinkingBudget: 2048,
      preset: null,
      priceInput: 0,
      priceOutput: 0,
      priceCachedInput: 0,
      updatedAt: new Date('2026-07-27T00:00:00Z'),
    }, null);

    assert.equal(model.temperature, 0.3);
    assert.equal(model.thinkingMode, 'enabled');
  });
});
