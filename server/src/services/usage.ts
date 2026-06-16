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
export function recordInfraUsage(kind: 'embedding' | 'rerank', model: string, tokens: number): void {
  if (!(tokens > 0)) return;
  void recordTokenUsage({ kind, provider: 'openai', model, usage: { inputTokens: tokens, outputTokens: 0, cachedInput: 0 } });
}

const dayKey = (d: Date): string => d.toISOString().slice(0, 10); // YYYY-MM-DD（UTC）

/**
 * 近 windowDays 天的 token 用量聚合：总量 + 按模型 / 按天 / Top 用户。
 * v1 在内存里按取回的流水分桶（窗口内量级可控）；上量后改 SQL rollup。
 */
export async function tokenUsageSummary(windowDays = 30): Promise<AdminTokenUsageView> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const rows = await prisma.tokenUsage.findMany({
    where: { createdAt: { gte: since } },
    select: {
      userId: true, kind: true, model: true, inputTokens: true, outputTokens: true,
      totalTokens: true, costMicros: true, createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
    take: 50000,
  });

  const totals = { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costMicros: 0 };
  const modelMap = new Map<string, { calls: number; totalTokens: number; costMicros: number }>();
  const dayMap = new Map<string, { totalTokens: number; costMicros: number }>();
  const userMap = new Map<string, { totalTokens: number; costMicros: number }>();
  // 检索基建（嵌入 / 重排）单独归集，不混进「用户产出」用量。
  const USER_KINDS = new Set(['chat', 'deliverable']);
  const infraMap = new Map<string, { kind: string; model: string; calls: number; totalTokens: number; costMicros: number }>();

  for (const r of rows) {
    if (!USER_KINDS.has(r.kind)) {
      const key = `${r.kind}|${r.model}`;
      const it = infraMap.get(key) ?? { kind: r.kind, model: r.model, calls: 0, totalTokens: 0, costMicros: 0 };
      it.calls += 1; it.totalTokens += r.totalTokens; it.costMicros += r.costMicros;
      infraMap.set(key, it);
      continue;
    }
    totals.calls += 1;
    totals.inputTokens += r.inputTokens;
    totals.outputTokens += r.outputTokens;
    totals.totalTokens += r.totalTokens;
    totals.costMicros += r.costMicros;

    const m = modelMap.get(r.model) ?? { calls: 0, totalTokens: 0, costMicros: 0 };
    m.calls += 1; m.totalTokens += r.totalTokens; m.costMicros += r.costMicros;
    modelMap.set(r.model, m);

    const dk = dayKey(r.createdAt);
    const d = dayMap.get(dk) ?? { totalTokens: 0, costMicros: 0 };
    d.totalTokens += r.totalTokens; d.costMicros += r.costMicros;
    dayMap.set(dk, d);

    if (r.userId) {
      const us = userMap.get(r.userId) ?? { totalTokens: 0, costMicros: 0 };
      us.totalTokens += r.totalTokens; us.costMicros += r.costMicros;
      userMap.set(r.userId, us);
    }
  }

  const byModel = (await Promise.all([...modelMap.entries()].map(async ([model, s]) => ({
    model, calls: s.calls, totalTokens: s.totalTokens, costMicros: s.costMicros,
    calibrated: (await resolveModelRate(model)).calibrated,
  })))).sort((a, b) => b.costMicros - a.costMicros);

  const byDay = [...dayMap.entries()]
    .map(([day, s]) => ({ day, totalTokens: s.totalTokens, costMicros: s.costMicros }))
    .sort((a, b) => (a.day < b.day ? -1 : 1));

  const topUserEntries = [...userMap.entries()]
    .sort((a, b) => b[1].costMicros - a[1].costMicros)
    .slice(0, 8);
  const names = topUserEntries.length
    ? await prisma.user.findMany({ where: { id: { in: topUserEntries.map(([id]) => id) } }, select: { id: true, name: true } })
    : [];
  const nameMap = new Map(names.map((u) => [u.id, u.name]));
  const topUsers = topUserEntries.map(([userId, s]) => ({
    userId,
    name: nameMap.get(userId) || null,
    totalTokens: s.totalTokens,
    costMicros: s.costMicros,
  }));

  const infra = [...infraMap.values()].sort((a, b) => b.totalTokens - a.totalTokens);
  return { windowDays, totals, byModel, byDay, topUsers, infra };
}
