import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { providerInfo } from '../llm/gateway.js';
import { resolveUser } from '../services/context.js';
import { recordAudit } from '../services/audit.js';

export async function metaRoutes(app: FastifyInstance) {
  app.get('/health', async () => ({ ok: true }));

  // 当前用户 + AI 提供方信息（前端启动时拉取）
  app.get('/me', async (req) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const plan = user.planId ? await prisma.plan.findUnique({ where: { id: user.planId } }) : null;
    const credit = await prisma.creditLedger.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
    });
    const onboarded = !!(await prisma.profile.findFirst({ where: { tenantId: user.tenantId } }));
    return {
      user: { id: user.id, name: user.name, role: user.role, benmingColor: user.benmingColor },
      tenant: { id: user.tenant.id, name: user.tenant.name, industry: user.tenant.industry, stage: user.tenant.stage },
      plan: plan ? { name: plan.name, creditsPerMonth: plan.creditsPerMonth } : null,
      creditBalance: credit?.balance ?? 0,
      onboarded,
      ai: await providerInfo(),
    };
  });

  // 更新本命色
  app.put<{ Body: { color: string } }>('/me/color', async (req) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    await prisma.user.update({ where: { id: user.id }, data: { benmingColor: req.body.color } });
    await recordAudit({ tenantId: user.tenantId, userId: user.id, action: 'user.color.update', payload: { color: req.body.color } });
    return { ok: true, color: req.body.color };
  });
}
