// 上游模型并发闸 — 纯单元测试（不连库、不联网、不触达任何 provider）。
//   cd server && node --import tsx --test test/llmGate.test.ts
//
// 覆盖 2026-07 压测 P0-2 的三条行为约定：
//   ① 并发不超过配置上限，超出的排队；
//   ② 排队超时降级为 AI_BUSY(503)，而不是把调用方永远挂住；
//   ③ 上游 429 触发整窗冷却（压测实测：429 之后连 12 并发复测都是 48/48 全挂，
//      说明是滚动时间窗限额，必须整窗停发而不是让每条请求各自重试）。
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  acquireLlmSlot,
  withLlmSlot,
  noteUpstreamRateLimited,
  llmGateStats,
  is429,
  retryAfterSecOf,
  __resetLlmGate,
} from '../src/services/llmGate.js';

const ENV_KEYS = [
  'LLM_GATE_ENABLED', 'LLM_MAX_CONCURRENCY', 'LLM_BURST_CONCURRENCY', 'LLM_BURST_QUIET_MS',
  'LLM_QUEUE_MAX', 'LLM_QUEUE_TIMEOUT_MS', 'LLM_COOLDOWN_BASE_MS', 'LLM_COOLDOWN_MAX_MS',
  'LLM_RAMP_START', 'LLM_RATE_MAX_PER_MIN',
  'LLM_AUX_MAX_CONCURRENCY', 'LLM_AUX_BURST_CONCURRENCY', 'LLM_AUX_QUEUE_TIMEOUT_MS',
  'AI_AUX_MODEL', 'AI_AUX_BASE_URL', 'AI_AUX_API_KEY', 'AI_AUX_PROVIDER',
] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  __resetLlmGate();
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  __resetLlmGate();
});

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('并发上限', () => {
  test('放行到上限后开始排队，释放一个才放行一个', async () => {
    process.env.LLM_MAX_CONCURRENCY = '2';
    process.env.LLM_BURST_CONCURRENCY = '2';

    const a = await acquireLlmSlot();
    const b = await acquireLlmSlot();
    assert.equal(llmGateStats().inFlight, 2);

    let thirdGranted = false;
    const third = acquireLlmSlot().then((s) => { thirdGranted = true; return s; });
    await tick();
    assert.equal(thirdGranted, false, '超过上限的请求应排队而不是直接放行');
    assert.equal(llmGateStats().queued, 1);

    a.release();
    const c = await third;
    assert.equal(thirdGranted, true, '有槽位释放后队首应被放行');
    assert.equal(llmGateStats().inFlight, 2);

    b.release();
    c.release();
    assert.equal(llmGateStats().inFlight, 0);
  });

  test('release 幂等：重复调用不会把 inFlight 减成负数', async () => {
    process.env.LLM_MAX_CONCURRENCY = '1';
    const s = await acquireLlmSlot();
    s.release();
    s.release();
    assert.equal(llmGateStats().inFlight, 0);
  });

  // 回归：Number('') === 0 而非 NaN。早期实现用 `Number(process.env[k] ?? '')` 判默认值，
  // 未设环境变量时会拿到 0，经 Math.max(1, 0) 变成并发上限 1——等于把上游吞吐锁死在 1，
  // 且不会有任何报错。默认值必须真的是默认值。
  test('未设环境变量时用文档中的默认值（8 并发 / 12 突发），不是 1', () => {
    const st = llmGateStats('main');
    assert.equal(st.maxConcurrency, 8);
    assert.equal(st.burstConcurrency, 12);
  });

  test('空串环境变量等同未设置', () => {
    process.env.LLM_MAX_CONCURRENCY = '   ';
    assert.equal(llmGateStats('main').maxConcurrency, 8);
  });

  test('LLM_GATE_ENABLED=false 时完全不拦（留给应急开关）', async () => {
    process.env.LLM_GATE_ENABLED = 'false';
    process.env.LLM_MAX_CONCURRENCY = '1';
    const slots = await Promise.all([acquireLlmSlot(), acquireLlmSlot(), acquireLlmSlot()]);
    assert.equal(slots.length, 3);
    for (const s of slots) s.release();
  });
});

describe('排队降级', () => {
  test('排队超时抛 AI_BUSY(503)，不把调用方永远挂住', async () => {
    process.env.LLM_MAX_CONCURRENCY = '1';
    process.env.LLM_BURST_CONCURRENCY = '1';
    process.env.LLM_QUEUE_TIMEOUT_MS = '1000'; // 下限就是 1s

    const held = await acquireLlmSlot();
    const err = await acquireLlmSlot().then(() => null, (e) => e as Error & { code?: string; statusCode?: number });
    assert.ok(err, '应当抛错而不是无限等待');
    assert.equal(err.code, 'AI_BUSY');
    assert.equal(err.statusCode, 503);
    assert.equal(llmGateStats().timedOut, 1);
    held.release();
  });

  test('队列满立即拒绝，不无界堆积', async () => {
    process.env.LLM_MAX_CONCURRENCY = '1';
    process.env.LLM_BURST_CONCURRENCY = '1';
    process.env.LLM_QUEUE_MAX = '1';
    process.env.LLM_QUEUE_TIMEOUT_MS = '60000';

    const held = await acquireLlmSlot();
    const queued = acquireLlmSlot();           // 占满队列
    await tick();
    const err = await acquireLlmSlot().then(() => null, (e) => e as Error & { code?: string });
    assert.equal(err?.code, 'AI_BUSY');
    assert.equal(llmGateStats().rejected, 1);

    held.release();
    (await queued).release();
  });
});

