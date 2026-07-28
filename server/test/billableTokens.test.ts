// 算力按成本加权 —— 纯单元测试（不连库）。
//   cd server && node --import tsx --test test/billableTokens.test.ts
//
// 算力扣减原本是 ceil((输入 + 输出) × ratio)，把两者等价合并——而输出比输入贵约 5 倍
// （¥180 vs ¥36 / 1M）。于是长输出用户被系统性少扣。2026-07-28 用生产近 30 天数据实测：
//   chat 少扣 2.9%（缓存读的 0.1× 折扣抵消了大部分输出溢价）、deliverable 少扣 31.8%、
//   单用户最差少扣 46.3%。
//
// 换算基准取 rate.in，故等价量的单位就是「未缓存输入 token」——当前输入占 token 约 97%，
// 老用户余额观感基本不动，只有长输出场景才被正确加价。
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  billableTokenEquivalents,
  weightedQuotaReserveTokens,
  type ModelRate,
} from '../src/data/modelPrices.js';
import { billableOf } from '../src/services/usage.js';

// 生产实配（2026-07-28 按 Anthropic Opus 4.6 官方价 × 汇率 7.2 刷入）：元 / 1M token
const OPUS: ModelRate = { in: 36, out: 180, cachedIn: 3.6 };

let saved: string | undefined;
beforeEach(() => { saved = process.env.CREDIT_WEIGHTED; delete process.env.CREDIT_WEIGHTED; });
afterEach(() => { if (saved === undefined) delete process.env.CREDIT_WEIGHTED; else process.env.CREDIT_WEIGHTED = saved; });

describe('各档权重来自后台单价', () => {
  test('纯未缓存输入 → 权重 1（等价量就是它本身）', () => {
    const got = billableTokenEquivalents({ inputTokens: 1000, outputTokens: 0, cachedInput: 0 }, OPUS);
    assert.equal(got, 1000);
  });

  test('输出按 out/in ≈ 5 倍计 —— 这是本次修复的核心', () => {
    const got = billableTokenEquivalents({ inputTokens: 0, outputTokens: 1000, cachedInput: 0 }, OPUS);
    assert.equal(got, 5000, '¥180 / ¥36 = 5');
    assert.notEqual(got, 1000, '等价合并就是修复前的口径');
  });

  test('缓存读按 cachedIn/in ≈ 0.1 倍计（用户该享受到这个折扣）', () => {
    const got = billableTokenEquivalents({ inputTokens: 1000, outputTokens: 0, cachedInput: 1000 }, OPUS);
    assert.equal(got, 100);
  });

  test('缓存写按 1.25 倍计', () => {
    const got = billableTokenEquivalents({ inputTokens: 1000, outputTokens: 0, cachedInput: 0, cacheWrite: 1000 }, OPUS);
    assert.equal(got, 1250);
  });

  test('权重随后台单价走：输出价翻倍，等价量也翻倍（换供应商价表无需改代码）', () => {
    const doubled: ModelRate = { ...OPUS, out: 360 };
    const got = billableTokenEquivalents({ inputTokens: 0, outputTokens: 1000, cachedInput: 0 }, doubled);
    assert.equal(got, 10000);
  });

  // 生产实测形态：chat 均输入 28,417 / 输出 829、缓存命中约 10.6%。
  test('生产 chat 形态下变化很小（缓存折扣抵消了输出溢价）', () => {
    const usage = { inputTokens: 28417, outputTokens: 829, cachedInput: 3012 };
    const old = usage.inputTokens + usage.outputTokens;
    const now = billableTokenEquivalents(usage, OPUS);
    const delta = (now / old - 1) * 100;
    assert.ok(delta > -5 && delta < 15, `chat 形态的变化应在小幅区间内，实际 ${delta.toFixed(1)}%`);
  });
});

describe('兜底与开关', () => {
  test('未配单价（in=0）→ 回落裸 token 求和，不除零', () => {
    const got = billableTokenEquivalents({ inputTokens: 100, outputTokens: 50, cachedInput: 0 }, { in: 0, out: 0 });
    assert.equal(got, 150);
    assert.ok(Number.isFinite(got));
  });

  test('只配输入价、漏配输出价 → 退回裸 token，不把输出免费送掉', () => {
    const got = billableTokenEquivalents(
      { inputTokens: 100, outputTokens: 50, cachedInput: 0 },
      { in: 36, out: 0 },
    );
    assert.equal(got, 150);
  });

  test('CREDIT_WEIGHTED=false → 立即退回旧口径（应急回滚，无需改代码）', () => {
    process.env.CREDIT_WEIGHTED = 'false';
    const got = billableTokenEquivalents({ inputTokens: 1000, outputTokens: 1000, cachedInput: 0 }, OPUS);
    assert.equal(got, 2000, '关掉后必须与旧口径逐位相同');
  });

  test('cachedIn 未配时缓存读回落 in（权重 1，不白送折扣也不多扣）', () => {
    const got = billableTokenEquivalents({ inputTokens: 1000, outputTokens: 0, cachedInput: 1000 }, { in: 36, out: 180 });
    assert.equal(got, 1000);
  });

  test('读+写超过总输入时不产生负数', () => {
    const got = billableTokenEquivalents(
      { inputTokens: 100, outputTokens: 0, cachedInput: 80, cacheWrite: 999999 },
      OPUS,
    );
    assert.ok(got > 0 && Number.isFinite(got));
  });
});

describe('生成前动态悲观预留', () => {
  test('按最贵输入档 + 最大输出权重预留', () => {
    const got = weightedQuotaReserveTokens(128_000, 8_000, OPUS);
    assert.equal(got, 200_000, '输入缓存写最贵 1.25×，输出 ¥180/¥36=5×');
  });

  test('单价不完整时使用裸 token 上界', () => {
    assert.equal(weightedQuotaReserveTokens(128_000, 8_000, { in: 36, out: 0 }), 136_000);
  });

  test('关闭加权开关时预留与旧口径同单位', () => {
    process.env.CREDIT_WEIGHTED = 'false';
    assert.equal(weightedQuotaReserveTokens(128_000, 8_000, OPUS), 136_000);
  });
});

describe('billableOf：扣减与记账必须同源', () => {
  // 真值由 gateway 算好回填；这里只读不算，避免两处口径分叉。
  test('有 billableTokens 时原样采用', () => {
    assert.equal(billableOf({ inputTokens: 100, outputTokens: 50, billableTokens: 342 }), 342);
  });

  test('缺失（mock / 未过 maybeRecord）→ 回落裸 token 求和', () => {
    assert.equal(billableOf({ inputTokens: 100, outputTokens: 50 }), 150);
  });

  test('异常值（NaN / 负数）→ 回落，不把负额度退给用户', () => {
    assert.equal(billableOf({ inputTokens: 100, outputTokens: 50, billableTokens: NaN }), 150);
    assert.equal(billableOf({ inputTokens: 100, outputTokens: 50, billableTokens: -9 }), 150);
  });

  test('0 是合法值（缓存全命中且无输出时确实接近 0）', () => {
    assert.equal(billableOf({ inputTokens: 100, outputTokens: 0, billableTokens: 0 }), 0);
  });
});
