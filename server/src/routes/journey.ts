// GET /journey（WO-07）：用户级 journey 视图（stage + diagRound + 派生「下一步」卡）。
// 全 tab 顶部「下一步」卡的唯一数据源；stage 只由服务端事件迁移，前端不可直写。
import type { FastifyInstance } from 'fastify';
import { resolveUser } from '../services/context.js';
import { getJourneyView } from '../services/journey.js';

export async function journeyRoutes(app: FastifyInstance) {
  app.get('/journey', async (req) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    return getJourneyView(user.id, user.tenantId);
  });
}
