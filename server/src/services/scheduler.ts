// 定时任务框架（M1 PR-4）：进程内周期扫描（生产为单实例部署，见 prod 部署口径）。
// 设计：任务注册制（名字+周期+执行体），每个任务独立 try/catch —— 一个任务崩不影响其它；
// 每次执行打点日志，命中业务动作再落审计（audit_log）。测试/脚本环境不自启（NODE_ENV=test 或未调 start）。
// 任务位（随里程碑挂载）：案卷久未推进召回（已挂，v1 打点候选）→ M2 接：久不复盘提醒、预言到期验证、里程碑解锁。
// 触达注意：微信订阅消息是一次性授权，发送额度来自用户在打卡/复盘动线里的每次授权（前端埋点），
// 定时任务只负责「找出该提醒谁」并登记候选，发送走后续订阅消息通道。
import { prisma } from '../db.js';
import { recordAudit } from './audit.js';
import { now } from './clock.js';
import {
  hasSentWechatNotificationToday,
  hasWechatSubscriptionQuota,
  notifyReviewReminder,
  sendWechatSubscribeMessage,
} from './wechatSubscribe.js';

export interface ScheduledJob {
  name: string;
  intervalMs: number;
  run: () => Promise<void>;
}

const jobs: ScheduledJob[] = [];
const timers: ReturnType<typeof setInterval>[] = [];
let started = false;

export function registerJob(job: ScheduledJob): void {
  jobs.push(job);
}

/** 单个任务执行（含隔离与打点）；测试可直接调用驱动任务，不依赖真实计时器。 */
export async function runJob(name: string): Promise<void> {
  const job = jobs.find((j) => j.name === name);
  if (!job) throw new Error(`未注册的定时任务：${name}`);
  const t0 = Date.now();
  try {
    await job.run();
    console.log(`[scheduler] ${name} ok in ${Date.now() - t0}ms`);
  } catch (err) {
    console.error(`[scheduler] ${name} failed:`, (err as Error).message);
  }
}

export function startScheduler(): void {
  if (started || process.env.NODE_ENV === 'test') return;
  started = true;
  for (const job of jobs) {
    const t = setInterval(() => { void runJob(job.name); }, job.intervalMs);
    // 不阻止进程退出
    (t as { unref?: () => void }).unref?.();
    timers.push(t);
  }
  console.log(`[scheduler] started · ${jobs.length} jobs: ${jobs.map((j) => `${j.name}@${Math.round(j.intervalMs / 1000)}s`).join(', ')}`);
}

export function stopScheduler(): void {
  timers.forEach((t) => clearInterval(t));
  timers.length = 0;
  started = false;
}

// ============ 任务：案卷久未推进召回候选 ============
// 有活跃案卷、但 ≥48h 没有任何动作（打卡/回填/认可都会碰 casefile.updatedAt）→ 登记召回候选。
// 幂等：同一用户同一天只登记一次（按当天已有 system.recall.candidate 审计去重）。
export const RECALL_IDLE_HOURS = 48;

export async function scanIdleCasefiles(): Promise<number> {
  const cutoff = new Date(now().getTime() - RECALL_IDLE_HOURS * 3600_000);
  const dayStart = new Date(now().getFullYear(), now().getMonth(), now().getDate());
  const stale = await prisma.casefile.findMany({
    where: { status: 'active', updatedAt: { lt: cutoff } },
    select: { id: true, tenantId: true, userId: true, title: true, updatedAt: true },
    take: 200,
  });
  let flagged = 0;
  for (const cf of stale) {
    const already = await prisma.auditLog.findFirst({
      where: { userId: cf.userId, action: 'system.recall.candidate', createdAt: { gte: dayStart } },
      select: { id: true },
    });
    if (already) continue;
    await recordAudit({
      tenantId: cf.tenantId,
      userId: cf.userId,
      action: 'system.recall.candidate',
      payload: { casefileId: cf.id, title: cf.title, idleSince: cf.updatedAt.toISOString(), reason: `案卷超过 ${RECALL_IDLE_HOURS}h 未推进` },
    });
    flagged += 1;
  }
  if (flagged) console.log(`[scheduler] recall candidates: ${flagged}`);
  return flagged;
}

// ============ 任务：久不复盘提醒候选（M2 PR-8） ============
// 复盘过至少一次、但最近 REVIEW_GAP_DAYS 天没有 day 复盘、且案卷仍活跃 → 登记提醒候选。
// V6.0 §16 防呆「久不复盘 → 主动提醒 + 说明连续天数中断的影响」；发送走订阅消息通道（授权由前端动线累积）。
export const REVIEW_GAP_DAYS = 2;

