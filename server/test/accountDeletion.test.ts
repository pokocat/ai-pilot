import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import { prisma } from '../src/db.js';
import { ACCOUNT_DELETION_POLICY, eraseAccount, scanDataErasureJobs } from '../src/services/accountDeletion.js';
import { api, cleanBusiness, closeApp, getApp, login, seedBaseline, uniquePhone } from './helpers.js';

before(async () => { await getApp(); await cleanBusiness(); await seedBaseline(); });
beforeEach(async () => { await cleanBusiness(); });
after(async () => { await closeApp(); });

test('注销政策覆盖所有带 userId/tenantId 的模型', () => {
  const covered = new Set<string>(Object.values(ACCOUNT_DELETION_POLICY).flat());
  const scoped = Prisma.dmmf.datamodel.models
    .filter((model) => model.fields.some((field) => field.name === 'userId' || field.name === 'tenantId'))
    .map((model) => model.name);
  const missing = scoped.filter((name) => !covered.has(name));
  assert.deepEqual(missing, [], `新增的用户/租户数据表必须先归类注销政策：${missing.join(', ')}`);
});

test('独占租户注销先进入 30 天隔离期，公开入口立即撤销，到期后才物理清理', async () => {
  const token = await login(uniquePhone(), '待注销用户');
  const user = await prisma.user.findUniqueOrThrow({ where: { id: token } });
  const share = await prisma.reportHtml.create({
    data: { tenantId: user.tenantId, userId: user.id, title: '待撤销报告', html: '<html>secret</html>' },
  });
  await prisma.knowledgeItem.create({
    data: {
      tenantId: user.tenantId, userId: user.id, kind: 'document', sourceType: 'upload',
      title: '敏感资料', text: '敏感正文', fileKey: `kb/${user.id}/source.pdf`, inferenceFileKey: `kb/${user.id}/infer.png`,
    },
  });
  await prisma.creativeAsset.create({
    data: { tenantId: user.tenantId, userId: user.id, kind: 'source', ossKey: `creative/${user.id}/source.png`, mimeType: 'image/png' },
  });
  const order = await prisma.paymentOrder.create({
    data: {
      outTradeNo: `erase-${Date.now()}`, tenantId: user.tenantId, userId: user.id,
      amount: 9900, status: 'applied', clientRequestId: 'personal-request',
      rawNotifyJson: { openid: 'private-openid' }, refundRawJson: { phone: '13800000000' },
    },
  });
  const trace = await prisma.llmTrace.create({
    data: {
      tenantId: user.tenantId, userId: user.id, sessionId: 'private-session', kind: 'chat',
      provider: 'mock', model: 'mock', status: 'error', promptText: '私人问题', responseText: '私人回答',
      contextJson: { private: true }, errorMessage: 'private error',
    },
  });
  await prisma.clientEvent.create({ data: { tenantId: user.tenantId, userId: user.id, name: 'wence_enter', propsJson: { private: true } } });
  await prisma.auditLog.create({ data: { tenantId: user.tenantId, userId: user.id, action: 'private.action', payloadJson: { phone: user.phone } } });
  await prisma.moderationLog.create({ data: { tenantId: user.tenantId, userId: user.id, refType: 'input', verdict: 'block', detailJson: { text: 'private' } } });

  const before = await api('GET', `/api/r/${share.id}`);
  assert.equal(before.status, 200);
  const deleted = await api('DELETE', '/api/me', { token });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.equal(deleted.body.ok, true);
  assert.ok(deleted.body.erasureJobId);
  assert.ok(Date.parse(deleted.body.retentionUntil) > Date.now() + 29 * 86400_000);

  assert.equal((await api('GET', `/api/r/${share.id}`)).status, 404, '公开链接必须在注销事务提交时立即失效');
  const retainedUser = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  assert.ok(retainedUser.deletedAt);
  assert.ok(retainedUser.purgeAfter);
  assert.equal(await prisma.tenant.count({ where: { id: user.tenantId } }), 1);
  assert.equal(await prisma.reportHtml.count({ where: { id: share.id } }), 1);
  assert.ok((await prisma.reportHtml.findUniqueOrThrow({ where: { id: share.id } })).revokedAt);
  assert.equal(await prisma.knowledgeItem.count({ where: { userId: user.id } }), 1);
  assert.equal(await prisma.creativeAsset.count({ where: { userId: user.id } }), 1);
  assert.equal((await api('GET', '/api/me', { token })).status, 401, '隔离期内旧 token 必须立即失效');
  const relogin = await api('POST', '/api/auth/login', { body: { phone: user.phone } });
  assert.equal(relogin.status, 423);
  assert.equal(relogin.body.code, 'ACCOUNT_DELETION_PENDING');

  const retainedBeforePurge = await prisma.paymentOrder.findUniqueOrThrow({ where: { id: order.id } });
  assert.equal(retainedBeforePurge.userId, user.id, '隔离期内不得提前匿名化，才能支持受控恢复');
  const retainedJob = await prisma.dataErasureJob.findUniqueOrThrow({ where: { id: deleted.body.erasureJobId } });
  assert.equal(retainedJob.status, 'retained');
  assert.equal(retainedJob.subjectUserId, user.id);
  assert.ok((retainedJob.objectKeys as unknown[]).length >= 5);

  await prisma.dataErasureJob.update({
    where: { id: retainedJob.id },
    data: { nextAttemptAt: new Date(Date.now() - 1000) },
  });
  await prisma.user.update({ where: { id: user.id }, data: { purgeAfter: new Date(Date.now() - 1000) } });
  assert.equal(await scanDataErasureJobs(), 1);
  assert.equal(await prisma.user.count({ where: { id: user.id } }), 0);
  assert.equal(await prisma.tenant.count({ where: { id: user.tenantId } }), 0);
  assert.equal(await prisma.reportHtml.count({ where: { id: share.id } }), 0);
  assert.equal(await prisma.knowledgeItem.count({ where: { userId: user.id } }), 0);
  assert.equal(await prisma.creativeAsset.count({ where: { userId: user.id } }), 0);

  const retainedOrder = await prisma.paymentOrder.findUniqueOrThrow({ where: { id: order.id } });
  assert.match(retainedOrder.userId, /^deleted:[a-f0-9]{64}$/);
  assert.match(retainedOrder.tenantId, /^deleted:[a-f0-9]{64}$/);
  assert.equal(retainedOrder.clientRequestId, null);
  assert.equal(retainedOrder.rawNotifyJson, null);
  assert.equal(retainedOrder.refundRawJson, null);
  const retainedTrace = await prisma.llmTrace.findUniqueOrThrow({ where: { id: trace.id } });
  assert.equal(retainedTrace.userId, null);
  assert.equal(retainedTrace.tenantId, null);
  assert.equal(retainedTrace.promptText, null);
  assert.equal(retainedTrace.responseText, null);
  assert.equal(retainedTrace.contextJson, null);

  const job = await prisma.dataErasureJob.findUniqueOrThrow({ where: { id: deleted.body.erasureJobId } });
  assert.equal(job.status, 'completed');
  assert.deepEqual(job.objectKeys, []);
  assert.equal(job.externalOwnerId, null);
});

