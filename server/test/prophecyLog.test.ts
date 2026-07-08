// 预言账本（M2 PR-9）测试：记录/验证/命中率（服务端计数）、注入、到期扫描幂等、
// 真实性铁律（测试/mock 环境抽取器返回空 → 不产生伪预言）、隔离。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, login, uniquePhone } from './helpers.ts';
import { prisma } from '../src/db.ts';
import { extractAndRecordProphecies, prophecyBriefing } from '../src/services/prophecyLog.ts';
import { scanDueProphecies } from '../src/services/scheduler.ts';
import { buildGenContext } from '../src/services/context.ts';
import { buildSystemParts } from '../src/llm/schema.ts';

before(async () => {
  await getApp();
  await cleanBusiness();
  await seedBaseline();
});

after(async () => {
  await closeApp();
});

test('记录 + 验证 → 命中率服务端算；未验证时 hitRate=null 不编 0%；已验证 <5 条也不出比率', async () => {
  const token = await login(uniquePhone(), '天机用户');
  const record = (prophecy: string, extra: Record<string, unknown> = {}) => api('POST', '/api/prophecies', { token, body: { prophecy, ...extra } });
  const verify = (id: string, outcome: string, note?: string) => api('POST', `/api/prophecies/${id}/verify`, { token, body: { outcome, note } });

  const p1 = await record('3 月现金流承压，回款会延迟', { dueDate: '2026-03-31', verifyStandard: '3 月回款是否延迟两周以上' });
  assert.equal(p1.status, 200);
  assert.equal(p1.body.prophecy.seq, 1);
  const p2 = await record('4 月有意外进账');
  const p3 = await record('5 月团队可能出问题');

  const before1 = await api('GET', '/api/prophecies', { token });
  assert.equal(before1.body.stats.hitRate, null, '未验证不编命中率');

  await verify(p1.body.prophecy.id, 'hit', '回款延迟两周');
  await verify(p2.body.prophecy.id, 'hit');
  const v3 = await verify(p3.body.prophecy.id, 'miss', '团队稳定');
  // 已验证仅 3 条（<5）：批次C 最小样本保护——即使 2/3 命中也不出比率，避免样本太小就喂晋升
  assert.equal(v3.body.stats.hit, 2);
  assert.equal(v3.body.stats.miss, 1);
  assert.equal(v3.body.stats.hitRate, null, '已验证 3 条 <5，不出命中率');
  assert.equal(v3.body.stats.pending, 0);

  // 补 2 条到 ≥5 条已验证，命中率才由服务端算出
  const p4 = await record('6 月出现新客户来源');
  const p5 = await record('7 月成本会上升');
  await verify(p4.body.prophecy.id, 'hit');
  const v5 = await verify(p5.body.prophecy.id, 'hit');
  assert.equal(v5.body.stats.total, 5);
  assert.equal(v5.body.stats.hit, 4);
  assert.equal(v5.body.stats.miss, 1);
  assert.equal(v5.body.stats.hitRate, 80, '4/(4+1)=80%（已验证 5 条 ≥5）');

  const bad = await api('POST', `/api/prophecies/${p1.body.prophecy.id}/verify`, { token, body: { outcome: 'kinda' } });
  assert.equal(bad.status, 400);
});

test('真实性铁律：mock/测试环境抽取器返回空 → 不产生伪预言（即使有命盘和天势文本）', async () => {
  const token = await login(uniquePhone(), '抽取用户');
  const user = await prisma.user.findFirstOrThrow({ where: { id: token } });
  await api('PUT', '/api/profile/bazi', { token, body: { calendar: 'solar', year: 1988, month: 3, day: 15, hour: 10, gender: 'male' } });

  const n = await extractAndRecordProphecies({
    tenantId: user.tenantId,
    userId: user.id,
    text: '结合你的命盘，7 月忌神当令要防守，预计 8 月中旬会有一个转介绍大单落地，9 月是进攻窗口。'.repeat(3),
  });
  assert.equal(n, 0, 'liveProvider=null → 抽取为空');
  assert.equal(await prisma.prophecyLog.count({ where: { userId: user.id } }), 0);

  // 无命盘用户直接短路（连抽取都不调）
  const t2 = await login(uniquePhone(), '无盘用户');
  const u2 = await prisma.user.findFirstOrThrow({ where: { id: t2 } });
  assert.equal(await extractAndRecordProphecies({ tenantId: u2.tenantId, userId: u2.id, text: 'x'.repeat(200) }), 0);
});

test('注入：有预言 → dynamic 段带【天机账本】；未命中口径含「人谋可以改命」提示', async () => {
  const token = await login(uniquePhone(), '注入天机用户');
  const user = await prisma.user.findFirstOrThrow({ where: { id: token } });
  await api('POST', '/api/prophecies', { token, body: { prophecy: '下月有贵人引荐', dueDate: '2026-08-01' } });

  const line = await prophecyBriefing(user.id);
  assert.ok(line);
  assert.match(line!, /【天机账本（系统计数/);
  assert.match(line!, /人谋可以改命/);

  const { ctx } = await buildGenContext({ userId: user.id, tenantId: user.tenantId, agentKey: 'general', userMessage: '月度复盘' });
  const { dynamic } = buildSystemParts(ctx.systemPrompt, ctx, 'chat');
  assert.match(dynamic, /【天机账本/);
  assert.match(dynamic, /下月有贵人引荐/);
});

test('到期扫描：pending 且到期 → 登记对账候选，行级幂等；未到期/已验证不动', async () => {
  await prisma.auditLog.deleteMany({ where: { action: 'system.prophecy.due' } });
  const token = await login(uniquePhone(), '到期用户');
  const user = await prisma.user.findFirstOrThrow({ where: { id: token } });
  const mk = (prophecy: string, dueDate: string | null, status = 'pending') =>
    prisma.prophecyLog.create({ data: { tenantId: user.tenantId, userId: user.id, seq: Math.floor(Math.random() * 1e9), prophecy, dueDate, status } });
  const due = await mk('已到期预言', '2026-06-30');
  await mk('未到期预言', '2099-01-01');
  await mk('已验证预言', '2026-06-01', 'hit');

  const n = await scanDueProphecies();
  assert.equal(n, 1);
  const rows = await prisma.auditLog.findMany({ where: { action: 'system.prophecy.due', userId: user.id } });
  assert.equal(rows.length, 1);
  assert.equal((rows[0].payloadJson as { prophecyId: string }).prophecyId, due.id);

  // 重扫幂等（dueNotifiedAt 已置）
  assert.equal(await scanDueProphecies(), 0);
});

test('隔离：他人不能验证我的预言', async () => {
  const token = await login(uniquePhone(), '我预言');
  const other = await login(uniquePhone(), '他预言');
  const p = await api('POST', '/api/prophecies', { token, body: { prophecy: '我的预言' } });
  const r = await api('POST', `/api/prophecies/${p.body.prophecy.id}/verify`, { token: other, body: { outcome: 'hit' } });
  assert.equal(r.status, 404);
});
