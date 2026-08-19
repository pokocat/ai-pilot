// 定时任务框架（M1 PR-4）：每个 API 实例都会计时，但每轮通过 PostgreSQL advisory lock 选出唯一执行者。
// 设计：任务注册制（名字+周期+执行体），每个任务独立 try/catch —— 一个任务崩不影响其它；
// 每次执行打点日志，命中业务动作再落审计（audit_log）。测试/脚本环境不自启（NODE_ENV=test 或未调 start）。
// 任务位（随里程碑挂载）：案卷久未推进召回（已挂，v1 打点候选）→ M2 接：久不复盘提醒、预言到期验证、里程碑解锁。
// 触达注意：微信订阅消息是一次性授权，发送额度来自用户在打卡/复盘动线里的每次授权（前端埋点），
// 定时任务只负责「找出该提醒谁」并登记候选，发送走后续订阅消息通道。
import { prisma } from '../db.js';
import { recordAudit } from './audit.js';
import { now, dateKey, hourOf, dayStart } from './clock.js';
import { MORNING_ORDER_JOB, WEEKLY_REVIEW_JOB } from './reminders.js';
import { scanPrescriptionFollowups } from './prescription.js';
import { sweepPendingOrders, sweepPendingRefunds } from './wechatPay.js';
import { expireStalePendingSubscriptions, reconcilePapayOrders, reconcilePendingSubscriptions, scanAutoRenewals, scanPendingSubscriptionCancellations } from './wechatPapay.js';
import {
  hasSentWechatNotificationToday,
  hasWechatSubscriptionQuota,
  notifyReviewReminder,
  sendWechatSubscribeMessage,
} from './wechatSubscribe.js';
import { scanClipRenderNotifications } from './video/renderNotification.js';
import { scanAvatarTrainingNotifications } from './video/avatarNotification.js';
import { scanDataErasureJobs } from './accountDeletion.js';
import { runVideoMaintenanceSweep } from './video/maintenance.js';

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
    if (process.env.NODE_ENV === 'test') {
      await job.run();
    } else {
      await prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<Array<{ acquired: boolean }>>`
          SELECT pg_try_advisory_xact_lock(hashtext(${`junshi:scheduler:${name}`})) AS acquired
        `;
        if (!rows[0]?.acquired) {
          console.log(`[scheduler] ${name} skipped · another instance owns lease`);
          return;
        }
        await job.run();
      }, { timeout: 15 * 60_000 });
    }
    console.log(`[scheduler] ${name} ok in ${Date.now() - t0}ms`);
  } catch (err) {
    console.error(`[scheduler] ${name} failed:`, (err as Error).message);
  }
}

