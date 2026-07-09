// V7-11 提醒体系：提醒日历视图（用户态，纯读派生）。
// 行级隔离：resolveUser 后按 user.id/tenantId 派生；无副作用、无鉴权外的额外分支。
import type { FastifyInstance } from 'fastify';
import { resolveUser } from '../services/context.js';
import { buildReminderView } from '../services/reminders.js';

export async function reminderRoutes(app: FastifyInstance) {
  // 提醒日历：今日军令截止 / 20:30 复盘 / 周五周复盘 + 订阅状态（subscribeReady=模板是否已配置）
  app.get('/reminders', async (req) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    return buildReminderView({ tenantId: user.tenantId, userId: user.id });
  });
}
