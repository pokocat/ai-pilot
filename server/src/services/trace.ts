// LLM 调用诊断 trace（可观测）。每次模型调用（含 mock / 0 token / 错误）记一行，
// 与 token_usage 分表（后者只记真实计费）。原文捕获由 env.llmTraceCaptureText 控制并截断。
import { prisma } from '../db.js';
import { Prisma } from '@prisma/client';
import { env } from '../env.js';
import { noteLlmCall } from './metrics.js';
import type { Usage } from '../llm/schema.js';
import type { UsageMeta } from './usage.js';
import type { AdminDateRange, AdminTraceDetail, AdminTraceItem, AdminTraceListView, LlmContextTrace } from '../../../shared/contracts';

const TEXT_MAX = 4000;
function clip(s?: string | null): string | null {
  if (!s) return null;
  return s.length > TEXT_MAX ? s.slice(0, TEXT_MAX) + '…' : s;
}

/** 上游 id 列表 → 逗号分隔字符串。空数组落 null，别落空串——SQL 里 `IS NULL` 比 `= ''` 好查。 */
function joinUpstreamIds(ids?: string[] | null): string | null {
  if (!ids?.length) return null;
  return ids.join(',');
}

export interface TraceInput {
  meta?: UsageMeta;
  agentKey?: string | null;
  versionId?: string | null;
  kind: 'chat' | 'deliverable';
  provider: string;
  model: string;
  endpointId?: string | null;
  endpointLabel?: string | null;
  /** 本次调用产生的全部上游响应 id（按发生顺序）。落库为逗号分隔，供账单对账反查。 */
  upstreamIds?: string[] | null;
  status: 'ok' | 'error';
  errorMessage?: string | null;
  /** classifyLlmError() 的分类结果；只喂 Prometheus 错误分布指标，不落库（无 schema 变更）。 */
  errorBucket?: string | null;
  latencyMs: number;
  toolCalls?: number;
  iterations?: number;
  usage?: Usage;
  promptText?: string | null;
  responseText?: string | null;
  context?: LlmContextTrace | null;
}

/** 记一条 trace。内部 catch，绝不影响主流程。 */
export async function recordTrace(t: TraceInput): Promise<void> {
  // Prometheus 侧同口径计数（先记内存再写库：写库失败也不能丢观测）。
  noteLlmCall(t.kind, t.provider, t.model, t.status, t.latencyMs, t.errorBucket ?? undefined);
  try {
    const u = t.usage;
    await prisma.llmTrace.create({
      data: {
        tenantId: t.meta?.tenantId ?? null,
        userId: t.meta?.userId ?? null,
        sessionId: t.meta?.sessionId ?? null,
        agentKey: t.meta?.agentKey ?? t.agentKey ?? null,
        versionId: t.versionId ?? null,
        kind: t.kind,
        provider: t.provider,
        model: t.model,
        endpointId: t.endpointId ?? null,
        endpointLabel: t.endpointLabel ?? null,
        upstreamIds: joinUpstreamIds(t.upstreamIds),
        status: t.status,
        errorMessage: clip(t.errorMessage),
        latencyMs: Math.max(0, Math.round(t.latencyMs)),
        toolCalls: t.toolCalls ?? 0,
        iterations: t.iterations ?? 0,
        inputTokens: Math.max(0, u?.inputTokens ?? 0),
        outputTokens: Math.max(0, u?.outputTokens ?? 0),
        cachedInput: Math.max(0, u?.cachedInput ?? 0),
        cacheWrite: Math.max(0, u?.cacheWrite ?? 0),
        totalTokens: Math.max(0, (u?.inputTokens ?? 0) + (u?.outputTokens ?? 0)),
        promptText: env.llmTraceCaptureText ? clip(t.promptText) : null,
        responseText: env.llmTraceCaptureText ? clip(t.responseText) : null,
        contextJson: t.context ? (t.context as unknown as Prisma.InputJsonValue) : undefined,
      },
    });
  } catch (err) {
    console.error('[trace] record failed:', (err as Error).message);
  }
}

type TraceRow = {
  id: string;
  createdAt: Date;
  tenantId: string | null;
  userId: string | null;
  sessionId: string | null;
  agentKey: string | null;
  versionId?: string | null;
  kind: string;
  provider: string;
  model: string;
  endpointId: string | null;
  endpointLabel: string | null;
  status: string;
  latencyMs: number;
  toolCalls: number;
  totalTokens: number;
  cachedInput: number;
  errorMessage: string | null;
};

type TraceSource = {
  userName?: string | null;
  userPhone?: string | null;
  tenantName?: string | null;
  agentName?: string | null;
};

