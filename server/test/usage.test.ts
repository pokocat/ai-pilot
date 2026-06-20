// Token 成本核算：单价（元 / 1M token）× 用量 → 微元（1e-6 元）的纯函数测试（无需 DB，可本地直接跑）。
// 单价由运营在「模型」配置里填；没配 → 传 {in:0,out:0} → 成本 0（不做任何内置估算/回退）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateCostMicros } from '../src/data/modelPrices.js';

test('estimateCostMicros: 微元 = tokens × 单价(元/1M)', () => {
  // 单价 in 18 / out 72（元/1M）：1000*18 + 500*72 = 54000 微元 = ¥0.054
  assert.equal(estimateCostMicros({ inputTokens: 1000, outputTokens: 500, cachedInput: 0 }, { in: 18, out: 72 }), 54000);
});

test('estimateCostMicros: 缓存输入按低价、fresh 不重复计', () => {
  // in 18 / cachedIn 9：输入 1000（命中 400）+ 输出 0 = 600*18 + 400*9 = 14400
  assert.equal(estimateCostMicros({ inputTokens: 1000, outputTokens: 0, cachedInput: 400 }, { in: 18, out: 72, cachedIn: 9 }), 14400);
});

test('estimateCostMicros: 没配单价（0）→ 成本计 0', () => {
  assert.equal(estimateCostMicros({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, { in: 0, out: 0 }), 0);
});

test('estimateCostMicros: 运营填的自定义单价', () => {
  // in 2 / out 8（元/1M）：1000*2 + 1000*8 = 10000 微元
  assert.equal(estimateCostMicros({ inputTokens: 1000, outputTokens: 1000 }, { in: 2, out: 8 }), 10000);
});

test('estimateCostMicros: 负数/越界 cached 被夹紧，不会算出负成本', () => {
  assert.equal(estimateCostMicros({ inputTokens: -5, outputTokens: -5, cachedInput: 999 }, { in: 18, out: 72 }), 0);
});
