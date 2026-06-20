// P1 功能：运营只读看板（项目/报告/知识）+ 报告重命名。
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import { getApp, closeApp, api, seedBaseline, cleanBusiness } from './helpers.js';

const ADMIN = 'p1-master-key';
let tenantId = '', userId = '', reportId = '';

before(async () => {
  process.env.ADMIN_TOKEN = ADMIN;
  await getApp();
  await seedBaseline();
});
after(async () => { await closeApp(); });

beforeEach(async () => {
  await cleanBusiness();
  await seedBaseline();
  const tenant = await prisma.tenant.create({ data: { name: '看板公司' } });
  tenantId = tenant.id;
  const user = await prisma.user.create({ data: { tenantId, phone: '13700000009', name: '老板', role: 'owner' } });
  userId = user.id;
  const project = await prisma.project.create({ data: { tenantId, userId, name: '融资冲刺', slug: 'rongzi' } });
  const report = await prisma.reportDoc.create({ data: { tenantId, userId, projectId: project.id, title: '战略体检', slug: 'zhanlue', type: '战略体检', currentVersion: 1 } });
  reportId = report.id;
  await prisma.knowledgeItem.create({ data: { tenantId, projectId: project.id, userId, kind: 'insight', title: '关键洞察', text: '增长乏力', sourceType: 'manual' } });
});

test('只读看板：项目/报告返回跨租户数据', async () => {
  const projects = await api('GET', '/api/admin/projects', { adminToken: ADMIN });
  assert.equal(projects.status, 200);
  const p = projects.body.find((x: any) => x.name === '融资冲刺');
  assert.ok(p, '应列出项目');
  assert.equal(p.tenantName, '看板公司');
  assert.equal(p.reports, 1);
  assert.equal(p.knowledge, 1);

  const reports = await api('GET', '/api/admin/reports', { adminToken: ADMIN });
  assert.equal(reports.status, 200);
  assert.ok(reports.body.find((x: any) => x.title === '战略体检'));
  // 知识库看板由 main 的 /admin/knowledge 提供（不同 shape），此处不重复断言。
});

test('记忆候选：/memories 返回本人记忆、按权重排序、租户隔离', async () => {
  await prisma.memory.create({ data: { tenantId, userId, agentKey: 'general', kind: 'preference', text: '偏好稳健打法', weight: 2, source: 'conversation' } });
  await prisma.memory.create({ data: { tenantId, userId, agentKey: 'general', kind: 'fact', text: '团队 20 人', weight: 1, source: 'conversation' } });

  const res = await api('GET', '/api/memories', { token: userId });
  assert.equal(res.status, 200);
  assert.ok(res.body.length >= 2);
  assert.equal(res.body[0].text, '偏好稳健打法', '高权重在前');

  // 关键词过滤
  const filtered = await api('GET', '/api/memories?q=团队', { token: userId });
  assert.equal(filtered.body.length, 1);
  assert.equal(filtered.body[0].text, '团队 20 人');

  // 他人看不到
  const otherTenant = await prisma.tenant.create({ data: { name: '别家2' } });
  const other = await prisma.user.create({ data: { tenantId: otherTenant.id, phone: '13700000011', name: '别人2', role: 'owner' } });
  const otherRes = await api('GET', '/api/memories', { token: other.id });
  assert.equal(otherRes.body.length, 0, '跨用户不可见');
});

test('报告重命名：改 title、租户隔离', async () => {
  const ok = await api('PATCH', `/api/reports/${reportId}`, { token: userId, body: { title: '战略体检 v2' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.title, '战略体检 v2');
  const r = await prisma.reportDoc.findUnique({ where: { id: reportId } });
  assert.equal(r!.title, '战略体检 v2');
  assert.equal(r!.slug, 'zhanlue', 'slug 归一键不变');

  // 空标题拒绝
  const bad = await api('PATCH', `/api/reports/${reportId}`, { token: userId, body: { title: '  ' } });
  assert.equal(bad.status, 400);

  // 他人无法改（租户隔离）
  const otherTenant = await prisma.tenant.create({ data: { name: '别家' } });
  const other = await prisma.user.create({ data: { tenantId: otherTenant.id, phone: '13700000010', name: '别人', role: 'owner' } });
  const denied = await api('PATCH', `/api/reports/${reportId}`, { token: other.id, body: { title: '篡改' } });
  assert.equal(denied.status, 404);
});
