// 算力计量（《投产开发指导》§5）：按次扣费 + 余额查询 + 不足拦截。
// 单位是「次」：结构化深度产出（report）按 COST.report 计费；自由对话（chat）免费。
// 余额取最近一条 CreditLedger 的 balance；扣费追加一条 delta<0 的流水。
// creditsPerMonth < 0（企业版·不限量）→ 不校验、不扣减。
//
// 注：演示用「读余额→写流水」非原子；生产应放进事务 + 行锁（SELECT … FOR UPDATE）或原子自减，
//     避免高并发下的双花。本项目对话产出为人触发、单用户串行，演示足够。

import { prisma } from '../db.js';

export const CREDIT_COST = { report: 1, chat: 0 } as const;

export class InsufficientCreditsError extends Error {
  statusCode = 402;
  code = 'INSUFFICIENT_CREDITS';
  constructor(msg = '算力不足，请充值后再产出') { super(msg); }
}

const isUnlimited = (balance: number) => balance < 0;

/** 当前算力余额（无流水视为 0）。 */
export async function getBalance(userId: string): Promise<number> {
  const last = await prisma.creditLedger.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } });
  return last?.balance ?? 0;
}

/** 产出前校验：不足则抛 402（不限量套餐放行）。cost<=0 直接放行。 */
export async function ensureCredits(userId: string, cost: number): Promise<void> {
  if (cost <= 0) return;
  const bal = await getBalance(userId);
  if (isUnlimited(bal)) return;
  if (bal < cost) throw new InsufficientCreditsError();
}

/** 产出成功后扣费：追加一条 delta=-cost 的流水，返回新余额。 */
export async function chargeCredits(tenantId: string, userId: string, cost: number, reason: string): Promise<number> {
  const bal = await getBalance(userId);
  if (cost <= 0 || isUnlimited(bal)) return bal;
  const balance = bal - cost;
  await prisma.creditLedger.create({ data: { tenantId, userId, delta: -cost, reason, balance } });
  return balance;
}
