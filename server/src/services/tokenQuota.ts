// 月度 Token 额度账户（文本产出消耗池）。与钻石轴(credits.ts)正交：
//   钻石(CreditLedger) 管「一次性解锁 + 图片按张」；本服务管「套餐月度 token 额度」。
// 扣减 = ceil(真实 totalTokens × agent.billingRatio)；按自然月惰性重置；不限量(quota<0)放行。
// 关键：额度扣减是强一致路径（原子自减），与旁路统计 recordTokenUsage（catch 吞错）分离，绝不能漏扣。
// 临界策略：余额>0 放行 → 事后实扣（可透支一次到负）→ 余额≤0 时下次请求 ensureQuota 抛 402。

import { prisma } from '../db.js';
import type { Prisma } from '@prisma/client';
import { now, dayStart } from './clock.js';
import { periodKeyOf, isExpired, nextResetAt, daysRemaining } from './planTime.js';
import { featureFlagPayload } from './featureFlag.js';
import { CHAT_MAX_TOKENS } from '../llm/providers/completionGuard.js';
import { weightedQuotaReserveTokens } from '../data/modelPrices.js';
import { grantCredits } from './credits.js';
import {
  effectiveProvider,
  getAiConfig,
  maxConfiguredRateWeights,
  resolveModelRate,
} from './aiConfig.js';

// P0-2：单次产出的悲观额度预留（token 计）。真实成本只有产出后才知道，故产出前先按此预扣、
// 产出后 settle 按真实 token 多退少补。作用是**并发下把透支限制为有界**（每个在途请求各占一份），
// 取代旧的「ensureQuota 只判 balance>0 → 无锁事后扣」导致 N 个并发全部放行的无界透支。
// 导出供 rawJson 系（extractGraphTriples/summarizePoints 等不回传真实 token 用量）的调用方
// 按同一基准定额结算：reserveQuota 预留后 settle(RESERVE_TOKENS, ratio) = 全额扣留、不退。
export const RESERVE_TOKENS = 2000;
// 用户可见生成的最大输入预算：覆盖系统提示词、历史、120k 字符引用和档案块的悲观上界。
// 最终预留还会叠加 CHAT_MAX_TOKENS × 当前最高输出权重；只影响在途占额，结算后多退少补。
export const GENERATION_MAX_INPUT_TOKENS = 128_000;

export async function generationQuotaReserveTokens(
  opts?: { forceLive?: boolean; model?: string | null },
): Promise<number> {
  try {
    const cfg = await getAiConfig();
    // mock/测试调用没有真实 token 成本，保留小额并发门禁即可；自定义 OpenAI 智能体可用 forceLive 覆盖。
    if (!opts?.forceLive && effectiveProvider(cfg) === 'mock') return RESERVE_TOKENS;
    const rate = opts?.model
      ? (await resolveModelRate(opts.model)).rate
      : await maxConfiguredRateWeights();
    return weightedQuotaReserveTokens(
      GENERATION_MAX_INPUT_TOKENS,
      CHAT_MAX_TOKENS,
      rate,
    );
  } catch {
    // DB/配置瞬时不可用时仍按裸 token 上界预留，不能退回旧的 2k 小额预留。
    return GENERATION_MAX_INPUT_TOKENS + CHAT_MAX_TOKENS;
  }
}

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
  balance: number; // 剩余（含增购算力包；可为负=已透支/耗尽）
  used: number; // 本月已用（只算月度部分，增购包消耗不计入）；不限量返回 0
  unlimited: boolean;
  packBalance: number; // 增购算力包剩余（派生的 packRemaining，永久有效直到用完）
}

const emptyState: QuotaState = { quota: 0, balance: 0, used: 0, unlimited: false, packBalance: 0 };
const unlimitedState: QuotaState = { quota: -1, balance: -1, used: 0, unlimited: true, packBalance: 0 };

/**
 * 增购算力包（pack-in-balance）的派生剩余量。约定「消耗先吃月度、后吃 pack」，
 * 故 pack 真实剩余 = 总余额被 clamp 到上一个同步点的 pack 存量之内；
 * quota<0（不限量套餐）时余额恒为负哨兵、pack 从未被消耗，直接取存量。
 */
