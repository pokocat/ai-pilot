// 模型费率 SSOT 纯单元测试：端点池同名模型必须使用完整且一致的价格。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildConfiguredRateMap } from '../src/services/aiConfig.js';

describe('模型级费率 SSOT', () => {
  test('同名多端点价格一致 → 只产生一个确定费率', () => {
    const { map, issues } = buildConfiguredRateMap([
      { model: 'Claude-X', priceInput: 36, priceOutput: 180, priceCachedInput: 3.6 },
      { model: 'claude-x', priceInput: 36, priceOutput: 180, priceCachedInput: 3.6 },
    ]);
    assert.deepEqual(map.get('claude-x'), { in: 36, out: 180, cachedIn: 3.6 });
    assert.deepEqual(issues, []);
  });

  test('同名多端点价格冲突 → 整个模型不校准，不再由查询顺序随机覆盖', () => {
    const { map, issues } = buildConfiguredRateMap([
      { model: 'claude-x', priceInput: 36, priceOutput: 180, priceCachedInput: 3.6 },
      { model: 'claude-x', priceInput: 30, priceOutput: 150, priceCachedInput: 3 },
    ]);
    assert.equal(map.has('claude-x'), false);
    assert.ok(issues.some((x) => x.includes('冲突单价')));
  });

  test('只填输入或输出价 → 不校准，避免把另一档按 0 计费', () => {
    const { map, issues } = buildConfiguredRateMap([
      { model: 'partial', priceInput: 36, priceOutput: 0, priceCachedInput: 0 },
    ]);
    assert.equal(map.has('partial'), false);
    assert.ok(issues.some((x) => x.includes('必须同时配置')));
  });

  test('同名未定价端点不覆盖已校准模型价', () => {
    const { map, issues } = buildConfiguredRateMap([
      { model: 'shared', priceInput: 0, priceOutput: 0, priceCachedInput: 0 },
      { model: 'shared', priceInput: 10, priceOutput: 20, priceCachedInput: 0 },
    ]);
    assert.deepEqual(map.get('shared'), { in: 10, out: 20, cachedIn: undefined });
    assert.deepEqual(issues, []);
  });
});
