// 月度 Token 额度账户（文本产出消耗池）。与钻石轴(credits.ts)正交：
//   钻石(CreditLedger) 管「一次性解锁 + 图片按张」；本服务管「套餐月度 token 额度」。
// 扣减 = ceil(真实 totalTokens × agent.billingRatio)；按自然月惰性重置；不限量(quota<0)放行。
// 关键：额度扣减是强一致路径（原子自减），与旁路统计 recordTokenUsage（catch 吞错）分离，绝不能漏扣。
// 临界策略：余额>0 放行 → 事后实扣（可透支一次到负）→ 余额≤0 时下次请求 ensureQuota 抛 402。

import { prisma } from '../db.js';
import type { Prisma } from '@prisma/client';
import { now } from './clock.js';
import { periodKeyOf, isExpired, nextResetAt, daysRemaining } from './planTime.js';

// P0-2：单次产出的悲观额度预留（token 计）。真实成本只有产出后才知道，故产出前先按此预扣、
// 产出后 settle 按真实 token 多退少补。作用是**并发下把透支限制为有界**（每个在途请求各占一份），
// 取代旧的「ensureQuota 只判 balance>0 → 无锁事后扣」导致 N 个并发全部放行的无界透支。
const RESERVE_TOKENS = 2000;

export class InsufficientQuotaError extends Error {
  statusCode = 402;
  code = 'INSUFFICIENT_QUOTA';
  constructor(msg = '本月 token 额度已用尽，请续费或升级套餐') {
    super(msg);
  }
}

const isUnlimited = (quota: number) => quota < 0;

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
 * 取/建用户当月额度账户，惰性重置（购买时快照 B + 订阅锚点子周期 + 过期冻结）：
 * - **首建账户**：初始额度 = live plan.tokenQuotaPerMonth（购买时快照；之后不再回读 live plan）。
 * - **跨锚点子周期**：复用 `wallet.quota` 快照重置 balance（**不回读 live plan** → 后台改套餐只影响新购）。
 * - **已过期**：quota / balance 归 0 冻结（只读锁定的额度侧体现；assertPlanActive 另在 AI 入口拦 403）。
 * periodKey 语义：付费用户=锚点子周期起始日(YYYY-MM-DD)；免费/历史用户=自然月(YYYY-MM)。见 planTime.periodKeyOf。
 */
