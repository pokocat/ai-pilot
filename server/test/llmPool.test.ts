// 上游端点池：路由与故障转移 — 纯单元测试（不连库、不联网、不触达任何 provider）。
//   cd server && node --import tsx --test test/llmPool.test.ts
//
// 锁住四条设计约定：
//   ① **分布式一致**：同样的输入，任意实例独立算出同样的候选顺序（无需协调）；
//   ② **会话粘性**：同一会话固定落同一端点——上游提示词缓存按账号隔离，打散就归零；
//   ③ **最小重映射**：一个端点冷却下线，只有它承载的那部分会话迁走，其余不动；
//   ④ **故障转移**：429/5xx 换端点重试；4xx 不换（换了也一样错）。
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveCandidates, withEndpoint, coolEndpoint, isTransferable,
  __resetLlmPool, __setPoolForTest, type PoolEndpoint,
} from '../src/services/llmPool.js';
import { __resetLlmGate } from '../src/services/llmGate.js';
import type { ResolvedAiConfig } from '../src/services/aiConfig.js';

const base: ResolvedAiConfig = {
  provider: 'openai', label: 'base', baseUrl: 'https://base/v1', model: 'base-model',
  apiKey: 'sk-base', embeddingModel: '', temperature: 0.7,
  thinkingMode: 'disabled', thinkingBudget: 1024, timeoutMs: 60_000,
  embeddingEnabled: false, embeddingBaseUrl: '', embeddingApiKey: '',
  rerankEnabled: false, rerankModel: '', rerankBaseUrl: '', rerankApiKey: '',
};

const ep = (id: string, over: Partial<PoolEndpoint> = {}): PoolEndpoint => ({
  id, label: id, provider: 'openai', baseUrl: `https://${id}/v1`, apiKey: `sk-${id}`,
  model: `m-${id}`, temperature: 0.7, thinkingMode: 'disabled', thinkingBudget: 1024,
  weight: 1, tier: 0, maxConcurrency: 0, ...over,
});

const POOL = [ep('a'), ep('b'), ep('c')];
function usePool(endpoints = POOL, sticky = true) {
  __setPoolForTest(endpoints, { mode: 'pool', sticky });
}

let savedEnv: string | undefined;
beforeEach(() => {
  savedEnv = process.env.LLM_POOL_MAX_ATTEMPTS;
  __resetLlmPool();
  __resetLlmGate();
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.LLM_POOL_MAX_ATTEMPTS;
  else process.env.LLM_POOL_MAX_ATTEMPTS = savedEnv;
  __resetLlmPool();
  __resetLlmGate();
});

describe('未启用池时零变化', () => {
  test('mode=single → 只有传入的 base 一个候选', async () => {
    __setPoolForTest(POOL, { mode: 'single', sticky: true });
    const c = await resolveCandidates(base);
    assert.equal(c.length, 1);
    assert.equal(c[0], base, '必须原样返回，调用方据此判断「没走池」');
  });

  test('mode=pool 但池为空 → 同样回退 base', async () => {
    __setPoolForTest([], { mode: 'pool', sticky: true });
    const c = await resolveCandidates(base);
    assert.equal(c[0], base);
  });

  test('辅助档显式绕过主端点池，保留 AI_AUX_* 选择的模型与账号', async () => {
    usePool();
    const aux = { ...base, model: 'aux-model', apiKey: 'sk-aux', lane: 'aux' as const, poolBypass: true };
    const c = await resolveCandidates(aux);
    assert.deepEqual(c, [aux]);
    assert.equal(c[0].endpointId, undefined);
  });

  test('只选择与当前 provider 相同协议的端点，避免跨协议误发请求', async () => {
    usePool([
      ep('oa'),
      ep('cl', { provider: 'claude', baseUrl: 'https://claude.example', model: 'claude-opus-4-6' }),
    ]);
    const c = await resolveCandidates(base, { affinityKey: 'k' });
    assert.deepEqual(c.map((x) => x.endpointId), ['oa']);
  });
});

