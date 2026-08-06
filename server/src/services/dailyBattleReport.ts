import type { DailyBattleReportView } from '../../../shared/contracts';
import { prisma } from '../db.js';
import { dayOfYear } from './clock.js';
import { activeCasefile, todayStr } from './casefile.js';
import { reviewStreak } from './reviewLog.js';
import { syncProgress } from './progress.js';

const QUOTES = [
  '集中优势兵力，各个歼灭。',
  '没有调查，就没有发言权。',
  '善战者，求之于势，不责于人。',
  '伤其十指，不如断其一指。',
  '不打无准备之仗。',
  '知己知彼，百战不殆。',
  '兵贵神速。',
];

/** 当前登录用户当天的战报视图。所有数字都来自案卷军令、经营回填和复盘账本。 */
export async function dailyBattleReport(userId: string): Promise<DailyBattleReportView> {
  const date = todayStr();
  const casefile = await activeCasefile(userId);
  const [orders, backfill, streak, progress] = await Promise.all([
    casefile
      ? prisma.casefileOrder.findMany({ where: { casefileId: casefile.id, date }, orderBy: { createdAt: 'asc' } })
      : [],
    casefile
      ? prisma.casefileMetric.findUnique({ where: { casefileId_date: { casefileId: casefile.id, date } } })
      : null,
    reviewStreak(userId),
    syncProgress(userId),
  ]);

  const done = orders.filter((order) => order.done).length;
  const aligned = orders.filter((order) => order.aligned === true).length;
  return {
    date,
    casefileTitle: casefile?.title ?? null,
    rank: progress?.rank ?? '新兵',
    streak,
    orders: orders.map((order) => ({ id: order.id, text: order.text, done: order.done, aligned: order.aligned })),
    done,
    total: orders.length,
    aligned,
    alignRate: orders.length ? Math.round((aligned / orders.length) * 100) : null,
    backfill: backfill ? { leads: backfill.leads, consults: backfill.consults, deals: backfill.deals } : null,
    quote: QUOTES[dayOfYear() % QUOTES.length],
  };
}