async function loadWallet(userId: string): Promise<{ quota: number; balance: number } | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { tenantId: true, planActivatedAt: true, planExpiresAt: true, plan: { select: { tokenQuotaPerMonth: true } } },
  });
  if (!user) return null;
  const at = now();
  const expired = isExpired(user.planExpiresAt, at);
  const planQuota = user.plan?.tokenQuotaPerMonth ?? 0; // 仅用于首建账户的初始快照
  const pk = periodKeyOf(user.planActivatedAt, at);
  const initial = expired ? 0 : planQuota;

  // 防并发首建竞争（userId 唯一）：upsert 在 Prisma 下并发仍可能 P2002，捕获后回读。
  const w = await prisma.tokenWallet
    .upsert({
      where: { userId },
      update: {},
      create: { tenantId: user.tenantId, userId, quota: initial, balance: initial, periodKey: pk },
    })
    .catch(async (e: { code?: string }) => {
      if (e.code === 'P2002') return prisma.tokenWallet.findUnique({ where: { userId } });
      throw e;
    });
  if (!w) return null;

  // 跨子周期：复用快照（不回读 live plan）；过期则归 0。
  if (w.periodKey !== pk) {
    const q = expired ? 0 : w.quota;
    const reset = await prisma.tokenWallet.update({
      where: { userId },
      data: { quota: q, balance: q, periodKey: pk },
    });
    return { quota: reset.quota, balance: reset.balance };
  }
  // 同子周期内刚过期：立即冻结到 0（至多一次过渡写，之后幂等）。
  if (expired && (w.quota !== 0 || w.balance !== 0)) {
    const z = await prisma.tokenWallet.update({ where: { userId }, data: { quota: 0, balance: 0 } });
    return { quota: z.quota, balance: z.balance };
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

// 额度账户的 per-user 串行锁（与 credits 同套路）：保证「校验余额 → 扣减」整体原子，杜绝并发无界透支。
async function lockQuota(db: Prisma.TransactionClient, userId: string): Promise<void> {
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`quota:${userId}`}))`;
}

/** 产出前的额度预留：成功后产出，产出后必须 settle（多退少补）或失败时 refund（全额退回）。 */
export interface QuotaReservation {
  unlimited: boolean;
  settle: (realTokens: number, ratio: number) => Promise<QuotaState>;
  refund: () => Promise<void>;
}

/**
 * P0-2：产出前在锁内**预扣**一份悲观估算额度（ceil(RESERVE_TOKENS × ratio)），返回结算句柄。
 * - 余额≤0 → 抛 402（与旧 ensureQuota 语义一致，仍允许「最后一次透支」：余额>0 即可预留一份）。
 * - 并发：advisory lock 串行化「读余额 + 扣预留」，故第二个并发请求会看到已被预留压低/转负的余额而被拦，透支有界。
 * - settle：按真实 token 计算实际成本，delta = 预留 − 实际，>0 退回、<0 追扣（幂等：settle/refund 二选一只生效一次）。
 */
// 复盘保底（M2 PR-6）：留存动作不因额度耗尽中断——余额≤0 时，复盘类调用每日最多放行 N 次
// （照常预留/结算，余额可为负=透支记账，进入后台消耗明细）。仅额度层面的保底；
// 套餐到期的只读锁定仍由 assertPlanActive 把守，不受影响。
export const REVIEW_GRACE_PER_DAY = 2;

async function graceUsedToday(userId: string): Promise<number> {
  const d = now();
  const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return prisma.auditLog.count({ where: { userId, action: 'system.quota.grace', createdAt: { gte: dayStart } } });
}

export async function reserveQuota(userId: string, ratio = 1, opts?: { grace?: 'review' }): Promise<QuotaReservation> {
  const w = await loadWallet(userId); // 锁外先确保账户存在 + 惰性月度重置（upsert 不宜进事务）
  if (!w) throw new InsufficientQuotaError('当前套餐无月度 token 额度，请升级套餐');
  if (isUnlimited(w.quota)) {
    return { unlimited: true, settle: async () => unlimitedState, refund: async () => {} };
  }
  const reserved = Math.ceil(RESERVE_TOKENS * (ratio > 0 ? ratio : 1));
  // 保底资格在锁外预查（并发极端下最多多放行一次，可接受；额度本身仍有界透支）
  const allowNegative = opts?.grace ? (await graceUsedToday(userId)) < REVIEW_GRACE_PER_DAY : false;
  let graceGranted = false;
  await prisma.$transaction(async (tx) => {
    await lockQuota(tx, userId);
    const row = await tx.tokenWallet.findUnique({ where: { userId }, select: { balance: true } });
    if ((row?.balance ?? 0) <= 0) {
      if (!allowNegative) throw new InsufficientQuotaError();
      graceGranted = true; // 复盘保底：额度耗尽仍放行（透支记账）
    }
    await tx.tokenWallet.update({ where: { userId }, data: { balance: { decrement: reserved } } });
  });
  if (graceGranted) {
    const { recordAudit } = await import('./audit.js');
    await recordAudit({ userId, action: 'system.quota.grace', payload: { kind: opts?.grace, reserved } }).catch(() => {});
  }

  let done = false;
  return {
    unlimited: false,
    settle: async (realTokens: number, ratio2: number): Promise<QuotaState> => {
      if (done) return getQuotaState(userId);
      const cost = Math.ceil(Math.max(0, realTokens) * (ratio2 > 0 ? ratio2 : 1));
      const delta = reserved - cost; // >0 多退；<0 少补（仍可使最终余额为负=本次透支）
      const st = await prisma.$transaction(async (tx) => {
        await lockQuota(tx, userId);
        const updated = await tx.tokenWallet.update({
          where: { userId },
          data: { balance: { increment: delta } },
          select: { quota: true, balance: true },
        });
        return toState(updated.quota, updated.balance);
      });
      done = true; // 仅在结算成功后置位；若上面事务抛错，done 仍为 false → 路由 catch 的 refund 会退回预留
      return st;
    },
    refund: async (): Promise<void> => {
      if (done) return;
      done = true;
      await prisma.$transaction(async (tx) => {
        await lockQuota(tx, userId);
        await tx.tokenWallet.update({ where: { userId }, data: { balance: { increment: reserved } } });
      });
    },
  };
}

/**
 * 套餐购买/升级/续费：覆盖式授予当月额度（balance=quota，重置周期键）。quota<0=不限量。
 * activatedAt = 套餐激活锚点（购买/升级=now、续费=保留原锚点），用于对齐 periodKey 子周期；
 * 不传（如测试/历史调用）→ null → 按自然月键，行为同旧版。
 */
export async function setQuota(
  tenantId: string,
  userId: string,
  quota: number,
  activatedAt: Date | null = null,
  db: Prisma.TransactionClient = prisma,
): Promise<void> {
  const pk = periodKeyOf(activatedAt, now());
  await db.tokenWallet.upsert({
    where: { userId },
    update: { quota, balance: quota, periodKey: pk, tenantId },
    create: { tenantId, userId, quota, balance: quota, periodKey: pk },
  });
}

/** 套餐到期 → AI 交互门禁错误（D4）：拦一切产出/对话，只读放行。 */
export class PlanExpiredError extends Error {
  statusCode = 403;
  code = 'PLAN_EXPIRED';
  constructor(msg = '套餐已到期，续费后可继续使用（到期后内容只读、AI 交互暂停）') {
    super(msg);
  }
}

/**
 * AI 交互门禁（D4）：套餐过期 → 抛 PLAN_EXPIRED(403)，拦截一切产出 / 对话 / 图片生成。
 * 挂在 /generate、/generate-sync、/summarize 等 AI 入口的预校验段（早于 reserveQuota）。
 * 读类（报告/方案库/历史/导出）不挂此门禁 → 只读放行。
 */
export async function assertPlanActive(userId: string): Promise<void> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { planExpiresAt: true } });
  if (u && isExpired(u.planExpiresAt, now())) throw new PlanExpiredError();
}

export interface PlanStatus {
  active: boolean; // 套餐是否有效（未过期）
  expired: boolean; // 是否已过期（→ 前端只读模式）
  expiresAt: string | null; // 绝对到期时间（ISO）；null=不到期
  daysRemaining: number | null; // 剩余天数（向上取整）；null=不到期
  nextResetAt: string; // 下次月度额度重置时刻（ISO）
}

/** 套餐状态（供 /me 展示到期日 / 剩余天数 / 下次额度重置日 + 驱动前端只读态）。 */
export async function getPlanStatus(userId: string): Promise<PlanStatus> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { planActivatedAt: true, planExpiresAt: true } });
  const at = now();
  const expiresAt = u?.planExpiresAt ?? null;
  const expired = isExpired(expiresAt, at);
  return {
    active: !expired,
    expired,
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
    daysRemaining: daysRemaining(expiresAt, at),
    nextResetAt: nextResetAt(u?.planActivatedAt ?? null, at).toISOString(),
  };
}
