// Token 成本折算 —— 纯单元测试（不连库）。
//   cd server && node --import tsx --test test/modelPrices.test.ts
//
// 背景（2026-07-28）：输入 token 有三档单价而早期实现只拆了两档。
// Anthropic 官方计价：命中缓存读 0.1×、写入缓存 1.25×（5m TTL）/ 2×（1h TTL）、其余 1×。
// 早期 `usageOf` 把 cache_creation_input_tokens 并进 inputTokens 且不单独记，于是缓存写
// 按 1× 计价 —— 每次写少算 25%，且用量不落库、事后无法量化差多少。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { estimateCostMicros, CACHE_WRITE_MULTIPLIER, type ModelRate } from '../src/data/modelPrices.js';

// 生产实配（2026-07-28 按 Anthropic Opus 4.6 官方价 × 汇率 7.2 刷入）：元 / 1M token
const OPUS: ModelRate = { in: 36, out: 180, cachedIn: 3.6 };

describe('三档输入计价', () => {
  test('全部未缓存：按 in 计', () => {
    // 1M 输入 × ¥36 = ¥36 = 36,000,000 微元
    const got = estimateCostMicros({ inputTokens: 1_000_000, outputTokens: 0, cachedInput: 0 }, OPUS);
    assert.equal(got, 36_000_000);
  });

  test('全部命中缓存：按 cachedIn 计（约 1/10）', () => {
    const got = estimateCostMicros({ inputTokens: 1_000_000, outputTokens: 0, cachedInput: 1_000_000 }, OPUS);
    assert.equal(got, 3_600_000);
  });

  // 这条是本次修复的核心：缓存写不再按 1× 计。
  test('全部写入缓存：按 in × 1.25 计，而不是 in', () => {
    const got = estimateCostMicros(
      { inputTokens: 1_000_000, outputTokens: 0, cachedInput: 0, cacheWrite: 1_000_000 },
      OPUS,
    );
    assert.equal(got, 45_000_000, '¥36 × 1.25 = ¥45');
    assert.notEqual(got, 36_000_000, '按基础价计就是修复前的缺陷');
  });

  test('三档混合：各按各自单价累加', () => {
    // 未缓存 500k×36 + 写 300k×45 + 读 200k×3.6 = 18,000,000 + 13,500,000 + 720,000
    const got = estimateCostMicros(
      { inputTokens: 1_000_000, outputTokens: 0, cachedInput: 200_000, cacheWrite: 300_000 },
      OPUS,
    );
    assert.equal(got, 18_000_000 + 13_500_000 + 720_000);
  });

  test('输出按 out 计，与输入分档无关', () => {
    const got = estimateCostMicros({ inputTokens: 0, outputTokens: 1_000_000, cachedInput: 0 }, OPUS);
    assert.equal(got, 180_000_000);
  });
});

describe('向后兼容', () => {
  // 不报 cacheWrite 的 provider（openai / dify / mock / 历史记录）行为必须一字不变，
  // 否则这次修复会悄悄改掉别的链路的成本口径。
  test('provider 不报 cacheWrite 时，等价于旧的两档拆法', () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 500_000, cachedInput: 400_000 };
    const expected = 600_000 * 36 + 400_000 * 3.6 + 500_000 * 180;
    assert.equal(estimateCostMicros(usage, OPUS), Math.round(expected));
  });

  test('cachedIn 未配时回退 in', () => {
    const rate: ModelRate = { in: 36, out: 180 };
    const got = estimateCostMicros({ inputTokens: 1_000_000, outputTokens: 0, cachedInput: 1_000_000 }, rate);
    assert.equal(got, 36_000_000);
  });

  test('cacheWrite 单价可显式覆盖（1 小时 TTL 是 2×，需运营自己填）', () => {
    const rate: ModelRate = { ...OPUS, cacheWrite: 72 }; // 36 × 2
    const got = estimateCostMicros(
      { inputTokens: 1_000_000, outputTokens: 0, cachedInput: 0, cacheWrite: 1_000_000 },
      rate,
    );
    assert.equal(got, 72_000_000);
  });

  test('未配单价 → 成本 0（不做任何内置价表回退）', () => {
    const got = estimateCostMicros(
      { inputTokens: 9_999_999, outputTokens: 9_999_999, cachedInput: 0, cacheWrite: 9_999_999 },
      { in: 0, out: 0 },
    );
    assert.equal(got, 0);
  });
});

describe('异常报数不产生负数或超额', () => {
  test('缓存命中数超过总输入时被截断', () => {
    const got = estimateCostMicros({ inputTokens: 100, outputTokens: 0, cachedInput: 999_999 }, OPUS);
    assert.equal(got, Math.round(100 * 3.6));
  });

  test('读+写之和超过总输入时，未缓存档不会算成负数', () => {
    const got = estimateCostMicros(
      { inputTokens: 100, outputTokens: 0, cachedInput: 80, cacheWrite: 999_999 },
      OPUS,
    );
    // 读 80 档满，写档被截到剩余 20，未缓存档为 0
    assert.equal(got, Math.round(80 * 3.6 + 20 * 36 * CACHE_WRITE_MULTIPLIER));
    assert.ok(got > 0);
  });

  test('负数输入被夹到 0', () => {
    assert.equal(
      estimateCostMicros({ inputTokens: -5, outputTokens: -5, cachedInput: -5, cacheWrite: -5 }, OPUS),
      0,
    );
  });
});
