// 品牌资产包（WO-13）：生成 / 读取 / 确认。生成门槛与生成逻辑在 services/brandKit。
import type { FastifyInstance } from 'fastify';
import { resolveUser } from '../services/context.js';
import { generateBrandKit, getBrandKit, approveBrandKit } from '../services/brandKit.js';

export async function brandKitRoutes(app: FastifyInstance) {
  app.get('/brand-kit', async (req) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    return getBrandKit(user.id);
  });

  app.post('/brand-kit/generate', async (req) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    return generateBrandKit(user.id, user.tenantId); // 未到执行阶段 → BrandKitLockedError(403)
  });

  app.post('/brand-kit/approve', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const ok = await approveBrandKit(user.id);
    if (!ok) return reply.code(404).send({ code: 'NOT_FOUND', error: '还没有品牌资产包可确认' });
    return { ok: true };
  });
}
