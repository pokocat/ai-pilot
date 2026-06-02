import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';

export async function agentRoutes(app: FastifyInstance) {
  // 智能体注册表（前端启动时拉取，替代原型 app.js 的 AGENTS 常量）
  app.get('/agents', async (req) => {
    const onlyEnabled = (req.query as { enabled?: string }).enabled !== 'false';
    const agents = await prisma.agent.findMany({
      where: onlyEnabled ? { enabled: true } : {},
      orderBy: { sort: 'asc' },
    });
    return agents.map(publicAgent);
  });

  app.get<{ Params: { key: string } }>('/agents/:key', async (req, reply) => {
    const a = await prisma.agent.findUnique({ where: { key: req.params.key } });
    if (!a) return reply.code(404).send({ error: 'agent not found' });
    return publicAgent(a);
  });
}

function publicAgent(a: {
  key: string; name: string; role: string; icon: string; type: string; gift: boolean;
  enabled: boolean; greet: string; chipsJson: unknown; memText: string; learnText: string; deliverableKey: string | null;
}) {
  return {
    key: a.key,
    name: a.name,
    role: a.role,
    icon: a.icon,
    type: a.type,
    gift: a.gift,
    enabled: a.enabled,
    greet: a.greet,
    chips: a.chipsJson,
    memText: a.memText,
    learnText: a.learnText,
    deliverableKey: a.deliverableKey,
  };
}
