// P2-10：工具调用观测——在工具循环里 fire-and-forget 记录每次调用，后台按工具聚合成功率/错误率/延迟。
import { prisma } from '../db.js';
import type { ToolStatItem } from '../../../shared/contracts';

/** 记录单次工具调用（fire-and-forget；落库失败绝不影响主流程）。 */
export function recordToolCall(agentKey: string | null, tool: string, ok: boolean, ms: number): void {
  void prisma.toolCallLog.create({ data: { agentKey: agentKey ?? null, tool, ok, ms } }).catch(() => {});
}

/** 按工具聚合最近 N 天：调用数 / 错误数 / 错误率(%) / 平均延迟(ms)。 */
export async function aggregateToolStats(opts: { agentKey?: string; days?: number } = {}): Promise<ToolStatItem[]> {
  const days = Math.min(90, Math.max(1, opts.days ?? 7));
  const since = new Date(Date.now() - days * 86400000);
  const where = { createdAt: { gte: since }, ...(opts.agentKey ? { agentKey: opts.agentKey } : {}) };
  const grouped = await prisma.toolCallLog.groupBy({ by: ['tool'], where, _count: { _all: true }, _avg: { ms: true } });
  const errs = await prisma.toolCallLog.groupBy({ by: ['tool'], where: { ...where, ok: false }, _count: { _all: true } });
  const errMap = new Map(errs.map((e) => [e.tool, e._count._all]));
  return grouped
    .map((g): ToolStatItem => {
      const calls = g._count._all;
      const errors = errMap.get(g.tool) ?? 0;
      return { tool: g.tool, calls, errors, errorRate: calls ? Math.round((errors / calls) * 1000) / 10 : 0, avgMs: Math.round(g._avg.ms ?? 0) };
    })
    .sort((a, b) => b.calls - a.calls);
}
