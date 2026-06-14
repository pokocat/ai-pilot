// Token 计费 P1：价表与成本计算的纯函数测试（无需 DB，可本地直接跑）。
// 单位为人民币「微元」（1e-6 元）；OpenAI/Anthropic 美元价经 USD_TO_CNY(=7.2) 换算成元。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateCostMicros, rateFor, MODEL_RATES, DEFAULT_RATE } from '../src/data/modelPrices.js';

test('rateFor: 精确命中 / 带后缀前缀命中 / 未知兜底', () => {
  assert.equal(rateFor('gpt-4o').calibrated, true);
  // 模型名常带日期后缀 → 前缀匹配
  assert.equal(rateFor('gpt-4o-2024-08-06').calibrated, true);
  assert.deepEqual(rateFor('claude-3-5-sonnet-20241022').rate, MODEL_RATES['claude-3-5-sonnet']);
  // 默认 agnes 不在价表 → 兜底且标「待校准」
  const unknown = rateFor('agnes-2.0-flash');
  assert.equal(unknown.calibrated, false);
  assert.deepEqual(unknown.rate, DEFAULT_RATE);
});

test('estimateCostMicros: 微元 = tokens × 单价(元/1M)', () => {
  // gpt-4o 元价=美元价×7.2：in 2.5→18 / out 10→72。1000*18 + 500*72 = 54000 微元 = ¥0.054
  assert.equal(estimateCostMicros('gpt-4o', { inputTokens: 1000, outputTokens: 500, cachedInput: 0 }), 54000);
});

test('estimateCostMicros: 缓存输入按低价、fresh 不重复计', () => {
  // gpt-4o cachedIn 1.25→9：输入 1000（命中 400）+ 输出 0 = 600*18 + 400*9 = 14400
  assert.equal(estimateCostMicros('gpt-4o', { inputTokens: 1000, outputTokens: 0, cachedInput: 400 }), 14400);
});

test('estimateCostMicros: 未知模型用兜底单价（元）', () => {
  // DEFAULT_RATE in=1 / out=3（元/1M）：1000 in + 1000 out = 1000 + 3000 = 4000
  assert.equal(estimateCostMicros('agnes-2.0-flash', { inputTokens: 1000, outputTokens: 1000, cachedInput: 0 }), 4000);
});

test('estimateCostMicros: 负数/越界 cached 被夹紧，不会算出负成本', () => {
  assert.equal(estimateCostMicros('gpt-4o', { inputTokens: -5, outputTokens: -5, cachedInput: 999 }), 0);
});