describe('会话粘性（保住上游提示词缓存）', () => {
  test('同一会话反复解析恒定落同一端点', async () => {
    usePool();
    const picks = new Set<string>();
    for (let i = 0; i < 20; i++) {
      picks.add((await resolveCandidates(base, { affinityKey: 'session-42' }))[0].endpointId!);
    }
    assert.equal(picks.size, 1, `同一会话应恒定落同一端点，实际落了 ${[...picks].join(',')}`);
  });

  test('不同会话会分散到不同端点（不是所有流量都压一个）', async () => {
    usePool();
    const picks = new Set<string>();
    for (let i = 0; i < 200; i++) {
      picks.add((await resolveCandidates(base, { affinityKey: `s${i}` }))[0].endpointId!);
    }
    assert.equal(picks.size, 3, '三个等权端点应该都被用到');
  });

  test('sticky=false 时同一会话会漂移（明确要均散时才关）', async () => {
    usePool(POOL, false);
    const picks = new Set<string>();
    for (let i = 0; i < 60; i++) {
      picks.add((await resolveCandidates(base, { affinityKey: 'same' }))[0].endpointId!);
    }
    assert.ok(picks.size > 1, 'sticky 关闭后不应再固定落同一端点');
  });
});

describe('分布式一致性与最小重映射', () => {
  test('无状态：两个「实例」独立解析，候选顺序完全一致', async () => {
    usePool();
    const inst1 = (await resolveCandidates(base, { affinityKey: 'k' })).map((c) => c.endpointId);
    __resetLlmPool();       // 模拟另一个进程：无任何共享内存状态
    usePool();
    const inst2 = (await resolveCandidates(base, { affinityKey: 'k' })).map((c) => c.endpointId);
    assert.deepEqual(inst1, inst2, 'HRW 必须只依赖 key + 端点集，不依赖本地计数器');
  });

  test('权重生效：权重高的端点承载更多会话', async () => {
    usePool([ep('big', { weight: 8 }), ep('small', { weight: 1 })]);
    let big = 0;
    const N = 500;
    for (let i = 0; i < N; i++) {
      if ((await resolveCandidates(base, { affinityKey: `s${i}` }))[0].endpointId === 'big') big++;
    }
    // 理论 8/9 ≈ 89%；给足抽样容差，只断言「显著偏向且没把小的饿死」。
    assert.ok(big / N > 0.75, `big 应承载多数流量，实际 ${(big / N * 100).toFixed(0)}%`);
    assert.ok(big / N < 0.99, `small 不应被完全饿死，实际 big ${(big / N * 100).toFixed(0)}%`);
  });

  test('移除一个端点只重映射它自己承载的那部分（一致性哈希性质）', async () => {
    const keys = Array.from({ length: 300 }, (_, i) => `s${i}`);
    usePool();
    const before = new Map<string, string>();
    for (const k of keys) before.set(k, (await resolveCandidates(base, { affinityKey: k }))[0].endpointId!);

    __resetLlmPool();
    usePool([ep('a'), ep('b')]); // c 下线
    let moved = 0, movedNotOnC = 0;
    for (const k of keys) {
      const now = (await resolveCandidates(base, { affinityKey: k }))[0].endpointId!;
      if (now !== before.get(k)) { moved++; if (before.get(k) !== 'c') movedNotOnC++; }
    }
    assert.equal(movedNotOnC, 0, '原本不在 c 上的会话一个都不该迁移');
    assert.ok(moved > 0 && moved < keys.length * 0.5, `只该迁走 c 承载的约 1/3，实际迁走 ${moved}/${keys.length}`);
  });
});

describe('冷却与降级 tier', () => {
  test('冷却中的端点排到最后，但不剔除（全冷却时仍要有东西可试）', async () => {
    usePool();
    const first = (await resolveCandidates(base, { affinityKey: 'k' }))[0].endpointId!;
    await coolEndpoint(first, 60_000, 'rate_limited');
    const after = await resolveCandidates(base, { affinityKey: 'k' });
    assert.notEqual(after[0].endpointId, first, '冷却的端点不该还排第一');
    assert.equal(after[after.length - 1].endpointId, first, '冷却的端点应排到最后而不是消失');
    assert.equal(after.length, 3);
  });

  test('tier≥1 只在低 tier 全冷却时才排到前面', async () => {
    usePool([ep('p1'), ep('p2'), ep('backup', { tier: 1 })]);
    const normal = await resolveCandidates(base, { affinityKey: 'k' });
    assert.ok(normal.slice(0, 2).every((c) => c.endpointId !== 'backup'), 'tier1 平时不该排进前两位');

    await coolEndpoint('p1', 60_000, 'rate_limited');
    await coolEndpoint('p2', 60_000, 'rate_limited');
    const degraded = await resolveCandidates(base, { affinityKey: 'k' });
    assert.equal(degraded[0].endpointId, 'backup', 'tier0 全冷却后才轮到降级备份');
  });
});

