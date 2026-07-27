// mock 上游模拟（压测可测性）—— 纯单元测试。
//   cd server && node --import tsx --test test/mockUpstream.test.ts
//
// 要锁的核心是一条容易被忽略的事实：**mock 原本不过并发闸**。
// gateway 里 mock 是被直接调用的（只有真 provider 才 withLlmSlot），所以哪怕给 mock 加了延迟，
// llmGate 的队列深度/排队等待在压测里**依然恒为 0**——闸门与端点池这两个本轮新建的核心
// 在 S5 场景里等于没被测到。因此这里既要验「延迟生效」，更要验「真的占了槽位」。
//
// 同时锁住默认零影响：不配环境变量时必须同步直出、不碰闸门（生产走的就是这条）。
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mockUpstream, mockUpstreamEnabled } from '../src/llm/providers/mock.js';
import { llmGateStats, __resetLlmGate } from '../src/services/llmGate.js';

const ENV = [
  'AI_MOCK_LATENCY_MS', 'AI_MOCK_LATENCY_JITTER_MS', 'AI_MOCK_429_RATE',
  'LLM_MAX_CONCURRENCY', 'LLM_BURST_CONCURRENCY', 'LLM_QUEUE_TIMEOUT_MS', 'LLM_COOLDOWN_BASE_MS',
] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  __resetLlmGate();
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  __resetLlmGate();
});

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('默认关闭时零影响', () => {
  test('未配 AI_MOCK_LATENCY_MS → 不启用', () => {
    assert.equal(mockUpstreamEnabled(), false);
  });

  test('空串 / 0 / 非法值都等同未配置', () => {
    for (const v of ['', '   ', '0', 'abc', '-5']) {
      process.env.AI_MOCK_LATENCY_MS = v;
      assert.equal(mockUpstreamEnabled(), false, `AI_MOCK_LATENCY_MS=${JSON.stringify(v)} 不应启用`);
    }
  });

  test('关闭时立即返回，且完全不占闸门槽位', async () => {
    const t0 = Date.now();
    const out = await mockUpstream(() => 'ok');
    assert.equal(out, 'ok');
    assert.ok(Date.now() - t0 < 50, '不应有任何延迟');
    assert.equal(llmGateStats('main').granted, 0, '关闭时不该动用闸门');
    assert.equal(llmGateStats('main').inFlight, 0);
  });
});

describe('开启后表现得像真实上游', () => {
  test('注入延迟生效，并占用一个真实闸门槽位', async () => {
    process.env.AI_MOCK_LATENCY_MS = '120';
    const t0 = Date.now();
    const p = mockUpstream(() => 'ok');
    await tick();
    assert.equal(llmGateStats('main').inFlight, 1, '执行期间必须占着槽位——否则压测测不到队列');
    assert.equal(await p, 'ok');
    assert.ok(Date.now() - t0 >= 110, `延迟未生效，仅 ${Date.now() - t0}ms`);
    assert.equal(llmGateStats('main').inFlight, 0, '结束后必须归还');
    assert.equal(llmGateStats('main').granted, 1);
  });

  test('超过并发上限的请求排队，而不是一起打上游', async () => {
    process.env.AI_MOCK_LATENCY_MS = '150';
    process.env.LLM_MAX_CONCURRENCY = '2';
    process.env.LLM_BURST_CONCURRENCY = '2';
    process.env.LLM_QUEUE_TIMEOUT_MS = '60000';

    const all = [1, 2, 3, 4, 5].map((i) => mockUpstream(() => i));
    await tick();
    const st = llmGateStats('main');
    assert.equal(st.inFlight, 2, '在途应被压到配置上限');
    assert.equal(st.queued, 3, '其余应排队——这正是 S5 要观测的队列深度');

    assert.deepEqual(await Promise.all(all), [1, 2, 3, 4, 5]);
    assert.equal(llmGateStats('main').inFlight, 0);
    assert.ok(llmGateStats('main').maxQueueDepth >= 3, '队列深度峰值应被记录，供 /metrics 上报');
  });

  test('AI_MOCK_429_RATE=1 → 抛 429 并触发整窗冷却（零 Token 复现限流惩罚）', async () => {
    process.env.AI_MOCK_LATENCY_MS = '10';
    process.env.AI_MOCK_429_RATE = '1';
    process.env.LLM_COOLDOWN_BASE_MS = '2000';

    await assert.rejects(
      mockUpstream(() => 'never'),
      (e: Error & { statusCode?: number }) => e.statusCode === 429,
    );
    const st = llmGateStats('main');
    assert.equal(st.seen429, 1);
    assert.equal(st.coolingDown, true, '429 后应进入整窗冷却');
    assert.equal(st.ceiling, 0, '冷却期允许并发应为 0');
    assert.equal(st.consecutive429, 1, '失败归还槽位不能把连续 429 清零');
  });

  test('AI_MOCK_429_RATE=0（默认）不注入错误', async () => {
    process.env.AI_MOCK_LATENCY_MS = '10';
    assert.equal(await mockUpstream(() => 'ok'), 'ok');
    assert.equal(llmGateStats('main').seen429, 0);
    assert.equal(llmGateStats('main').coolingDown, false);
  });

  test('抖动叠加在基准之上，不会让耗时低于基准', async () => {
    process.env.AI_MOCK_LATENCY_MS = '60';
    process.env.AI_MOCK_LATENCY_JITTER_MS = '40';
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now();
      await mockUpstream(() => 'ok');
      const dt = Date.now() - t0;
      assert.ok(dt >= 55, `耗时 ${dt}ms 低于基准 60ms`);
      assert.ok(dt < 250, `耗时 ${dt}ms 明显超出 基准+抖动 上界`);
    }
  });

  test('可指定车道，aux 的模拟负载不占 main 的槽位', async () => {
    process.env.AI_MOCK_LATENCY_MS = '100';
    const p = mockUpstream(() => 'ok', 'aux');
    await tick();
    assert.equal(llmGateStats('aux').inFlight, 1);
    assert.equal(llmGateStats('main').inFlight, 0);
    await p;
  });
});
