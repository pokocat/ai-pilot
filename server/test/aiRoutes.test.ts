// 归一化接入配置：用途路由 + 迁移 + 可回滚切换（2026-08-07 · 重设计三期）。
//   cd server && npm test -- test/aiRoutes.test.ts
//
// 三期的两条命根子，本文件都必须钉死：
//   ① **默认零变化**：AI_CONFIG_V2 不开就完全走旧表，一行行为都不能变；
//   ② **回落而不是停摆**：开了但路由不可用（迁移没跑完 / 路由被清空 / 表还没建）时，
//      必须静默回落旧路径。切换失败的代价是「没用上新结构」，绝不能是「AI 停了」。
import { describe, test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import {
  resolveRoute, routeToConfig, configForPurpose, v2Enabled, v2Status, __resetAiRoutes,
  PURPOSES,
} from '../src/services/aiRoutes.js';
import { getAiConfig } from '../src/services/aiConfig.js';
import type { ResolvedAiConfig } from '../src/services/aiConfig.js';

const base: ResolvedAiConfig = {
  provider: 'openai', label: '旧配置', baseUrl: 'https://legacy/v1', model: 'legacy-model',
  apiKey: 'sk-legacy-real-key', embeddingModel: '', temperature: 0.7,
  thinkingMode: 'disabled', thinkingBudget: 1024, timeoutMs: 60_000,
  embeddingEnabled: false, embeddingBaseUrl: '', embeddingApiKey: '',
  rerankEnabled: false, rerankModel: '', rerankBaseUrl: '', rerankApiKey: '',
};

let savedFlag: string | undefined;
const useV2 = (on: boolean) => { if (on) process.env.AI_CONFIG_V2 = 'true'; else delete process.env.AI_CONFIG_V2; __resetAiRoutes(); };

async function wipe(): Promise<void> {
  await prisma.aiRouteMember.deleteMany({});
  await prisma.aiRoute.deleteMany({});
  await prisma.aiEndpoint.deleteMany({});
  await prisma.aiCredential.deleteMany({});
  __resetAiRoutes();
}

/** 造一条完整路由：凭证 → 端点 → 路由 → 成员。 */
async function seedRoute(purpose: string, over: {
  mode?: 'single' | 'pool'; label?: string; model?: string; baseUrl?: string;
  dialect?: string; provider?: string; apiKey?: string; temperature?: number;
  thinkingMode?: string; budget?: object;
} = {}): Promise<string> {
  const cred = await prisma.aiCredential.create({
    data: { label: `${purpose}-凭证`, vendor: 'qiniu', apiKey: over.apiKey ?? 'sk-v2-real-key' },
  });
  const ep = await prisma.aiEndpoint.create({
    data: {
      label: over.label ?? `${purpose}-端点`, credentialId: cred.id,
      dialect: over.dialect ?? 'anthropic_gateway', provider: over.provider ?? 'claude',
      baseUrl: over.baseUrl ?? 'https://api.qnaigc.com', model: over.model ?? 'claude-opus-4-6',
      temperature: over.temperature ?? 0.5, thinkingMode: over.thinkingMode ?? 'adaptive', thinkingBudget: 2048,
    },
  });
  const route = await prisma.aiRoute.create({
    data: { purpose, mode: over.mode ?? 'single', sticky: true, ...(over.budget ? { budgetJson: over.budget } : {}) },
  });
  await prisma.aiRouteMember.create({ data: { routeId: route.id, endpointId: ep.id, primary: true } });
  __resetAiRoutes();
  return ep.id;
}

before(() => { savedFlag = process.env.AI_CONFIG_V2; });
beforeEach(async () => { await wipe(); useV2(false); });
after(async () => {
  await wipe();
  if (savedFlag === undefined) delete process.env.AI_CONFIG_V2; else process.env.AI_CONFIG_V2 = savedFlag;
  await prisma.$disconnect();
});

describe('开关默认关 = 完全旧行为', () => {
  test('不设 AI_CONFIG_V2 → v2Enabled 为假，任何用途都解析不出路由', async () => {
    await seedRoute('chat');
    assert.equal(v2Enabled(), false);
    for (const p of PURPOSES) assert.equal(await resolveRoute(p), null, `${p} 不该在关闭时生效`);
  });

  test('不设开关时 getAiConfig 走旧表（哪怕新表里有完整路由）', async () => {
    await seedRoute('chat', { label: 'V2 专属端点', model: 'v2-only-model' });
    const cfg = await getAiConfig(true);
    assert.notEqual(cfg.model, 'v2-only-model', '关闭状态下不该读到新表');
  });
});

describe('切到 V2 后按用途解析', () => {
  test('chat 路由 → 端点的方言 / 温度 / thinking 全部生效', async () => {
    await seedRoute('chat');
    useV2(true);
    const cfg = await configForPurpose('chat', base);
    assert.ok(cfg);
    assert.equal(cfg!.model, 'claude-opus-4-6');
    assert.equal(cfg!.apiKey, 'sk-v2-real-key');
    // 方言必须一路带到 provider 的请求组装处，否则关闭思考的写法会用错。
    assert.equal(cfg!.dialect, 'anthropic_gateway');
    assert.equal(cfg!.temperature, 0.5);
    assert.equal(cfg!.thinkingMode, 'adaptive');
    assert.equal(cfg!.endpointId, cfg!.traceEndpointId);
  });

  test('用途级预算覆盖全局超时（成果 300s 这类口径不再是硬编码常量）', async () => {
    await seedRoute('deliverable', { budget: { timeoutMs: 300_000 } });
    useV2(true);
    const cfg = await configForPurpose('deliverable', base);
    assert.equal(cfg!.timeoutMs, 300_000);
  });

  test('aux 路由走独立车道且 bypass 主池（抽取不该和用户可见的生成抢槽位）', async () => {
    await seedRoute('aux', { provider: 'openai', dialect: 'openai_chat', model: 'small-model' });
    useV2(true);
    const cfg = await configForPurpose('aux', base);
    assert.equal(cfg!.lane, 'aux');
    assert.equal(cfg!.poolBypass, true);
    assert.equal(cfg!.model, 'small-model');
  });

  test('chat / deliverable 不 bypass（它们本来就该参与端点池分流）', async () => {
    await seedRoute('chat');
    useV2(true);
    assert.equal((await configForPurpose('chat', base))!.poolBypass, false);
  });

  test('嵌入 / 重排路由投影回 cfg 上的对应字段，既有消费方零改动', async () => {
    await seedRoute('chat');
    await seedRoute('embedding', { provider: 'openai', dialect: 'openai_chat', model: 'bge-m3', baseUrl: 'https://api.siliconflow.cn/v1' });
    useV2(true);
    const cfg = await getAiConfig(true);
    assert.equal(cfg.embeddingEnabled, true);
    assert.equal(cfg.embeddingModel, 'bge-m3');
    assert.equal(cfg.embeddingBaseUrl, 'https://api.siliconflow.cn/v1');
  });
});

describe('回落：切换失败的代价不能是 AI 停摆', () => {
  test('开了开关但没有 chat 路由 → getAiConfig 回落旧表，不抛不空', async () => {
    useV2(true);
    const cfg = await getAiConfig(true);
    assert.ok(cfg.model, '必须给得出一份可用配置');
    assert.equal(await resolveRoute('chat'), null);
  });

  test('路由存在但成员都没配 key → 视为不可用并回落（放进去只会稳定失败）', async () => {
    await seedRoute('chat', { apiKey: '' });
    useV2(true);
    assert.equal(await resolveRoute('chat'), null);
  });

  test('mock 端点不受 key 过滤影响（演示环境仍要能走通）', async () => {
    await seedRoute('chat', { provider: 'mock', dialect: 'mock', apiKey: '', model: 'template' });
    useV2(true);
    const route = await resolveRoute('chat');
    assert.ok(route, 'mock 端点不该被 key 过滤剔除');
  });

  test('脏 budgetJson 不会把路由打挂（解析失败按未配置处理）', async () => {
    await seedRoute('chat', { budget: { 乱七八糟: true } as object });
    useV2(true);
    const cfg = await configForPurpose('chat', base);
    assert.ok(cfg);
    assert.equal(cfg!.timeoutMs, base.timeoutMs, '脏预算应退回基准超时，而不是 undefined');
  });
});

describe('切换前自检', () => {
  test('v2Status：没迁移时 ready=false —— 切过去就是把 AI 关掉，必须先看得见', async () => {
    useV2(true);
    const st = await v2Status();
    assert.equal(st.enabled, true);
    assert.equal(st.ready, false);
  });

  test('v2Status：迁好后 ready=true 并列出各用途路由与 primary', async () => {
    await seedRoute('chat', { label: '七牛主端点' });
    await seedRoute('aux', { provider: 'openai', dialect: 'openai_chat', label: '小模型' });
    useV2(true);
    const st = await v2Status();
    assert.equal(st.ready, true);
    const chat = st.routes.find((r) => r.purpose === 'chat');
    assert.equal(chat?.primary, '七牛主端点');
    assert.equal(st.routes.length, 2);
  });

  test('v2Status 列出待确认 vendor 的凭证（迁移只标黄不阻断，但必须看得见）', async () => {
    await prisma.aiCredential.create({
      data: { label: '来路不明', vendor: 'custom', apiKey: 'sk-x', needsReview: true },
    });
    __resetAiRoutes();
    const st = await v2Status();
    assert.equal(st.credentialsNeedingReview.length, 1);
    assert.equal(st.credentialsNeedingReview[0].label, '来路不明');
  });
});

describe('一把 key 喂多个端点（消掉「key 复制 N 份」）', () => {
  test('同一凭证下的两个端点共用一把 key，改 key 只改一处', async () => {
    const cred = await prisma.aiCredential.create({ data: { label: '七牛主账号', vendor: 'qiniu', apiKey: 'sk-shared-1' } });
    for (const [i, model] of ['claude-opus-4-6', 'claude-sonnet-4-6'].entries()) {
      const ep = await prisma.aiEndpoint.create({
        data: { label: `端点${i}`, credentialId: cred.id, dialect: 'anthropic_gateway', provider: 'claude', baseUrl: 'https://api.qnaigc.com', model },
      });
      const route = await prisma.aiRoute.upsert({
        where: { purpose: 'chat' }, update: { mode: 'pool' },
        create: { purpose: 'chat', mode: 'pool', sticky: true },
      });
      await prisma.aiRouteMember.create({ data: { routeId: route.id, endpointId: ep.id, primary: i === 0 } });
    }
    __resetAiRoutes();
    useV2(true);
    const route = await resolveRoute('chat');
    assert.equal(route!.endpoints.length, 2);
    assert.ok(route!.endpoints.every((e) => e.apiKey === 'sk-shared-1'));

    // 换 key：只改凭证这一行，两个端点一起变——旧结构要改 N 行 ai_model。
    await prisma.aiCredential.update({ where: { id: cred.id }, data: { apiKey: 'sk-rotated' } });
    __resetAiRoutes();
    const after = await resolveRoute('chat');
    assert.ok(after!.endpoints.every((e) => e.apiKey === 'sk-rotated'));
  });
});

describe('routeToConfig 的取值口径', () => {
  test('single 模式取 primary；没有 primary 时退回第一个（不能返回空配置）', async () => {
    await seedRoute('chat', { label: '主' });
    useV2(true);
    const route = (await resolveRoute('chat'))!;
    assert.equal(routeToConfig(route, base).label, '主');

    // 人为把 primary 清掉，模拟迁移半途或运营误操作。
    await prisma.aiRouteMember.updateMany({ data: { primary: false } });
    __resetAiRoutes();
    const noPrimary = (await resolveRoute('chat'))!;
    assert.equal(routeToConfig(noPrimary, base).label, '主', '没有 primary 也必须给得出端点');
  });
});
