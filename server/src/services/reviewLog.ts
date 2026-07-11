// 复盘账本服务（M2 PR-8）：六层复盘事件 → 对齐率 / 连续复盘天数（全部服务端计算）。
// day 层触发点：执行页「生成今日复盘」发起复盘对话时落一条（当日军令/回填的事实快照）；
// 同层同日 upsert（一天多次复盘只算一次，快照取最新）。week/month 等层随 M3 触发词路由接入。
import { prisma } from '../db.js';
import type { Prisma } from '@prisma/client';
import { dateKey, dayStart, weekStart } from './clock.js';
import { activeCasefile, todayStr } from './casefile.js';

// 复盘覆盖区间：day=当天；week=本周一→今天；month=当月 1 号→今天（quarter/year/team 暂按当天，随后续聚合）。
// 日历日/周一一律按 Asia/Shanghai 派生（P1-4），不依赖进程 TZ。
function periodRange(layer: ReviewLayer, today: string): { date: string; from: string } {
  if (layer === 'week') {
    const monday = dateKey(weekStart());
    return { date: monday, from: monday };
  }
  if (layer === 'month') { const m = `${today.slice(0, 7)}-01`; return { date: m, from: m }; }
  return { date: today, from: today };
}

export const REVIEW_LAYERS = ['day', 'week', 'month', 'quarter', 'year', 'team'] as const;
export type ReviewLayer = (typeof REVIEW_LAYERS)[number];

export interface ReviewView {
  id: string;
  layer: ReviewLayer;
  date: string;
  ordersTotal: number;
  ordersDone: number;
  alignedTotal: number;
  alignRate: number | null;
  hasBackfill: boolean;
  createdAt: string;
}

/** 记一次复盘（day 层自动快照当日军令与回填事实；同层同日 upsert）。 */
export async function recordReview(args: {
  tenantId: string;
  userId: string;
  layer?: ReviewLayer;
  note?: string;
}): Promise<ReviewView> {
  const layer: ReviewLayer = args.layer && REVIEW_LAYERS.includes(args.layer) ? args.layer : 'day';
  const today = todayStr();
  const { date, from } = periodRange(layer, today);
  const cf = await activeCasefile(args.userId);

  // 覆盖区间事实快照：军令完成/对齐 + CasefileMetric(线索/咨询/成交)求和（week/month=期聚合，修 A-4「月复盘 LLM 现编」）。
  let ordersTotal = 0, ordersDone = 0, alignedTotal = 0, leads = 0, consults = 0, deals = 0, hasBackfill = false;
  if (cf) {
    const orders = await prisma.casefileOrder.findMany({ where: { casefileId: cf.id, date: { gte: from, lte: today } } });
    ordersTotal = orders.length;
    ordersDone = orders.filter((o) => o.done).length;
    alignedTotal = orders.filter((o) => o.aligned === true).length;
    const metrics = await prisma.casefileMetric.findMany({ where: { casefileId: cf.id, date: { gte: from, lte: today } } });
    for (const m of metrics) { leads += m.leads; consults += m.consults; deals += m.deals; }
    hasBackfill = metrics.length > 0;
  }
  // 对齐率（V6.0 §10：对齐主要矛盾的事 ÷ 总事数）；无军令 = null，不编 0%
  const alignRate = ordersTotal > 0 ? Math.round((alignedTotal / ordersTotal) * 100) : null;

  const data = {
    tenantId: args.tenantId,
    casefileId: cf?.id ?? null,
    ordersTotal, ordersDone, alignedTotal, alignRate, hasBackfill,
    metricsJson: { leads, consults, deals } as Prisma.InputJsonValue,
    note: (args.note ?? '').trim().slice(0, 500),
  };
  const row = await prisma.reviewLog.upsert({
    where: { userId_layer_date: { userId: args.userId, layer, date } },
    update: data,
    create: { userId: args.userId, layer, date, ...data },
  });
  // WO-07：首次日复盘 → journey executing→reviewing（review.first；仅 day 层，重复触发幂等）
  if (layer === 'day') await import('./journey.js').then((m) => m.applyJourneyEvent(args.userId, args.tenantId, 'review.first')).catch(() => {});
  // D-3-3：月复盘落库成功 → 健康度估测挂钩（每月幂等一次；动态 import 断开与 health.ts 的静态环）。
  // fire-and-forget：估测不阻塞月复盘返回，失败也不影响本次复盘落库。
  if (layer === 'month') void import('./health.js').then((m) => m.maybeEstimateMonthlyHealth(args.userId, args.tenantId)).catch(() => {});
  return {
    id: row.id, layer: row.layer as ReviewLayer, date: row.date,
    ordersTotal: row.ordersTotal, ordersDone: row.ordersDone, alignedTotal: row.alignedTotal,
    alignRate: row.alignRate, hasBackfill: row.hasBackfill, createdAt: row.createdAt.toISOString(),
  };
}

