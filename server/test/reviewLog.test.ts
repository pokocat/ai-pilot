// 复盘账本（M2 PR-8）测试：day 快照事实、同日 upsert、连续天数服务端计算、注入、断档提醒扫描。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, login, uniquePhone, deliverable } from './helpers.ts';
import { prisma } from '../src/db.ts';
import { reviewStreak, reviewBriefing } from '../src/services/reviewLog.ts';
import { scanReviewGaps } from '../src/services/scheduler.ts';
import { todayStr } from '../src/services/casefile.ts';

before(async () => {
  await getApp();
  await cleanBusiness();
  await seedBaseline();
});

after(async () => {
  await closeApp();
});

function isoDaysAgo(n: number): string {
  const d = new Date(Date.now() - n * 86400_000);
  return `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`;
}

const PLAN = deliverable('破局方案', [
  { h: '现状判断', b: '信任链路断裂。' },
  { h: '行动清单', list: ['重做案例证明', '私聊老客', '发一条观点内容'] },
]);

test('发起复盘：day 层快照当日军令/回填事实；同日重复发起 upsert 不翻倍', async () => {
  const token = await login(uniquePhone(), '复盘用户');
  await api('POST', '/api/casefile/accept', { token, body: { deliverable: PLAN, agentName: '军师' } });
  // 打卡 1 条 + 回填
  const cf = await api('GET', '/api/casefile', { token });
  await api('PATCH', `/api/casefile/orders/${cf.body.casefile.orders[0].id}`, { token, body: { done: true } });
  await api('PUT', '/api/casefile/backfill', { token, body: { leads: 8, consults: 2, deals: 1 } });

  const r = await api('POST', '/api/casefile/review', { token, body: { layer: 'day' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.review.ordersTotal, 3);
  assert.equal(r.body.review.ordersDone, 1);
  assert.equal(r.body.review.alignedTotal, 3, '认可拆出的军令都标对齐');
  assert.equal(r.body.review.alignRate, 100);
  assert.equal(r.body.review.hasBackfill, true);
  assert.equal(r.body.streak, 1);

  // 同日再次发起 → 仍是一条（快照更新）
  await api('PATCH', `/api/casefile/orders/${cf.body.casefile.orders[1].id}`, { token, body: { done: true } });
  const again = await api('POST', '/api/casefile/review', { token, body: {} });
  assert.equal(again.body.review.ordersDone, 2, '快照取最新');
  assert.equal(await prisma.reviewLog.count({ where: { userId: token, layer: 'day', date: todayStr() } }), 1);

  // 非法 layer 回落 day
  const w = await api('POST', '/api/casefile/review', { token, body: { layer: 'hack' } });
  assert.equal(w.body.review.layer, 'day');
});

test('连续复盘天数：昨天+前天有复盘、今天未复盘 → 2；断一天归零重计', async () => {
  const token = await login(uniquePhone(), '连续用户');
  const user = await prisma.user.findFirstOrThrow({ where: { id: token } });
  const mk = (date: string) => prisma.reviewLog.create({ data: { tenantId: user.tenantId, userId: user.id, layer: 'day', date } });
  await mk(isoDaysAgo(1));
  await mk(isoDaysAgo(2));
  assert.equal(await reviewStreak(user.id), 2, '今天没复盘不打断（今晚可补）');

  await mk(isoDaysAgo(0));
  assert.equal(await reviewStreak(user.id), 3);

  // 断档用户：只有 3 天前 → streak 0
  const token2 = await login(uniquePhone(), '断档用户');
  const u2 = await prisma.user.findFirstOrThrow({ where: { id: token2 } });
  await prisma.reviewLog.create({ data: { tenantId: u2.tenantId, userId: u2.id, layer: 'day', date: isoDaysAgo(3) } });
  assert.equal(await reviewStreak(u2.id), 0);
});

test('注入：复盘账本块带连续天数与事实快照；GET /reviews 返回列表+streak', async () => {
  const token = await login(uniquePhone(), '注入复盘用户');
  const user = await prisma.user.findFirstOrThrow({ where: { id: token } });
  await api('POST', '/api/casefile/review', { token, body: {} });

  const line = await reviewBriefing(user.id);
  assert.ok(line);
  assert.match(line!, /【复盘账本（系统计数/);
  assert.match(line!, /连续复盘：1 天/);

  const r = await api('GET', '/api/reviews', { token });
  assert.equal(r.body.items.length, 1);
  assert.equal(r.body.streak, 1);
});

test('断档提醒扫描：复盘过但断档≥2天且案卷活跃 → 登记候选（按天幂等）', async () => {
  await prisma.auditLog.deleteMany({ where: { action: 'system.review.reminder.candidate' } });
  const token = await login(uniquePhone(), '待提醒用户');
  const user = await prisma.user.findFirstOrThrow({ where: { id: token } });
  await api('POST', '/api/casefile/accept', { token, body: { deliverable: PLAN, agentName: '军师' } });
  await prisma.reviewLog.create({ data: { tenantId: user.tenantId, userId: user.id, layer: 'day', date: isoDaysAgo(4) } });

  const flagged = await scanReviewGaps();
  assert.ok(flagged >= 1);
  const rows = await prisma.auditLog.findMany({ where: { action: 'system.review.reminder.candidate', userId: user.id } });
  assert.equal(rows.length, 1);
  assert.equal((rows[0].payloadJson as { lastReviewDate: string }).lastReviewDate, isoDaysAgo(4));

  // 同日重扫幂等
  await scanReviewGaps();
  assert.equal(await prisma.auditLog.count({ where: { action: 'system.review.reminder.candidate', userId: user.id } }), 1);
});
