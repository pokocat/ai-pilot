// D-3-3 健康度估测框架（按 BATCH3_PLAN §2 定型）。
// 触发：月复盘 ReviewLog 落库成功后，每月幂等一次（services/reviewLog.ts recordReview 的 month 分支 fire）。
// 铁律：所有输入由服务端算好再喂 LLM；任一维度输入为空 → 该维度强制 na（宁缺勿假，绝不让模型现场脑补健康度）。
// 计费取舍：健康度估测搭月复盘对话的既有额度，不单独 reserveQuota——一月一次、成本可控，故用不计费的 structured()
//   薄封装（无 live provider / 测试环境直接返回 null，此时所有维度回落 na，不产生真实成本也不伪造水位）。
import { prisma } from '../db.js';
import { z } from 'zod';
import { structured } from '../llm/gateway.js';
import { now, dateKey, monthKey } from './clock.js';
import { reviewStreak } from './reviewLog.js';
import { decisionStats } from './decisionLog.js';
import { prophecyStats } from './prophecyLog.js';

export const HEALTH_DIMS = ['revenue', 'customer', 'product', 'team', 'brand'] as const;
export type HealthDim = (typeof HEALTH_DIMS)[number];
export type HealthLevel = 'high' | 'mid' | 'low' | 'na';
export interface HealthDimResult { key: HealthDim; level: HealthLevel; rationale: string }
export interface HealthEstimate { dims: HealthDimResult[]; at: string; source: 'estimate' }

const DIM_CN: Record<HealthDim, string> = { revenue: '营收', customer: '客户', product: '产品', team: '团队', brand: '品牌' };
// na 文案里点名「缺什么数据」——用运营/客户能听懂的口径，而非 dim key。
const DIM_MISSING: Record<HealthDim, string> = { revenue: '营收/成交', customer: '客户/线索', product: '产品', team: '执行复盘', brand: '品牌' };
const LEVEL_CN: Record<Exclude<HealthLevel, 'na'>, string> = { high: '高水位', mid: '中水位', low: '低水位' };

// biz metric key → 归属维度（关键词匹配；命不中的 key 不参与任何维度评估）。
function bizDimOf(key: string): HealthDim | null {
  const k = key.toLowerCase();
  if (/revenue|gmv|sales|turnover|order_value|营收|成交|客单/.test(k)) return 'revenue';
  if (/repurchase|retention|member|nps|deal_rate|customer|复购|会员|客户|留存/.test(k)) return 'customer';
  if (/product|sku|quality|margin|毛利|品/.test(k)) return 'product';
  if (/brand|fans|follow|exposure|reach|粉|曝光|品牌/.test(k)) return 'brand';
  return null;
}

const HealthSchema = z.object({
  dims: z.array(z.object({
    key: z.enum(HEALTH_DIMS),
    level: z.enum(['high', 'mid', 'low', 'na']),
    rationale: z.string().max(80).optional().default(''),
  })).default([]),
});

const HEALTH_SYS =
  '你是经营健康度评估器。只依据给出的「各维度证据」，给每个维度一个水位判断：high(高)/mid(中)/low(低)。' +
  '证据不足以判断的维度给 na。严禁编造证据里没有的数字或维度。每维一句理由（rationale，≤40字，用证据里的事实，不要展开建议）。' +
  '只输出 JSON：{"dims":[{"key":"revenue|customer|product|team|brand","level":"high|mid|low|na","rationale":"…"}]}。';

/**
 * 估测一次健康度：服务端聚合各维度证据 → 有证据的维度交 LLM 判水位、无证据的维度强制 na。
 * 全维度无证据时直接返回全 na（不触达 LLM，零成本）。
 */
