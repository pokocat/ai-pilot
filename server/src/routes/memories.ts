// 记忆候选列表：供对话页 @引用选择器的「记忆」分组（此前由「知识」覆盖，现单列一组）。
// 仅返回当前用户自己的长期记忆（tenant+user 行级隔离），可按项目/智能体/关键词过滤。
import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { resolveUser } from '../services/context.js';
import type { MemoryCandidate } from '../../../shared/contracts';

export async function memoryRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { projectId?: string; agentKey?: string; q?: string; limit?: string } }>(
    '/memories',
    async (req): Promise<MemoryCandidate[]> => {
      const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
      const q = (req.query.q ?? '').trim();
      const take = Math.min(50, Math.max(1, Number(req.query.limit ?? 30)));
      const rows = await prisma.memory.findMany({
        where: {
          tenantId: user.tenantId,
          userId: user.id,
          ...(req.query.projectId ? { projectId: req.query.projectId } : {}),
          ...(req.query.agentKey ? { agentKey: req.query.agentKey } : {}),
          ...(q ? { text: { contains: q, mode: 'insensitive' } } : {}),
        },
        orderBy: [{ weight: 'desc' }, { createdAt: 'desc' }],
        take,
        include: { agent: { select: { name: true } } },
      });
      return rows.map((m) => ({
        id: m.id, text: m.text, kind: m.kind, agentKey: m.agentKey,
        agentName: m.agent?.name ?? null, projectId: m.projectId, createdAt: m.createdAt.toISOString(),
      }));
    },
  );
}
