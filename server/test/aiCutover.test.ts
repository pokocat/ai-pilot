// 迁移 + 切换 + 回滚的**端到端彩排**（2026-08-07 · 重设计三期）。
//   cd server && npm test -- test/aiCutover.test.ts
//
// 为什么单独有这个文件：`aiMigrate.test.ts` 验的是「迁移写出来的行对不对」，
// `aiRoutes.test.ts` 验的是「新表读出来的配置对不对」。但生产切换真正的风险不是这两件，
// 而是**第三件**——切过去之后，运行时拿到的那份配置跟切之前是不是同一份。
// 任何一个字段在迁移里丢了（方言、温度、思考预算、单价、池权重），线上表现都会变，
// 而两边各自的单测都还是绿的。所以这里按**生产形态**造数据，逐字段比对切换前后。
//
// 生产形态取自 AGENTS §13 与 2026-07-27 变更记录：两个 claude 端点直连七牛、端点池开启、
// 会话粘性开启、adaptive 思考、按官方价刷入的四档单价。
import { describe, test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import { migrateAiConfig } from '../src/services/aiConfigMigrate.js';
import { getAiConfig } from '../src/services/aiConfig.js';
import { __resetAiRoutes, v2Status } from '../src/services/aiRoutes.js';
import { loadPool, __resetLlmPool } from '../src/services/llmPool.js';
import { thinkingRequestTuning } from '../src/llm/thinking.js';

let savedFlag: string | undefined;
const setV2 = (on: boolean) => {
  if (on) process.env.AI_CONFIG_V2 = 'true'; else delete process.env.AI_CONFIG_V2;
  __resetAiRoutes(); __resetLlmPool();
};

async function wipe(): Promise<void> {
  await prisma.aiRouteMember.deleteMany({});
  await prisma.aiRoute.deleteMany({});
  await prisma.aiEndpoint.deleteMany({});
  await prisma.aiCredential.deleteMany({});
  await prisma.aiModel.deleteMany({});
  await prisma.aiSetting.deleteMany({});
  __resetAiRoutes(); __resetLlmPool();
}

/** 生产形态：两个 claude 端点直连七牛、池开启、粘性开启、adaptive 思考、四档单价。 */
async function seedProductionShape() {
  const main = await prisma.aiModel.create({
    data: {
      provider: 'claude', label: 'dj-claude-4.6-opus', preset: 'qiniu-anthropic',
      baseUrl: 'https://api.qnaigc.com/bypass/anthropic', model: 'claude-opus-4-6',
      apiKey: 'sk-qiniu-prod-shape', temperature: 0.7,
      thinkingMode: 'adaptive', thinkingBudget: 1024,
      priceInput: 36, priceOutput: 180, priceCachedInput: 3.6, priceCacheWrite: 45,
      poolEnabled: true, weight: 1, tier: 0, maxConcurrency: 0,
    },
  });
  const backup = await prisma.aiModel.create({
    data: {
      provider: 'claude', label: 'claude-opus-4-6', preset: 'qiniu-anthropic',
      baseUrl: 'https://api.qnaigc.com/bypass/anthropic', model: 'claude-opus-4-6',
      apiKey: 'sk-qiniu-prod-shape', temperature: 0.7,
      thinkingMode: 'adaptive', thinkingBudget: 1024,
      priceInput: 36, priceOutput: 180, priceCachedInput: 3.6, priceCacheWrite: 45,
      poolEnabled: true, weight: 1, tier: 0, maxConcurrency: 0,
    },
  });
  await prisma.aiSetting.create({
    data: {
      id: 'default', provider: 'claude', label: 'dj-claude-4.6-opus',
      baseUrl: 'https://api.qnaigc.com/bypass/anthropic', model: 'claude-opus-4-6',
      apiKey: 'sk-qiniu-prod-shape', temperature: 0.7,
      thinkingMode: 'adaptive', thinkingBudget: 1024,
      activeModelId: main.id, routingMode: 'pool', stickyRouting: true,
    },
  });
  return { main, backup };
}

/** 只取「会改变线上行为」的那些字段做比对。 */
function runtimeShape(cfg: Awaited<ReturnType<typeof getAiConfig>>) {
  return {
    provider: cfg.provider, baseUrl: cfg.baseUrl, model: cfg.model, apiKey: cfg.apiKey,
    temperature: cfg.temperature, thinkingMode: cfg.thinkingMode, thinkingBudget: cfg.thinkingBudget,
  };
}

before(() => { savedFlag = process.env.AI_CONFIG_V2; });
beforeEach(async () => { await wipe(); setV2(false); });
after(async () => {
  await wipe();
  if (savedFlag === undefined) delete process.env.AI_CONFIG_V2; else process.env.AI_CONFIG_V2 = savedFlag;
  setV2(false);
  await prisma.$disconnect();
});

describe('生产形态的切换彩排', () => {
  test('切换前后运行时配置逐字段一致 —— 这是生产切换唯一真正的风险', async () => {
    await seedProductionShape();
    const before = runtimeShape(await getAiConfig(true));

    await migrateAiConfig({ apply: true, quiet: true });
    setV2(true);
    const after = runtimeShape(await getAiConfig(true));

    assert.deepEqual(after, before, '迁移后运行时配置发生了变化——任何一个字段变了线上表现都会变');
  });

  test('切换前后组装出的 thinking 参数也必须一模一样（方言不能在迁移里丢）', async () => {
    await seedProductionShape();
    const before = await getAiConfig(true);
    const tuneBefore = thinkingRequestTuning(before, { allowThinking: false });

    await migrateAiConfig({ apply: true, quiet: true });
    setV2(true);
    const after = await getAiConfig(true);
    const tuneAfter = thinkingRequestTuning(after, { allowThinking: false });

    // 生产是七牛 Anthropic 网关：关闭思考必须显式发 {type:'disabled'} 且不带 budget_tokens。
    assert.deepEqual(tuneAfter, tuneBefore);
    assert.deepEqual(tuneAfter.thinking, { type: 'disabled' });
    // 迁移把方言就此固化，切换后不再靠推断。
    assert.equal(after.dialect, 'anthropic_gateway');
  });

  test('端点池成员在切换前后等价（数量、权重、tier、model 都不能变）', async () => {
    await seedProductionShape();
    const poolBefore = await loadPool(true);
    assert.equal(poolBefore.settings.mode, 'pool');
    assert.equal(poolBefore.endpoints.length, 2);

    await migrateAiConfig({ apply: true, quiet: true });
    setV2(true);
    const poolAfter = await loadPool(true);

    assert.equal(poolAfter.settings.mode, 'pool');
    assert.equal(poolAfter.settings.sticky, poolBefore.settings.sticky);
    assert.equal(poolAfter.endpoints.length, poolBefore.endpoints.length);
    const key = (list: typeof poolAfter.endpoints) => list
      .map((e) => `${e.label}|${e.model}|${e.weight}|${e.tier}|${e.maxConcurrency}`).sort();
    assert.deepEqual(key(poolAfter.endpoints), key(poolBefore.endpoints));
  });

  test('单价四档在迁移中原样保留（丢了会让成本记账悄悄失准）', async () => {
    await seedProductionShape();
    await migrateAiConfig({ apply: true, quiet: true });
    const eps = await prisma.aiEndpoint.findMany();
    for (const e of eps) {
      assert.equal(e.priceInput, 36);
      assert.equal(e.priceOutput, 180);
      assert.equal(e.priceCachedInput, 3.6);
      assert.equal(e.priceCacheWrite, 45);
    }
  });

  test('回滚：关掉开关后立刻回到旧配置，且旧表一字未动', async () => {
    const { main } = await seedProductionShape();
    const before = runtimeShape(await getAiConfig(true));
    const legacyRowsBefore = await prisma.aiModel.findMany({ orderBy: { createdAt: 'asc' } });

    await migrateAiConfig({ apply: true, quiet: true });
    setV2(true);
    await getAiConfig(true); // 走一遍新路径

    setV2(false);
    const rolledBack = runtimeShape(await getAiConfig(true));
    assert.deepEqual(rolledBack, before, '回滚后必须回到与切换前完全一致的配置');

    const legacyRowsAfter = await prisma.aiModel.findMany({ orderBy: { createdAt: 'asc' } });
    assert.deepEqual(legacyRowsAfter, legacyRowsBefore);
    const setting = await prisma.aiSetting.findUnique({ where: { id: 'default' } });
    assert.equal(setting?.activeModelId, main.id);
  });

  test('切换前自检给得出「能不能切」的明确答案', async () => {
    await seedProductionShape();
    setV2(true);
    assert.equal((await v2Status()).ready, false, '没迁移就该是 false');

    await migrateAiConfig({ apply: true, quiet: true });
    __resetAiRoutes();
    const st = await v2Status();
    assert.equal(st.ready, true);
    assert.equal(st.credentialsNeedingReview.length, 0, '生产形态能判出 vendor，不该有待确认凭证');
    // 两个端点共用一把 key → 只该有一条凭证。
    assert.equal(await prisma.aiCredential.count(), 1);
  });
});
