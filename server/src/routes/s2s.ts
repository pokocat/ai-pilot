// 服务间接口（只给声量AI 后端调）：代售军师套餐的开通与对账查询。
// 契约见 docs/agents/08-backend.md §8.1「声量AI 代售套餐」与 docs/STUDIO_WEB_API.md。
// 鉴权全部在 services/externalPlanGrant.ts 的 authorizePlanGrantCaller（账号中心机器令牌）。
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { now } from '../services/clock.js';
import { daysRemaining, isExpired } from '../services/planTime.js';
import {
  authorizePlanGrantCaller, createOrReplayPlanGrant, findPlanGrant, grantRequestSchema, grantView,
  GRANT_SOURCES, PlanGrantError,
} from '../services/externalPlanGrant.js';

function fail(reply: FastifyReply, error: unknown) {
  if (error instanceof PlanGrantError) return reply.code(error.statusCode).send({ error: error.message, code: error.code });
  throw error;
}

const listQuery = z.object({
  source: z.enum(GRANT_SOURCES),
  orderNo: z.string().trim().min(1).max(64).optional(),
  identityUid: z.string().trim().min(1).max(128).optional(),
  status: z.enum(['pending', 'applied', 'blocked']).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export async function s2sRoutes(app: FastifyInstance) {
  // 开通（幂等）。200 已开通 / 202 用户还没有军师账号，已挂起待领取 / 409 冲突或需人工。
  app.post('/s2s/plan-grants', async (req, reply) => {
    try {
      await authorizePlanGrantCaller(req.headers as Record<string, unknown>);
      const parsed = grantRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? '参数不合法', code: 'BAD_REQUEST' });
      }
      const { row, replay } = await createOrReplayPlanGrant(parsed.data);
      const view = { ...await grantView(row), replay };
      if (row.status === 'pending') return reply.code(202).send(view);
      if (row.status === 'blocked') return reply.code(409).send({ ...view, error: '开通会缩短用户现有权益，需人工处理', code: 'PLAN_CHANGE_SHORTENS' });
      return view;
    } catch (error) { return fail(reply, error); }
  });

  // 按账号中心 uid 查军师当前套餐（声量AI 付费弹窗用：判断「已在小程序开通」、收款前预判会不会被 blocked）。
  // 用户在军师还没有账号 → linked=false、active=false。只读，不建档、不领取挂起单。
  app.get<{ Params: { uid: string } }>('/s2s/users/:uid/plan', async (req, reply) => {
    try {
      await authorizePlanGrantCaller(req.headers as Record<string, unknown>);
      const uid = req.params.uid.trim();
      if (!uid || uid.length > 128) return reply.code(400).send({ error: 'uid 不合法', code: 'BAD_REQUEST' });
      const [user, pendingGrants] = await Promise.all([
        prisma.user.findUnique({
          where: { identityUid: uid },
          select: { deletedAt: true, planExpiresAt: true, plan: { select: { id: true, name: true, period: true, price: true, tierRank: true, planFamilyKey: true } } },
        }),
        prisma.externalPlanGrant.count({ where: { identityUid: uid, status: 'pending' } }),
      ]);
      const at = now();
      const live = user && !user.deletedAt ? user : null;
      const plan = live?.plan ?? null;
      const expired = !!plan && isExpired(live!.planExpiresAt, at);
      return {
        identityUid: uid,
        linked: !!live,
        active: !!plan && !expired,
        state: !plan ? 'none' : expired ? 'expired' : 'active',
        plan: plan ? { id: plan.id, name: plan.name, period: plan.period, tierRank: plan.tierRank ?? null, planFamilyKey: plan.planFamilyKey ?? null } : null,
        expiresAt: live?.planExpiresAt ? live.planExpiresAt.toISOString() : null,
        daysRemaining: plan ? daysRemaining(live!.planExpiresAt, at) : null,
        pendingGrants,
      };
    } catch (error) { return fail(reply, error); }
  });

  // 按订单号查一笔。
  app.get<{ Params: { source: string; orderNo: string } }>('/s2s/plan-grants/:source/:orderNo', async (req, reply) => {
    try {
      await authorizePlanGrantCaller(req.headers as Record<string, unknown>);
      const row = await findPlanGrant(req.params.source, req.params.orderNo);
      if (!row) return reply.code(404).send({ error: '没有这笔开通记录', code: 'GRANT_NOT_FOUND' });
      return grantView(row);
    } catch (error) { return fail(reply, error); }
  });

  // 对账列表：按时间窗 / uid / 状态筛，createdAt 倒序。
  app.get('/s2s/plan-grants', async (req, reply) => {
    try {
      await authorizePlanGrantCaller(req.headers as Record<string, unknown>);
      const parsed = listQuery.safeParse(req.query);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? '参数不合法', code: 'BAD_REQUEST' });
      const q = parsed.data;
      const rows = await prisma.externalPlanGrant.findMany({
        where: {
          source: q.source,
          ...(q.orderNo ? { orderNo: q.orderNo } : {}),
          ...(q.identityUid ? { identityUid: q.identityUid } : {}),
          ...(q.status ? { status: q.status } : {}),
          ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lt: new Date(q.to) } : {}) } } : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: q.limit ?? 50,
      });
      return { items: await Promise.all(rows.map(grantView)) };
    } catch (error) { return fail(reply, error); }
  });
}