test('多人租户注销隔离本人、撤销本人公开页，不影响租户共享档案与其他成员', async () => {
  const ownerToken = await login(uniquePhone(), '企业主');
  const owner = await prisma.user.findUniqueOrThrow({ where: { id: ownerToken } });
  const member = await prisma.user.create({
    data: { tenantId: owner.tenantId, phone: uniquePhone(), name: '企业成员', role: 'member' },
  });
  await prisma.profile.create({ data: { tenantId: owner.tenantId, industry: '企业共享行业' } });
  const ownerShare = await prisma.reportHtml.create({ data: { tenantId: owner.tenantId, userId: owner.id, title: '个人公开页', html: 'private' } });
  const memberShare = await prisma.reportHtml.create({ data: { tenantId: owner.tenantId, userId: member.id, title: '成员公开页', html: 'shared' } });

  const deleted = await api('DELETE', '/api/me', { token: ownerToken });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.ok((await prisma.user.findUniqueOrThrow({ where: { id: owner.id } })).deletedAt);
  assert.equal(await prisma.user.count({ where: { id: member.id } }), 1);
  assert.equal(await prisma.tenant.count({ where: { id: owner.tenantId } }), 1);
  assert.equal(await prisma.profile.count({ where: { tenantId: owner.tenantId } }), 1);
  assert.ok((await prisma.reportHtml.findUniqueOrThrow({ where: { id: ownerShare.id } })).revokedAt);
  assert.equal(await prisma.reportHtml.count({ where: { id: memberShare.id } }), 1);
  assert.equal((await api('GET', `/api/r/${ownerShare.id}`)).status, 404);
  assert.equal((await api('GET', `/api/r/${memberShare.id}`)).status, 200);
});

test('并发重复注销幂等复用同一保留任务，不因唯一键竞争返回失败', async () => {
  const token = await login(uniquePhone(), '并发注销用户');
  const results = await Promise.all(Array.from({ length: 8 }, () => eraseAccount(token)));
  assert.equal(new Set(results.map((row) => row.erasureJobId)).size, 1);
  assert.equal(new Set(results.map((row) => row.retentionUntil)).size, 1);
  assert.equal(await prisma.dataErasureJob.count({ where: { subjectUserId: token } }), 1);
});

test('保留期配置不得低于 30 天', async () => {
  const previous = process.env.ACCOUNT_DELETION_RETENTION_DAYS;
  process.env.ACCOUNT_DELETION_RETENTION_DAYS = '1';
  try {
    const token = await login(uniquePhone(), '最短保留期用户');
    const result = await eraseAccount(token);
    assert.ok(Date.parse(result.retentionUntil) >= Date.now() + 29 * 86400_000);
  } finally {
    if (previous === undefined) delete process.env.ACCOUNT_DELETION_RETENTION_DAYS;
    else process.env.ACCOUNT_DELETION_RETENTION_DAYS = previous;
  }
});
