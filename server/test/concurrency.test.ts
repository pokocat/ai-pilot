// 并发回归测试：覆盖线上常见的重复点击、重试、并行回调类竞态。
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import { api, cleanBusiness, closeApp, getApp, seedBaseline, uniquePhone, deliverable } from './helpers.js';
import { issueSmsCode, verifySmsCode } from '../src/services/sms.js';
import { saveReportVersion } from '../src/services/reports.js';
import { publishDraft, rollbackToVersion } from '../src/services/agentVersions.js';
import { applyPlanPurchase } from '../src/services/purchase.js';

before(async () => {
  await getApp();
  await seedBaseline();
});

after(async () => { await closeApp(); });

beforeEach(async () => {
  await cleanBusiness();
  await seedBaseline();
});

async function createUserWithCredits(balance: number) {
  const tenant = await prisma.tenant.create({ data: { name: '并发测试企业' } });
  const user = await prisma.user.create({
    data: { tenantId: tenant.id, phone: uniquePhone(), name: '并发用户', role: 'owner' },
  });
  await prisma.creditLedger.create({
    data: { tenantId: tenant.id, userId: user.id, delta: balance, reason: '测试初始余额', balance },
  });
  return { tenantId: tenant.id, userId: user.id };
}

async function createUnlockAgent(key: string, price: number) {
  await prisma.agent.upsert({
    where: { key },
    update: {
      billing: 'unlock',
      price,
      enabled: true,
      meterUnit: 'text',
    },
    create: {
      key,
      name: `并发智能体 ${key}`,
      role: '并发测试',
      icon: 'zap',
      type: 'custom',
      gift: false,
      billing: 'unlock',
      price,
      billingRatio: 1,
      meterUnit: 'text',
      enabled: true,
      greet: '你好',
      chipsJson: [],
      memText: '记忆',
      learnText: '已记住',
      systemPrompt: '你是并发测试智能体',
      deliverableKey: null,
      memoryConfig: {},
      sort: 999,
    },
  });
}

