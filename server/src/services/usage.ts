// Token 用量记账与统计（计费 P1 · 旁路）。
// 网关在每次真实模型调用后调用 recordTokenUsage()；不参与按次扣费，记账失败绝不影响主流程产出。
// 统计供运营后台「Token 用量」看板用。Dify 路径 v1 暂不计量（其响应未取 metadata.usage）。

import { prisma } from '../db.js';
import { estimateCostMicros } from '../data/modelPrices.js';
import { resolveModelRate } from './aiConfig.js';
import type { Usage } from '../llm/schema.js';
import type { AdminTokenUsageView } from '../../../shared/contracts';

// 网关把会话上下文带进来，便于按用户/租户/会话归集。
export interface UsageMeta {
  tenantId?: string | null;
  userId?: string | null;
  sessionId?: string | null;
  agentKey?: string | null;
  ratio?: number; // 该智能体计费比例：creditCost(本次扣额) = ceil(totalTokens × ratio)
  sandbox?: boolean; // 运营沙盒试跑：仍记诊断 trace，但不写 token_usage（不污染计费统计、不真扣额度）
}

/**
 * 落一条 token 用量流水。totalTokens<=0（mock/兜底/Dify 无 usage）不写库——保持「表=真实消耗」。
 * 内部 catch：记账永远不抛，避免拖垮用户产出。
 */
export async function recordTokenUsage(
  args: UsageMeta & { kind: string; provider: string; model: string; usage: Usage; creditCost?: number },
): Promise<void> {
  try {
    const u = args.usage;
    const inputTokens = Math.max(0, u.inputTokens);
    const outputTokens = Math.max(0, u.outputTokens);
    const totalTokens = inputTokens + outputTokens;
    if (totalTokens <= 0) return;
    const { rate } = await resolveModelRate(args.model); // 运营在模型配置里填的单价优先，否则内置价表
    await prisma.tokenUsage.create({
      data: {
        tenantId: args.tenantId ?? null,
        userId: args.userId ?? null,
        sessionId: args.sessionId ?? null,
        agentKey: args.agentKey ?? null,
        kind: args.kind,
        provider: args.provider,
        model: args.model,
        inputTokens,
        outputTokens,
        cachedInput: Math.max(0, u.cachedInput ?? 0),
        totalTokens,
        costMicros: estimateCostMicros(u, rate),
        creditCost: args.creditCost ?? 0,
      },
    });
  } catch (err) {
    console.error('[usage] record failed:', (err as Error).message);
  }
}

/** 记录「检索基建」（嵌入 / 重排）的 token 消耗，与用户产出用量区分（无 user 归属、不扣额度）。fire-and-forget。 */
// P2-1：provider 不再硬编码 'openai'（嵌入/重排可跑在 Jina/Cohere/SiliconFlow 等任意端点），默认中性 'infra'，可由调用方覆盖。
export function recordInfraUsage(kind: 'embedding' | 'rerank', model: string, tokens: number, provider = 'infra'): void {
  if (!(tokens > 0)) return;
  void recordTokenUsage({ kind, provider, model, usage: { inputTokens: tokens, outputTokens: 0, cachedInput: 0 } });
}

const dayKey = (d: Date): string => d.toISOString().slice(0, 10); // YYYY-MM-DD（UTC）

/**
 * 近 windowDays 天的 token 用量聚合：总量 + 按模型 / 按天 / Top 用户。
 * v1 在内存里按取回的流水分桶（窗口内量级可控）；上量后改 SQL rollup。
 */
export async function tokenUsageSummary(windowDays = 30): Promise<AdminTokenUsageView> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  // P2-2：全部用 SQL 聚合（groupBy / aggregate / raw 按天截断），不再装载 ≤50k 行内存分桶——避免大窗口静默截断少算。
  const USER_KINDS = ['chat', 'deliverable'];
  const userWhere = { createdAt: { gte: since }, kind: { in: USER_KINDS } };
  const [modelGroups, userGroups, infraGroups, totalAgg, dayRows] = await Promise.all([
    prisma.tokenUsage.groupBy({ by: ['model'], where: userWhere, _sum: { totalTokens: true, costMicros: true }, _count: { _all: true } }),
    prisma.tokenUsage.groupBy({ by: ['userId'], where: { ...userWhere, userId: { not: null } }, _sum: { totalTokens: true, costMicros: true }, orderBy: { _sum: { costMicros: 'desc' } }, take: 8 }),
    prisma.tokenUsage.groupBy({ by: ['kind', 'model'], where: { createdAt: { gte: since }, kind: { notIn: USER_KINDS } }, _sum: { totalTokens: true, costMicros: true }, _count: { _all: true } }),
    prisma.tokenUsage.aggregate({ where: userWhere, _sum: { inputTokens: true, outputTokens: true, totalTokens: true, costMicros: true }, _count: { _all: true } }),
    prisma.$queryRaw<{ day: string; totaltokens: bigint | number; costmicros: bigint | number }[]>`
      SELECT to_char(date_trunc('day', "createdAt"), 'YYYY-MM-DD') AS day,
             COALESCE(SUM("totalTokens"), 0) AS totaltokens,
             COALESCE(SUM("costMicros"), 0) AS costmicros
      FROM token_usage
      WHERE "createdAt" >= ${since} AND "kind" IN ('chat', 'deliverable')
      GROUP BY 1 ORDER BY 1`,
  ]);

  const totals = {
    calls: totalAgg._count._all,
    inputTokens: totalAgg._sum.inputTokens ?? 0,
    outputTokens: totalAgg._sum.outputTokens ?? 0,
    totalTokens: totalAgg._sum.totalTokens ?? 0,
    costMicros: totalAgg._sum.costMicros ?? 0,
  };

  const byModel = (await Promise.all(modelGroups.map(async (g) => ({
    model: g.model, calls: g._count._all,
    totalTokens: g._sum.totalTokens ?? 0, costMicros: g._sum.costMicros ?? 0,
    calibrated: (await resolveModelRate(g.model)).calibrated,
  })))).sort((a, b) => b.costMicros - a.costMicros);

  const byDay = dayRows.map((r) => ({ day: r.day, totalTokens: Number(r.totaltokens), costMicros: Number(r.costmicros) }));

  const topUserEntries = userGroups.filter((g): g is typeof g & { userId: string } => !!g.userId);
  const names = topUserEntries.length
    ? await prisma.user.findMany({ where: { id: { in: topUserEntries.map((g) => g.userId) } }, select: { id: true, name: true } })
    : [];
  const nameMap = new Map(names.map((u) => [u.id, u.name]));
  const topUsers = topUserEntries.map((g) => ({
    userId: g.userId,
    name: nameMap.get(g.userId) || null,
    totalTokens: g._sum.totalTokens ?? 0,
    costMicros: g._sum.costMicros ?? 0,
  }));

  const infra = infraGroups.map((g) => ({
    kind: g.kind, model: g.model, calls: g._count._all,
    totalTokens: g._sum.totalTokens ?? 0, costMicros: g._sum.costMicros ?? 0,
  })).sort((a, b) => b.totalTokens - a.totalTokens);

  return { windowDays, totals, byModel, byDay, topUsers, infra };
}
