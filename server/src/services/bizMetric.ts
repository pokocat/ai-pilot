// WO-10：结构化经营周报数。字段由行业决定（与 IndustryBenchmark.metricKey 对齐），形成连续序列供军师对比。
// 注入【经营序列】块时，与行业中位 p50 的「差值由服务端算」（数字铁律，禁 AI 自算）。
import { prisma } from '../db.js';

/** 该行业可报的指标集（=基准库该行业启用的 metricKey，保证「报什么就能对比什么」）。 */
export async function metricTemplate(industry: string | null | undefined): Promise<{ metricKey: string; metricName: string; unit: string }[]> {
  if (!industry) return [];
  const rows = await prisma.industryBenchmark.findMany({ where: { industry, enabled: true }, orderBy: { metricKey: 'asc' }, select: { metricKey: true, metricName: true, unit: true } });
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.metricKey) ? false : (seen.add(r.metricKey), true)));
}

export async function upsertWeek(args: { tenantId: string; userId: string; weekStart: string; metrics: Record<string, number> }): Promise<void> {
  await prisma.bizMetricWeekly.upsert({
    where: { userId_weekStart: { userId: args.userId, weekStart: args.weekStart } },
    update: { metricsJson: args.metrics },
    create: { tenantId: args.tenantId, userId: args.userId, weekStart: args.weekStart, metricsJson: args.metrics },
  });
}

export async function series(userId: string, weeks = 8): Promise<{ weekStart: string; metrics: Record<string, number> }[]> {
  const rows = await prisma.bizMetricWeekly.findMany({ where: { userId }, orderBy: { weekStart: 'desc' }, take: weeks });
  return rows.reverse().map((r) => ({ weekStart: r.weekStart, metrics: (r.metricsJson ?? {}) as Record<string, number> }));
}

/** 注入【经营序列】块：本周各指标 + 与行业中位 p50 的差（服务端算）。无数据 → null。 */
export async function bizMetricBlock(userId: string, industry: string | null | undefined): Promise<string | null> {
  const rows = await prisma.bizMetricWeekly.findMany({ where: { userId }, orderBy: { weekStart: 'desc' }, take: 1 });
  const metrics = rows.length ? ((rows[0].metricsJson ?? {}) as Record<string, number>) : {};
  const keys = Object.keys(metrics);
  if (!keys.length) return null;
  const benchmarks = industry
    ? await prisma.industryBenchmark.findMany({ where: { industry, enabled: true, metricKey: { in: keys }, p50: { not: null } }, select: { metricKey: true, metricName: true, unit: true, p50: true } })
    : [];
  const bmap = new Map(benchmarks.map((b) => [b.metricKey, b] as const));
  const lines = keys.map((k) => {
    const v = metrics[k];
    const b = bmap.get(k);
    if (b && b.p50 != null) {
      const diff = Math.round((v - b.p50) * 10) / 10;
      const rel = diff === 0 ? '与行业中位持平' : diff > 0 ? `高于行业中位 ${diff}${b.unit}` : `低于行业中位 ${Math.abs(diff)}${b.unit}`;
      return `${b.metricName} ${v}${b.unit}，${rel}`;
    }
    return `${k} ${v}`;
  });
  return `【经营序列（本周实报，与行业基准的差为系统所算，禁止自行推算）】\n${lines.join('\n')}`;
}
