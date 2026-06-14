import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { resolveUser } from '../services/context.js';
import { getBalance } from '../services/credits.js';
import { setQuota } from '../services/tokenQuota.js';
import { recordAudit } from '../services/audit.js';
import type { Plan as PlanView, PlanPurchaseResult } from '../../../shared/contracts';

function publicPlan(plan: {
  id: string;
  name: string;
  price: number;
  period: string;
  creditsPerMonth: number;
  tokenQuotaPerMonth: number;
  agentCount: number;
  featuresJson: unknown;
  highlighted: boolean;
}): PlanView {
  return {
    id: plan.id,
    name: plan.name,
    price: plan.price,
    period: plan.period,
    creditsPerMonth: plan.creditsPerMonth,
    tokenQuotaPerMonth: plan.tokenQuotaPerMonth,
    agentCount: plan.agentCount,
    featuresJson: Array.isArray(plan.featuresJson) ? plan.featuresJson.map(String) : [],
    highlighted: plan.highlighted,
  };
}

export async function planRoutes(app: FastifyInstance) {
  app.get('/plans', async (): Promise<PlanView[]> => {
    const plans = await prisma.plan.findMany({ orderBy: { sort: 'asc' } });
    return plans.map(publicPlan);
  });

  app.post<{ Params: { id: string } }>('/plans/:id/purchase', async (req, reply): Promise<PlanPurchaseResult | void> => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const plan = await prisma.plan.findUnique({ where: { id: req.params.id } });
    if (!plan) return reply.code(404).send({ error: '套餐不存在', code: 'PLAN_NOT_FOUND' });

    const before = await getBalance(user.id);
    const unlimited = plan.creditsPerMonth < 0;
    const grantedCredits = unlimited ? 0 : plan.creditsPerMonth;
    const creditBalance = unlimited ? -1 : (before < 0 ? grantedCredits : before + grantedCredits);

    await prisma.$transaction([
      prisma.user.update({ where: { id: user.id }, data: { planId: plan.id } }),
      prisma.creditLedger.create({
        data: {
          tenantId: user.tenantId,
          userId: user.id,
          delta: grantedCredits,
          reason: `${plan.name} · 套餐购买`,
          balance: creditBalance,
        },
      }),
    ]);
    // 月度 token 额度：覆盖式授予当月额度（区别于钻石的叠加充值）
    await setQuota(user.tenantId, user.id, plan.tokenQuotaPerMonth);
    await recordAudit({
      tenantId: user.tenantId,
      userId: user.id,
      action: 'user.plan.purchase',
      payload: { planId: plan.id, planName: plan.name, grantedCredits, creditBalance, grantedTokens: plan.tokenQuotaPerMonth },
    });

    return { ok: true, plan: publicPlan(plan), creditBalance, grantedCredits, grantedTokens: plan.tokenQuotaPerMonth };
  });
}
