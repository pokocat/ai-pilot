// 结构化经营周报（WO-10）：模板（报什么）/ 填报 / 序列。注入【经营序列】在 context 装配。
import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { resolveUser } from '../services/context.js';
import { metricTemplate, upsertWeek, series } from '../services/bizMetric.js';
// metricTemplate 复用于填报校验（key 必须 ∈ 行业模板）。

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
    const ws = req.params.weekStart;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ws)) return reply.code(400).send({ code: 'BAD_REQUEST', error: 'weekStart 需 YYYY-MM-DD' });
    // 校验 weekStart 为周一：纯日历日用 UTC 解释（避免进程 TZ 干扰），getUTCDay()===1 即周一。
    // 序列/唯一键都以「周一」为锚，非周一入库会撕裂对齐（同一周落两条），故非法直接 400 而非静默归一。
    const d = new Date(`${ws}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || d.getUTCDay() !== 1) return reply.code(400).send({ code: 'WEEKSTART_NOT_MONDAY', error: 'weekStart 必须是当周周一' });
    // 指标 key 必须 ∈ 该用户行业模板（= 基准库该行业启用的 metricKey）：报什么才能对比什么，表外 key 拒绝。
    const profile = await prisma.profile.findFirst({ where: { tenantId: user.tenantId }, orderBy: { updatedAt: 'desc' } });
    const allowed = new Set((await metricTemplate(profile?.industry)).map((t) => t.metricKey));
    const metrics: Record<string, number> = {};
    for (const [k, v] of Object.entries(req.body?.metrics ?? {})) {
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      if (!allowed.has(k)) return reply.code(400).send({ code: 'METRIC_KEY_INVALID', error: `指标 ${k} 不在你的行业模板内，无法对比，拒绝入库` });
      metrics[k] = v;
    }
    await upsertWeek({ tenantId: user.tenantId, userId: user.id, weekStart: ws, metrics });
    return { ok: true };
  });

  // 最近 N 周序列
  app.get<{ Querystring: { weeks?: string } }>('/biz-metrics', async (req) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const weeks = Math.min(52, Math.max(1, parseInt(req.query.weeks ?? '8', 10) || 8));
    return { items: await series(user.id, weeks) };
  });
}
