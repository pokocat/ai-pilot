// 端点检测体系（2026-08-07 · 重设计二期）。
//   cd server && npm test -- test/aiProbe.test.ts
//
// 不联网：用 provider='mock' 跑编排逻辑，验的是**探活自己的骨架**——
// 结果结构、能力回填、运营锁定优先、一键全停、models 地址拼装。
// 各检测项打给真实上游的那部分由「测试连接」和线上定时探活覆盖，不在单测里造假响应，
// 那样只会测出我们对上游的想象。
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import {
  runProbes, probeEndpointById, modelsUrl, probeSchedulerEnabled, scheduledProbeSweep,
  scheduledProbesForPurposes, ALL_PROBES, SCHEDULED_PROBES, type ProbeKind,
} from '../src/services/aiProbe.js';
import type { ResolvedAiConfig } from '../src/services/aiConfig.js';
import { createEndpoint, __wipeAiV2 } from '../src/services/aiV2Admin.js';

const AT = new Date('2026-08-07T10:00:00.000Z');

const mockCfg = (over: Partial<ResolvedAiConfig> = {}): ResolvedAiConfig => ({
  provider: 'mock', label: '探活用', baseUrl: '', model: 'template', apiKey: '',
  embeddingModel: '', temperature: 0.7, thinkingMode: 'disabled', thinkingBudget: 1024,
  timeoutMs: 20_000,
  embeddingEnabled: false, embeddingBaseUrl: '', embeddingApiKey: '',
  rerankEnabled: false, rerankModel: '', rerankBaseUrl: '', rerankApiKey: '',
  ...over,
});

before(async () => { await __wipeAiV2(); });
after(async () => { await __wipeAiV2(); await prisma.$disconnect(); });

describe('GET /models 的地址拼装', () => {
  test('OpenAI 兼容：baseUrl 已含 /v1，直接接 /models', () => {
    assert.equal(modelsUrl('openai_chat', 'https://api.qnaigc.com/v1'), 'https://api.qnaigc.com/v1/models');
    assert.equal(modelsUrl('openai_chat', 'https://api.qnaigc.com/v1/'), 'https://api.qnaigc.com/v1/models');
  });

  test('Anthropic 协议：baseUrl 是协议根，要自己补 /v1', () => {
    assert.equal(modelsUrl('anthropic', 'https://api.qnaigc.com'), 'https://api.qnaigc.com/v1/models');
    // 已经带版本段的不重复补。
    assert.equal(modelsUrl('anthropic', 'https://api.qnaigc.com/v1'), 'https://api.qnaigc.com/v1/models');
  });

  test('baseUrl 为空（官方直连未配网关）→ 空串，调用方据此跳过', () => {
    assert.equal(modelsUrl('anthropic', ''), '');
  });
});

describe('探活编排', () => {
  test('每一项都产出独立记录（kind / ok / at / 耗时），不会因某项失败中断其它项', async () => {
    const kinds: ProbeKind[] = ['connectivity', 'thinking', 'tools'];
    const out = await runProbes(mockCfg(), kinds, AT);
    assert.deepEqual(out.results.map((r) => r.kind), kinds);
    for (const r of out.results) {
      assert.equal(r.at, AT.toISOString());
      assert.equal(typeof r.latencyMs, 'number');
      assert.equal(typeof r.ok, 'boolean');
    }
  });

  test('整体 ok = 所有项都 ok', async () => {
    const out = await runProbes(mockCfg(), ['connectivity'], AT);
    // mock 没有真实 key，connectivity 必然不通——这里要的就是「失败被如实记下来」。
    assert.equal(out.ok, out.results.every((r) => r.ok));
    assert.equal(out.ok, false);
    assert.ok(out.results[0].error, '失败必须带原因，不能只给个 false');
  });

  test('探活失败 → 回填 caps 证伪该能力（校验器据此拦截后续配置）', async () => {
    const out = await runProbes(mockCfg({ thinkingMode: 'enabled' }), ['tools'], AT);
    assert.equal(out.caps.tools, 'no');
  });

  test('运营锁定的能力项不被探活覆盖（探活是证据，运营的显式判断优先）', async () => {
    const out = await runProbes(
      mockCfg({ capsJson: { tools: 'yes', locked: ['tools'] } }),
      ['tools'],
      AT,
    );
    assert.equal(out.caps.tools, 'yes', '锁定后不该被探活改写');
  });

  test('已有 caps 被保留，只覆盖本次探到的那几项', async () => {
    const out = await runProbes(
      mockCfg({ capsJson: { thinking: 'yes', vision: 'no', maxOutputTokens: 8192 } }),
      ['tools'],
      AT,
    );
    assert.equal(out.caps.thinking, 'yes');
    assert.equal(out.caps.vision, 'no');
    assert.equal(out.caps.maxOutputTokens, 8192);
    assert.equal(out.caps.tools, 'no');
  });

  test('脏 capsJson 不会把探活打挂（退化成空能力）', async () => {
    const out = await runProbes(mockCfg({ capsJson: '这不是对象' }), ['tools'], AT);
    assert.equal(out.caps.tools, 'no');
  });
});