export function packRemainingOf(row: { quota: number; balance: number; packBalance: number }): number {
  const stock = Math.max(0, row.packBalance);
  if (isUnlimited(row.quota)) return stock;
  return Math.min(Math.max(0, row.balance), stock);
}

/** 同步点刷写 balance 的统一口径：不限量保持负哨兵，其余 = 月度额度 + pack 剩余。 */
function balanceWithPack(quota: number, packRemaining: number): number {
  return isUnlimited(quota) ? quota : quota + Math.max(0, packRemaining);
}

function toState(quota: number, balance: number, packBalance: number): QuotaState {
  const pack = packRemainingOf({ quota, balance, packBalance });
  if (isUnlimited(quota)) return { ...unlimitedState, packBalance: pack };
  // 已用只算月度：先把 pack 剩余从总余额里剔除，剩下的才是月度余额。
  const monthlyRemaining = Math.max(0, balance - pack);
  return { quota, balance, used: Math.max(0, quota - monthlyRemaining), unlimited: false, packBalance: pack };
}

/**
 * 取/建用户当月额度账户，惰性重置（购买时快照 B + 订阅锚点子周期 + 过期冻结）：
 * - **首建账户**：初始额度 = live plan.tokenQuotaPerMonth（购买时快照；之后不再回读 live plan）。
 * - **跨锚点子周期**：复用 `wallet.quota` 快照重置 balance（**不回读 live plan** → 后台改套餐只影响新购）。
 * - **已过期**：quota 归 0 冻结、balance 只保留增购包剩余（只读锁定的额度侧体现；assertPlanActive 另在 AI 入口拦 403）。
 * - **增购算力包**：三个同步点都先派生 packRemaining 再刷写，绝不把「买来的、永久有效」的算力抹掉。
 * periodKey 语义：付费用户=锚点子周期起始日(YYYY-MM-DD)；免费/历史用户=自然月(YYYY-MM)。见 planTime.periodKeyOf。
 */
