// 归一化迁移脚本（2026-08-07 · 重设计三期）。
//   cd server && npm test -- test/aiMigrate.test.ts
//
// 迁移脚本必须被回归钉住，否则「迁完是不是对的」只能等到生产窗口那天现场判断。
// 重点不是「能不能跑完」，是三条**跑错了会出事**的性质：
//   ① 幂等 —— 重跑不产生重复端点（迁移半途失败、迁完又新增端点，都是常态）；
//   ② 一把 key 只建一条凭证 —— 这正是三期要消掉的「key 复制 N 份」；
//   ③ 算不出成员时**宁可不迁**也不迁出一条空的 chat 路由（那等于把线上 AI 关掉）。
import { describe, test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import { migrateAiConfig } from '../src/services/aiConfigMigrate.js';
import { __resetAiRoutes } from '../src/services/aiRoutes.js';

async function wipe(): Promise<void> {
  await prisma.aiRouteMember.deleteMany({});
  await prisma.aiRoute.deleteMany({});
  await prisma.aiEndpoint.deleteMany({});
  await prisma.aiCredential.deleteMany({});
  await prisma.aiModel.deleteMany({});
  await prisma.aiSetting.deleteMany({});
  __resetAiRoutes();
}

async function seedLegacy(over: {
  routingMode?: string; sticky?: boolean; embeddingEnabled?: boolean; embeddingModel?: string;
} = {}) {
  const a = await prisma.aiModel.create({
    data: {
      provider: 'claude', label: '七牛主端点', baseUrl: 'https://api.qnaigc.com', model: 'claude-opus-4-6',
      apiKey: 'sk-qiniu-shared', preset: 'qiniu-anthropic', thinkingMode: 'adaptive', temperature: 0.6,
      priceInput: 36, priceOutput: 180, poolEnabled: true, weight: 3, tier: 0,
    },
  });
  const b = await prisma.aiModel.create({
    data: {
      // 同一把 key 的第二个端点 —— 旧结构里 key 被复制了两份。
      provider: 'claude', label: '七牛备用端点', baseUrl: 'https://api.qnaigc.com', model: 'claude-sonnet-4-6',
      apiKey: 'sk-qiniu-shared', preset: 'qiniu-anthropic', poolEnabled: true, weight: 1, tier: 1,
    },
  });
  await prisma.aiSetting.create({
    data: {
      id: 'default', provider: 'claude', label: '七牛主端点', baseUrl: 'https://api.qnaigc.com',
      model: 'claude-opus-4-6', apiKey: 'sk-qiniu-shared', activeModelId: a.id,
      routingMode: over.routingMode ?? 'pool', stickyRouting: over.sticky ?? true,
      embeddingEnabled: over.embeddingEnabled ?? false, embeddingModel: over.embeddingModel ?? '',
      embeddingBaseUrl: 'https://api.siliconflow.cn/v1', embeddingApiKey: 'sk-silicon',
    },
  });
  return { a, b };
}

beforeEach(wipe);
after(async () => { await wipe(); await prisma.$disconnect(); });

describe('预演不写库', () => {
  test('不带 --apply 时一行都不写（迁移前必须能先看清楚要发生什么）', async () => {
    await seedLegacy();
    await migrateAiConfig({ apply: false, quiet: true });
    assert.equal(await prisma.aiEndpoint.count(), 0);
    assert.equal(await prisma.aiCredential.count(), 0);
    assert.equal(await prisma.aiRoute.count(), 0);
  });
});

describe('迁移结果', () => {
  test('每行 ai_model 生成一个端点，且方言被就此固化（不再靠推断）', async () => {
    await seedLegacy();
    await migrateAiConfig({ apply: true, quiet: true });
    const eps = await prisma.aiEndpoint.findMany({ orderBy: { label: 'asc' } });
    assert.equal(eps.length, 2);
    for (const e of eps) {
      assert.equal(e.dialect, 'anthropic_gateway', '七牛网关端点应固化成兼容网关方言');
      assert.ok(e.legacyModelId, '必须留迁移溯源，否则重跑会建重复端点');
    }
  });

  test('同一把 key 只建一条凭证（消掉「key 复制 N 份」）', async () => {
    await seedLegacy();
    await migrateAiConfig({ apply: true, quiet: true });
    const creds = await prisma.aiCredential.findMany();
    assert.equal(creds.length, 1);
    assert.equal(creds[0].vendor, 'qiniu');
    assert.equal(creds[0].needsReview, false);
    const eps = await prisma.aiEndpoint.findMany();
    assert.equal(new Set(eps.map((e) => e.credentialId)).size, 1);
  });

  test('activeModelId → chat 路由的 primary；池成员带上权重与备份层', async () => {
    const { a, b } = await seedLegacy();
    await migrateAiConfig({ apply: true, quiet: true });
    const route = await prisma.aiRoute.findUnique({
      where: { purpose: 'chat' },
      include: { members: { include: { endpoint: true } } },
    });
    assert.equal(route?.mode, 'pool');
    assert.equal(route?.members.length, 2);
    const primary = route!.members.find((m) => m.primary);
    assert.equal(primary?.endpoint.legacyModelId, a.id);
    const backup = route!.members.find((m) => !m.primary);
    assert.equal(backup?.endpoint.legacyModelId, b.id);
    assert.equal(backup?.tier, 1);
    assert.equal(backup?.weight, 1);
  });

  test('deliverable 路由继承 primary 但拿到自己的超时预算（成果是异步生成，可以给更长时间）', async () => {
    await seedLegacy();
    await migrateAiConfig({ apply: true, quiet: true });
    const r = await prisma.aiRoute.findUnique({ where: { purpose: 'deliverable' }, include: { members: true } });
    assert.equal(r?.members.length, 1);
    assert.deepEqual(r?.budgetJson, { timeoutMs: 300_000 });
  });

  test('嵌入开启时迁成独立路由；关闭时不迁（不凭空造一条没人要的路由）', async () => {
    await seedLegacy({ embeddingEnabled: true, embeddingModel: 'bge-m3' });
    await migrateAiConfig({ apply: true, quiet: true });
    const emb = await prisma.aiRoute.findUnique({ where: { purpose: 'embedding' }, include: { members: { include: { endpoint: true } } } });
    assert.equal(emb?.members[0]?.endpoint.model, 'bge-m3');
    // 嵌入用的是它自己的 key，不该混进对话凭证。
    const cred = await prisma.aiCredential.findUnique({ where: { id: emb!.members[0].endpoint.credentialId } });
    assert.equal(cred?.apiKey, 'sk-silicon');

    await wipe();
    await seedLegacy({ embeddingEnabled: false });
    await migrateAiConfig({ apply: true, quiet: true });
    assert.equal(await prisma.aiRoute.findUnique({ where: { purpose: 'embedding' } }), null);
  });

  test('single 模式如实迁成 single（不擅自把运营没开的分流打开）', async () => {
    await seedLegacy({ routingMode: 'single', sticky: false });
    await migrateAiConfig({ apply: true, quiet: true });
    const r = await prisma.aiRoute.findUnique({ where: { purpose: 'chat' } });
    assert.equal(r?.mode, 'single');
    assert.equal(r?.sticky, false);
  });
});

describe('幂等与安全', () => {
  test('重跑不产生重复端点 / 重复凭证 / 重复成员', async () => {
    await seedLegacy();
    await migrateAiConfig({ apply: true, quiet: true });
    await migrateAiConfig({ apply: true, quiet: true });
    await migrateAiConfig({ apply: true, quiet: true });
    assert.equal(await prisma.aiEndpoint.count(), 2);
    assert.equal(await prisma.aiCredential.count(), 1);
    assert.equal(await prisma.aiRouteMember.count({ where: { route: { purpose: 'chat' } } }), 2);
  });

  test('端点移出池后重跑 → 路由成员跟着收缩（成员是全量重放，不是只增不减）', async () => {
    const { b } = await seedLegacy();
    await migrateAiConfig({ apply: true, quiet: true });
    await prisma.aiModel.update({ where: { id: b.id }, data: { poolEnabled: false } });
    await migrateAiConfig({ apply: true, quiet: true });
    const members = await prisma.aiRouteMember.count({ where: { route: { purpose: 'chat' } } });
    assert.equal(members, 1);
  });

  test('vendor 推断不出来 → 标黄但照样入路由（在这里拦住会把 chat 路由迁成空的）', async () => {
    const m = await prisma.aiModel.create({
      data: { provider: 'openai', label: '自建网关', baseUrl: 'https://gw.internal.example/v1', model: 'x', apiKey: 'sk-unknown' },
    });
    await prisma.aiSetting.create({
      data: { id: 'default', provider: 'openai', label: '自建网关', baseUrl: 'https://gw.internal.example/v1', model: 'x', apiKey: 'sk-unknown', activeModelId: m.id },
    });
    await migrateAiConfig({ apply: true, quiet: true });
    const cred = await prisma.aiCredential.findFirst({ where: { apiKey: 'sk-unknown' } });
    assert.equal(cred?.vendor, 'custom');
    assert.equal(cred?.needsReview, true, '必须标黄，让运营看得见');
    const route = await prisma.aiRoute.findUnique({ where: { purpose: 'chat' }, include: { members: true } });
    assert.equal(route?.members.length, 1, '标黄不等于阻断——阻断会把线上 AI 关掉');
  });

  test('算不出任何 chat 成员时宁可不迁，也不迁出一条空路由', async () => {
    await prisma.aiSetting.create({
      data: { id: 'default', provider: 'mock', label: '未配置', baseUrl: '', model: '', apiKey: '', activeModelId: null },
    });
    await migrateAiConfig({ apply: true, quiet: true });
    assert.equal(await prisma.aiRoute.findUnique({ where: { purpose: 'chat' } }), null);
  });

  test('迁移只增不删：旧表一行都不动（回滚＝把开关关掉）', async () => {
    const { a } = await seedLegacy();
    const before = await prisma.aiModel.findMany({ orderBy: { createdAt: 'asc' } });
    const settingBefore = await prisma.aiSetting.findUnique({ where: { id: 'default' } });
    await migrateAiConfig({ apply: true, quiet: true });
    const after = await prisma.aiModel.findMany({ orderBy: { createdAt: 'asc' } });
    assert.deepEqual(after, before);
    assert.deepEqual(await prisma.aiSetting.findUnique({ where: { id: 'default' } }), settingBefore);
    assert.equal(settingBefore?.activeModelId, a.id);
  });
});