function toItem(r: TraceRow, source: TraceSource = {}): AdminTraceItem {
  return {
    id: r.id,
    at: r.createdAt.toISOString(),
    agentKey: r.agentKey,
    agentName: source.agentName ?? null,
    versionId: r.versionId ?? null,
    userId: r.userId,
    userName: source.userName ?? null,
    userPhone: source.userPhone ?? null,
    tenantId: r.tenantId,
    tenantName: source.tenantName ?? null,
    sessionId: r.sessionId,
    kind: r.kind,
    provider: r.provider,
    model: r.model,
    endpointId: r.endpointId,
    endpointLabel: r.endpointLabel,
    status: r.status === 'error' ? 'error' : 'ok', latencyMs: r.latencyMs,
    toolCalls: r.toolCalls, totalTokens: r.totalTokens, cachedInput: r.cachedInput, errorMessage: r.errorMessage,
  };
}

/** trace 列表 + 概览统计（调用数/错误数/均延迟），可按状态、agent 过滤。 */
export async function listTraces(opts: {
  days?: number;
  from?: Date;
  toExclusive?: Date;
  range?: AdminDateRange;
  status?: string;
  agentKey?: string;
  limit?: number;
  page?: number;
  pageSize?: number;
}): Promise<AdminTraceListView> {
  const days = opts.range?.days ?? Math.min(3660, Math.max(1, opts.days ?? 7));
  const since = opts.from ?? new Date(Date.now() - days * 86400_000);
  const toExclusive = opts.toExclusive ?? new Date();
  const where = {
    createdAt: { gte: since, lt: toExclusive },
    ...(opts.status === 'ok' || opts.status === 'error' ? { status: opts.status } : {}),
    ...(opts.agentKey ? { agentKey: opts.agentKey } : {}),
  };
  const page = Math.max(1, Math.floor(opts.page ?? 1));
  const pageSize = Math.min(200, Math.max(1, Math.floor(opts.pageSize ?? opts.limit ?? 50)));
  const [rows, agg, errors] = await Promise.all([
    prisma.llmTrace.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * pageSize, take: pageSize }),
    prisma.llmTrace.aggregate({ where, _count: { _all: true }, _avg: { latencyMs: true } }),
    prisma.llmTrace.count({ where: { ...where, status: 'error' } }),
  ]);
  const userIds = [...new Set(rows.map((r) => r.userId).filter((id): id is string => !!id))];
  const tenantIds = [...new Set(rows.map((r) => r.tenantId).filter((id): id is string => !!id))];
  const agentKeys = [...new Set(rows.map((r) => r.agentKey).filter((key): key is string => !!key))];
  const [users, tenants, agents] = await Promise.all([
    userIds.length
      ? prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, phone: true } })
      : [],
    tenantIds.length
      ? prisma.tenant.findMany({ where: { id: { in: tenantIds } }, select: { id: true, name: true } })
      : [],
    agentKeys.length
      ? prisma.agent.findMany({ where: { key: { in: agentKeys } }, select: { key: true, name: true } })
      : [],
  ]);
  const userMap = new Map(users.map((u) => [u.id, u]));
  const tenantMap = new Map(tenants.map((t) => [t.id, t.name]));
  const agentMap = new Map(agents.map((a) => [a.key, a.name]));
  return {
    windowDays: days,
    ...(opts.range ? { range: opts.range } : {}),
    page,
    pageSize,
    pages: Math.max(1, Math.ceil(agg._count._all / pageSize)),
    totals: { calls: agg._count._all, errors, avgLatencyMs: Math.round(agg._avg.latencyMs ?? 0) },
    items: rows.map((r) => {
      const user = r.userId ? userMap.get(r.userId) : null;
      return toItem(r, {
        userName: user?.name ?? null,
        userPhone: user?.phone ?? null,
        tenantName: r.tenantId ? tenantMap.get(r.tenantId) ?? null : null,
        agentName: r.agentKey ? agentMap.get(r.agentKey) ?? null : null,
      });
    }),
  };
}

/** 单条 trace 详情（含迭代/工具数与原文，若捕获）。 */
export async function getTrace(id: string): Promise<AdminTraceDetail | null> {
  const r = await prisma.llmTrace.findUnique({ where: { id } });
  if (!r) return null;
  const [user, tenant, agent] = await Promise.all([
    r.userId
      ? prisma.user.findUnique({ where: { id: r.userId }, select: { name: true, phone: true } })
      : null,
    r.tenantId
      ? prisma.tenant.findUnique({ where: { id: r.tenantId }, select: { name: true } })
      : null,
    r.agentKey
      ? prisma.agent.findUnique({ where: { key: r.agentKey }, select: { name: true } })
      : null,
  ]);
  return {
    ...toItem(r, {
      userName: user?.name ?? null,
      userPhone: user?.phone ?? null,
      tenantName: tenant?.name ?? null,
      agentName: agent?.name ?? null,
    }),
    upstreamIds: r.upstreamIds,
    iterations: r.iterations,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    promptText: r.promptText,
    responseText: r.responseText,
    context: (r.contextJson as unknown as LlmContextTrace | null) ?? null,
  };
}
