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
    assert.deepEqual(map.get('claude-x'), { in: 36, out: 180, cachedIn: 3.6, cacheWrite: undefined });
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
    assert.deepEqual(map.get('shared'), { in: 10, out: 20, cachedIn: undefined, cacheWrite: undefined });
    assert.deepEqual(issues, []);
  });
});

// 缓存写单价第四档（2026-08-07 补 D4）。
// 此前 ModelRate.cacheWrite 有读取逻辑、注释也写着「运营可显式填」，但库里没有这一列、
// 后台没有输入框、buildConfiguredRateMap 也不产出这一档 —— 实际永远走硬编码的 1.25×。
describe('缓存写单价档', () => {
  test('显式填了就用运营的值（1h TTL 2× 或供应商统一单价 1× 都靠它表达）', () => {
    const { map, issues } = buildConfiguredRateMap([
      { model: 'claude-x', priceInput: 36, priceOutput: 180, priceCachedInput: 3.6, priceCacheWrite: 72 },
    ]);
    assert.deepEqual(map.get('claude-x'), { in: 36, out: 180, cachedIn: 3.6, cacheWrite: 72 });
    assert.deepEqual(issues, []);
  });

  test('未填 / 历史行 → cacheWrite 为 undefined，折算继续走 in × 1.25，与加这一档之前逐位相同', () => {
    const { map } = buildConfiguredRateMap([
      { model: 'legacy', priceInput: 36, priceOutput: 180, priceCachedInput: 3.6 },
    ]);
    assert.equal(map.get('legacy')?.cacheWrite, undefined);
  });

  test('只填缓存写、没填输入/输出 → 仍判未校准（不能只凭一档就开始计费）', () => {
    const { map, issues } = buildConfiguredRateMap([
      { model: 'only-write', priceInput: 0, priceOutput: 0, priceCachedInput: 0, priceCacheWrite: 72 },
    ]);
    assert.equal(map.has('only-write'), false);
    assert.ok(issues.some((x) => x.includes('必须同时配置')));
  });

  test('同名端点只有缓存写档不一致 → 整个模型退回未校准（四档全部纳入一致性判定）', () => {
    const { map, issues } = buildConfiguredRateMap([
      { model: 'claude-x', priceInput: 36, priceOutput: 180, priceCachedInput: 3.6, priceCacheWrite: 45 },
      { model: 'claude-x', priceInput: 36, priceOutput: 180, priceCachedInput: 3.6, priceCacheWrite: 72 },
    ]);
    assert.equal(map.has('claude-x'), false);
    assert.ok(issues.some((x) => x.includes('冲突单价')));
  });

  test('一端显式填、另一端留空也算冲突 —— 留空是「按 1.25× 推导」，与显式值不是一回事', () => {
    const { map } = buildConfiguredRateMap([
      { model: 'claude-x', priceInput: 36, priceOutput: 180, priceCachedInput: 3.6 },
      { model: 'claude-x', priceInput: 36, priceOutput: 180, priceCachedInput: 3.6, priceCacheWrite: 45 },
    ]);
    assert.equal(map.has('claude-x'), false);
  });
});
