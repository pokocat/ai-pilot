import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { resolveUser } from '../services/context.js';
import { recordFeedback } from '../services/memory.js';
import type { MemoryConfig } from '../data/agents.js';

export async function libraryRoutes(app: FastifyInstance) {
  // 方案库列表
  app.get('/library', async (req) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const items = await prisma.deliverable.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      include: { agent: true },
    });
    return items.map((d) => ({
      id: d.id,
      title: d.title,
      type: d.type,
      agentKey: d.agentKey,
      agentName: d.agent.name,
      sessionId: d.sessionId,
      content: d.contentJson,
      at: d.createdAt,
    }));
  });

  // 存入方案库
  app.post<{ Body: { title: string; type: string; agentKey: string; sessionId?: string; content: object } }>(
    '/library',
    async (req) => {
      const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
      const d = await prisma.deliverable.create({
        data: {
          tenantId: user.tenantId,
          userId: user.id,
          sessionId: req.body.sessionId ?? null,
          agentKey: req.body.agentKey,
          title: req.body.title,
          type: req.body.type,
          contentJson: req.body.content,
          status: 'ready',
        },
      });
      // 反馈回流：存入 = 采纳信号
      const agent = await prisma.agent.findUnique({ where: { key: req.body.agentKey } });
      if (agent) {
        await recordFeedback({
          tenantId: user.tenantId,
          userId: user.id,
          agentKey: req.body.agentKey,
          cfg: agent.memoryConfig as unknown as MemoryConfig,
          signal: 'adopt',
          title: req.body.title,
        });
      }
      return { id: d.id, at: d.createdAt };
    },
  );

  app.delete<{ Params: { id: string } }>('/library/:id', async (req) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    await prisma.deliverable.deleteMany({ where: { id: req.params.id, userId: user.id } });
    return { ok: true };
  });
}
