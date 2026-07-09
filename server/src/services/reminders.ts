// V7-11 提醒体系补全（后端）：提醒日历派生视图 + 两个定时提醒任务（09:00 军令 / 周五周复盘）。
// 纯读派生，不新建表；三条提醒节奏（军令截止 / 20:30 复盘 / 周五周复盘）对齐设计 §13.2 文案逐字。
// 触达一律复用 services/wechatSubscribe.ts 的 sendWechatSubscribeMessage（先预留后结算 + 日志幂等），
// 未配模板则静默跳过（照 daily-review-reminder 口径）。提醒暂借 scene 'review' 模板（不新增 scene，
// 仅换 order-flavored 标题）——见 SEAM 说明：理想应由后续在 wechatSubscribe.ts 增设独立 'order' 模板。
import type { ReminderItem, ReminderView } from '../../../shared/contracts';
import { prisma } from '../db.js';
import { recordAudit } from './audit.js';
import { activeCasefile, todayStr } from './casefile.js';
import { now } from './clock.js';
import type { ScheduledJob } from './scheduler.js';
import {
  hasWechatSubscriptionQuota,
  sendWechatSubscribeMessage,
  templateIdForScene,
} from './wechatSubscribe.js';

// 设计 §13.2 逐字文案（禁改）：三提醒节奏 20:30 今日复盘 / 18:00 补咨询记录 / 周五 周复盘。
const REVIEW_DESC = '20:30 生成今日复盘。';
const ORDER_DESC = '18:00 前补充高意向咨询记录。';
const WEEKLY_DESC = '本周五检查成交漏斗和内容表现。';

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** 本地 YYYY-MM-DD（与 casefile.todayStr 同口径，用于按天分桶的字符串区间扫描）。 */
function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** DateTime → HH:mm（军令 dueAt 展示用）。 */
function hhmm(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 当天零点（审计按天幂等的下界）。 */
function dayStartOf(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** 本周一零点（周提醒按周幂等 / 本周军令与周复盘的下界）。星期一为一周起点。 */
function weekStartOf(d: Date): Date {
  const dow = (d.getDay() + 6) % 7; // Mon=0 … Sun=6
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  start.setDate(start.getDate() - dow);
  return start;
}

/**
 * 提醒日历派生视图（GET /reminders）：纯读派生，不建表。
 * order 项时间取活跃案卷内最近一条未完成军令的 dueAt（无则默认 18:00）；
 * subscribed 取 WechatSubscription（scene 'review'，status accept）是否存在；
 * subscribeReady 取 review 订阅模板是否已配置（未配则前端不引导授权）。
 */
export async function buildReminderView(args: { tenantId: string; userId: string }): Promise<ReminderView> {
  const { userId } = args;
  const cf = await activeCasefile(userId);

  let orderTime = '18:00';
  if (cf) {
    const nextOrder = await prisma.casefileOrder.findFirst({
      where: { casefileId: cf.id, done: false, dueAt: { not: null } },
      orderBy: { dueAt: 'asc' },
      select: { dueAt: true },
    });
    // V7-05 起 dueAt 为标签串（18:00 / 今日 / 本周 / 待补）；是 HH:MM 才当提醒时刻，否则沿用默认。
    if (nextOrder?.dueAt) orderTime = /^\d{1,2}:\d{2}$/.test(nextOrder.dueAt) ? nextOrder.dueAt : orderTime;
  }

  const sub = await prisma.wechatSubscription.findFirst({
    where: { userId, scene: 'review', status: 'accept' },
    select: { id: true },
  });
  const subscribed = !!sub;

  const items: ReminderItem[] = [
    { key: 'order', time: orderTime, title: '今日军令截止', desc: ORDER_DESC, kind: 'order', subscribed },
    { key: 'review', time: '20:30', title: '今日复盘', desc: REVIEW_DESC, kind: 'review', subscribed },
    { key: 'weekly', time: '周五', title: '周复盘', desc: WEEKLY_DESC, kind: 'weekly', subscribed },
  ];

  return { items, subscribeReady: templateIdForScene('review') !== '' };
}

/**
 * 任务：09:00 军令提醒。服务端本地时间 ≥ ORDER_REMINDER_HOUR（默认 9）后，
 * 有活跃案卷、今日有未完成军令、当天未提醒过（system.order.reminder 审计行按天幂等）→ 发订阅消息。
 * 复用 scene 'review' 模板（不新增 scene），标题换成军令口径；有订阅额度才真正推送，未配模板静默跳过。
 * 幂等锚点用独立审计行（非 wechatNotificationLog scene），避免与 daily-review-reminder 的 review 触达互相抑制。
 * 返回本轮登记提醒的用户数（按天恰好一次）。
 */
export async function morningOrderReminderScan(): Promise<number> {
  const hour = Number(process.env.ORDER_REMINDER_HOUR ?? 9);
  const d = now();
  if (d.getHours() < hour) return 0;
  const today = todayStr();
  const dayStart = dayStartOf(d);

  const actives = await prisma.casefile.findMany({
    where: { status: 'active' },
    select: { id: true, tenantId: true, userId: true },
    take: 500,
  });

  let reminded = 0;
  for (const cf of actives) {
    const undone = await prisma.casefileOrder.findFirst({
      where: { casefileId: cf.id, date: today, done: false },
      select: { id: true },
    });
    if (!undone) continue;
    const already = await prisma.auditLog.findFirst({
      where: { userId: cf.userId, action: 'system.order.reminder', createdAt: { gte: dayStart } },
      select: { id: true },
    });
    if (already) continue;

    await recordAudit({
      tenantId: cf.tenantId,
      userId: cf.userId,
      action: 'system.order.reminder',
      payload: { casefileId: cf.id, date: today, reason: '今日有未完成军令' },
    });
    if (await hasWechatSubscriptionQuota(cf.userId, 'review')) {
      await sendWechatSubscribeMessage({
        tenantId: cf.tenantId,
        userId: cf.userId,
        scene: 'review',
        title: '今日军令待完成',
        note: '18:00 前补充高意向咨询记录',
      }).catch(() => ({ sent: false }));
    }
    reminded += 1;
  }
  if (reminded) console.log(`[scheduler] morning order reminders: ${reminded}`);
  return reminded;
}

/**
 * 任务：周五周复盘提醒。周五（getDay()===5）且本地时间 ≥ WEEK_REVIEW_REMINDER_HOUR（默认 17）后，
 * 有活跃案卷、本周有军令记录、本周尚无 week 层复盘、本周未提醒过（system.weekly.review.reminder 按周幂等）→ 发提醒。
 * 复用 review 模板；有订阅额度才推送，未配静默跳过。返回本轮登记提醒的用户数。
 */
export async function weeklyReviewReminderScan(): Promise<number> {
  const hour = Number(process.env.WEEK_REVIEW_REMINDER_HOUR ?? 17);
  const d = now();
  if (d.getDay() !== 5) return 0;
  if (d.getHours() < hour) return 0;
  const weekStart = weekStartOf(d);
  const weekStartStr = ymd(weekStart);

  const actives = await prisma.casefile.findMany({
    where: { status: 'active' },
    select: { id: true, tenantId: true, userId: true },
    take: 500,
  });

  let reminded = 0;
  for (const cf of actives) {
    const hasWeekOrders = await prisma.casefileOrder.findFirst({
      where: { casefileId: cf.id, date: { gte: weekStartStr } },
      select: { id: true },
    });
    if (!hasWeekOrders) continue;
    const weekReview = await prisma.reviewLog.findFirst({
      where: { userId: cf.userId, layer: 'week', date: { gte: weekStartStr } },
      select: { id: true },
    });
    if (weekReview) continue;
    const already = await prisma.auditLog.findFirst({
      where: { userId: cf.userId, action: 'system.weekly.review.reminder', createdAt: { gte: weekStart } },
      select: { id: true },
    });
    if (already) continue;

    await recordAudit({
      tenantId: cf.tenantId,
      userId: cf.userId,
      action: 'system.weekly.review.reminder',
      payload: { casefileId: cf.id, weekStart: weekStartStr, reason: '本周尚未做周复盘' },
    });
    if (await hasWechatSubscriptionQuota(cf.userId, 'review')) {
      await sendWechatSubscribeMessage({
        tenantId: cf.tenantId,
        userId: cf.userId,
        scene: 'review',
        title: '周复盘提醒',
        note: '本周五检查成交漏斗和内容表现',
      }).catch(() => ({ sent: false }));
    }
    reminded += 1;
  }
  if (reminded) console.log(`[scheduler] weekly review reminders: ${reminded}`);
  return reminded;
}

// 两个任务配置：由 scheduler.ts（父任务）import 后 registerJob 挂载；每 30 分钟扫一轮，按天/按周幂等，多扫无副作用。
export const MORNING_ORDER_JOB: ScheduledJob = {
  name: 'morning-order-reminder',
  intervalMs: 30 * 60_000,
  run: async () => { await morningOrderReminderScan(); },
};

export const WEEKLY_REVIEW_JOB: ScheduledJob = {
  name: 'weekly-review-reminder',
  intervalMs: 30 * 60_000,
  run: async () => { await weeklyReviewReminderScan(); },
};
