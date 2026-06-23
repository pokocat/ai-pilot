// 记忆候选列表：供对话页 @引用选择器的「记忆」分组（此前由「知识」覆盖，现单列一组）。
// 仅返回当前用户自己的长期记忆（tenant+user 行级隔离），可按项目/智能体/关键词过滤。
import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { resolveUser } from '../services/context.js';
import { deleteUserMemory, updateOwnMemory } from '../services/memory.js';
import { recordAudit } from '../services/audit.js';
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

  // P1-C2：用户编辑自己的一条长期记忆（记忆主权——让用户能纠正军师记错的事实）。
  app.patch<{ Params: { id: string }; Body: { text?: string } }>('/memories/:id', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const text = (req.body?.text ?? '').trim();
    if (!text) return reply.code(400).send({ error: 'empty text' });
    const ok = await updateOwnMemory(user.tenantId, user.id, req.params.id, text);
    if (!ok) return reply.code(404).send({ error: 'memory not found' });
    await recordAudit({ tenantId: user.tenantId, userId: user.id, action: 'user.memory.update', payload: { memoryId: req.params.id } });
    return { ok: true };
  });

  // P1-C2：用户删除自己的一条长期记忆（租户+用户双重校验，幂等）。
  app.delete<{ Params: { id: string } }>('/memories/:id', async (req) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    await deleteUserMemory(user.tenantId, user.id, req.params.id);
    await recordAudit({ tenantId: user.tenantId, userId: user.id, action: 'user.memory.delete', payload: { memoryId: req.params.id } });
    return { ok: true };
  });
}
