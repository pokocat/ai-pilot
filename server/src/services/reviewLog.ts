// 复盘账本服务（M2 PR-8）：六层复盘事件 → 对齐率 / 连续复盘天数（全部服务端计算）。
// day 层触发点：执行页「生成今日复盘」发起复盘对话时落一条（当日军令/回填的事实快照）；
// 同层同日 upsert（一天多次复盘只算一次，快照取最新）。week/month 等层随 M3 触发词路由接入。
import { prisma } from '../db.js';
import { now } from './clock.js';
import { activeCasefile, todayStr } from './casefile.js';

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
  const date = todayStr();
  const cf = await activeCasefile(args.userId);

  // day 层事实快照：当日军令完成/对齐情况 + 是否回填
  let ordersTotal = 0; let ordersDone = 0; let alignedTotal = 0; let hasBackfill = false;
  if (cf) {
    const orders = await prisma.casefileOrder.findMany({ where: { casefileId: cf.id, date } });
    ordersTotal = orders.length;
    ordersDone = orders.filter((o) => o.done).length;
    alignedTotal = orders.filter((o) => o.aligned === true).length;
    hasBackfill = !!(await prisma.casefileMetric.findUnique({ where: { casefileId_date: { casefileId: cf.id, date } } }));
  }
  // 对齐率（V6.0 §10：对齐主要矛盾的事 ÷ 总事数）；无军令 = null，不编 0%
  const alignRate = ordersTotal > 0 ? Math.round((alignedTotal / ordersTotal) * 100) : null;

  const data = {
    tenantId: args.tenantId,
    casefileId: cf?.id ?? null,
    ordersTotal, ordersDone, alignedTotal, alignRate, hasBackfill,
    note: (args.note ?? '').trim().slice(0, 500),
  };
  const row = await prisma.reviewLog.upsert({
    where: { userId_layer_date: { userId: args.userId, layer, date } },
    update: data,
    create: { userId: args.userId, layer, date, ...data },
  });
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
  const d = now();
  const iso = (t: Date) => `${t.getFullYear()}-${`${t.getMonth() + 1}`.padStart(2, '0')}-${`${t.getDate()}`.padStart(2, '0')}`;
  let cursor = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  // 今天还没复盘不打断连续（今晚还可以补）；从昨天开始也算连续
  if (!dates.has(iso(cursor))) cursor = new Date(cursor.getTime() - 86400_000);
  let streak = 0;
  while (dates.has(iso(cursor))) {
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
  return lines.join('\n');
}