describe('落库与回填', () => {
  test('probeEndpointById 把结果与能力写回该行；未配 key 的行不外呼、直接如实记未配置', async () => {
    const id = await createEndpoint({ label: 'TEST-probe-nokey', provider: 'openai', baseUrl: 'https://x/v1', model: 'm', apiKey: '' });
    const row = { id };
    const out = await probeEndpointById(row.id, ['connectivity'], AT);
    assert.ok(out);
    assert.equal(out!.ok, false);
    assert.match(out!.results[0].error ?? '', /API Key/);

    const after = await prisma.aiEndpoint.findUnique({ where: { id: row.id } });
    // 未配 key 走的是早退分支：不该把「没试过」写成「试过且失败」。
    assert.equal(after?.lastProbeAt, null);
  });

  test('mock 端点探活会落库（含 lastProbeOk 与逐项结果）', async () => {
    const id = await createEndpoint({ label: 'TEST-probe-mock', provider: 'mock', baseUrl: '', model: 'template', apiKey: '' });
    const row = { id };
    const out = await probeEndpointById(row.id, ['connectivity'], AT);
    assert.ok(out);
    const after = await prisma.aiEndpoint.findUnique({ where: { id: row.id } });
    assert.equal(after?.lastProbeAt?.toISOString(), AT.toISOString());
    assert.equal(after?.lastProbeOk, out!.ok);
    const probe = after?.probeJson as { results?: { kind: string }[] } | null;
    assert.equal(probe?.results?.[0]?.kind, 'connectivity');
  });

  test('不同周期的探活结果按 kind 合并保存，高频项不覆盖低频项', async () => {
    const id = await createEndpoint({ label: 'TEST-probe-merge', provider: 'mock', baseUrl: '', model: 'template', apiKey: '' });
    await probeEndpointById(id, ['thinking'], AT);
    await probeEndpointById(id, ['connectivity'], new Date(AT.getTime() + 10 * 60_000));
    const after = await prisma.aiEndpoint.findUnique({ where: { id } });
    const probe = after?.probeJson as { results?: { kind: string; at: string }[] } | null;
    assert.deepEqual(probe?.results?.map((r) => r.kind), ['connectivity', 'thinking']);
    assert.equal(probe?.results?.find((r) => r.kind === 'thinking')?.at, AT.toISOString());
  });

  test('embedding/rerank 端点会投影到各自协议配置，不误读全局 chat 开关', async () => {
    const id = await createEndpoint({
      label: 'TEST-probe-purpose-config', provider: 'mock', baseUrl: 'http://127.0.0.1:1/v1',
      model: 'purpose-model', apiKey: 'sk-real-key-for-local-test',
    });
    const out = await probeEndpointById(id, ['embedding', 'rerank'], AT);
    assert.ok(out);
    for (const result of out!.results) {
      assert.doesNotMatch(result.error ?? '', /未开启|缺少模型/, `${result.kind} 不应退回全局 chat 配置`);
    }
  });

  test('模型不存在 → null，不抛', async () => {
    assert.equal(await probeEndpointById('不存在的id', ['connectivity'], AT), null);
  });
});