describe('故障转移', () => {
  test('429 → 冷却当前端点并换下一个重试', async () => {
    usePool();
    const tried: string[] = [];
    const out = await withEndpoint(base, async (cfg) => {
      tried.push(cfg.endpointId!);
      if (tried.length === 1) throw Object.assign(new Error('rate limited'), { statusCode: 429 });
      return 'ok';
    }, { affinityKey: 'k' });

    assert.equal(out, 'ok');
    assert.equal(tried.length, 2, '第一次 429 后应转移到第二个端点');
    assert.notEqual(tried[0], tried[1]);
    // 失败的那个应已进冷却 → 下次解析不再排第一
    const next = await resolveCandidates(base, { affinityKey: 'k' });
    assert.notEqual(next[0].endpointId, tried[0]);
  });

  test('5xx 也转移；4xx 不转移（换端点也一样错）', async () => {
    usePool();
    let calls = 0;
    await assert.rejects(withEndpoint(base, async () => {
      calls++;
      throw Object.assign(new Error('bad request'), { statusCode: 400 });
    }, { affinityKey: 'k' }));
    assert.equal(calls, 1, '400 只该试一次');

    __resetLlmPool(); __resetLlmGate(); usePool();
    calls = 0;
    await assert.rejects(withEndpoint(base, async () => {
      calls++;
      throw Object.assign(new Error('upstream boom'), { statusCode: 503 });
    }, { affinityKey: 'k' }));
    assert.ok(calls > 1, `5xx 应转移重试，实际只试了 ${calls} 次`);
  });

  test('转移次数有上限，不会把所有端点挨个打一遍', async () => {
    process.env.LLM_POOL_MAX_ATTEMPTS = '2';
    usePool();
    let calls = 0;
    await assert.rejects(withEndpoint(base, async () => {
      calls++;
      throw Object.assign(new Error('rate limited'), { statusCode: 429 });
    }, { affinityKey: 'k' }));
    assert.equal(calls, 2);
  });

  test('AI_BUSY / 审核拦截不转移——那是我方主动降级，不是端点的问题', () => {
    assert.equal(isTransferable(Object.assign(new Error('busy'), { code: 'AI_BUSY', statusCode: 503 })), false);
    assert.equal(isTransferable(Object.assign(new Error('blocked'), { code: 'MODERATION_BLOCK' })), false);
    assert.equal(isTransferable(Object.assign(new Error('truncated'), { code: 'AI_OUTPUT_TRUNCATED' })), false);
    assert.equal(isTransferable(Object.assign(new Error('rl'), { statusCode: 429 })), true);
    assert.equal(isTransferable(Object.assign(new Error('boom'), { statusCode: 502 })), true);
    assert.equal(isTransferable(Object.assign(new Error('timeout'), { code: 'AI_TIMEOUT' })), true);
    assert.equal(isTransferable(Object.assign(new Error('nope'), { statusCode: 401 })), false);
  });

  test('成功路径下 cfg 带的是选中端点的 baseUrl/key/model，不是 base 的', async () => {
    usePool([ep('thinking', { thinkingMode: 'enabled', thinkingBudget: 4096, temperature: 0.3 })]);
    const seen = await withEndpoint(base, async (cfg) => cfg, { affinityKey: 'k' });
    assert.ok(seen.endpointId);
    assert.equal(seen.baseUrl, `https://${seen.endpointId}/v1`);
    assert.equal(seen.apiKey, `sk-${seen.endpointId}`);
    assert.equal(seen.model, `m-${seen.endpointId}`);
    assert.equal(seen.thinkingMode, 'enabled');
    assert.equal(seen.thinkingBudget, 4096);
    assert.equal(seen.temperature, 0.3, '端点池必须保留配置温度；请求层再按 Thinking 临时锁为 1');
    assert.notEqual(seen.baseUrl, base.baseUrl);
  });

  test('达到尝试上限的最后一个失败端点也会进入冷却', async () => {
    process.env.LLM_POOL_MAX_ATTEMPTS = '1';
    usePool([ep('a'), ep('b')]);
    const first = (await resolveCandidates(base, { affinityKey: 'last-attempt' }))[0].endpointId!;
    await assert.rejects(withEndpoint(base, async () => {
      throw Object.assign(new Error('upstream boom'), { statusCode: 503 });
    }, { affinityKey: 'last-attempt' }));
    const next = await resolveCandidates(base, { affinityKey: 'last-attempt' });
    assert.notEqual(next[0].endpointId, first, '最后一次失败也必须共享冷却，不能继续排第一');
  });
});
