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
  runProbes, probeModelById, modelsUrl, probeSchedulerEnabled, scheduledProbeSweep,
  ALL_PROBES, SCHEDULED_PROBES, type ProbeKind,
} from '../src/services/aiProbe.js';
import type { ResolvedAiConfig } from '../src/services/aiConfig.js';

const AT = new Date('2026-08-07T10:00:00.000Z');

const mockCfg = (over: Partial<ResolvedAiConfig> = {}): ResolvedAiConfig => ({
  provider: 'mock', label: '探活用', baseUrl: '', model: 'template', apiKey: '',
  embeddingModel: '', temperature: 0.7, thinkingMode: 'disabled', thinkingBudget: 1024,
  timeoutMs: 20_000,
  embeddingEnabled: false, embeddingBaseUrl: '', embeddingApiKey: '',
  rerankEnabled: false, rerankModel: '', rerankBaseUrl: '', rerankApiKey: '',
  ...over,
});

before(async () => { await prisma.aiModel.deleteMany({ where: { label: { startsWith: 'TEST-probe-' } } }); });
after(async () => {
  await prisma.aiModel.deleteMany({ where: { label: { startsWith: 'TEST-probe-' } } });
  await prisma.$disconnect();
});

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
  test('probeModelById 把结果与能力写回该行；未配 key 的行不外呼、直接如实记未配置', async () => {
    const row = await prisma.aiModel.create({
      data: { provider: 'openai', label: 'TEST-probe-nokey', baseUrl: 'https://x/v1', model: 'm', apiKey: '' },
    });
    const out = await probeModelById(row.id, ['connectivity'], AT);
    assert.ok(out);
    assert.equal(out!.ok, false);
    assert.match(out!.results[0].error ?? '', /API Key/);

    const after = await prisma.aiModel.findUnique({ where: { id: row.id } });
    // 未配 key 走的是早退分支：不该把「没试过」写成「试过且失败」。
    assert.equal(after?.lastProbeAt, null);
  });

  test('mock 端点探活会落库（含 lastProbeOk 与逐项结果）', async () => {
    const row = await prisma.aiModel.create({
      data: { provider: 'mock', label: 'TEST-probe-mock', baseUrl: '', model: 'template', apiKey: '' },
    });
    const out = await probeModelById(row.id, ['connectivity'], AT);
    assert.ok(out);
    const after = await prisma.aiModel.findUnique({ where: { id: row.id } });
    assert.equal(after?.lastProbeAt?.toISOString(), AT.toISOString());
    assert.equal(after?.lastProbeOk, out!.ok);
    const probe = after?.probeJson as { results?: { kind: string }[] } | null;
    assert.equal(probe?.results?.[0]?.kind, 'connectivity');
  });

  test('模型不存在 → null，不抛', async () => {
    assert.equal(await probeModelById('不存在的id', ['connectivity'], AT), null);
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

  test('未配 key 的端点被定时探活跳过（不浪费也不刷错误）', async () => {
    const row = await prisma.aiModel.create({
      data: { provider: 'openai', label: 'TEST-probe-skip', baseUrl: 'https://x/v1', model: 'm', apiKey: '' },
    });
    await scheduledProbeSweep(AT);
    const after = await prisma.aiModel.findUnique({ where: { id: row.id } });
    assert.equal(after?.lastProbeAt, null);
  });
});
