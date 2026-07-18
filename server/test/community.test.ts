// V7-13 社群 / 档案工作台：邀请码惰性生成 + 唯一性、ServiceAssignment CRUD（admin 路由）、
// 档案工作台计数（confirmed bizCategory）、跨租户隔离（TC-G）。
// communityRoutes 尚未在 app.ts 注册（缝合点由父任务接），故本文件把路由挂到一个本地 Fastify 实例上，
// 与共享 app 同库（prisma 全局）跑真实 handler——父任务接线后同样通过。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import { getApp, closeApp, cleanBusiness, seedBaseline, login, uniquePhone } from './helpers.ts';
import { prisma } from '../src/db.ts';
import { communityRoutes } from '../src/routes/community.ts';
import { ensureInviteCode } from '../src/services/community.ts';

const ADMIN = 'test-community-admin-token';
let app: FastifyInstance;
let userA = '';
let userB = '';

before(async () => {
  process.env.ADMIN_TOKEN = ADMIN;
  await getApp(); // 共享 app 供 login 建号
  await cleanBusiness();
  await seedBaseline();
  userA = await login(uniquePhone(), '甲老板');
  userB = await login(uniquePhone(), '乙老板');

  app = Fastify();
  await app.register(communityRoutes, { prefix: '/api' });
  await app.ready();
});

after(async () => {
  await app.close();
  await closeApp();
});

type InjOpts = { token?: string; admin?: string; body?: unknown };
function inj(method: string, url: string, opts: InjOpts = {}) {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.token) headers['x-user-id'] = opts.token;
  if (opts.admin) headers['x-admin-token'] = opts.admin;
  return app.inject({ method, url, headers, payload: opts.body as object | undefined });
}

async function seedKnowledge(userId: string, rows: { biz: string; stage?: string }[]) {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { tenantId: true } });
  await prisma.knowledgeItem.createMany({
    data: rows.map((r) => ({
      tenantId: u!.tenantId,
      userId,
      kind: 'document',
      text: '样例资料',
      sourceType: 'upload',
      stage: r.stage ?? 'confirmed',
      bizCategory: r.biz,
    })),
  });
}

test('邀请码：惰性生成 + 幂等 + 跨用户唯一', async () => {
  const a1 = await ensureInviteCode(userA);
  assert.match(a1, /^JS[0-9A-Z]{4}$/); // JS + 4 位 base32
  const a2 = await ensureInviteCode(userA);
  assert.equal(a2, a1); // 二次调用返回同一码（幂等）

  const b1 = await ensureInviteCode(userB);
  assert.notEqual(b1, a1); // 两个用户不同码

  const row = await prisma.user.findUnique({ where: { id: userA }, select: { inviteCode: true } });
  assert.equal(row?.inviteCode, a1); // 已持久化
});

test('ServiceAssignment CRUD via admin 路由：PUT 建/改 → GET 读回 → 用户侧可见', async () => {
  const put = await inj('PUT', `/api/admin/users/${userA}/service`, {
    admin: ADMIN,
    body: {
      teacherName: '林老师',
      teacherWechat: 'lin_junshi_03',
      className: '上海 3 班',
      groupQrUrl: 'https://oss.example/qr.png',
      taskDone: 4,
      taskTotal: 6,
      note: '负责资料确认和入群任务',
    },
  });
  assert.equal(put.statusCode, 200);
  assert.equal(put.json().service.className, '上海 3 班');
  assert.equal(put.json().service.taskDone, 4);
  assert.equal(put.json().service.taskTotal, 6);

  const get = await inj('GET', `/api/admin/users/${userA}/service`, { admin: ADMIN });
  assert.equal(get.statusCode, 200);
  assert.equal(get.json().service.teacherWechat, 'lin_junshi_03');

  // upsert：只传部分字段，其余保留
  const put2 = await inj('PUT', `/api/admin/users/${userA}/service`, { admin: ADMIN, body: { taskDone: 5 } });
  assert.equal(put2.statusCode, 200);
  assert.equal(put2.json().service.taskDone, 5);
  assert.equal(put2.json().service.className, '上海 3 班'); // 未传字段不被清空

  // 用户侧 /me/service 读到自己的分配
  const mine = await inj('GET', '/api/me/service', { token: userA });
  assert.equal(mine.statusCode, 200);
  assert.equal(mine.json().service.className, '上海 3 班');
});

test('未分班用户：/me/service 返回 null', async () => {
  const mine = await inj('GET', '/api/me/service', { token: userB });
  assert.equal(mine.statusCode, 200);
  assert.equal(mine.json().service, null);
});

test('档案工作台：分区计数 = confirmed KnowledgeItem 的 bizCategory', async () => {
  const u = await login(uniquePhone(), '计数老板');
  await seedKnowledge(u, [
    { biz: 'founder' },
    { biz: 'founder' },
    { biz: 'company' },
    { biz: 'growth' }, // 计入「产品服务」
    { biz: 'founder', stage: 'staging' }, // 非 confirmed → 不计
    { biz: 'finance', stage: 'optimized' }, // 非 confirmed → 不计
  ]);

  const wb = await inj('GET', '/api/me/workbench', { token: u });
  assert.equal(wb.statusCode, 200);
  const secs = Object.fromEntries(wb.json().sections.map((s: { key: string }) => [s.key, s]));

  assert.equal(secs.founder.count, 2);
  assert.equal(secs.founder.ready, true);
  assert.equal(secs.company.count, 1);
  assert.equal(secs.product.count, 1); // 产品服务 计 growth
  assert.equal(secs.finance.count, 0); // optimized 不计入
  assert.equal(secs.finance.ready, false);

  assert.ok([20, 55, 85].includes(wb.json().completeness));
  const missing = wb.json().missing;
  assert.ok(missing.length >= 1 && missing.length <= 3);
  assert.ok(missing.every((m: { title: string }) => typeof m.title === 'string' && m.title.length > 0));
});

test('跨租户隔离（TC-G）：B 的 workbench 不含 A 的资料；admin 分班路由需管理员', async () => {
  const uC = await login(uniquePhone(), '丙老板');
  const uD = await login(uniquePhone(), '丁老板');
  await seedKnowledge(uC, [{ biz: 'company' }, { biz: 'company' }]);
  await seedKnowledge(uD, [{ biz: 'company' }]);

  const wbC = await inj('GET', '/api/me/workbench', { token: uC });
  const wbD = await inj('GET', '/api/me/workbench', { token: uD });
  const cCompany = wbC.json().sections.find((s: { key: string }) => s.key === 'company').count;
  const dCompany = wbD.json().sections.find((s: { key: string }) => s.key === 'company').count;
  assert.equal(cCompany, 2); // 只数 C 自己的
  assert.equal(dCompany, 1); // C 的 2 条不叠加到 D

  // admin 分班路由：无凭证 → 401，普通用户 → 403（非管理员）
  const noAuth = await inj('GET', `/api/admin/users/${uC}/service`);
  assert.equal(noAuth.statusCode, 401);
  const asUser = await inj('GET', `/api/admin/users/${uC}/service`, { token: uD });
  assert.equal(asUser.statusCode, 403);
});

test('admin PUT 不存在的用户 → 404 USER_NOT_FOUND', async () => {
  const r = await inj('PUT', '/api/admin/users/nonexistent-id/service', { admin: ADMIN, body: { className: 'x' } });
  assert.equal(r.statusCode, 404);
  assert.equal(r.json().code, 'USER_NOT_FOUND');
});
