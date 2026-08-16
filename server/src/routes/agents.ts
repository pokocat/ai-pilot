import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { resolveUser } from '../services/context.js';
import { verifyUserToken } from '../services/userToken.js';
import { getBalance } from '../services/credits.js';
import { ownedAgentKeys, publicOwned } from '../services/entitlements.js';
import { recordAudit } from '../services/audit.js';
import { parseAttribution, recordActivation } from '../services/activation.js';
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
    // C 端展示的计费/倍率/开场白以「已发布版本」为准（与实际扣费口径一致；草稿改动不外泄）。
    const pubIds = agents.map((a) => a.publishedVersionId).filter((x): x is string => !!x);
    const versions = pubIds.length ? await prisma.agentVersion.findMany({ where: { id: { in: pubIds } } }) : [];
    const verMap = new Map(versions.map((v) => [v.id, v]));
    return agents.map((a) => publicAgent(overlayPublished(a, a.publishedVersionId ? verMap.get(a.publishedVersionId) ?? null : null), owned));
  });

  app.get<{ Params: { key: string } }>('/agents/:key', async (req, reply): Promise<AgentView | void> => {
    const a = await prisma.agent.findUnique({ where: { key: req.params.key } });
    if (!a) return reply.code(404).send({ error: '这位军师暂时不可用', code: 'AGENT_NOT_FOUND' });
    const owned = await ownedKeysForHeader(req.headers['x-user-id'] as string | undefined);
    const ver = a.publishedVersionId ? await prisma.agentVersion.findUnique({ where: { id: a.publishedVersionId } }) : null;
    return publicAgent(overlayPublished(a, ver), owned);
  });

  // 启用智能体：仅 unlock 类需要显式启用，「确认即启用」不收费。
  // 2026-08 计费改造：对话走额度、产出物走独立钻石计费，启用动作本身不再扣权益点
  // （落库/门禁/来源归因/审计一律保留，只旁路收费；agent.price 仍供 metered 与后台展示用）。
  app.post<{ Params: { key: string }; Body: { source?: string; refId?: string } }>('/agents/:key/purchase', async (req, reply): Promise<AgentPurchaseResult | void> => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const agent = await prisma.agent.findUnique({ where: { key: req.params.key } });
    if (!agent || !agent.enabled) return reply.code(404).send({ error: '智能体不存在或已下架', code: 'AGENT_NOT_FOUND' });
    if (agent.billing !== 'unlock') {
      return reply.code(400).send({ error: '该智能体无需购买', code: 'AGENT_NOT_PURCHASABLE' });
    }

    try {
      const purchased = await prisma.$transaction(async (tx) => {
        const existing = await tx.userAgent.findUnique({
          where: { userId_agentKey: { userId: user.id, agentKey: agent.key } },
        });
        if (existing) {
          return { alreadyOwned: true, creditBalance: await getBalance(user.id), pricePaid: 0 };
        }
        await tx.userAgent.create({
          data: { userId: user.id, agentKey: agent.key, source: 'purchase', pricePaid: 0 },
        });
        return { alreadyOwned: false, creditBalance: await getBalance(user.id), pricePaid: 0 };
      });
      if (!purchased.alreadyOwned) {
        await recordAudit({
          tenantId: user.tenantId,
          userId: user.id,
          action: 'user.agent.purchase',
          payload: { agentKey: agent.key, agentName: agent.name, pricePaid: 0, creditBalance: purchased.creditBalance },
        });
        // D-1 开通来源归因：仅首次解锁记事件（幂等重复不重复计）。source 从请求体读、缺省 catalog、表外回落。
        const { source, refId } = parseAttribution(req.body?.source, req.body?.refId);
        await recordActivation({ tenantId: user.tenantId, userId: user.id, itemType: 'agent', itemKey: agent.key, source, refId }).catch(() => {});
      }
      return {
        ok: true,
        agentKey: agent.key,
        pricePaid: purchased.pricePaid,
        creditBalance: purchased.creditBalance,
        alreadyOwned: purchased.alreadyOwned,
      };
    } catch (e) {
      // 并发重复启用：另一个请求已写入开通记录（唯一约束 userId_agentKey）→ 幂等返回
      if ((e as { code?: string }).code === 'P2002') {
        return { ok: true, agentKey: agent.key, pricePaid: 0, creditBalance: await getBalance(user.id), alreadyOwned: true };
      }
      throw e;
    }
  });
}

// 无 token / 无效 token 时返回空集（公开拉取仍可看到列表，只是 unlock 显示未开通）。
async function ownedKeysForHeader(token?: string): Promise<Set<string>> {
  const id = verifyUserToken(token);
  if (!id) return new Set();
  const user = await prisma.user.findUnique({ where: { id }, select: { id: true } });
  if (!user) return new Set();
  return ownedAgentKeys(user.id);
}

// 把「已发布版本」的计费/接入/开场白/行为内容覆盖到 agent 行（身份字段 name/icon/role/type/enabled 仍取 agent 行）。
// P1-A5：greet/chips/memText/learnText 随版本冻结；旧版本相应列为 null → 回退 Agent 行（无回归）。
type PublishedOverlay = {
  billing: string; price: number; billingRatio: number; meterUnit: string; greet: string; deliverableKey: string | null;
  chipsJson?: unknown; memText?: string | null; learnText?: string | null;
} | null;
function overlayPublished<T extends Record<string, unknown>>(a: T, ver: PublishedOverlay): T {
  if (!ver) return a;
  return {
    ...a,
    billing: ver.billing, price: ver.price, billingRatio: ver.billingRatio,
    meterUnit: ver.meterUnit, greet: ver.greet, deliverableKey: ver.deliverableKey,
    chipsJson: ver.chipsJson ?? a.chipsJson,
    memText: ver.memText ?? a.memText,
    learnText: ver.learnText ?? a.learnText,
  };
}

function publicAgent(
  a: {
    key: string; name: string; role: string; icon: string; type: string; gift: boolean;
    billing: string; price: number; billingRatio: number; meterUnit: string;
    enabled: boolean; greet: string; chipsJson: unknown;
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
    billingRatio: a.billingRatio,
    meterUnit: (a.meterUnit as AgentView['meterUnit']) || 'text',
    owned: publicOwned(a.billing, owned.has(a.key)),
    enabled: a.enabled,
    greet: a.greet,
    chips: a.chipsJson as [string, string][],
    memText: a.memText,
    learnText: a.learnText,
    deliverableKey: a.deliverableKey,
  };
}
