import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { resolveUser } from '../services/context.js';
import { getBalance } from '../services/credits.js';
import { ownedAgentKeys, publicOwned } from '../services/entitlements.js';
import { recordAudit } from '../services/audit.js';
import type { Agent as AgentView, AgentPurchaseResult } from '../../../shared/contracts';

export async function agentRoutes(app: FastifyInstance) {
  // 智能体注册表（前端启动时拉取，替代原型 app.js 的 AGENTS 常量）。
  // 带 x-user-id 时回填每个智能体的 owned（unlock 是否已解锁）。
  app.get('/agents', async (req): Promise<AgentView[]> => {
    const onlyEnabled = (req.query as { enabled?: string }).enabled !== 'false';
    const agents = await prisma.agent.findMany({
      where: onlyEnabled ? { enabled: true } : {},
      orderBy: { sort: 'asc' },
    });
    const owned = await ownedKeysForHeader(req.headers['x-user-id'] as string | undefined);
    return agents.map((a) => publicAgent(a, owned));
  });

  app.get<{ Params: { key: string } }>('/agents/:key', async (req, reply): Promise<AgentView | void> => {
    const a = await prisma.agent.findUnique({ where: { key: req.params.key } });
    if (!a) return reply.code(404).send({ error: 'agent not found' });
    const owned = await ownedKeysForHeader(req.headers['x-user-id'] as string | undefined);
    return publicAgent(a, owned);
  });

  // 解锁/购买智能体：仅 unlock 类可购买，消耗算力（按次次数）。free/metered 无需购买。
  app.post<{ Params: { key: string } }>('/agents/:key/purchase', async (req, reply): Promise<AgentPurchaseResult | void> => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const agent = await prisma.agent.findUnique({ where: { key: req.params.key } });
    if (!agent || !agent.enabled) return reply.code(404).send({ error: '智能体不存在或已下架', code: 'AGENT_NOT_FOUND' });
    if (agent.billing !== 'unlock') {
      return reply.code(400).send({ error: '该智能体无需购买', code: 'AGENT_NOT_PURCHASABLE' });
    }

    // 幂等：已开通直接返回当前余额，不重复扣费。
    const existing = await prisma.userAgent.findUnique({
      where: { userId_agentKey: { userId: user.id, agentKey: agent.key } },
    });
    const balance = await getBalance(user.id);
    if (existing) {
      return { ok: true, agentKey: agent.key, pricePaid: 0, creditBalance: balance, alreadyOwned: true };
    }

    const unlimited = balance < 0; // 不限量套餐：解锁免扣
    if (!unlimited && balance < agent.price) {
      return reply.code(402).send({ error: '权益点不足，无法启用该智能体', code: 'INSUFFICIENT_CREDITS' });
    }
    const newBalance = unlimited ? -1 : balance - agent.price;

    try {
      await prisma.$transaction([
        prisma.userAgent.create({
          data: { userId: user.id, agentKey: agent.key, source: 'purchase', pricePaid: unlimited ? 0 : agent.price },
        }),
        ...(unlimited
          ? []
          : [
              prisma.creditLedger.create({
                data: {
                  tenantId: user.tenantId,
                  userId: user.id,
                  delta: -agent.price,
                  reason: `解锁智能体 · ${agent.name}`,
                  balance: newBalance,
                },
              }),
            ]),
      ]);
    } catch (e) {
      // 并发重复购买：另一个请求已写入开通记录（唯一约束 userId_agentKey）→ 幂等返回、不重复扣费
      if ((e as { code?: string }).code === 'P2002') {
        return { ok: true, agentKey: agent.key, pricePaid: 0, creditBalance: await getBalance(user.id), alreadyOwned: true };
      }
      throw e;
    }
    await recordAudit({
      tenantId: user.tenantId,
      userId: user.id,
      action: 'user.agent.purchase',
      payload: { agentKey: agent.key, agentName: agent.name, price: agent.price, creditBalance: newBalance },
    });

    return { ok: true, agentKey: agent.key, pricePaid: unlimited ? 0 : agent.price, creditBalance: newBalance, alreadyOwned: false };
  });
}

// 无 token / 无效 token 时返回空集（公开拉取仍可看到列表，只是 unlock 显示未开通）。
async function ownedKeysForHeader(token?: string): Promise<Set<string>> {
  const id = (token ?? '').trim();
  if (!id) return new Set();
  const user = await prisma.user.findUnique({ where: { id }, select: { id: true } });
  if (!user) return new Set();
  return ownedAgentKeys(user.id);
}

function publicAgent(
  a: {
    key: string; name: string; role: string; icon: string; type: string; gift: boolean;
    billing: string; price: number; enabled: boolean; greet: string; chipsJson: unknown;
    memText: string; learnText: string; deliverableKey: string | null;
  },
  owned: Set<string>,
): AgentView {
  return {
    key: a.key,
    name: a.name,
    role: a.role,
    icon: a.icon,
    type: a.type as AgentView['type'],
    gift: a.gift,
    billing: a.billing as AgentView['billing'],
    price: a.price,
    owned: publicOwned(a.billing, owned.has(a.key)),
    enabled: a.enabled,
    greet: a.greet,
    chips: a.chipsJson as [string, string][],
    memText: a.memText,
    learnText: a.learnText,
    deliverableKey: a.deliverableKey,
  };
}
