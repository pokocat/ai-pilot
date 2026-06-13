// 智能体权益（《投产开发指导》§4.1 扩展）：注册赠送 free 智能体；
// unlock 智能体需用算力解锁（或后台开通）后才可对话产出；metered 智能体按次计费。
// 价格单位统一为「算力次数」，与 CreditLedger 共用同一账户。
import { prisma } from '../db.js';
import { CREDIT_COST } from './credits.js';

export type AgentBilling = 'free' | 'unlock' | 'metered';

export class AgentLockedError extends Error {
  statusCode = 403;
  code = 'AGENT_LOCKED';
  constructor(msg = '该智能体未开通，请先解锁后再使用') {
    super(msg);
  }
}

/** 用户已开通（解锁/赠送/后台开通）的 agentKey 集合。 */
export async function ownedAgentKeys(userId: string): Promise<Set<string>> {
  const rows = await prisma.userAgent.findMany({ where: { userId }, select: { agentKey: true } });
  return new Set(rows.map((r) => r.agentKey));
}

/** 该 agent 对前台是否「可直接使用」：free/metered 恒可用；unlock 需已开通。 */
export function isAgentUsable(billing: string, owned: boolean): boolean {
  return billing !== 'unlock' || owned;
}

/**
 * 对外暴露给前台的「是否已拥有」：
 * free/metered 恒为 true（无需解锁即可使用）；unlock 取实际开通记录。
 */
export function publicOwned(billing: string, hasRow: boolean): boolean {
  return billing !== 'unlock' || hasRow;
}

/** 产出/对话前的开通校验：unlock 未开通 → 抛 403 AGENT_LOCKED（free/metered 放行）。 */
export async function assertAgentAccess(userId: string, agent: { key: string; billing: string }): Promise<void> {
  if (agent.billing !== 'unlock') return;
  const row = await prisma.userAgent.findUnique({
    where: { userId_agentKey: { userId, agentKey: agent.key } },
  });
  if (!row) throw new AgentLockedError();
}

/**
 * 一次产出/对话的算力成本：
 * - metered：结构化产出按 agent.price 收费，纯对话免费；
 * - free/unlock：结构化产出 = CREDIT_COST.report，纯对话 = CREDIT_COST.chat。
 */
export function agentCost(agent: { billing: string; price: number }, isDeliverable: boolean): number {
  if (agent.billing === 'metered') return isDeliverable ? agent.price : CREDIT_COST.chat;
  return isDeliverable ? CREDIT_COST.report : CREDIT_COST.chat;
}
