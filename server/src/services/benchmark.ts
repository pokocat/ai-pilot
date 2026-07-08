// WO-08：行业基准注入块。取用户行业下 enabled 且 p50 非空的指标，格式化为分位数串（「复购率：行业中位 45%（P25 30% / P75 60%）」）。
// 数字铁律：基准数字以此块为准，块中没有的指标 AI 不得引用行业数据、不得自行推算。宁缺勿假——p50 空即不注入。
import { prisma } from '../db.js';

export async function benchmarkBlock(industry: string | null | undefined): Promise<string | null> {
  if (!industry) return null;
  const rows = await prisma.industryBenchmark.findMany({
    where: { industry, enabled: true, p50: { not: null } },
    orderBy: { metricKey: 'asc' },
    take: 12,
  });
  if (!rows.length) return null;
  const lines = rows.map((r) => {
    const band = r.p25 != null && r.p75 != null ? `（P25 ${r.p25}${r.unit} / P75 ${r.p75}${r.unit}）` : '';
    return `${r.metricName}：行业中位 ${r.p50}${r.unit}${band}${r.note ? ` · ${r.note}` : ''}`;
  });
  return `【行业基准（系统数据，引用时以此为准；本块没有的指标不得引用行业数据、不得自行推算）】\n${lines.join('\n')}`;
}
