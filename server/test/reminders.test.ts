// V7-11 提醒体系测试：直接调服务（不走 HTTP / 不依赖 x-test-now 时间旅行），聚焦
//   1) buildReminderView 派生（活跃案卷 + 军令 → 三条提醒节奏、逐字文案、订阅态）
//   2) morningOrderReminderScan 按天幂等（审计行恰好一条）+ 未完成军令/小时门前置条件
//   3) weeklyReviewReminderScan 周五门控 + 幂等（工作日无关：非周五仅断言「不发」）
// 测试环境未配订阅模板 → sendWechatSubscribeMessage 静默跳过、不触网；幂等锚点用独立审计行。
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import { getApp, closeApp, seedBaseline, cleanBusiness } from './helpers.js';
import { buildReminderView, morningOrderReminderScan, weeklyReviewReminderScan } from '../src/services/reminders.js';
import { todayStr } from '../src/services/casefile.js';
import { now, weekdayOf } from '../src/services/clock.js';

let tenantId = '', userId = '';

before(async () => { await getApp(); await seedBaseline(); });
after(async () => {
  delete process.env.ORDER_REMINDER_HOUR;
  delete process.env.WEEK_REVIEW_REMINDER_HOUR;
  await closeApp();
});

beforeEach(async () => {
  await cleanBusiness();
  await seedBaseline();
  const tenant = await prisma.tenant.create({ data: { name: '提醒Co' } });
  tenantId = tenant.id;
  const user = await prisma.user.create({ data: { tenantId, phone: '13900000009', name: '提醒用户', role: 'owner' } });
  userId = user.id;
});

async function makeCasefileWithOrder(opts: { done?: boolean; date?: string; dueAt?: string | null } = {}) {
  const cf = await prisma.casefile.create({
    data: { tenantId, userId, title: '增长破局 v4', risksJson: [], status: 'active' },
  });
  await prisma.casefileOrder.create({
    data: {
      tenantId, userId, casefileId: cf.id,
      date: opts.date ?? todayStr(),
      text: '上传近 30 天成交漏斗表',
      done: opts.done ?? false,
      dueAt: opts.dueAt ?? null,
    },
  });
  return cf;
}

test('buildReminderView：活跃案卷 + 军令 → 三条提醒节奏（逐字文案）', async () => {
  await makeCasefileWithOrder({ dueAt: '17:00' });
  const view = await buildReminderView({ tenantId, userId });

  assert.equal(view.items.length, 3);
  assert.deepEqual(view.items.map((i) => i.kind), ['order', 'review', 'weekly']);

  const order = view.items.find((i) => i.kind === 'order')!;
  assert.equal(order.time, '17:00', 'order 时间取未完成军令 dueAt');
  assert.equal(order.desc, '18:00 前补充高意向咨询记录。');

  const review = view.items.find((i) => i.kind === 'review')!;
  assert.equal(review.time, '20:30');
  assert.equal(review.desc, '20:30 生成今日复盘。');

  const weekly = view.items.find((i) => i.kind === 'weekly')!;
  assert.equal(weekly.time, '周五');
  assert.equal(weekly.desc, '本周五检查成交漏斗和内容表现。');

  // 测试环境未配模板 → subscribeReady=false；无订阅行 → subscribed=false
  assert.equal(view.subscribeReady, false);
  assert.equal(order.subscribed, false);
});

test('buildReminderView：无 dueAt / 无案卷 → order 时间默认 18:00，仍返回三条', async () => {
  const noCf = await buildReminderView({ tenantId, userId });
  assert.equal(noCf.items.length, 3);
  assert.equal(noCf.items.find((i) => i.kind === 'order')!.time, '18:00');

  await makeCasefileWithOrder(); // 军令无 dueAt
  const withCf = await buildReminderView({ tenantId, userId });
  assert.equal(withCf.items.find((i) => i.kind === 'order')!.time, '18:00');
});

test('buildReminderView：已授权订阅 → subscribed=true', async () => {
  await makeCasefileWithOrder();
  await prisma.wechatSubscription.create({
    data: { tenantId, userId, scene: 'review', templateId: 'tpl_review', status: 'accept', remaining: 1, acceptedAt: now() },
  });
  const view = await buildReminderView({ tenantId, userId });
  assert.ok(view.items.every((i) => i.subscribed === true), '三条均标记已订阅（均走 review 模板）');
});

test('morningOrderReminderScan：按天幂等，审计行恰好一条', async () => {
  process.env.ORDER_REMINDER_HOUR = '0'; // 绕过真实小时门（不依赖 x-test-now）
  await makeCasefileWithOrder(); // 今日有未完成军令

  const n1 = await morningOrderReminderScan();
  const n2 = await morningOrderReminderScan();
  assert.equal(n1, 1, '首轮登记一次');
  assert.equal(n2, 0, '次轮幂等，不再登记');

  const rows = await prisma.auditLog.count({ where: { userId, action: 'system.order.reminder' } });
  assert.equal(rows, 1, '审计行恰好一条');
});

test('morningOrderReminderScan：今日军令已完成 → 不提醒', async () => {
  process.env.ORDER_REMINDER_HOUR = '0';
  await makeCasefileWithOrder({ done: true });
  const n = await morningOrderReminderScan();
  assert.equal(n, 0);
  assert.equal(await prisma.auditLog.count({ where: { userId, action: 'system.order.reminder' } }), 0);
});

test('morningOrderReminderScan：未到点（小时门）→ 不触发', async () => {
  process.env.ORDER_REMINDER_HOUR = '25'; // getHours() 恒 < 25
  await makeCasefileWithOrder();
  const n = await morningOrderReminderScan();
  assert.equal(n, 0);
  assert.equal(await prisma.auditLog.count({ where: { userId, action: 'system.order.reminder' } }), 0);
});

test('weeklyReviewReminderScan：周五门控 + 按周幂等（工作日无关）', async () => {
  process.env.WEEK_REVIEW_REMINDER_HOUR = '0';
  await makeCasefileWithOrder(); // 本周有军令、且尚无 week 层复盘

  // 用上海时区日历（weekdayOf，P1-4 口径）判断「今天是不是周五」，不能用裸 Date#getDay()——
  // 后者按进程本地时区（CI runner 为 UTC）取星期，在 UTC 16:00-23:59（对应上海次日 00:00-07:59）
  // 会比 weeklyReviewReminderScan 内部真正使用的 weekdayOf() 少算一天，导致本断言与被测实现口径不一致而误判失败。
  const isFriday = weekdayOf() === 5;
  const n1 = await weeklyReviewReminderScan();
  const n2 = await weeklyReviewReminderScan();
  const rows = await prisma.auditLog.count({ where: { userId, action: 'system.weekly.review.reminder' } });

  if (isFriday) {
    assert.equal(n1, 1, '周五应登记一次');
    assert.equal(n2, 0, '按周幂等');
    assert.equal(rows, 1, '审计行恰好一条');
  } else {
    assert.equal(n1, 0, '非周五不触发');
    assert.equal(n2, 0);
    assert.equal(rows, 0, '非周五不落审计行');
  }
});

test('weeklyReviewReminderScan：未到点（小时门/工作日门）→ 不触发', async () => {
  process.env.WEEK_REVIEW_REMINDER_HOUR = '25'; // 即便周五也永不达标
  await makeCasefileWithOrder();
  const n = await weeklyReviewReminderScan();
  assert.equal(n, 0);
  assert.equal(await prisma.auditLog.count({ where: { userId, action: 'system.weekly.review.reminder' } }), 0);
});