export async function scanReviewGaps(): Promise<number> {
  const dayStart = new Date(now().getFullYear(), now().getMonth(), now().getDate());
  const cutoff = new Date(now().getTime() - REVIEW_GAP_DAYS * 86400_000);
  const iso = (t: Date) => `${t.getFullYear()}-${`${t.getMonth() + 1}`.padStart(2, '0')}-${`${t.getDate()}`.padStart(2, '0')}`;
  // 有活跃案卷的用户里，找「复盘过但最近断档」的（按用户聚合最近一次 day 复盘日期）
  const actives = await prisma.casefile.findMany({ where: { status: 'active' }, select: { tenantId: true, userId: true }, take: 500 });
  let flagged = 0;
  for (const cf of actives) {
    const last = await prisma.reviewLog.findFirst({
      where: { userId: cf.userId, layer: 'day' },
      orderBy: { date: 'desc' },
      select: { date: true },
    });
    if (!last || last.date >= iso(cutoff)) continue; // 从没复盘过（由召回任务管）或还没断档
    const already = await prisma.auditLog.findFirst({
      where: { userId: cf.userId, action: 'system.review.reminder.candidate', createdAt: { gte: dayStart } },
      select: { id: true },
    });
    if (already) continue;
    await recordAudit({
      tenantId: cf.tenantId,
      userId: cf.userId,
      action: 'system.review.reminder.candidate',
      payload: { lastReviewDate: last.date, gapDays: REVIEW_GAP_DAYS, reason: '连续复盘中断风险' },
    });
    if (await hasWechatSubscriptionQuota(cf.userId, 'review')) {
      notifyReviewReminder({ tenantId: cf.tenantId, userId: cf.userId, lastReviewDate: last.date });
    }
    flagged += 1;
  }
  if (flagged) console.log(`[scheduler] review reminder candidates: ${flagged}`);
  return flagged;
}

// ============ 任务：当日复盘订阅提醒 ============
// 21:30 前后（按服务端本地时区）提醒当天还没做 day 复盘的活跃案卷用户。
// 发送前检查：用户当天未收到过 review 订阅消息、仍有一次性授权额度、当天未复盘。
export const REVIEW_REMINDER_HOUR = Number(process.env.REVIEW_REMINDER_HOUR ?? 21);

export async function scanDailyReviewReminders(): Promise<number> {
  const d = now();
  if (d.getHours() < REVIEW_REMINDER_HOUR) return 0;
  const today = `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`;
  const actives = await prisma.casefile.findMany({
    where: { status: 'active' },
    select: { tenantId: true, userId: true },
    take: 500,
  });
  let sent = 0;
  for (const cf of actives) {
    const reviewed = await prisma.reviewLog.findUnique({
      where: { userId_layer_date: { userId: cf.userId, layer: 'day', date: today } },
      select: { id: true },
    });
    if (reviewed) continue;
    if (await hasSentWechatNotificationToday(cf.userId, 'review')) continue;
    if (!(await hasWechatSubscriptionQuota(cf.userId, 'review'))) continue;
    const r = await sendWechatSubscribeMessage({
      tenantId: cf.tenantId,
      userId: cf.userId,
      scene: 'review',
      title: '今晚复盘提醒',
      note: '记录今日结果，调整明天军令',
    });
    if (r.sent) sent += 1;
  }
  if (sent) console.log(`[scheduler] daily review reminders sent: ${sent}`);
  return sent;
}

// ============ 任务：预言到期验证候选（M2 PR-9） ============
// pending 且 dueDate ≤ 今天 且未提醒过 → 登记「天机对账」候选（行级 dueNotifiedAt 幂等），
// 下次日/月复盘时由军师带出来逐条对账（发送提醒走订阅消息通道）。
export async function scanDueProphecies(): Promise<number> {
  const d = now();
  const today = `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`;
  const due = await prisma.prophecyLog.findMany({
    where: { status: 'pending', dueNotifiedAt: null, dueDate: { not: null, lte: today } },
    take: 200,
  });
  for (const p of due) {
    await recordAudit({
      tenantId: p.tenantId,
      userId: p.userId,
      action: 'system.prophecy.due',
      payload: { prophecyId: p.id, seq: p.seq, dueDate: p.dueDate, prophecy: p.prophecy.slice(0, 100) },
    });
    await prisma.prophecyLog.update({ where: { id: p.id }, data: { dueNotifiedAt: new Date() } });
  }
  if (due.length) console.log(`[scheduler] prophecies due: ${due.length}`);
  return due.length;
}

// 注册内置任务（周期：每 6 小时扫一轮；召回/提醒按天幂等，多扫无副作用）
registerJob({ name: 'casefile-idle-recall', intervalMs: 6 * 3600_000, run: async () => { await scanIdleCasefiles(); } });
registerJob({ name: 'review-gap-reminder', intervalMs: 6 * 3600_000, run: async () => { await scanReviewGaps(); } });
registerJob({ name: 'daily-review-reminder', intervalMs: 30 * 60_000, run: async () => { await scanDailyReviewReminders(); } });
registerJob({ name: 'prophecy-due-scan', intervalMs: 6 * 3600_000, run: async () => { await scanDueProphecies(); } });
