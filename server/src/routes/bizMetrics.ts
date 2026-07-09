// 结构化经营周报（WO-10）：模板（报什么）/ 填报 / 序列。注入【经营序列】在 context 装配。
import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { resolveUser } from '../services/context.js';
import { metricTemplate, upsertWeek, series } from '../services/bizMetric.js';

export async function bizMetricRoutes(app: FastifyInstance) {
  // 按行业返回可报指标集（与基准库对齐）
  app.get('/biz-metrics/template', async (req) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const profile = await prisma.profile.findFirst({ where: { tenantId: user.tenantId }, orderBy: { updatedAt: 'desc' } });
    return { items: await metricTemplate(profile?.industry) };
  });

  // 填报某周（YYYY-MM-DD 周一）
  app.put<{ Params: { weekStart: string }; Body: { metrics?: Record<string, number> } }>('/biz-metrics/:weekStart', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(req.params.weekStart)) return reply.code(400).send({ code: 'BAD_REQUEST', error: 'weekStart 需 YYYY-MM-DD' });
    const metrics: Record<string, number> = {};
    for (const [k, v] of Object.entries(req.body?.metrics ?? {})) if (typeof v === 'number' && Number.isFinite(v)) metrics[k] = v;
    await upsertWeek({ tenantId: user.tenantId, userId: user.id, weekStart: req.params.weekStart, metrics });
    return { ok: true };
  });

  // 最近 N 周序列
  app.get<{ Querystring: { weeks?: string } }>('/biz-metrics', async (req) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const weeks = Math.min(52, Math.max(1, parseInt(req.query.weeks ?? '8', 10) || 8));
    return { items: await series(user.id, weeks) };
  });
}
