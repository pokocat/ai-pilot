// Token 用量记账与统计（计费 P1 · 旁路）。
// 网关在每次真实模型调用后调用 recordTokenUsage()；不参与按次扣费，记账失败绝不影响主流程产出。
// 统计供运营后台「Token 用量」看板用。Dify 路径 v1 暂不计量（其响应未取 metadata.usage）。

import { prisma } from '../db.js';
import { estimateCostMicros } from '../data/modelPrices.js';
import { resolveModelRate } from './aiConfig.js';
import { noteUsageUnreported, noteTokenUsage } from './metrics.js';
import type { Usage } from '../llm/schema.js';
import type { AdminTokenUsageView } from '../../../shared/contracts';

// 网关把会话上下文带进来，便于按用户/租户/会话归集。
export interface UsageMeta {
  tenantId?: string | null;
  userId?: string | null;
  sessionId?: string | null;
  agentKey?: string | null;
  ratio?: number; // 该智能体计费比例：creditCost(本次扣额) = ceil(totalTokens × ratio)
  // 运营沙盒试跑：仍记诊断 trace，且**按 kind='sandbox' 照实写 token_usage**（provider 真的收了这笔钱）。
  // 只是不挂 userId/sessionId、creditCost 恒 0，用户用量口径本就只聚合 chat/deliverable，自然过滤。
  sandbox?: boolean;
  signal?: AbortSignal; // GenerationJob 显式取消/job 预算；只传执行链，不写入 usage/trace
  skipAskRecovery?: boolean; // durable worker 先落主消息，再在独立 attempt + 3s 预算内补推荐选项
  firstTokenStartedAtMs?: number; // 用户体验口径起点：GenerationJob 接单/创建时刻
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
    if (totalTokens <= 0) {
      // mock / Dify v1 无 usage 时为 0 属预期，直接跳过保持「表=真实消耗」。
      // 但真实付费 provider 报 0 一定是它没回传 usage（`?? 0` 把「字段缺失」和「真的是 0」
      // 抹平了）——这类调用真金白银花掉却在表里查不到任何行，是**静默漏账**。
      // 不写垃圾行，但必须让它可见：计数进 /metrics，供成本告警发现口径缺口。
      if (args.provider !== 'mock') noteUsageUnreported(args.provider, args.model);
      return;
    }
    const { rate } = await resolveModelRate(args.model); // 运营在模型配置里填的单价优先，否则内置价表
    const costMicros = estimateCostMicros(u, rate);
    // Prometheus 侧同口径累计（成本告警数据源）。先记后写库：钱已经花了，写库失败不该让消耗隐身。
    noteTokenUsage({
      kind: args.kind, provider: args.provider, model: args.model,
      inputTokens, outputTokens,
      cachedInput: Math.max(0, u.cachedInput ?? 0), cacheWrite: Math.max(0, u.cacheWrite ?? 0),
      costMicros,
    });
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
        cacheWrite: Math.max(0, u.cacheWrite ?? 0),
        totalTokens,
        costMicros,
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

/**
 * 记录「主模型辅助调用」（洞察抽取 / 预言 / 势研判 / 履历 / 汇总 / 图谱等 rawText 系）的 token 消耗。
 * 这些调用此前完全不入 token_usage → 真实成本被系统性低估（见售卖前体检 P1；每轮 extractInsights、
 * 每次总军师输出后的 extractProphecies 都是未记账的真实调用，直接影响单位经济/定价口径）。
 * 无 user 归属（辅助调用常无会话上下文），按 kind='aux' 归入基建用量，不参与按次扣费（creditCost 恒 0）。
 *
 * 取数顺序（**先真实回报、后字符估算**，2026-08 与七牛逐笔对账后定死）：
 *  1. `reported`：provider 在响应里回的 usage（openai/claude 的 usageOf()）。这是唯一可信口径。
 *  2. 只有 provider 没回 usage（inputTokens+outputTokens<=0，如 mock / 端点不吐 usage 字段）才退回字符估算。
 *
 * 为什么必须以真实回报为准：**推理模型的思考 token 不出现在返回正文里**。实测 kimi-k3 一次
 * completion_tokens:400 / reasoning_tokens:400 而正文 0 字——按「字符数÷2」估会记成 0。deepseek-v4-flash 同理。
 * 2026-08 与七牛逐笔对账：我方账本 ¥22.44 vs 实计 ¥56.30，系统性少记约 60%，aux 占当月成本 17.5%，
 * 输出侧最多被低估 11 倍。字符估算只保留为「provider 真的没给数」时的下限兜底，绝不能再当主口径。
 * fire-and-forget，绝不抛。
 */
export function recordAuxUsage(
  model: string,
  provider: string,
  inputText: string,
  outputText: string,
  meta?: UsageMeta,
  reported?: Usage | null,
): void {
  const usage = auxUsageOf(inputText, outputText, reported);
  if (usage.inputTokens + usage.outputTokens <= 0) return;
  void recordTokenUsage({ ...meta, kind: 'aux', provider, model, usage });
}

/**
 * aux 用量取数：provider 真实回报优先，字符估算兜底。见 recordAuxUsage 上的顺序说明。
 * 导出仅供单测直接断言「同一段文本 + 真实 usage 时记的是真实值」，业务侧请走 recordAuxUsage。
 */
export function auxUsageOf(inputText: string, outputText: string, reported?: Usage | null): Usage {
  if (reported) {
    const inputTokens = Math.max(0, reported.inputTokens);
    const outputTokens = Math.max(0, reported.outputTokens);
    // >0 才认：`?? 0` 会把「字段缺失」和「真的是 0」抹平，两者都退回估算才不会静默漏账。
    if (inputTokens + outputTokens > 0) {
      return { inputTokens, outputTokens, cachedInput: Math.max(0, reported.cachedInput ?? 0), ...(reported.cacheWrite ? { cacheWrite: Math.max(0, reported.cacheWrite) } : {}) };
    }
  }
  // 兜底：CJK 为主 ≈ 2 字符/token。已知偏低（思考 token 不在正文里），仅供成本可见性。
  return { inputTokens: Math.ceil((inputText?.length ?? 0) / 2), outputTokens: Math.ceil((outputText?.length ?? 0) / 2), cachedInput: 0 };
}

/**
 * 取本次调用应扣的「输入 token 等价量」——额度扣减唯一入口。
 *
 * 真值由 gateway 的 `maybeRecord` 在记账时按实际 model + 后台单价算好回填到 `usage.billableTokens`
 * （只有它同时握有这两样：端点池会换 model，路由拿不到）。这里只做读取与兜底，**不重新计算**，
 * 以保证「扣的额度」与「token_usage 里记的 creditCost」永远是同一个数。
 *
 * 缺省（mock / 未过 maybeRecord / 记账失败）→ 回落裸 token 求和，与旧口径一致。
 */
export function billableOf(usage: { inputTokens: number; outputTokens: number; billableTokens?: number }): number {
  const fallback = Math.max(0, usage.inputTokens) + Math.max(0, usage.outputTokens);
  const b = usage.billableTokens;
  return typeof b === 'number' && Number.isFinite(b) && b >= 0 ? b : fallback;
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