test('并发购买不同 unlock 智能体：同一余额账户串行扣减，不能双花', async () => {
  const { userId } = await createUserWithCredits(10);
  await createUnlockAgent('race_unlock_a', 8);
  await createUnlockAgent('race_unlock_b', 8);

  const results = await Promise.all([
    api('POST', '/api/agents/race_unlock_a/purchase', { token: userId, body: {} }),
    api('POST', '/api/agents/race_unlock_b/purchase', { token: userId, body: {} }),
  ]);

  assert.equal(results.filter((r) => r.status === 200).length, 1, '只有一次购买能成功');
  assert.equal(results.filter((r) => r.status === 402).length, 1, '余额被首个请求占用后，另一个应余额不足');
  assert.equal(await prisma.userAgent.count({ where: { userId } }), 1, '只开通一个智能体');

  const last = await prisma.creditLedger.findFirst({
    where: { userId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  assert.equal(last?.balance, 2, '余额只扣一次');
});

test('并发套餐发放：同一余额账户串行叠加，不丢充值', async () => {
  const { tenantId, userId } = await createUserWithCredits(10);
  const plan = await prisma.plan.findFirst({ where: { creditsPerMonth: { gt: 0 } }, orderBy: { creditsPerMonth: 'asc' } });
  assert.ok(plan);

  await Promise.all(Array.from({ length: 4 }, () =>
    applyPlanPurchase(
      { id: userId, tenantId },
      plan,
      { reason: `${plan.name} · 并发测试购买`, source: 'test_race' },
    ),
  ));

  const last = await prisma.creditLedger.findFirst({
    where: { userId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  assert.equal(last?.balance, 10 + plan.creditsPerMonth * 4);
  assert.equal(await prisma.creditLedger.count({ where: { userId, reason: `${plan.name} · 并发测试购买` } }), 4);
});

test('并发校验同一短信验证码：只能消费成功一次', async () => {
  const phone = uniquePhone();
  const issued = await issueSmsCode(phone, '127.0.0.1', 'login');
  assert.ok(issued.devCode);

  const results = await Promise.all(Array.from({ length: 8 }, () => verifySmsCode(phone, issued.devCode!, 'login')));
  assert.equal(results.filter(Boolean).length, 1, '同一验证码并发校验只能一个请求成功');
  const row = await prisma.smsCode.findFirst({ where: { phone }, orderBy: { createdAt: 'desc' } });
  assert.ok(row?.consumedAt, '成功后应标记已消费');
});

test('并发发送同手机号短信：限频判断串行化，只落一条验证码', async () => {
  const phone = uniquePhone();
  const settled = await Promise.allSettled(Array.from({ length: 6 }, () => issueSmsCode(phone, '127.0.0.1', 'login')));
  assert.equal(settled.filter((r) => r.status === 'fulfilled').length, 1, '只有首个发码成功');
  assert.equal(settled.filter((r) => r.status === 'rejected').length, 5, '其余请求被冷却限制拦截');
  assert.equal(await prisma.smsCode.count({ where: { phone, scene: 'login' } }), 1);
});

test('并发保存同名报告：版本号按同一报告串行递增', async () => {
  const { tenantId, userId } = await createUserWithCredits(0);
  const calls = Array.from({ length: 4 }, (_, i) =>
    saveReportVersion({
      tenantId,
      userId,
      title: '并发报告',
      type: '测试报告',
      content: deliverable('并发报告', [{ h: `段落 ${i + 1}`, b: `内容 ${i + 1}` }]),
    }),
  );

  const results = await Promise.all(calls);
  assert.deepEqual(results.map((r) => r.version).sort((a, b) => a - b), [1, 2, 3, 4]);
  const doc = await prisma.reportDoc.findFirst({ where: { tenantId, slug: '并发报告' } });
  assert.equal(doc?.currentVersion, 4);
  assert.equal(await prisma.reportVersion.count({ where: { reportId: doc!.id } }), 4);
});

test('并发发布同一智能体草稿：同内容只生成一个发布版本', async () => {
  const agentKey = 'race_publish_agent';
  await createUnlockAgent(agentKey, 0);
  await prisma.agent.update({ where: { key: agentKey }, data: { publishedVersionId: null, draftDirty: true } });
  await prisma.agentVersion.deleteMany({ where: { agentKey } });
  const results = await Promise.all(Array.from({ length: 6 }, () => publishDraft(agentKey)));
  assert.equal(results.filter((r) => r.changed).length, 1, '只有首个请求生成新版本');
  assert.equal(await prisma.agentVersion.count({ where: { agentKey } }), 1);
  const agent = await prisma.agent.findUnique({ where: { key: agentKey } });
  assert.ok(agent?.publishedVersionId);
});

test('P1-A4 回滚后再发布同已发布配置：识别为幂等，不造新版本', async () => {
  const agentKey = 'rollback_dedup_agent';
  await createUnlockAgent(agentKey, 0);
  await prisma.agentVersion.deleteMany({ where: { agentKey } });
  await prisma.agent.update({ where: { key: agentKey }, data: { publishedVersionId: null, systemPrompt: 'V1 内容' } });
  const v1 = await publishDraft(agentKey);
  await prisma.agent.update({ where: { key: agentKey }, data: { systemPrompt: 'V2 内容' } });
  const v2 = await publishDraft(agentKey);
  assert.equal(v2.version, 2);
  await rollbackToVersion(agentKey, v1.versionId); // published=v1, latest=v2
  // 草稿改回与 v1 同配置再发布：基线取「当前已发布 v1」→ 幂等，不应造 v3（旧实现基线取 latest=v2 会误造）。
  await prisma.agent.update({ where: { key: agentKey }, data: { systemPrompt: 'V1 内容' } });
  const again = await publishDraft(agentKey);
  assert.equal(again.changed, false, '草稿==当前已发布(v1) → 幂等');
  assert.equal(again.version, 1);
  assert.equal(await prisma.agentVersion.count({ where: { agentKey } }), 2, '仍只有 v1/v2，无 v3');
});

test('P1-A3 回滚与发布并发：始终恰好一行 published 且指针一致', async () => {
  const agentKey = 'rollback_race_agent';
  await createUnlockAgent(agentKey, 0);
  await prisma.agentVersion.deleteMany({ where: { agentKey } });
  await prisma.agent.update({ where: { key: agentKey }, data: { publishedVersionId: null, systemPrompt: 'A' } });
  const v1 = await publishDraft(agentKey);
  await prisma.agent.update({ where: { key: agentKey }, data: { systemPrompt: 'B' } });
  const v2 = await publishDraft(agentKey);
  await prisma.agent.update({ where: { key: agentKey }, data: { systemPrompt: 'C' } });
  await Promise.all([
    rollbackToVersion(agentKey, v1.versionId),
    publishDraft(agentKey),
    rollbackToVersion(agentKey, v2.versionId),
  ]);
  const publishedCount = await prisma.agentVersion.count({ where: { agentKey, status: 'published' } });
  assert.equal(publishedCount, 1, '并发回滚/发布后必须恰好一行 published');
  const agent = await prisma.agent.findUnique({ where: { key: agentKey } });
  const pub = await prisma.agentVersion.findFirst({ where: { agentKey, status: 'published' } });
  assert.equal(agent?.publishedVersionId, pub?.id, '指针必须与唯一 published 行一致');
});
