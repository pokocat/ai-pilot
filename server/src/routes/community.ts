// V7-13 社群 / 档案工作台路由：
//   用户侧  GET /me/workbench（档案工作台）、GET /me/service（社群服务分配，无则 null）
//   运营侧  GET/PUT /admin/users/:id/service（分班 / 配老师，requireAdmin）
// 注：/me 主视图加 inviteCode + service 是「缝合点」，由 metaRoutes 侧用本 service 的 helper 拼装（见文件尾注）。
import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { resolveUser } from '../services/context.js';
import { requireAdmin } from '../services/adminAuth.js';
import { recordAudit } from '../services/audit.js';
import { buildWorkbench, buildServiceView, setService } from '../services/community.js';
import type { ServiceAssignmentUpdate } from '../../../shared/contracts';

export async function communityRoutes(app: FastifyInstance) {
  // 档案工作台：完整度 + 4 分区真实计数（bizCategory）+ 当前最该补（nextQuestions 派生）。
  app.get('/me/workbench', async (req) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    return buildWorkbench({ tenantId: user.tenantId, userId: user.id });
  });

  // 社群服务分配（账户卡「服务老师微信 / 群二维码」）；无分配 → { service: null }。
  app.get('/me/service', async (req) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    return { service: await buildServiceView(user.id) };
  });

  // ── 运营后台：用户详情面板「社群服务」表单 ──
  app.get<{ Params: { id: string } }>(
    '/admin/users/:id/service',
    { preHandler: requireAdmin },
    async (req) => {
      return { service: await buildServiceView(req.params.id) };
    },
  );

  app.put<{ Params: { id: string }; Body: ServiceAssignmentUpdate }>(
    '/admin/users/:id/service',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const target = await prisma.user.findUnique({
        where: { id: req.params.id },
        select: { id: true, tenantId: true },
      });
      if (!target) return reply.code(404).send({ error: '用户不存在', code: 'USER_NOT_FOUND' });

      const body = (req.body ?? {}) as ServiceAssignmentUpdate;
      const service = await setService(target.id, target.tenantId, body);
      await recordAudit({
        tenantId: target.tenantId,
        userId: target.id,
        action: 'admin.user.service.set',
        payload: { className: service.className, teacherName: service.teacherName },
      });
      return { service };
    },
  );
}
