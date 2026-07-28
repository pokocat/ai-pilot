// 「缺失被当成 0」这一类缺陷的回归 —— 纯单元测试（不连库）。
//   cd server && node --import tsx --test test/silentZero.test.ts
//
// 2026-07-28 全仓排查的产物。同一根因在这个仓库里咬过四次，共同点都是
// **把「字段/变量缺失」和「值真的是 0」抹平，然后按 0 走正常逻辑**：
//   ① services/llmGate.ts   —— Number('') === 0 → 并发上限算成 1，锁死上游吞吐（已修）
//   ② app.ts MAX_IN_FLIGHT  —— 空串 → 0 → 被 `if (>0)` 判掉，过载闸静默关闭（本次修）
//   ③ app.ts RATE_LIMIT_MAX —— 空串 → max:0 → 每个请求都 429，全站宕机（本次修）
//   ④ providers/*.ts usage  —— provider 不回传 usage → {0,0,0} → 整条用量记录被丢弃，
//                              真金白银花掉却查不到任何行（本次改为计数暴露）
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { envNum } from '../src/env.js';
import { noteUsageUnreported, usageUnreportedNow, renderMetrics, __resetMetrics } from '../src/services/metrics.js';

const KEY = 'TEST_ENV_NUM_PROBE';
let saved: string | undefined;
beforeEach(() => { saved = process.env[KEY]; delete process.env[KEY]; __resetMetrics(); });
afterEach(() => { if (saved === undefined) delete process.env[KEY]; else process.env[KEY] = saved; __resetMetrics(); });

describe('envNum：空串不能被当成显式 0', () => {
  test('未设置 → 默认值', () => {
    assert.equal(envNum(KEY, 200), 200);
  });

  // 这条是核心：`Number(process.env.X ?? 200)` 在这里会返回 0。
  test('设了但留空 → 默认值，而不是 0', () => {
    process.env[KEY] = '';
    assert.equal(envNum(KEY, 200), 200);
    assert.notEqual(envNum(KEY, 200), 0, '返回 0 就会让过载闸静默关闭 / 限流把全站打死');
  });

  test('纯空白同样按未设置处理', () => {
    process.env[KEY] = '   ';
    assert.equal(envNum(KEY, 200), 200);
  });

  test('非数字 / 负数 → 默认值', () => {
    process.env[KEY] = 'abc';
    assert.equal(envNum(KEY, 200), 200);
    process.env[KEY] = '-5';
    assert.equal(envNum(KEY, 200), 200);
  });

  test('显式写 0 仍然是 0（关闭开关必须可用）', () => {
    process.env[KEY] = '0';
    assert.equal(envNum(KEY, 200), 0);
  });

  test('正常数值原样返回', () => {
    process.env[KEY] = '350';
    assert.equal(envNum(KEY, 200), 350);
  });
});

describe('provider 未回传 usage 必须可见，不能静默漏账', () => {
  test('按 provider+model 分别计数', () => {
    noteUsageUnreported('openai', 'agnes-2.0-flash');
    noteUsageUnreported('openai', 'agnes-2.0-flash');
    noteUsageUnreported('claude', 'claude-opus-4-6');
    const m = usageUnreportedNow();
    assert.equal(m.get('openai|agnes-2.0-flash'), 2);
    assert.equal(m.get('claude|claude-opus-4-6'), 1);
  });

  test('/metrics 里带标签导出，运维能据此发现口径缺口', async () => {
    noteUsageUnreported('openai', 'agnes-2.0-flash');
    const body = await renderMetrics();
    assert.match(body, /junshi_usage_unreported_total/);
    assert.match(body, /provider="openai"/);
    assert.match(body, /model="agnes-2\.0-flash"/);
  });

  test('没有漏账时导出 0 而不是整条指标消失（否则告警无法区分「没漏」和「没采到」）', async () => {
    const body = await renderMetrics();
    assert.match(body, /junshi_usage_unreported_total 0/);
  });
});