export function startScheduler(): void {
  if (started || process.env.NODE_ENV === 'test') return;
  // 显式停机开关。两个用途：
  //   ① 压测——本函数只在 NODE_ENV!=test 时启动，而压测栈按 P0-0 已切到 production，
  //      定时任务会真的开始周期性全量扫库并尝试推送，给容量测量掺进无关的背景负载；
  //   ② 运维——可在只运 API 的节点关闭背景扫描；多实例同时开启也会由 DB 锁去重。
  // 默认 true = 行为不变。
  if ((process.env.SCHEDULER_ENABLED ?? 'true').trim() === 'false') {
    console.log('[scheduler] SCHEDULER_ENABLED=false，本进程不启动定时任务');
    return;
  }
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
  const todayStart = dayStart(); // 上海时区当日 00:00（P1-4）
  const stale = await prisma.casefile.findMany({
    where: { status: 'active', updatedAt: { lt: cutoff } },
    select: { id: true, tenantId: true, userId: true, title: true, updatedAt: true },
    take: 200,
  });
  let flagged = 0;
  for (const cf of stale) {
    const already = await prisma.auditLog.findFirst({
      where: { userId: cf.userId, action: 'system.recall.candidate', createdAt: { gte: todayStart } },
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
  const todayStart = dayStart(); // 上海时区当日 00:00（P1-4）
  const cutoff = new Date(now().getTime() - REVIEW_GAP_DAYS * 86400_000);
  // 有活跃案卷的用户里，找「复盘过但最近断档」的（按用户聚合最近一次 day 复盘日期）
  const actives = await prisma.casefile.findMany({ where: { status: 'active' }, select: { tenantId: true, userId: true }, take: 500 });
  let flagged = 0;
  for (const cf of actives) {
    const last = await prisma.reviewLog.findFirst({
      where: { userId: cf.userId, layer: 'day' },
      orderBy: { date: 'desc' },
      select: { date: true },
    });
    if (!last || last.date >= dateKey(cutoff)) continue; // 从没复盘过（由召回任务管）或还没断档
    const already = await prisma.auditLog.findFirst({
      where: { userId: cf.userId, action: 'system.review.reminder.candidate', createdAt: { gte: todayStart } },
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
  if (hourOf() < REVIEW_REMINDER_HOUR) return 0;
  const today = dateKey();
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
      category: '复盘提醒',
      title: '今晚复盘提醒',
      note: '记录今日结果，调整明天军令',
    });
    if (r.sent) sent += 1;
  }
  if (sent) console.log(`[scheduler] daily review reminders sent: ${sent}`);
  return sent;
}

// ============ 任务：套餐到期提醒 ============
// 2026-08-09 正式发布起，关掉注册自动开通、所有人都有真到期日，而全站此前**没有任何**到期提醒：
// 到期那天 planGate 直接翻只读、AI 交互全停，用户只会看到「方案已到期」的拦截弹窗——续费提醒
// 必须提前送到手机上，而不是等他撞墙。
//
// 借 review 场景模板（与 scanDueProphecies / reminders.ts 同口径，不新增 scene）：新模板要走微信后台
// 申请与逐字核键，而 26922「最新分析报告提醒」本就是 类型/名称/备注/时间 的通用提醒位，语义装得下。
//
// 幂等：每个「用户 × 本次到期日 × 提前天数档」只发一次，锚点写 audit_log（key 里带 expiresAt，
// 续费换了到期日就是新一轮，不会因为上次发过而永远不再提醒）。
export const PLAN_EXPIRY_REMIND_HOUR = Number(process.env.PLAN_EXPIRY_REMIND_HOUR ?? 10);
/** 提前天数档：7/3/1 天各推一次，0 = 到期当天补一条（此时已只读，是最后的续费触点）。 */
export const PLAN_EXPIRY_REMIND_BUCKETS = [7, 3, 1, 0];

/** 落在哪个提醒档：剩余天数向上取整后取「不大于它的最大档」，跨档跳跃（扫描漏了一天）也不会漏提醒。 */
function expiryBucketOf(daysLeft: number): number | null {
  if (daysLeft < 0) return null; // 已过期超过一天：不再打扰，续费引导由端上只读态承担
  for (const b of PLAN_EXPIRY_REMIND_BUCKETS) if (daysLeft >= b) return b;
  return null;
}

export async function scanPlanExpiryReminders(): Promise<number> {
  if (hourOf() < PLAN_EXPIRY_REMIND_HOUR) return 0; // 不在凌晨推送
  const at = now();
  const horizon = new Date(at.getTime() + (PLAN_EXPIRY_REMIND_BUCKETS[0] + 1) * 864e5);
  const users = await prisma.user.findMany({
    where: { planId: { not: null }, planExpiresAt: { not: null, lte: horizon, gte: new Date(at.getTime() - 864e5) } },
    select: { id: true, tenantId: true, planExpiresAt: true, plan: { select: { name: true } } },
    take: 500,
  });
  let sent = 0;
  for (const u of users) {
    const daysLeft = Math.ceil((u.planExpiresAt!.getTime() - at.getTime()) / 864e5);
    const bucket = expiryBucketOf(daysLeft);
    if (bucket === null) continue;
    const key = `${u.id}:${u.planExpiresAt!.toISOString()}:${bucket}`;
    const done = await prisma.auditLog.findFirst({
      where: { userId: u.id, action: 'system.plan.expiry_notice', payloadJson: { path: ['key'], equals: key } },
      select: { id: true },
    });
    if (done) continue;
    // 与当晚复盘提醒共用同一份一次性授权额度：同一天不叠着推两条（复盘先到就让给复盘，明天再提醒）。
    if (await hasSentWechatNotificationToday(u.id, 'review')) continue;
    if (!(await hasWechatSubscriptionQuota(u.id, 'review'))) continue;
    const planName = u.plan?.name ?? '当前方案';
    const r = await sendWechatSubscribeMessage({
      tenantId: u.tenantId,
      userId: u.id,
      scene: 'review',
      category: bucket === 0 ? '方案到期' : '方案续期提醒',
      title: bucket === 0 ? `${planName}今日到期` : `${planName}还有${bucket}天到期`,
      note: bucket === 0 ? '续期后可继续对话与出成果' : '提前续期，避免推演中断',
    });
    if (!r.sent) continue;
    // 锚点只在**真发出去之后**才写：没送达就不该占掉这一档，否则用户一条提醒都收不到却显示已提醒过。
    await recordAudit({
      tenantId: u.tenantId, userId: u.id, action: 'system.plan.expiry_notice',
      payload: { key, bucket, daysLeft, planName, expiresAt: u.planExpiresAt!.toISOString() },
    });
    sent += 1;
  }
  if (sent) console.log(`[scheduler] plan expiry reminders sent: ${sent}`);
  return sent;
}

// ============ 任务：预言到期验证候选（M2 PR-9） ============
// pending 且 dueDate ≤ 今天 且未提醒过 → 登记「天机对账」候选（行级 dueNotifiedAt 幂等），
// 下次日/月复盘时由军师带出来逐条对账。
// #1 预言揭封（留存机制）：此前这里只记账不推送——「预言到期」这个全体系最强的回访事件在用户
// 手机上毫无动静。补上订阅消息推送：借 review 场景模板（与 reminders.ts 同口径，不新增 scene），
// 额度制天然限频；岁验（年度谶语，basis 约定前缀）换专属措辞。best-effort：推送失败/无额度
// 不阻断 dueNotifiedAt 锚点——对账候选照常进复盘，推送只是多一次拉回。
export async function scanDueProphecies(): Promise<number> {
  const today = dateKey();
  const due = await prisma.prophecyLog.findMany({
    where: { status: 'pending', dueNotifiedAt: null, dueDate: { not: null, lte: today } },
    take: 200,
  });
  const tried = new Set<string>(); // 同一轮同一用户至多推一条（多条同日到期只打扰一次，进复盘自会看到全部）
  const pushed = new Set<string>(); // 其中真正送达微信的（供日志如实计数，勿与 tried 混用）
  for (const p of due) {
    await recordAudit({
      tenantId: p.tenantId,
      userId: p.userId,
      action: 'system.prophecy.due',
      payload: { prophecyId: p.id, seq: p.seq, dueDate: p.dueDate, prophecy: p.prophecy.slice(0, 100) },
    });
    if (!tried.has(p.userId)) {
      tried.add(p.userId);
      const isOmen = (p.basis ?? '').startsWith('年度谶语·岁验'); // 与 strategicProfile.registerVerseOmen 的约定值对齐
      // 只把**真发出去的**计入 pushed。此前这里统计的是「尝试过的用户数」且吞掉了 r.sent，
      // 于是无配额/微信拒收时日志照样宣称「pushed N」——正是这类不核实的计数器，
      // 掩盖了「套餐到账通知从未发出」整整半个月（2026-07-31 真机实测才发现）。
      const r = await sendWechatSubscribeMessage({
        tenantId: p.tenantId,
        userId: p.userId,
        scene: 'review',
        category: isOmen ? '岁验' : '预言对账',
        title: isOmen ? '一年前那句话，今日对账' : '预言到期·今日对账',
        note: p.prophecy, // 发送侧 clip 到 20 字；谶语「七言，七言」整 15 字恰好完整可见
      }).catch(() => ({ sent: false }));
      if (r.sent) pushed.add(p.userId);
    }
    await prisma.prophecyLog.update({ where: { id: p.id }, data: { dueNotifiedAt: new Date() } });
  }
  if (due.length) console.log(`[scheduler] prophecies due: ${due.length} (pushed ${pushed.size})`);
  return due.length;
}

// WO-14 处方追踪闭环：activated 满 7 天的处方行级打 followupAt（每处方一次，followupAt=null 幂等，多扫无副作用）。
export async function scanPrescriptionFollowup(): Promise<number> {
  const flagged = await scanPrescriptionFollowups();
  if (flagged) console.log(`[scheduler] prescription followups flagged: ${flagged}`);
  return flagged;
}

// 注册内置任务（周期：每 6 小时扫一轮；召回/提醒按天幂等，多扫无副作用）
// 端点探活（services/aiProbe）：把「能力靠猜、验证靠人记得点按钮」变成周期性证据。
// 频率见 SCHEDULED_PROBES；探活是真实计费请求，用量按 kind='probe' 单独记账，
// 并留 AI_PROBE_SCHEDULED=false 一键全停。
registerJob({
  name: 'ai-endpoint-probe',
  intervalMs: 10 * 60_000,
  run: async () => {
    const { scheduledProbeSweep } = await import('./aiProbe.js');
    await scheduledProbeSweep(now());
  },
});

registerJob({ name: 'casefile-idle-recall', intervalMs: 6 * 3600_000, run: async () => { await scanIdleCasefiles(); } });
registerJob({ name: 'review-gap-reminder', intervalMs: 6 * 3600_000, run: async () => { await scanReviewGaps(); } });
registerJob({ name: 'daily-review-reminder', intervalMs: 30 * 60_000, run: async () => { await scanDailyReviewReminders(); } });
registerJob({ name: 'prophecy-due-scan', intervalMs: 6 * 3600_000, run: async () => { await scanDueProphecies(); } });
// 套餐到期提醒：每 2 小时扫一轮（PLAN_EXPIRY_REMIND_HOUR 之前直接短路），按「用户×到期日×档位」幂等。
registerJob({ name: 'plan-expiry-reminder', intervalMs: 2 * 3600_000, run: async () => { await scanPlanExpiryReminders(); } });
registerJob({ name: 'prescription-followup-scan', intervalMs: 6 * 3600_000, run: async () => { await scanPrescriptionFollowup(); } });
// 数字分身训练是石榴云端异步任务；用户离开小程序后由服务端继续轮询。
// 只扫最近 24h 主动点过“训练好通知我”的账号，不启动新训练、不消耗石榴生成点数。
registerJob({ name: 'avatar-training-notification', intervalMs: 60_000, run: async () => {
  const result = await scanAvatarTrainingNotifications();
  if (result.scanned || result.failed) {
    console.log(`[scheduler] avatar training notifications: sent=${result.sent} failed=${result.failed} (scanned ${result.scanned})`);
  }
} });
// 出片同样是云端异步任务：用户退出小程序后由服务端继续推进。
// 这个 job 还兼着一件更要紧的事 —— settleVideoJob 此前只在小程序轮询 GET /video/jobs/:id 时触发，
// 用户中途退出的话，出片失败的积分永远退不回来。详见 services/video/renderNotification.ts。
registerJob({ name: 'clip-render-notification', intervalMs: 60_000, run: async () => {
  const result = await scanClipRenderNotifications();
  if (result.settled || result.failed) {
    console.log(`[scheduler] clip render: settled=${result.settled} sent=${result.sent} failed=${result.failed} (scanned ${result.scanned})`);
  }
} });
registerJob({ name: 'account-erasure-sweep', intervalMs: 5 * 60_000, run: async () => {
  const completed = await scanDataErasureJobs();
  if (completed) console.log(`[scheduler] account erasure completed: ${completed}`);
} });
registerJob({ name: 'video-maintenance-sweep', intervalMs: 5 * 60_000, run: runVideoMaintenanceSweep });
// V7-11：09:00 军令提醒 + 周五周复盘提醒（scan 函数在 services/reminders.ts，job 常量在此注册）。
registerJob(MORNING_ORDER_JOB);
registerJob(WEEKLY_REVIEW_JOB);
// 支付对账 sweep（P0）：回调丢失/卡单自愈——paid 未 applied 查单补账、created 超时查单/关单。
// 未配支付（payConfigured=false）时 sweep 内部直接短路，注册无副作用。
registerJob({ name: 'pay-reconcile-sweep', intervalMs: 5 * 60_000, run: async () => {
  const r = await sweepPendingOrders();
  const refunds = await sweepPendingRefunds();
  const subscriptions = await scanAutoRenewals();
  const papay = await reconcilePapayOrders();
  const pendingSubscriptions = await reconcilePendingSubscriptions();
  const cancellations = await scanPendingSubscriptionCancellations();
  const staleSubscriptions = await expireStalePendingSubscriptions();
  if (r.applied || r.failed || r.closed) console.log(`[scheduler] pay sweep: applied=${r.applied} failed=${r.failed} closed=${r.closed} (scanned ${r.scanned})`);
  if (refunds.scanned) console.log(`[scheduler] refund sweep: completed=${refunds.completed} (scanned ${refunds.scanned})`);
  if (subscriptions.scanned) console.log(`[scheduler] auto-renew: submitted=${subscriptions.submitted} failed=${subscriptions.failed} (scanned ${subscriptions.scanned})`);
  if (papay.scanned) console.log(`[scheduler] papay reconcile: applied=${papay.applied} failed=${papay.failed} (scanned ${papay.scanned})`);
  if (pendingSubscriptions.scanned) console.log(`[scheduler] papay contract reconcile: activated=${pendingSubscriptions.activated} closed=${pendingSubscriptions.closed} (scanned ${pendingSubscriptions.scanned})`);
  if (cancellations.scanned) console.log(`[scheduler] papay cancellations: cancelled=${cancellations.cancelled} (scanned ${cancellations.scanned})`);
  if (staleSubscriptions) console.log(`[scheduler] papay pending subscriptions expired: ${staleSubscriptions}`);
} });