export async function estimateHealth(userId: string, tenantId: string): Promise<HealthEstimate> {
  const at = now().toISOString();
  const naAll = (): HealthEstimate => ({
    dims: HEALTH_DIMS.map((key) => ({ key, level: 'na' as HealthLevel, rationale: '' })), at, source: 'estimate',
  });

  // —— 服务端算好所有输入 ——
  const since = dateKey(new Date(now().getTime() - 30 * 86400_000));
  const [cfs, bizRows, profile, streak, lastAligned, dStats, pStats] = await Promise.all([
    prisma.casefile.findMany({ where: { userId }, select: { id: true } }),
    prisma.bizMetricWeekly.findMany({ where: { userId }, orderBy: { weekStart: 'desc' }, take: 1 }),
    prisma.profile.findFirst({ where: { tenantId }, orderBy: { updatedAt: 'desc' }, select: { industry: true } }),
    reviewStreak(userId),
    prisma.reviewLog.findFirst({ where: { userId, alignRate: { not: null } }, orderBy: { date: 'desc' }, select: { alignRate: true } }),
    decisionStats(userId),
    prophecyStats(userId),
  ]);
  const cm = cfs.length
    ? await prisma.casefileMetric.aggregate({ where: { casefileId: { in: cfs.map((c) => c.id) }, date: { gte: since } }, _sum: { leads: true, consults: true, deals: true } })
    : null;
  const leads = cm?._sum.leads ?? 0, consults = cm?._sum.consults ?? 0, deals = cm?._sum.deals ?? 0;

  const bizMetrics = bizRows.length ? ((bizRows[0].metricsJson ?? {}) as Record<string, number>) : {};
  const bizKeys = Object.keys(bizMetrics);
  const benchmarks = (profile?.industry && bizKeys.length)
    ? await prisma.industryBenchmark.findMany({ where: { industry: profile.industry, enabled: true, metricKey: { in: bizKeys }, p50: { not: null } }, select: { metricKey: true, metricName: true, unit: true, p50: true } })
    : [];
  const bmap = new Map(benchmarks.map((b) => [b.metricKey, b] as const));
  // 每维收集 biz 序列证据（带与行业中位的差，服务端算）。
  const bizEvidence: Partial<Record<HealthDim, string[]>> = {};
  for (const k of bizKeys) {
    const dim = bizDimOf(k);
    if (!dim) continue;
    const v = bizMetrics[k];
    const b = bmap.get(k);
    let line = `${b?.metricName ?? k} ${v}${b?.unit ?? ''}`;
    if (b && b.p50 != null) {
      const diff = Math.round((v - b.p50) * 10) / 10;
      line += diff === 0 ? '（与行业中位持平）' : diff > 0 ? `（高于行业中位 ${diff}${b.unit}）` : `（低于行业中位 ${Math.abs(diff)}${b.unit}）`;
    }
    (bizEvidence[dim] ??= []).push(line);
  }

  // —— 组装各维度证据；无证据的维度置空 → 强制 na ——
  const evidence: Partial<Record<HealthDim, string>> = {};
  // revenue：近30天成交 + biz 营收类序列
  {
    const parts: string[] = [];
    if (deals > 0) parts.push(`近30天成交 ${deals} 单`);
    if (bizEvidence.revenue) parts.push(...bizEvidence.revenue);
    if (parts.length) evidence.revenue = parts.join('；');
  }
  // customer：近30天线索/咨询 + biz 客户类序列
  {
    const parts: string[] = [];
    if (leads > 0 || consults > 0) parts.push(`近30天线索 ${leads}、咨询 ${consults}`);
    if (bizEvidence.customer) parts.push(...bizEvidence.customer);
    if (parts.length) evidence.customer = parts.join('；');
  }
  // product / brand：目前仅有 biz 序列可依据（无则 na，不硬凑）
  if (bizEvidence.product) evidence.product = bizEvidence.product.join('；');
  if (bizEvidence.brand) evidence.brand = bizEvidence.brand.join('；');
  // team：执行/复盘纪律（连续复盘 + 对齐率 + 决策统计）
  {
    const parts: string[] = [];
    if (streak > 0) parts.push(`连续复盘 ${streak} 天`);
    if (lastAligned?.alignRate != null) parts.push(`最近对齐率 ${lastAligned.alignRate}%`);
    if (dStats.total > 0) parts.push(`决策 ${dStats.total} 条${dStats.accuracy != null ? `（准确率 ${dStats.accuracy}%）` : ''}`);
    if (pStats.total > 0) parts.push(`天机 ${pStats.total} 条${pStats.hitRate != null ? `（命中率 ${pStats.hitRate}%）` : ''}`);
    if (parts.length) evidence.team = parts.join('；');
  }

  const dimsWithInput = HEALTH_DIMS.filter((d) => evidence[d]);
  if (!dimsWithInput.length) return naAll(); // 全维无证据 → 全 na，不触达 LLM

  const userPrompt = `本月各维度证据（只准依据这些判断，无列出的维度视为证据不足→na）：\n` +
    dimsWithInput.map((d) => `- ${DIM_CN[d]}(${d})：${evidence[d]}`).join('\n');
  const ai = await structured(HealthSchema, { system: HEALTH_SYS, user: userPrompt, maxChars: 1500 });
  const byKey = new Map((ai?.dims ?? []).map((d) => [d.key, d] as const));

  const dims: HealthDimResult[] = HEALTH_DIMS.map((key) => {
    // 无输入维度强制 na；有输入但 LLM 缺判/回 na/无 live provider → 也落 na（不伪造水位）。
    if (!evidence[key]) return { key, level: 'na', rationale: '' };
    const j = byKey.get(key);
    const level: HealthLevel = j && (j.level === 'high' || j.level === 'mid' || j.level === 'low') ? j.level : 'na';
    return { key, level, rationale: level === 'na' ? '' : (j?.rationale ?? '').slice(0, 40) };
  });
  return { dims, at, source: 'estimate' };
}