/** 连续复盘天数（day 层）：从今天（或昨天，若今天还没复盘）往回数连续有复盘的天数。 */
export async function reviewStreak(userId: string): Promise<number> {
  const rows = await prisma.reviewLog.findMany({
    where: { userId, layer: 'day' },
    select: { date: true },
    orderBy: { date: 'desc' },
    take: 400,
  });
  if (!rows.length) return 0;
  const dates = new Set(rows.map((r) => r.date));
  // 游标从「上海今天 00:00」的 UTC 瞬时起，每次回退 24h（上海无夏令时，恒落到前一日同一墙钟）。
  let cursor = dayStart();
  // 今天还没复盘不打断连续（今晚还可以补）；从昨天开始也算连续
  if (!dates.has(dateKey(cursor))) cursor = new Date(cursor.getTime() - 86400_000);
  let streak = 0;
  while (dates.has(dateKey(cursor))) {
    streak += 1;
    cursor = new Date(cursor.getTime() - 86400_000);
  }
  return streak;
}

export async function listReviews(userId: string, limit = 30): Promise<ReviewView[]> {
  const rows = await prisma.reviewLog.findMany({ where: { userId }, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }], take: limit });
  return rows.map((row) => ({
    id: row.id, layer: row.layer as ReviewLayer, date: row.date,
    ordersTotal: row.ordersTotal, ordersDone: row.ordersDone, alignedTotal: row.alignedTotal,
    alignRate: row.alignRate, hasBackfill: row.hasBackfill, createdAt: row.createdAt.toISOString(),
  }));
}

/** 注入对话的【复盘账本】块：连续天数 + 最近一次事实快照（战友见证/悬念钩子的真实素材）。 */
export async function reviewBriefing(userId: string): Promise<string | null> {
  const [streak, recent] = await Promise.all([reviewStreak(userId), listReviews(userId, 3)]);
  if (!recent.length) return null;
  const last = recent[0];
  const lines = [
    '【复盘账本（系统计数，引用时以此为准，禁止自行推算天数或比率）】',
    `连续复盘：${streak} 天`,
    `最近复盘：${last.date}（${last.layer}）· 军令 ${last.ordersDone}/${last.ordersTotal} 完成` +
      `${last.alignRate !== null ? ` · 对齐率 ${last.alignRate}%` : ''} · 数据回填${last.hasBackfill ? '已完成' : '未完成'}`,
  ];
  // WO-04：最近一次周/月报的期聚合（线索/咨询/成交），月复盘对账素材（系统求和，非 LLM 现编）。
  const period = await prisma.reviewLog.findFirst({ where: { userId, layer: { in: ['week', 'month'] } }, orderBy: { date: 'desc' }, select: { layer: true, date: true, metricsJson: true, ordersDone: true, ordersTotal: true } });
  if (period?.metricsJson) {
    const m = period.metricsJson as { leads?: number; consults?: number; deals?: number };
    lines.push(`最近${period.layer === 'month' ? '月报' : '周报'}（${period.date}）：线索 ${m.leads ?? 0} · 咨询 ${m.consults ?? 0} · 成交 ${m.deals ?? 0} · 军令 ${period.ordersDone}/${period.ordersTotal}`);
  }
  return lines.join('\n');
}
