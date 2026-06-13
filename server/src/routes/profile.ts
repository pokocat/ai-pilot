import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { resolveUser } from '../services/context.js';
import { recordAudit } from '../services/audit.js';

export async function profileRoutes(app: FastifyInstance) {
  // 建档问卷（运营可配，首登动态渲染）
  app.get('/survey', async () => {
    const qs = await prisma.surveyQuestion.findMany({ where: { enabled: true }, orderBy: { sort: 'asc' } });
    return qs.map((q) => ({ key: q.key, title: q.title, options: q.optionsJson }));
  });

  // 读取企业档案
  app.get('/profile', async (req) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const p = await prisma.profile.findFirst({ where: { tenantId: user.tenantId }, orderBy: { updatedAt: 'desc' } });
    return p ? { industry: p.industry, stage: p.stage, pain: p.pain, extra: p.extraJson } : null;
  });

  // 首登 30 秒建档 / 更新档案
  app.put<{ Body: { industry?: string; stage?: string; pain?: string; extra?: object } }>(
    '/profile',
    async (req) => {
      const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
      const existing = await prisma.profile.findFirst({ where: { tenantId: user.tenantId } });
      const data = {
        industry: req.body.industry,
        stage: req.body.stage,
        pain: req.body.pain,
        extraJson: req.body.extra ?? undefined,
      };
      const p = existing
        ? await prisma.profile.update({ where: { id: existing.id }, data })
        : await prisma.profile.create({ data: { ...data, tenantId: user.tenantId } });
      // 同步租户行业/阶段
      await prisma.tenant.update({
        where: { id: user.tenantId },
        data: { industry: p.industry ?? undefined, stage: p.stage ?? undefined },
      });
      await recordAudit({
        tenantId: user.tenantId,
        userId: user.id,
        action: existing ? 'user.profile.update' : 'user.profile.create',
        payload: { industry: p.industry, stage: p.stage, pain: p.pain },
      });
      return { industry: p.industry, stage: p.stage, pain: p.pain };
    },
  );
}
