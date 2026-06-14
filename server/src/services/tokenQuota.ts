// 月度 Token 额度账户（文本产出消耗池）。与钻石轴(credits.ts)正交：
//   钻石(CreditLedger) 管「一次性解锁 + 图片按张」；本服务管「套餐月度 token 额度」。
// 扣减 = ceil(真实 totalTokens × agent.billingRatio)；按自然月惰性重置；不限量(quota<0)放行。
// 关键：额度扣减是强一致路径（原子自减），与旁路统计 recordTokenUsage（catch 吞错）分离，绝不能漏扣。
// 临界策略：余额>0 放行 → 事后实扣（可透支一次到负）→ 余额≤0 时下次请求 ensureQuota 抛 402。

import { prisma } from '../db.js';

export class InsufficientQuotaError extends Error {
  statusCode = 402;
  code = 'INSUFFICIENT_QUOTA';
  constructor(msg = '本月 token 额度已用尽，请续费或升级套餐') {
    super(msg);
  }
}

const isUnlimited = (quota: number) => quota < 0;
// 自然月周期键（UTC），惰性重置锚点。
const periodKeyOf = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

export interface QuotaState {
  quota: number; // 本月授予总额度，-1=不限量
  balance: number; // 剩余（可为负=已透支/耗尽）
  used: number; // 本月已用 = max(0, quota-balance)；不限量返回 0
  unlimited: boolean;
}

const emptyState: QuotaState = { quota: 0, balance: 0, used: 0, unlimited: false };
const unlimitedState: QuotaState = { quota: -1, balance: -1, used: 0, unlimited: true };

function toState(quota: number, balance: number): QuotaState {
  if (isUnlimited(quota)) return unlimitedState;
  return { quota, balance, used: Math.max(0, quota - balance), unlimited: false };
}

/**
 * 取/建用户当月额度账户，惰性重置：首次建账、跨月则按当前套餐 tokenQuotaPerMonth 重置 balance。
 * 无 plan 的用户 → quota=0（即无额度，文本产出会被 ensureQuota 拦）。
 */
async function loadWallet(userId: string): Promise<{ quota: number; balance: number } | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { tenantId: true, plan: { select: { tokenQuotaPerMonth: true } } },
  });
  if (!user) return null;
  const planQuota = user.plan?.tokenQuotaPerMonth ?? 0;
  const pk = periodKeyOf(new Date());

  // 防并发首建竞争（userId 唯一）：upsert 在 Prisma 下并发仍可能 P2002，捕获后回读。
  const w = await prisma.tokenWallet
    .upsert({
      where: { userId },
      update: {},
      create: { tenantId: user.tenantId, userId, quota: planQuota, balance: planQuota, periodKey: pk },
    })
    .catch(async (e: { code?: string }) => {
      if (e.code === 'P2002') return prisma.tokenWallet.findUnique({ where: { userId } });
      throw e;
    });
  if (!w) return null;
  if (w.periodKey !== pk) {
    const reset = await prisma.tokenWallet.update({
      where: { userId },
      data: { quota: planQuota, balance: planQuota, periodKey: pk },
    });
    return { quota: reset.quota, balance: reset.balance };
  }
  return { quota: w.quota, balance: w.balance };
}

/** 当前额度状态（供 /me 展示进度条）。 */
export async function getQuotaState(userId: string): Promise<QuotaState> {
  const w = await loadWallet(userId);
  if (!w) return emptyState;
  return toState(w.quota, w.balance);
}

/**
 * 产出前粗校验：余额>0 放行（不限量放行）；≤0 抛 402。
 * 真实 token 只有产出后才知道，故这里只能粗判「还有没有额度」，允许最后一次透支。
 */
export async function ensureQuota(userId: string): Promise<void> {
  const w = await loadWallet(userId);
  if (!w) throw new InsufficientQuotaError('当前套餐无月度 token 额度，请升级套餐');
  if (isUnlimited(w.quota)) return;
  if (w.balance <= 0) throw new InsufficientQuotaError();
}

/**
 * 产出后实扣：扣 ceil(realTokens × ratio)，原子自减防双花。返回扣后状态（balance 可为负=本次透支）。
 * 不限量不扣；realTokens<=0（mock / Dify 无 usage / 缓存命中）不扣。
 */
export async function chargeQuota(userId: string, realTokens: number, ratio: number): Promise<QuotaState> {
  const w = await loadWallet(userId);
  if (!w) return emptyState;
  if (isUnlimited(w.quota)) return unlimitedState;
  const cost = Math.ceil(Math.max(0, realTokens) * (ratio > 0 ? ratio : 1));
  if (cost <= 0) return toState(w.quota, w.balance);
  const updated = await prisma.tokenWallet.update({
    where: { userId },
    data: { balance: { decrement: cost } },
    select: { quota: true, balance: true },
  });
  return toState(updated.quota, updated.balance);
}

/** 套餐购买/升级：覆盖式授予当月额度（balance=quota，重置周期键）。quota<0=不限量。 */
export async function setQuota(tenantId: string, userId: string, quota: number): Promise<void> {
  const pk = periodKeyOf(new Date());
  await prisma.tokenWallet.upsert({
    where: { userId },
    update: { quota, balance: quota, periodKey: pk, tenantId },
    create: { tenantId, userId, quota, balance: quota, periodKey: pk },
  });
}