describe('定时探活', () => {
  test('AI_PROBE_SCHEDULED=false 一键全停（定时项是真实计费请求，必须能不发版关掉）', async () => {
    const saved = process.env.AI_PROBE_SCHEDULED;
    try {
      process.env.AI_PROBE_SCHEDULED = 'false';
      assert.equal(probeSchedulerEnabled(), false);
      // 停用时 sweep 直接返回，不碰任何端点。
      await scheduledProbeSweep(AT);
    } finally {
      if (saved === undefined) delete process.env.AI_PROBE_SCHEDULED; else process.env.AI_PROBE_SCHEDULED = saved;
    }
    assert.equal(probeSchedulerEnabled(), true);
  });

  test('定时项的周期是「越贵越少跑」：连通性最密，模型范围最疏', () => {
    const by = Object.fromEntries(SCHEDULED_PROBES.map((p) => [p.kind, p.everyMs]));
    assert.ok(by.connectivity < by.thinking, '连通性应比 thinking 跑得密');
    assert.ok(by.thinking < by.model_scope, 'thinking 应比模型范围跑得密');
    // 定时项必须是 ALL_PROBES 的子集，否则调度会跑一个不存在的检测。
    for (const p of SCHEDULED_PROBES) assert.ok(ALL_PROBES.includes(p.kind), `${p.kind} 不在 ALL_PROBES 里`);
  });

  test('定时探活按在线用途选协议：嵌入/重排绝不走聊天 connectivity', () => {
    assert.deepEqual(
      scheduledProbesForPurposes(['embedding']).map((p) => p.kind),
      ['embedding'],
    );
    assert.deepEqual(
      scheduledProbesForPurposes(['rerank']).map((p) => p.kind),
      ['rerank'],
    );
    assert.deepEqual(
      scheduledProbesForPurposes(['chat']).map((p) => p.kind),
      ['connectivity', 'thinking', 'model_scope'],
    );
    assert.deepEqual(
      scheduledProbesForPurposes(['chat', 'embedding']).map((p) => p.kind),
      ['connectivity', 'embedding', 'thinking', 'model_scope'],
    );
    assert.deepEqual(scheduledProbesForPurposes([]), [], '未挂在线 route 的端点不能定时探活');
  });

  test('未配 key 的端点被定时探活跳过（不浪费也不刷错误）', async () => {
    const id = await createEndpoint({ label: 'TEST-probe-skip', provider: 'openai', baseUrl: 'https://x/v1', model: 'm', apiKey: '' });
    const row = { id };
    await scheduledProbeSweep(AT);
    const after = await prisma.aiEndpoint.findUnique({ where: { id: row.id } });
    assert.equal(after?.lastProbeAt, null);
  });
});

describe('探活耗时必须是真的', () => {
  test('latencyMs 反映实际耗时，不能恒为 0', async () => {
    // 这条针对一个真实踩过的坑：`{ ms: Date.now() - t0, value: await fn() }` 里 ms 先求值、
    // 恒等于 0，而单测不断言耗时就完全看不出来——只有拿真实上游对一次才暴露
    // （2026-08-08 预发：探活记 0ms、自测墙钟 3374ms）。指标 junshi_ai_endpoint_probe_duration_seconds
    // 因此一直在记 0，等于废的。
    const slow = mockCfg({ baseUrl: 'https://slow.invalid/v1', provider: 'openai', apiKey: 'sk-real-key-x' });
    const out = await runProbes(slow, ['model_scope'], AT);
    const r = out.results[0];
    assert.ok((r.latencyMs ?? -1) > 0, `耗时应为正数，实际 ${r.latencyMs}`);
  });
});
