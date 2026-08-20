// 模型调用侧洪水闸（llmGate.assertUpstreamCallBudget / noteUpstreamOutcall）。
//
// 这道闸是「一天刷几万次」这类事故的最终止损位：2026-08-19 单会话 12 小时打出 23,235 次
// 真实上游调用，HTTP 限流拦不住（那些调用是 worker 租约抖动打出来的，不走 HTTP 层）。
// 这里的用例钉的是四件事：单会话超限拦、全局超限拦、别的会话不受牵连、
// 以及 UPSTREAM_FLOOD 不可转移（否则会把配额烧到别的端点上、还把无辜端点标冷却）。
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { assertUpstreamCallBudget, noteUpstreamOutcall, __resetUpstreamFlood } from '../src/services/llmGate.js';
import { isTransferable, withEndpoint, __setPoolForTest, __resetLlmPool } from '../src/services/llmPool.js';
import type { ResolvedAiConfig } from '../src/services/aiConfig.js';

const ENV_S = 'LLM_FLOOD_SESSION_HOURLY';
const ENV_G = 'LLM_FLOOD_GLOBAL_HOURLY';
let savedS: string | undefined;
let savedG: string | undefined;

beforeEach(() => {
  savedS = process.env[ENV_S]; savedG = process.env[ENV_G];
  __resetUpstreamFlood();
});
afterEach(() => {
  if (savedS === undefined) delete process.env[ENV_S]; else process.env[ENV_S] = savedS;
  if (savedG === undefined) delete process.env[ENV_G]; else process.env[ENV_G] = savedG;
  __resetUpstreamFlood();
  __resetLlmPool();
});

function floodOf(fn: () => void): { code?: string; statusCode?: number } | null {
  try { fn(); return null; } catch (err) { return err as { code?: string; statusCode?: number }; }
}

describe('模型调用侧洪水闸', () => {
  test('单会话超限 → 抛 UPSTREAM_FLOOD；别的会话与全局不受牵连', () => {
    process.env[ENV_S] = '5';
    process.env[ENV_G] = '100000';
    for (let i = 0; i < 5; i++) noteUpstreamOutcall('sess-a');
    const err = floodOf(() => assertUpstreamCallBudget('sess-a'));
    assert.equal(err?.code, 'UPSTREAM_FLOOD');
    assert.equal(err?.statusCode, 429);
    // 无辜会话照常
    assert.equal(floodOf(() => assertUpstreamCallBudget('sess-b')), null);
    // 无会话键（纯全局口径）也照常——全局远没到
    assert.equal(floodOf(() => assertUpstreamCallBudget(null)), null);
  });

  test('全局超限 → 无论哪个会话都拦（兜「轮换会话键」的刷法）', () => {
    process.env[ENV_S] = '100000';
    process.env[ENV_G] = '8';
    for (let i = 0; i < 8; i++) noteUpstreamOutcall(`rotate-${i}`); // 每次换一个键
    const err = floodOf(() => assertUpstreamCallBudget('fresh-session'));
    assert.equal(err?.code, 'UPSTREAM_FLOOD');
  });

  test('设 0 关闭对应尺子', () => {
    process.env[ENV_S] = '0';
    process.env[ENV_G] = '0';
    for (let i = 0; i < 1000; i++) noteUpstreamOutcall('sess-any');
    assert.equal(floodOf(() => assertUpstreamCallBudget('sess-any')), null);
  });

  // 这条是钱的问题：UPSTREAM_FLOOD 的 statusCode 是 429，而 isTransferable 对 429 默认放行转移。
  // 若不显式排除，闸门每拦一次，端点池就换个端点再打一次——拦截变成了扇出。
  test('UPSTREAM_FLOOD 不可转移（尽管 statusCode=429）', () => {
    const err = Object.assign(new Error('flood'), { code: 'UPSTREAM_FLOOD', statusCode: 429 });
    assert.equal(isTransferable(err), false);
    // 对照：真正的上游 429 仍然可转移
    assert.equal(isTransferable(Object.assign(new Error('rate limited'), { statusCode: 429 })), true);
  });

  test('withEndpoint 集成：超限时外呼函数一次都不被调用', async () => {
    process.env[ENV_S] = '3';
    process.env[ENV_G] = '100000';
    __setPoolForTest([], { mode: 'single', sticky: true });
    const cfg = { provider: 'openai', label: 't', baseUrl: 'https://x.test', apiKey: 'sk-real-t', model: 'm', lane: 'main' } as unknown as ResolvedAiConfig;

    let calls = 0;
    // 前 3 次正常放行（withEndpoint 内部会经 noteEndpointAttempt 计数）
    for (let i = 0; i < 3; i++) {
      await withEndpoint(cfg, async () => { calls += 1; return 'ok'; }, { affinityKey: 'sess-int' });
    }
    assert.equal(calls, 3);
    // 第 4 次在外呼前被拦——fn 不该再被执行
    await assert.rejects(
      () => withEndpoint(cfg, async () => { calls += 1; return 'ok'; }, { affinityKey: 'sess-int' }),
      (err: { code?: string }) => err.code === 'UPSTREAM_FLOOD',
    );
    assert.equal(calls, 3, '超限后外呼函数一次都不许再执行——闸门的意义就是不花这笔钱');
  });
});
