import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import { dateKey } from '../src/services/clock.js';
import { api, cleanBusiness, closeApp, getApp, seedBaseline, uniquePhone } from './helpers.js';

process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'test-admin-token';

before(async () => { await getApp(); });
after(async () => { await closeApp(); });
beforeEach(async () => { await cleanBusiness(); await seedBaseline(); });

async function fixture() {
  const tenant = await prisma.tenant.create({ data: { name: '会话工作台企业' } });
  const user = await prisma.user.create({ data: { tenantId: tenant.id, phone: uniquePhone(), name: '会话排查用户' } });
  const session = await prisma.session.create({
    data: { tenantId: tenant.id, userId: user.id, agentKey: 'general', title: '增长策略复盘' },
  });
  await prisma.message.createMany({ data: [
    { sessionId: session.id, role: 'user', contentJson: { text: '最近转化为什么下降？' }, createdAt: new Date(Date.now() - 2_000) },
    { sessionId: session.id, role: 'assistant', contentJson: { text: '先核对渠道结构与成交周期。' }, createdAt: new Date(Date.now() - 1_000) },
    { sessionId: session.id, role: 'user', contentJson: { text: '先看渠道。' }, createdAt: new Date() },
  ] });
  const trace = await prisma.llmTrace.create({ data: {
    tenantId: tenant.id, userId: user.id, sessionId: session.id, agentKey: 'general',
    kind: 'chat', provider: 'mock', model: 'mock', status: 'ok', latencyMs: 16, totalTokens: 32,
  } });
  return { tenant, user, session, trace };
}

test('会话工作台支持北京时间自定义日期、跨实体搜索与消息/调用下钻', async () => {
  const { user, session, trace } = await fixture();
  const today = dateKey(new Date());
  const list = await api('GET', `/api/admin/sessions?from=${today}&to=${today}&q=${encodeURIComponent(user.phone)}`);
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.equal(list.body.range.timeZone, 'Asia/Shanghai');
  assert.equal(list.body.total, 1);
  assert.equal(list.body.summary.messages, 3);
  assert.equal(list.body.items[0].id, session.id);
  assert.equal(list.body.items[0].messageCount, 3);
  assert.match(list.body.items[0].lastMessage.preview, /先看渠道/);

  const detail = await api('GET', `/api/admin/sessions/${session.id}?limit=2`);
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
  assert.equal(detail.body.messagesTotal, 3);
  assert.equal(detail.body.messages.length, 2);
  assert.ok(detail.body.nextMessageCursor, '只取两条时必须明确还有更早消息');
  assert.equal(detail.body.traces[0].id, trace.id);

  const older = await api('GET', `/api/admin/sessions/${session.id}?limit=2&before=${detail.body.nextMessageCursor}`);
  assert.equal(older.status, 200);
  assert.equal(older.body.messages.length, 1);
  assert.notEqual(older.body.messages[0].id, detail.body.messages[0].id, '翻页不能重复当前页消息');
  assert.equal(older.body.messages[0].role, 'user');
});

test('审计工作台做服务端筛选和精确分页，并显式返回请求/会话/操作者链路键', async () => {
  const { tenant, user, session } = await fixture();
  const requestId = `req-${Date.now()}`;
  const log = await prisma.auditLog.create({ data: {
    tenantId: tenant.id,
    userId: user.id,
    action: 'admin.http',
    payloadJson: {
      method: 'POST', path: '/api/admin/example', statusCode: 500, ok: false,
      request: { requestId, ip: '127.0.0.1', userAgent: 'test' },
      body: { sessionId: session.id },
      auth: { admin: { username: '值班运营' } },
    },
  } });
  const today = dateKey(new Date());
  const view = await api('GET', `/api/admin/audit-view?from=${today}&to=${today}&includeAdmin=true&status=error&q=${requestId}&pageSize=1`);
  assert.equal(view.status, 200, JSON.stringify(view.body));
  assert.equal(view.body.total, 1);
  assert.equal(view.body.items[0].id, log.id);
  assert.equal(view.body.items[0].requestId, requestId);
  assert.equal(view.body.items[0].sessionId, session.id);
  assert.equal(view.body.items[0].operator, '值班运营');
  assert.equal(view.body.summary.failed, 1);
});

test('自定义日期缺一端时明确 400，不能静默退回固定 30 天', async () => {
  const today = dateKey(new Date());
  const res = await api('GET', `/api/admin/sessions?from=${today}`);
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'ADMIN_RANGE_INVALID');

  const invalid = await api('GET', '/api/admin/sessions?from=2026-02-31&to=2026-02-31');
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.code, 'ADMIN_RANGE_INVALID');
});
