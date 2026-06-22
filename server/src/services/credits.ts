// 算力计量（《投产开发指导》§5）：按次扣费 + 余额查询 + 不足拦截。
// 单位是「次」：结构化深度产出（report）按 COST.report 计费；自由对话（chat）免费。
// 余额取最近一条 CreditLedger 的 balance；扣费追加一条 delta<0 的流水。
// creditsPerMonth < 0（企业版·不限量）→ 不校验、不扣减。

import { prisma } from '../db.js';
import type { Prisma } from '@prisma/client';

export const CREDIT_COST = { report: 1, chat: 0 } as const;

export class InsufficientCreditsError extends Error {
  statusCode = 402;
  code = 'INSUFFICIENT_CREDITS';
  constructor(msg = '权益点不足，请调整方案后再继续') { super(msg); }
}

const isUnlimited = (balance: number) => balance < 0;
type CreditDb = Prisma.TransactionClient;

async function lockCreditAccount(db: CreditDb, userId: string): Promise<void> {
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`credit:${userId}`}))`;
}

async function balanceIn(db: CreditDb, userId: string): Promise<number> {
  const last = await db.creditLedger.findFirst({
    where: { userId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  return last?.balance ?? 0;
}

/** 当前算力余额（无流水视为 0）。 */
export async function getBalance(userId: string): Promise<number> {
  return balanceIn(prisma, userId);
}

/** 产出前校验：不足则抛 402（不限量套餐放行）。cost<=0 直接放行。 */
export async function ensureCredits(userId: string, cost: number): Promise<void> {
  if (cost <= 0) return;
  const bal = await getBalance(userId);
  if (isUnlimited(bal)) return;
  if (bal < cost) throw new InsufficientCreditsError();
}

async function appendCreditDelta(
  db: CreditDb,
  tenantId: string,
  userId: string,
  delta: number,
  reason: string,
): Promise<number> {
  await lockCreditAccount(db, userId);
  const bal = await balanceIn(db, userId);
  if (isUnlimited(bal)) return bal;
  const balance = bal + delta;
  if (balance < 0) throw new InsufficientCreditsError();
  await db.creditLedger.create({ data: { tenantId, userId, delta, reason, balance } });
  return balance;
}

/** 原子扣费：追加一条 delta=-cost 的流水，返回新余额。 */
export async function chargeCredits(
  tenantId: string,
  userId: string,
  cost: number,
  reason: string,
  db?: CreditDb,
): Promise<number> {
  if (cost <= 0) return getBalance(userId);
  const apply = (client: CreditDb) => appendCreditDelta(client, tenantId, userId, -cost, reason);
  return db ? apply(db) : prisma.$transaction((tx) => apply(tx));
}

/** 原子补回：用于预扣后产出失败退款。 */
export async function refundCredits(
  tenantId: string,
  userId: string,
  cost: number,
  reason: string,
  db?: CreditDb,
): Promise<number> {
  if (cost <= 0) return getBalance(userId);
  const apply = (client: CreditDb) => appendCreditDelta(client, tenantId, userId, cost, reason);
  return db ? apply(db) : prisma.$transaction((tx) => apply(tx));
}

/** 套餐赠送/切换：amount<0 表示不限量，余额写为 -1；否则在当前余额上叠加。 */
export async function grantCredits(
  tenantId: string,
  userId: string,
  amount: number,
  reason: string,
  db?: CreditDb,
): Promise<number> {
  const apply = async (client: CreditDb) => {
    await lockCreditAccount(client, userId);
    const bal = await balanceIn(client, userId);
    const unlimited = amount < 0;
    const delta = unlimited ? 0 : amount;
    const balance = unlimited ? -1 : (isUnlimited(bal) ? amount : bal + amount);
    await client.creditLedger.create({ data: { tenantId, userId, delta, reason, balance } });
    return balance;
  };
  return db ? apply(db) : prisma.$transaction((tx) => apply(tx));
}

export interface CreditReservation {
  charged: boolean;
  balance: number;
  refund: (reason?: string) => Promise<number>;
}

/** 已知费用的产出在调用模型前预扣，防止并发请求先交付后扣费失败。 */
export async function reserveCredits(
  tenantId: string,
  userId: string,
  cost: number,
  reason: string,
): Promise<CreditReservation> {
  const bal = await getBalance(userId);
  if (cost <= 0 || isUnlimited(bal)) {
    return { charged: false, balance: bal, refund: async () => bal };
  }
  const balance = await chargeCredits(tenantId, userId, cost, reason);
  return {
    charged: true,
    balance,
    refund: (refundReason = `${reason} · 失败退回`) => refundCredits(tenantId, userId, cost, refundReason),
  };
}