/**
 * 月复盘收尾挂钩：每月幂等一次把健康度估测落到 StrategicProfile.kpiJson.health。
 * 同月已有估测（kpiJson.health.at 落在本月）→ 跳过（不重复调用 LLM、不覆盖当月结论）。
 * fire-and-forget 安全：内部吞错，绝不打断月复盘主流程。
 */
export async function maybeEstimateMonthlyHealth(userId: string, tenantId: string): Promise<void> {
  try {
    const sp = await prisma.strategicProfile.findUnique({ where: { userId }, select: { kpiJson: true } });
    const kpi = { ...((sp?.kpiJson as Record<string, unknown> | null) ?? {}) };
    const existing = kpi.health as HealthEstimate | undefined;
    if (existing?.at && monthKey(new Date(existing.at)) === monthKey()) return; // 本月已估测 → 幂等跳过
    const estimate = await estimateHealth(userId, tenantId);
    await prisma.strategicProfile.upsert({
      where: { userId },
      update: { kpiJson: { ...kpi, health: estimate } as object },
      create: { tenantId, userId, kpiJson: { health: estimate } as object },
    });
  } catch (err) {
    console.error('[health] monthly estimate failed:', (err as Error).message);
  }
}

/**
 * 月战报注入块【健康度·军师估测】：只读 StrategicProfile.kpiJson.health 的落库值（禁止对话层现算）。
 * 高/中/低 水位文案；na → 「暂无法评估（缺X数据）」。块尾写死禁算口径。无落库估测 → null 不注入。
 */
export async function healthBlock(userId: string): Promise<string | null> {
  const sp = await prisma.strategicProfile.findUnique({ where: { userId }, select: { kpiJson: true } });
  const health = (sp?.kpiJson as { health?: HealthEstimate } | null)?.health;
  if (!health?.dims?.length) return null;
  const byKey = new Map(health.dims.map((d) => [d.key, d] as const));
  const lines = HEALTH_DIMS.map((key) => {
    const d = byKey.get(key);
    if (!d || d.level === 'na') return `${DIM_CN[key]}：暂无法评估（缺${DIM_MISSING[key]}数据）`;
    return `${DIM_CN[key]}：${LEVEL_CN[d.level]}${d.rationale ? ` · ${d.rationale}` : ''}`;
  });
  return `【健康度·军师估测（系统每月一次的落库估测，只读引用，禁止在对话中重新评估或换算口径）】\n${lines.join('\n')}\n` +
    '本块为月度一次性水位估测，报告直接引用即可，不要另算分数或百分比，也不要把水位换算成具体数字。';
}
