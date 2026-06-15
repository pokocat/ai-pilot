// 公开报告页:GET /api/r/:id → 返回服务端渲染的 HTML(凭不可猜 id 访问,不鉴权,供分享/发朋友圈)。
import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';

export async function reportShareRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>('/r/:id', async (req, reply) => {
    const row = await prisma.reportHtml.findUnique({ where: { id: req.params.id } });
    if (!row) return reply.code(404).type('text/html; charset=utf-8').send('<!DOCTYPE html><meta charset="utf-8"><body style="font-family:serif;text-align:center;padding:60px;color:#8a8170">报告不存在或已过期</body>');
    return reply.type('text/html; charset=utf-8').send(row.html);
  });
}
