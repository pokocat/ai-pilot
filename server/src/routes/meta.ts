import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { providerInfo } from '../llm/gateway.js';
import { resolveUser } from '../services/context.js';
import { recordAudit } from '../services/audit.js';
import { buildClientUnderstanding } from '../services/understanding.js';

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
    const understanding = await buildClientUnderstanding(user);
    return {
      user: { id: user.id, name: user.name, role: user.role, benmingColor: user.benmingColor },
      tenant: { id: user.tenant.id, name: user.tenant.name, industry: user.tenant.industry, stage: user.tenant.stage },
      plan: plan ? { name: plan.name, creditsPerMonth: plan.creditsPerMonth } : null,
      creditBalance: credit?.balance ?? 0,
      onboarded,
      ai: await providerInfo(),
      understanding,
    };
  });

  // 更新本命色
  app.put<{ Body: { color: string } }>('/me/color', async (req) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    await prisma.user.update({ where: { id: user.id }, data: { benmingColor: req.body.color } });
    await recordAudit({ tenantId: user.tenantId, userId: user.id, action: 'user.color.update', payload: { color: req.body.color } });
    return { ok: true, color: req.body.color };
  });

  // 更新身份：称呼(name) + 公司/品牌(company=租户名)。首登建档与「设置」都走这里。
  app.put<{ Body: { name?: string; company?: string } }>('/me', async (req) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const name = typeof req.body.name === 'string' ? req.body.name.trim().slice(0, 20) : undefined;
    const company = typeof req.body.company === 'string' ? req.body.company.trim().slice(0, 40) : undefined;
    if (name !== undefined) await prisma.user.update({ where: { id: user.id }, data: { name } });
    if (company !== undefined) await prisma.tenant.update({ where: { id: user.tenantId }, data: { name: company } });
    await recordAudit({
      tenantId: user.tenantId, userId: user.id, action: 'user.identity.update',
      payload: { nameSet: name !== undefined, companySet: company !== undefined },
    });
    return { ok: true, name, company };
  });

  // 注销账号（合规：彻底删除账号及其数据）。本应用 1 用户 ≈ 1 租户，独占租户时连同租户数据一并清除。
  app.delete('/me', async (req) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const tenantId = user.tenantId;
    // 删除前先记一条 null-租户审计（不会被下面按租户清除）
    await recordAudit({ userId: user.id, action: 'user.account.delete', payload: { tenantId } }).catch(() => {});
    const others = await prisma.user.count({ where: { tenantId, id: { not: user.id } } });
    await prisma.$transaction(async (tx) => {
      if (others === 0) {
        // 独占租户：按外键顺序清空该租户全部业务数据
        await tx.deliverable.deleteMany({ where: { tenantId } });
        await tx.message.deleteMany({ where: { session: { tenantId } } });
        await tx.reportDoc.deleteMany({ where: { tenantId } }); // 级联 reportVersion
        await tx.knowledgeItem.deleteMany({ where: { tenantId } }); // 级联 knowledgeChunk
        await tx.session.deleteMany({ where: { tenantId } });
        await tx.memory.deleteMany({ where: { tenantId } });
        await tx.project.deleteMany({ where: { tenantId } });
        await tx.creditLedger.deleteMany({ where: { tenantId } });
        await tx.tokenUsage.deleteMany({ where: { tenantId } });
        await tx.profile.deleteMany({ where: { tenantId } });
        await tx.auditLog.deleteMany({ where: { tenantId } });
        await tx.userAgent.deleteMany({ where: { userId: user.id } });
        await tx.user.delete({ where: { id: user.id } });
        await tx.tenant.delete({ where: { id: tenantId } });
      } else {
        // 多人租户：仅删除该用户自身相关数据
        await tx.userAgent.deleteMany({ where: { userId: user.id } });
        await tx.creditLedger.deleteMany({ where: { userId: user.id } });
        await tx.tokenUsage.deleteMany({ where: { userId: user.id } });
        await tx.deliverable.deleteMany({ where: { userId: user.id } });
        await tx.session.deleteMany({ where: { userId: user.id } });
        await tx.memory.deleteMany({ where: { userId: user.id } });
        await tx.user.delete({ where: { id: user.id } });
      }
    });
    return { ok: true };
  });
}