describe('429 整窗冷却', () => {
  test('收到 429 后停发新槽位，冷却期内排队而不是继续打上游', async () => {
    process.env.LLM_MAX_CONCURRENCY = '4';
    process.env.LLM_COOLDOWN_BASE_MS = '1000';
    process.env.LLM_QUEUE_TIMEOUT_MS = '60000';

    noteUpstreamRateLimited();
    const st = llmGateStats();
    assert.equal(st.coolingDown, true);
    assert.equal(st.ceiling, 0, '冷却期内允许的并发应为 0');

    let granted = false;
    const pending = acquireLlmSlot().then((s) => { granted = true; return s; });
    await tick();
    assert.equal(granted, false, '冷却期内不应放行');

    // 冷却到点后自动唤醒队列（不需要外部再触发）。
    await new Promise((r) => setTimeout(r, 1100));
    const s = await pending;
    assert.equal(granted, true, '冷却结束后队列应被自动唤醒');
    s.release();
  });

  test('Retry-After 优先于指数退避', () => {
    process.env.LLM_COOLDOWN_BASE_MS = '1000';
    noteUpstreamRateLimited(30);
    const st = llmGateStats();
    assert.ok(st.cooldownRemainingMs > 25_000, `应采信 Retry-After=30s，实际剩余 ${st.cooldownRemainingMs}ms`);
  });

  test('连续 429 指数退避且不超过上限', () => {
    process.env.LLM_COOLDOWN_BASE_MS = '1000';
    process.env.LLM_COOLDOWN_MAX_MS = '4000';
    for (let i = 0; i < 8; i++) noteUpstreamRateLimited();
    const st = llmGateStats();
    assert.equal(st.consecutive429, 8);
    assert.ok(st.cooldownRemainingMs <= 4000, `退避应封顶在 4000ms，实际 ${st.cooldownRemainingMs}ms`);
  });

  test('withLlmSlot 自动识别抛出的 429 并进入冷却', async () => {
    process.env.LLM_COOLDOWN_BASE_MS = '1000';
    const boom = Object.assign(new Error('OpenAI 兼容接口 429: too many requests'), { statusCode: 429 });
    await assert.rejects(withLlmSlot(async () => { throw boom; }));
    assert.equal(llmGateStats().coolingDown, true);
    assert.equal(llmGateStats().seen429, 1);
    assert.equal(llmGateStats().consecutive429, 1, '失败归还槽位不能把连续 429 误当成成功清零');
  });

  test('withLlmSlot 正常返回时归还槽位且不误判冷却', async () => {
    const out = await withLlmSlot(async () => 'ok');
    assert.equal(out, 'ok');
    assert.equal(llmGateStats().inFlight, 0);
    assert.equal(llmGateStats().coolingDown, false);
  });
});

describe('主/辅车道隔离', () => {
  test('aux 打满不影响 main 的槽位', async () => {
    process.env.LLM_MAX_CONCURRENCY = '2';
    process.env.LLM_BURST_CONCURRENCY = '2';
    process.env.LLM_AUX_MAX_CONCURRENCY = '1';
    process.env.LLM_AUX_BURST_CONCURRENCY = '1';

    const aux = await acquireLlmSlot('aux');
    assert.equal(llmGateStats('aux').inFlight, 1);
    assert.equal(llmGateStats('main').inFlight, 0, 'aux 占用不该记到 main 上');

    // aux 已满，但 main 仍然照常放行两个。
    const m1 = await acquireLlmSlot('main');
    const m2 = await acquireLlmSlot('main');
    assert.equal(llmGateStats('main').inFlight, 2);

    aux.release(); m1.release(); m2.release();
  });

  test('aux 的 429 冷却不牵连 main（独立账号才分车道，故不应互相拖累）', () => {
    process.env.LLM_COOLDOWN_BASE_MS = '5000';
    noteUpstreamRateLimited(undefined, 'aux');
    assert.equal(llmGateStats('aux').coolingDown, true);
    assert.equal(llmGateStats('main').coolingDown, false, 'main 不该被 aux 的限流拖进冷却');
  });

  test('aux 默认并发低于 main（后台任务不该和用户可见生成抢）', () => {
    assert.ok(
      llmGateStats('aux').maxConcurrency < llmGateStats('main').maxConcurrency,
      `aux=${llmGateStats('aux').maxConcurrency} 应小于 main=${llmGateStats('main').maxConcurrency}`,
    );
  });

  test('不传 lane 时等同 main（既有调用点行为不变）', async () => {
    process.env.LLM_MAX_CONCURRENCY = '1';
    process.env.LLM_BURST_CONCURRENCY = '1';
    const s = await acquireLlmSlot();
    assert.equal(llmGateStats('main').inFlight, 1);
    s.release();
  });
});

describe('429 识别', () => {
  test('覆盖 SDK 的 status、fetch 分支的 statusCode 与文案兜底', () => {
    assert.equal(is429({ status: 429 }), true, 'Anthropic SDK 用 err.status');
    assert.equal(is429({ statusCode: 429 }), true, 'openai/dify 分支显式塞的 statusCode');
    assert.equal(is429(new Error('Dify 429: rate limited')), true, '文案兜底');
    assert.equal(is429(new Error('Too Many Requests')), true);
    assert.equal(is429({ status: 500 }), false, '5xx 不是限流，不该触发冷却');
    assert.equal(is429(new Error('timeout')), false);
    assert.equal(is429(null), false);
  });

  test('retryAfterSecOf 从 headers / retryAfter 取值，非法值返回 undefined', () => {
    assert.equal(retryAfterSecOf({ headers: { 'retry-after': '12' } }), 12);
    assert.equal(retryAfterSecOf({ retryAfter: 5 }), 5);
    assert.equal(retryAfterSecOf({ headers: { 'retry-after': 'soon' } }), undefined);
    assert.equal(retryAfterSecOf(new Error('x')), undefined);
  });
});
