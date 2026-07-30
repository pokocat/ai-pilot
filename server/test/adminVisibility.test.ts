import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import { api, cleanBusiness, closeApp, getApp, login, seedBaseline, uniquePhone } from './helpers.ts';

process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'test-admin-token';

let userId = '';
let phone = '';

before(async () => {
  await getApp();
  await cleanBusiness();
  await prisma.llmTrace.deleteMany();
  await seedBaseline();
  phone = uniquePhone();
  userId = await login(phone, '来源用户');
});

after(async () => {
  await closeApp();
});

test('技能库返回可读名称与只读参数，内置知识检索可查看', async () => {
  const res = await api('GET', '/api/admin/skill-tools');
  assert.equal(res.status, 200);
  const skill = (res.body as Array<{ name: string; displayName?: string; inputSchema?: unknown }>).find((it) => it.name === 'search_knowledge');
  assert.equal(skill?.displayName, '知识库检索');
  assert.ok(skill?.inputSchema && typeof skill.inputSchema === 'object');
});

test('知识库看板带来源用户，详情 URL 严格校验 userId', async () => {
  const created = await api('POST', '/api/knowledge', {
    token: userId,
    body: { title: '用户归属测试', text: '这是一条用于验证后台用户归属的知识。', kind: 'insight' },
  });
  assert.equal(created.status, 200);

  const view = await api('GET', '/api/admin/knowledge');
  assert.equal(view.status, 200);
  const row = (view.body.items as Array<{ id: string; userId: string; userName: string | null; userPhone: string | null }>)
    .find((it) => it.id === created.body.id);
  assert.equal(row?.userId, userId);
  assert.equal(row?.userName, '来源用户');
  assert.equal(row?.userPhone, phone);

  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const other = await prisma.user.create({
    data: { tenantId: user.tenantId, phone: uniquePhone(), name: '同租户其他用户' },
  });
  const wrongOwner = await api('GET', `/api/admin/users/${other.id}/knowledge/${created.body.id}`);
  assert.equal(wrongOwner.status, 404);
  const rightOwner = await api('GET', `/api/admin/users/${userId}/knowledge/${created.body.id}`);
  assert.equal(rightOwner.status, 200);
  assert.match(rightOwner.body.textPreview, /后台用户归属/);
});

test('调用诊断返回来源用户、租户与智能体可读名称', async () => {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const trace = await prisma.llmTrace.create({
    data: {
      tenantId: user.tenantId,
      userId,
      sessionId: 'session-source-test',
      agentKey: 'general',
      kind: 'deliverable',
      provider: 'mock',
      model: 'mock',
      status: 'ok',
      latencyMs: 12,
      totalTokens: 20,
    },
  });

  const list = await api('GET', '/api/admin/observability');
  assert.equal(list.status, 200);
  const item = (list.body.items as Array<Record<string, unknown>>).find((it) => it.id === trace.id);
  assert.equal(item?.userId, userId);
  assert.equal(item?.userName, '来源用户');
  assert.equal(item?.userPhone, phone);
  assert.equal(item?.tenantName, (await prisma.tenant.findUniqueOrThrow({ where: { id: user.tenantId } })).name);
  assert.equal(typeof item?.agentName, 'string');
  assert.notEqual(item?.agentName, 'general');
  assert.equal(item?.sessionId, 'session-source-test');
});

test('审计默认排除历史 /api/metrics 抓取，显式开启时仍可查看', async () => {
  const metric = await prisma.auditLog.create({
    data: { action: 'user.http', payloadJson: { method: 'GET', path: '/api/metrics', statusCode: 200 } },
  });
  const business = await prisma.auditLog.create({
    data: { userId, action: 'user.test.visible', payloadJson: { ok: true } },
  });

  const normal = await api('GET', '/api/admin/audit-logs');
  assert.ok((normal.body as Array<{ id: string }>).some((it) => it.id === business.id));
  assert.ok(!(normal.body as Array<{ id: string }>).some((it) => it.id === metric.id));

  const withMetrics = await api('GET', '/api/admin/audit-logs?includeMetrics=true');
  assert.ok((withMetrics.body as Array<{ id: string }>).some((it) => it.id === metric.id));
});