async function loadWallet(userId: string): Promise<{ quota: number; balance: number; packBalance: number } | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { tenantId: true, planActivatedAt: true, planExpiresAt: true, plan: { select: { id: true, name: true, tokenQuotaPerMonth: true, creditsPerMonth: true, period: true } } },
  });
  if (!user) return null;
  const at = now();
  const expired = isExpired(user.planExpiresAt, at);
  const planQuota = user.plan?.tokenQuotaPerMonth ?? 0; // 仅用于首建账户的初始快照
  const pk = periodKeyOf(user.planActivatedAt, at);
  const initial = expired ? 0 : planQuota;

  // 防并发首建竞争（userId 唯一）：upsert 在 Prisma 下并发仍可能 P2002，捕获后回读。
  let w = await prisma.tokenWallet
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

  // 到期临时加额惰性回收：quota 与 balance 同减，保持 used 不变；审计记录本身保留。
  // 增购包口径：这里刻意不动 packBalance（回收的是运营临时加额，不是买来的包）。极端情况下
  // （回收把 balance 压到 packBalance 之下）派生的 packRemaining 会被临时侵蚀 —— 保守方向、可接受，
  // 不为此在临时加额路径上再叠一层 pack 记账。
  const expiredAdjustments = await prisma.tokenQuotaAdjustment.findMany({
    where: { userId, revokedAt: null, expiresAt: { lte: at } }, select: { id: true, delta: true },
  });
  if (expiredAdjustments.length) {
    w = await prisma.$transaction(async (tx) => {
      await lockQuota(tx, userId);
      const fresh = await tx.tokenWallet.findUniqueOrThrow({ where: { userId } });
      const ids = expiredAdjustments.map((item) => item.id);
      const stillActive = await tx.tokenQuotaAdjustment.findMany({ where: { id: { in: ids }, revokedAt: null }, select: { id: true, delta: true } });
      const delta = stillActive.reduce((sum, item) => sum + item.delta, 0);
      if (stillActive.length) await tx.tokenQuotaAdjustment.updateMany({ where: { id: { in: stillActive.map((item) => item.id) } }, data: { revokedAt: at } });
      if (!delta || fresh.quota < 0) return fresh;
      return tx.tokenWallet.update({ where: { userId }, data: { quota: { decrement: delta }, balance: { decrement: delta } } });
    });
  }

  // 年付套餐按锚点月惰性发放每月钻石。首见当前周期只补 marker（购买路径已发过），
  // 仅确认钱包从旧 periodKey 跨入新周期时才实际发放；唯一键保证并发/重复读取恰好一次。
  const ensureMonthlyCredits = async (crossedPeriod: boolean) => {
    if (expired || user.plan?.period !== 'year' || (user.plan.creditsPerMonth ?? 0) <= 0) return;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`entitlement:${userId}`}))`;
      const exists = await tx.monthlyCreditGrant.findUnique({ where: { userId_periodKey: { userId, periodKey: pk } } });
      if (exists) return;
      // 存量年付用户可能在旧版本里已跨月但从未得到钻石。即便钱包此前已被旧代码重置到当前 pk，
      // 只要当前已不是激活首周期且没有 marker，也补发当前周期；首周期仅补 marker，避免把购买时已发的一次再发一遍。
      const activationPeriod = periodKeyOf(user.planActivatedAt, user.planActivatedAt ?? at);
      const amount = crossedPeriod || pk !== activationPeriod ? user.plan!.creditsPerMonth : 0;
      if (amount > 0) await grantCredits(user.tenantId, userId, amount, `${user.plan!.name} · 月度权益恢复`, tx);
      const source = await tx.planEntitlement.findFirst({
        where: { userId, planId: user.plan!.id, status: 'active', startsAt: { lte: at }, OR: [{ expiresAt: null }, { expiresAt: { gt: at } }] },
        orderBy: { startsAt: 'desc' }, select: { sourceOrderId: true },
      });
      await tx.monthlyCreditGrant.create({
        data: { tenantId: user.tenantId, userId, periodKey: pk, planId: user.plan!.id, sourceOrderId: source?.sourceOrderId, amount },
      });
    });
  };

  // 跨子周期：复用快照（不回读 live plan）；过期则归 0。
  if (w.periodKey !== pk) {
    const resetResult = await prisma.$transaction(async (tx) => {
      await lockQuota(tx, userId);
      const fresh = await tx.tokenWallet.findUniqueOrThrow({ where: { userId } });
      // 另一个并发请求可能已完成跨期重置并开始预扣；此时绝不能再把余额刷回满额。
      if (fresh.periodKey === pk) return { wallet: fresh, crossed: false };
      const q = expired ? 0 : fresh.quota;
      // 增购包不随月度重置清零：先按刷写前的行派生 pack 剩余，再把它叠回新余额并落成新存量。
      const pr = packRemainingOf(fresh);
      const reset = await tx.tokenWallet.update({
        where: { userId },
        data: { quota: q, balance: balanceWithPack(q, pr), packBalance: pr, periodKey: pk },
      });
      return { wallet: reset, crossed: true };
    });
    await ensureMonthlyCredits(resetResult.crossed);
    return { quota: resetResult.wallet.quota, balance: resetResult.wallet.balance, packBalance: resetResult.wallet.packBalance };
  }
  await ensureMonthlyCredits(false);
  // 同子周期内刚过期：月度额度立即冻结到 0，但**增购包保值**（买来的算力永久有效，不因套餐到期蒸发）。
  // 因此过期用户的 balance 可能仍 >0——这不是漏洞：AI 入口有 assertPlanActive 403 挡着，
  // pack 只是被冻结保值，续费后（setQuota 同样保 pack）即可继续消耗。
  if (expired && (w.quota !== 0 || w.balance !== packRemainingOf(w) || w.packBalance !== packRemainingOf(w))) {
    const z = await prisma.$transaction(async (tx) => {
      await lockQuota(tx, userId);
      const fresh = await tx.tokenWallet.findUniqueOrThrow({ where: { userId } });
      const pr = packRemainingOf(fresh);
      if (fresh.quota === 0 && fresh.balance === pr && fresh.packBalance === pr) return fresh;
      return tx.tokenWallet.update({ where: { userId }, data: { quota: 0, balance: pr, packBalance: pr } });
    });
    return { quota: z.quota, balance: z.balance, packBalance: z.packBalance };
  }
  return { quota: w.quota, balance: w.balance, packBalance: w.packBalance };
}

/** 当前额度状态（供 /me 展示进度条）。 */
export async function getQuotaState(userId: string): Promise<QuotaState> {
  const w = await loadWallet(userId);
  if (!w) return emptyState;
  return toState(w.quota, w.balance, w.packBalance);
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
  if (isUnlimited(w.quota)) return toState(w.quota, w.balance, w.packBalance);
  const cost = Math.ceil(Math.max(0, realTokens) * (ratio > 0 ? ratio : 1));
  if (cost <= 0) return toState(w.quota, w.balance, w.packBalance);
  const updated = await prisma.tokenWallet.update({
    where: { userId },
    data: { balance: { decrement: cost } },
    select: { quota: true, balance: true, packBalance: true },
  });
  return toState(updated.quota, updated.balance, updated.packBalance);
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
 * P0-2：产出前在锁内**预扣**悲观估算额度（默认 RESERVE_TOKENS；用户可见生成传动态加权上界），返回结算句柄。
 * - 余额≤0 → 抛 402（与旧 ensureQuota 语义一致，仍允许「最后一次透支」：余额>0 即可预留一份）。
 * - 并发：advisory lock 串行化「读余额 + 扣预留」；上界大于余额时只占满余额到 0，预留本身不制造负数。
 * - settle：按真实 token 计算实际成本，delta = 预留 − 实际，>0 退回、<0 追扣（幂等：settle/refund 二选一只生效一次）。
 */
// 复盘保底（M2 PR-6）：留存动作不因额度耗尽中断——余额≤0 时，复盘类调用每日最多放行 N 次
// （照常预留/结算，余额可为负=透支记账，进入后台消耗明细）。仅额度层面的保底；
// 套餐到期的只读锁定仍由 assertPlanActive 把守，不受影响。
// D-10：复盘保底每日次数默认值（覆盖「日复盘 + 军令生成 + 2-3 次追问」的正常动线）。
// 运营可在「功能开关」面通过 FeatureFlag(id='review-grace').payload.perDay 覆盖，改动即时生效
// （普通 flag 60s 内存缓存，非合规硬需求，取舍见 featureFlag.ts）；未配置则回退此默认值。
export const REVIEW_GRACE_PER_DAY = 6;
// 保底类别 → 每日次数上限。复盘(留存)可配置(默认 6)；速诊(获客，WO-06)每日 1 次(静态)。各类别独立配额，互不挤占。
export type GraceKind = 'review' | 'quickscan';
const STATIC_GRACE_PER_DAY: Record<GraceKind, number> = { review: REVIEW_GRACE_PER_DAY, quickscan: 1 };

/** review 保底每日次数（读 FeatureFlag 'review-grace'.payload.perDay，缺省/非法回退默认 6）。 */
async function reviewGracePerDay(): Promise<number> {
  const payload = (await featureFlagPayload('review-grace')) as { perDay?: unknown } | null;
  const v = payload && typeof payload.perDay === 'number' ? payload.perDay : REVIEW_GRACE_PER_DAY;
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : REVIEW_GRACE_PER_DAY;
}

/** 某保底类别的当日次数上限（review 可配置；其余静态）。 */
async function gracePerDay(kind: GraceKind): Promise<number> {
  return kind === 'review' ? reviewGracePerDay() : STATIC_GRACE_PER_DAY[kind];
}

async function graceUsedToday(userId: string, kind: GraceKind): Promise<number> {
  // 按 payload.kind 过滤 → 各类别独立计当日已用次数（既有 review 记录 payload.kind='review'，向后兼容）。
  // 当日下界按 Asia/Shanghai 派生（P1-4）。
  return prisma.auditLog.count({
    where: { userId, action: 'system.quota.grace', createdAt: { gte: dayStart() }, payloadJson: { path: ['kind'], equals: kind } },
  });
}

/**
 * GenerationJob 的持久预留前置准备。钱包的首建/跨期/过期回收仍复用 loadWallet，
 * 真正的「读余额→扣预留」由 reserveDurableQuotaInTransaction 在建 job 的事务内完成。
 */
export interface DurableQuotaPreparation {
  unlimited: boolean;
  allowNegative: boolean;
}

export async function prepareDurableQuota(
  userId: string,
  grace?: GraceKind,
): Promise<DurableQuotaPreparation> {
  const wallet = await loadWallet(userId);
  if (!wallet) throw new InsufficientQuotaError('当前套餐无月度 token 额度，请升级套餐');
  if (isUnlimited(wallet.quota)) return { unlimited: true, allowNegative: false };
  const allowNegative = grace
    ? (await graceUsedToday(userId, grace)) < (await gracePerDay(grace))
    : false;
  return { unlimited: false, allowNegative };
}

export interface DurableQuotaReservation {
  periodKey: string | null;
  reserved: number;
  unlimited: boolean;
  graceGranted: boolean;
}

/** 在 GenerationJob 创建事务中执行的持久 Token 预留。 */
export async function reserveDurableQuotaInTransaction(
  tx: Prisma.TransactionClient,
  userId: string,
  ratio: number,
  reserveTokens: number,
  prepared: DurableQuotaPreparation,
): Promise<DurableQuotaReservation> {
  await lockQuota(tx, userId);
  const row = await tx.tokenWallet.findUnique({
    where: { userId },
    select: { quota: true, balance: true, periodKey: true },
  });
  if (!row) throw new InsufficientQuotaError('当前套餐无月度 token 额度，请升级套餐');
  if (prepared.unlimited || isUnlimited(row.quota)) {
    return { periodKey: row.periodKey, reserved: 0, unlimited: true, graceGranted: false };
  }

  const target = Math.ceil(Math.max(0, reserveTokens) * (ratio > 0 ? ratio : 1));
  let reserved: number;
  let graceGranted = false;
  if (row.balance <= 0) {
    if (!prepared.allowNegative) throw new InsufficientQuotaError();
    graceGranted = true;
    reserved = Math.min(target, RESERVE_TOKENS);
  } else {
    reserved = Math.min(target, row.balance);
  }
  if (reserved > 0) {
    await tx.tokenWallet.update({ where: { userId }, data: { balance: { decrement: reserved } } });
  }
  return { periodKey: row.periodKey, reserved, unlimited: false, graceGranted };
}

/**
 * GenerationJob 终态事务内的唯一钱包调整。charged 已包含 billing ratio。
 * 跨周期时只保留 job/TokenUsage 事实，不把旧周期预留差额返进新周期。
 */
export async function settleDurableQuotaInTransaction(
  tx: Prisma.TransactionClient,
  args: { userId: string; periodKey: string | null; reserved: number; charged: number; unlimited?: boolean },
): Promise<QuotaState> {
  await lockQuota(tx, args.userId);
  const row = await tx.tokenWallet.findUnique({
    where: { userId: args.userId },
    select: { quota: true, balance: true, packBalance: true, periodKey: true },
  });
  if (!row) return emptyState;
  if (args.unlimited || isUnlimited(row.quota)) return toState(row.quota, row.balance, row.packBalance);
  if (args.periodKey !== row.periodKey) return toState(row.quota, row.balance, row.packBalance);
  const delta = Math.max(0, args.reserved) - Math.max(0, args.charged);
  const updated = delta === 0
    ? row
    : await tx.tokenWallet.update({
      where: { userId: args.userId },
      data: { balance: { increment: delta } },
      select: { quota: true, balance: true, packBalance: true, periodKey: true },
    });
  return toState(updated.quota, updated.balance, updated.packBalance);
}

export async function reserveQuota(
  userId: string,
  ratio = 1,
  opts?: { grace?: GraceKind; reserveTokens?: number },
): Promise<QuotaReservation> {
  const w = await loadWallet(userId); // 锁外先确保账户存在 + 惰性月度重置（upsert 不宜进事务）
  if (!w) throw new InsufficientQuotaError('当前套餐无月度 token 额度，请升级套餐');
  if (isUnlimited(w.quota)) {
    const st = toState(w.quota, w.balance, w.packBalance);
    return { unlimited: true, settle: async () => st, refund: async () => {} };
  }
  const targetReserved = Math.ceil(Math.max(0, opts?.reserveTokens ?? RESERVE_TOKENS) * (ratio > 0 ? ratio : 1));
  let reserved = targetReserved;
  // 保底资格在锁外预查（并发极端下最多多放行一次，可接受；额度本身仍有界透支）
  const allowNegative = opts?.grace ? (await graceUsedToday(userId, opts.grace)) < (await gracePerDay(opts.grace)) : false;
  let graceGranted = false;
  await prisma.$transaction(async (tx) => {
    await lockQuota(tx, userId);
    const row = await tx.tokenWallet.findUnique({ where: { userId }, select: { balance: true } });
    const balance = row?.balance ?? 0;
    if (balance <= 0) {
      if (!allowNegative) throw new InsufficientQuotaError();
      graceGranted = true; // 复盘保底：额度耗尽仍放行（透支记账）
      // 保底本来就允许余额≤0 时再放行；此时不能把 20 万级生成上界整笔预扣成巨额负数。
      // 只占基础 2k，完成后仍由 settle 按真实加权用量追扣，最终账不打折。
      reserved = Math.min(targetReserved, RESERVE_TOKENS);
    } else {
      // 悲观上界可能大于当前余额：只占满现有余额，让其它并发看到 0 后被拦；
      // 不能在真实调用发生前仅靠预留就把账户打成巨额负数。
      reserved = Math.min(targetReserved, balance);
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
          select: { quota: true, balance: true, packBalance: true },
        });
        return toState(updated.quota, updated.balance, updated.packBalance);
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
 * 套餐购买/升级/续费：覆盖式授予当月额度（balance=月度额度+增购包剩余，重置周期键）。quota<0=不限量。
 * activatedAt = 套餐激活锚点（购买/升级=now、续费=保留原锚点），用于对齐 periodKey 子周期；
 * 不传（如测试/历史调用）→ null → 按自然月键，行为同旧版。
 * 增购包：硬覆盖前先在锁内派生 packRemaining 再叠回，避免续费/升级把买来的算力包抹掉（首建时为 0，行为同旧版）。
 * db 不传时自行包一层事务（锁 + 读现行 + 写必须原子）；调用方已有事务则复用其 tx。
 */
export async function setQuota(
  tenantId: string,
  userId: string,
  quota: number,
  activatedAt: Date | null = null,
  db?: Prisma.TransactionClient,
): Promise<void> {
  const pk = periodKeyOf(activatedAt, now());
  const apply = async (tx: Prisma.TransactionClient): Promise<void> => {
    await lockQuota(tx, userId);
    const cur = await tx.tokenWallet.findUnique({
      where: { userId },
      select: { quota: true, balance: true, packBalance: true },
    });
    const pr = cur ? packRemainingOf(cur) : 0;
    const balance = balanceWithPack(quota, pr);
    await tx.tokenWallet.upsert({
      where: { userId },
      update: { quota, balance, packBalance: pr, periodKey: pk, tenantId },
      create: { tenantId, userId, quota, balance, packBalance: pr, periodKey: pk },
    });
  };
  if (db) await apply(db);
  else await prisma.$transaction(apply);
}

/**
 * 增购算力包到账（SKU kind='quota'，永久有效直到用完）。由 applySkuGrant 在支付幂等事务内调用。
 * balance 与 packBalance 同增；钱包不存在时**照抄 loadWallet 的首建口径**（未过期取 plan.tokenQuotaPerMonth、
 * 过期/无套餐取 0，periodKey 按套餐锚点派生），绝不能建出 quota=0 的行抢掉有套餐用户的首建快照。
 */
export async function grantQuotaPack(
  tx: Prisma.TransactionClient,
  user: { id: string; tenantId: string },
  amount: number,
): Promise<void> {
  const add = Math.floor(Math.max(0, Number(amount) || 0));
  if (add <= 0) return;
  await lockQuota(tx, user.id);
  const cur = await tx.tokenWallet.findUnique({
    where: { userId: user.id },
    select: { quota: true, balance: true, packBalance: true },
  });
  if (cur) {
    await tx.tokenWallet.update({
      where: { userId: user.id },
      data: {
        // 不限量套餐的 balance 是负哨兵，不能被 +amount 破坏；pack 存量照记，降档/到期时按存量叠回。
        ...(isUnlimited(cur.quota) ? {} : { balance: { increment: add } }),
        packBalance: { increment: add },
      },
    });
    return;
  }
  const u = await tx.user.findUnique({
    where: { id: user.id },
    select: { planActivatedAt: true, planExpiresAt: true, plan: { select: { tokenQuotaPerMonth: true } } },
  });
  const at = now();
  const initial = u && !isExpired(u.planExpiresAt, at) ? (u.plan?.tokenQuotaPerMonth ?? 0) : 0;
  await tx.tokenWallet.create({
    data: {
      tenantId: user.tenantId,
      userId: user.id,
      quota: initial,
      balance: balanceWithPack(initial, add),
      packBalance: add,
      periodKey: periodKeyOf(u?.planActivatedAt ?? null, at),
    },
  });
}

/**
 * 增购算力包回收（退款）。只追回「尚未消耗」的部分：take = min(amount, packRemaining)。
 * 无钱包 → no-op。返回实际追回量（供审计/测试断言）。
 */
export async function revokeQuotaPack(
  tx: Prisma.TransactionClient,
  userId: string,
  amount: number,
): Promise<number> {
  const want = Math.floor(Math.max(0, Number(amount) || 0));
  if (want <= 0) return 0;
  await lockQuota(tx, userId);
  const cur = await tx.tokenWallet.findUnique({
    where: { userId },
    select: { quota: true, balance: true, packBalance: true },
  });
  if (!cur) return 0;
  const pr = packRemainingOf(cur);
  const take = Math.min(want, pr);
  await tx.tokenWallet.update({
    where: { userId },
    data: {
      // 不限量套餐的 balance 是负哨兵（pack 也从未被消耗），只需扣存量。
      ...(isUnlimited(cur.quota) || take === 0 ? {} : { balance: { decrement: take } }),
      packBalance: pr - take,
    },
  });
  return take;
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
  active: boolean; // 套餐是否有效（已开通且未过期）
  expired: boolean; // 已开通但已过期（→ 前端只读模式，引导续费）
  none: boolean; // 从未开通（→ 前端引导开通；与 expired 互斥）
  expiresAt: string | null; // 绝对到期时间（ISO）；null=不到期或未开通
  daysRemaining: number | null; // 剩余天数（向上取整）；null=不到期
  nextResetAt: string; // 下次月度额度重置时刻（ISO）
}

/** 套餐状态（供 /me 展示到期日 / 剩余天数 / 下次额度重置日 + 驱动前端只读态）。 */
export async function getPlanStatus(userId: string): Promise<PlanStatus> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { planId: true, planActivatedAt: true, planExpiresAt: true } });
  const at = now();
  const expiresAt = u?.planExpiresAt ?? null;
  const expired = isExpired(expiresAt, at);
  // 未开通与「企业版不限期」在到期字段上完全同形（expiresAt=null、expired=false），
  // 必须单独出 none，否则前端无从区分，只能等写操作吃 403 PLAN_REQUIRED。
  const none = !u?.planId;
  return {
    active: !expired && !none,
    expired,
    none,
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
    daysRemaining: daysRemaining(expiresAt, at),
    nextResetAt: nextResetAt(u?.planActivatedAt ?? null, at).toISOString(),
  };
}
