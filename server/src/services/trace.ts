// LLM 调用诊断 trace（可观测）。每次模型调用（含 mock / 0 token / 错误）记一行，
// 与 token_usage 分表（后者只记真实计费）。原文捕获由 env.llmTraceCaptureText 控制并截断。
import { prisma } from '../db.js';
import { env } from '../env.js';
import type { Usage } from '../llm/schema.js';
import type { UsageMeta } from './usage.js';
import type { AdminTraceDetail, AdminTraceItem, AdminTraceListView } from '../../../shared/contracts';

const TEXT_MAX = 4000;
function clip(s?: string | null): string | null {
  if (!s) return null;
  return s.length > TEXT_MAX ? s.slice(0, TEXT_MAX) + '…' : s;
}

export interface TraceInput {
  meta?: UsageMeta;
  agentKey?: string | null;
  versionId?: string | null;
  kind: 'chat' | 'deliverable';
  provider: string;
  model: string;
  status: 'ok' | 'error';
  errorMessage?: string | null;
  latencyMs: number;
  toolCalls?: number;
  iterations?: number;
  usage?: Usage;
  promptText?: string | null;
  responseText?: string | null;
}

/** 记一条 trace。内部 catch，绝不影响主流程。 */
export async function recordTrace(t: TraceInput): Promise<void> {
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
        status: t.status,
        errorMessage: clip(t.errorMessage),
        latencyMs: Math.max(0, Math.round(t.latencyMs)),
        toolCalls: t.toolCalls ?? 0,
        iterations: t.iterations ?? 0,
        inputTokens: Math.max(0, u?.inputTokens ?? 0),
        outputTokens: Math.max(0, u?.outputTokens ?? 0),
        cachedInput: Math.max(0, u?.cachedInput ?? 0),
        totalTokens: Math.max(0, (u?.inputTokens ?? 0) + (u?.outputTokens ?? 0)),
        promptText: env.llmTraceCaptureText ? clip(t.promptText) : null,
        responseText: env.llmTraceCaptureText ? clip(t.responseText) : null,
      },
    });
  } catch (err) {
    console.error('[trace] record failed:', (err as Error).message);
  }
}

function toItem(r: { id: string; createdAt: Date; agentKey: string | null; versionId?: string | null; kind: string; provider: string; model: string; status: string; latencyMs: number; toolCalls: number; totalTokens: number; cachedInput: number; errorMessage: string | null }): AdminTraceItem {
  return {
    id: r.id, at: r.createdAt.toISOString(), agentKey: r.agentKey, versionId: r.versionId ?? null, kind: r.kind, provider: r.provider,
    model: r.model, status: r.status === 'error' ? 'error' : 'ok', latencyMs: r.latencyMs,
    toolCalls: r.toolCalls, totalTokens: r.totalTokens, cachedInput: r.cachedInput, errorMessage: r.errorMessage,
  };
}

/** trace 列表 + 概览统计（调用数/错误数/均延迟），可按状态、agent 过滤。 */
export async function listTraces(opts: { days?: number; status?: string; agentKey?: string; limit?: number }): Promise<AdminTraceListView> {
  const days = Math.min(90, Math.max(1, opts.days ?? 7));
  const since = new Date(Date.now() - days * 86400_000);
  const where = {
    createdAt: { gte: since },
    ...(opts.status === 'ok' || opts.status === 'error' ? { status: opts.status } : {}),
    ...(opts.agentKey ? { agentKey: opts.agentKey } : {}),
  };
  const limit = Math.min(500, Math.max(1, opts.limit ?? 200));
  const [rows, agg, errors] = await Promise.all([
    prisma.llmTrace.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit }),
    prisma.llmTrace.aggregate({ where, _count: { _all: true }, _avg: { latencyMs: true } }),
    prisma.llmTrace.count({ where: { ...where, status: 'error' } }),
  ]);
  return {
    windowDays: days,
    totals: { calls: agg._count._all, errors, avgLatencyMs: Math.round(agg._avg.latencyMs ?? 0) },
    items: rows.map(toItem),
  };
}

/** 单条 trace 详情（含迭代/工具数与原文，若捕获）。 */
export async function getTrace(id: string): Promise<AdminTraceDetail | null> {
  const r = await prisma.llmTrace.findUnique({ where: { id } });
  if (!r) return null;
  return {
    ...toItem(r),
    iterations: r.iterations,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    promptText: r.promptText,
    responseText: r.responseText,
  };
}
