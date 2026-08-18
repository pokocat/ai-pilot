// 邀请关系链：注册时绑定推荐人、全程留痕、读数。
//
// 本期**只记录关系，不发任何奖励**（奖励机制后定，见 §「运营配置」的预留）。
// 关系数据物化存满三级（运营侧的邀请关系树要看完整链路），但对用户的呈现与将来的激励口径
// 只看一级——多级 + 利益是微信审核最敏感的形状。
import { prisma } from '../db.js';
import type { Prisma } from '@prisma/client';
import { featureFlagPayload } from './featureFlag.js';
import { isExpired } from './planTime.js';
import type { ReferralSummary } from '../../../shared/contracts';

/** 邀请码形状：与 services/community.ts 的 Crockford base32 同源（"JS" + 4 位，去掉 I/L/O/U）。 */
export const INVITE_CODE_SHAPE = /^JS[0-9A-HJKMNP-TV-Z]{4}$/;

export function isInviteCodeShape(value: unknown): value is string {
  return typeof value === 'string' && INVITE_CODE_SHAPE.test(value);
}

/** 归因结果。除 `bound` 外都不建边，但**每种都要落一行 attribution**。 */
export type ReferralOutcome = 'bound' | 'self' | 'unknown_code' | 'expired' | 'already_bound';

/** 建边来源。前端分享通道 + 海报扫码 + 运营人工补绑。 */
export type ReferralSource = 'share_friend' | 'share_timeline' | 'poster_qr' | 'manual';

// ── 运营配置（本期只有 window 真正生效，其余是给「后定的奖励机制」预留的栏位）────────────
//
// 全部读 FeatureFlag payload（与告警阈值同一套路），**代码里不留业务数值常量**：
// 对外的定价/权益/奖励类数字归运营后台，不归代码，也不许 seed。
//
// 将来发奖时的幂等 key 形状（挂点锚，本期不实现）：
//   `referral:{referrerId}:{newUserId}:{stage}`   stage ∈ register | paid
// 发放走 credits.ts 的 appendCreditDelta（它已支持 idempotencyKey，见 refundCreditsOnce 的用法），
// 并发下用邀请人行锁串行化「同一码多个新号同时进线」的发奖判定，避免各事务都读到未达上限而超发。
const FLAG_KEY = 'referral';
const DEFAULT_WINDOW_DAYS = 30;

export interface ReferralConfig {
  /** 归因窗口天数：捕获到码距注册超过这么久就不再归因。 */
  windowDays: number;
  /** 以下四项本期不生效，仅占位，等奖励机制定了直接读。 */
  rewardInviter: unknown;
  rewardInvitee: unknown;
  rewardOnPaid: unknown;
  dailyCap: unknown;
  ladder: unknown;
}

/**
 * 读邀请相关的运营配置。
 *
 * 注意 `featureFlagPayload` 带 60s 内存缓存（与告警阈值同一套路）：运营改完窗口天数后
 * **最多 60 秒收敛**，这是有意的取舍，不是 bug。要立刻读到最新值（运营改完想当场验证、
 * 或测试里刚写完就读）传 `{ fresh: true }` 绕过缓存。
 */
export async function referralConfig(opts: { fresh?: boolean } = {}): Promise<ReferralConfig> {
  const raw = (await featureFlagPayload(FLAG_KEY, opts).catch(() => null)) as Record<string, unknown> | null;
  const days = Number(raw?.window);
  return {
    // 越界/脏值回落默认，不让一个错配把归因窗口带到沟里（沿用告警阈值配置化的处理方式）。
    windowDays: Number.isFinite(days) && days > 0 && days <= 3650 ? days : DEFAULT_WINDOW_DAYS,
    rewardInviter: raw?.rewardInviter ?? null,
    rewardInvitee: raw?.rewardInvitee ?? null,
    rewardOnPaid: raw?.rewardOnPaid ?? null,
    dailyCap: raw?.dailyCap ?? null,
    ladder: raw?.ladder ?? null,
  };
}

type Db = Prisma.TransactionClient | typeof prisma;

/** 环检测的上溯上限：现存图无环时递归必然终止，这个数只是防脏数据把请求挂死的兜底。 */
const MAX_HOPS = 10_000;

/**
 * 沿 referrerId 一路向上找，看 `candidate` 的祖先链里是否出现 `userId`。
 *
 * **必须递归**：物化路径只存三级，A→B→C→D 这条链上 D 用 A 的码注册时，
 * 只比 lv1/lv2/lv3 会漏判（A 在 D 的四级之外），于是建出环来。
 */
async function wouldFormCycle(db: Db, userId: string, candidate: string): Promise<boolean> {
  let cursor: string | null = candidate;
  for (let hop = 0; hop < MAX_HOPS && cursor; hop++) {
    if (cursor === userId) return true;
    const row: { referrerId: string } | null = await db.referral.findUnique({
      where: { userId: cursor },
      select: { referrerId: true },
    });
    cursor = row?.referrerId ?? null;
  }
  return false;
}

export interface BindArgs {
  db: Db;
  userId: string;
  tenantId: string;
  inviteCode: string;
  /** 客户端捕获该码的时刻（ms epoch）。缺失按「不过期」处理，见下方注释。 */
  inviteCodeAt?: number;
  source?: ReferralSource;
  clientIp?: string | null;
  userAgent?: string | null;
}

/**
 * 注册时绑定推荐人。返回归因结果；**任何分支都会落一条 attribution**。
 *
 * 调用约定：**只在新注册（isNew=true）时调**。已注册用户登录不追认——存量用户互相填码
 * 是最容易被薅的口子。
 *
 * 事务约定：调用方把建号事务的 tx 传进来（关系与账号同生共死），但**绑定失败绝不能拖垮注册**
 * ——所以调用方要用 catch 兜住这个函数的异常，注册永远优先。
 */
export async function bindOnRegister(args: BindArgs): Promise<ReferralOutcome> {
  const { db, userId, tenantId, inviteCode, inviteCodeAt, clientIp, userAgent } = args;
  const source: ReferralSource = args.source ?? 'share_friend';

  const trace = async (outcome: ReferralOutcome, referrerId: string | null) => {
    await db.referralAttribution.create({
      data: {
        inviteCode,
        source,
        newUserId: userId,
        referrerId,
        outcome,
        clientIp: clientIp ?? null,
        userAgent: userAgent ? userAgent.slice(0, 500) : null,
      },
    });
    return outcome;
  };

  if (!isInviteCodeShape(inviteCode)) return trace('unknown_code', null);

  // 已经绑过就不动：单推荐人公理，绑定后不可变更。
  const existing = await db.referral.findUnique({ where: { userId }, select: { referrerId: true } });
  if (existing) return trace('already_bound', existing.referrerId);

  const referrer = await db.user.findUnique({
    where: { inviteCode },
    select: { id: true, tenantId: true },
  });
  if (!referrer) return trace('unknown_code', null);
  if (referrer.id === userId) return trace('self', referrer.id);

  // 归因窗口：客户端上报捕获时刻，窗口天数归运营配置。
  // inviteCodeAt 缺失时按「不过期」处理——带码但不带时间戳只可能来自非小程序调用，
  // 拿不到时间就无法判断新鲜度，此时宁可归因（仍然如实留痕），也不要凭空判死。
  if (typeof inviteCodeAt === 'number' && Number.isFinite(inviteCodeAt) && inviteCodeAt > 0) {
    const { windowDays } = await referralConfig();
    const deadline = new Date(inviteCodeAt + windowDays * 86_400_000);
    if (isExpired(deadline, new Date())) return trace('expired', referrer.id);
  }

  if (await wouldFormCycle(db, userId, referrer.id)) {
    // 成环只可能出现在脏数据或人工补绑上，正常分享链路走不到；照样留痕便于排查。
    return trace('self', referrer.id);
  }

  // 物化路径：取邀请人自己那行的 lv1/lv2 平移下来，不递归。
  const up = await db.referral.findUnique({
    where: { userId: referrer.id },
    select: { lv1: true, lv2: true },
  });

  await db.referral.create({
    data: {
      userId,
      tenantId,
      referrerId: referrer.id,
      lv1: referrer.id,
      lv2: up?.lv1 ?? null,
      lv3: up?.lv2 ?? null,
      inviteCode,
      source,
    },
  });
  return trace('bound', referrer.id);
}

/**
 * 「我的邀请」读数。
 *
 * `directCount` / `activatedCount` 都只数**直接**下级（lv1 = 我）。已开通的口径与
 * `services/planGate.ts` 同源：有 planId 且未过期（planExpiresAt 为 null = 不到期）。
 * 刻意不自己发明第二套「算不算已开通」，否则同一个人在这里和套餐页会显示成两种状态。
 */
export async function referralSummary(userId: string, inviteCode: string): Promise<ReferralSummary> {
  const now = new Date();
  const [directs, mine] = await Promise.all([
    prisma.referral.findMany({ where: { lv1: userId }, select: { userId: true } }),
    prisma.referral.findUnique({ where: { userId }, select: { boundAt: true, referrerId: true } }),
  ]);
  const directIds = directs.map((r) => r.userId);
  const directCount = directIds.length;
  // 直邀名单先取出来再数「已开通」：现阶段一个人的直邀量级很小，`in` 足够；
  // 将来若出现单人几千直邀，这里换成一条 join 的 raw SQL，别把 `in` 列表撑大。
  const activatedCount = directCount === 0 ? 0 : await prisma.user.count({
    where: {
      id: { in: directIds },
      planId: { not: null },
      OR: [{ planExpiresAt: null }, { planExpiresAt: { gt: now } }],
    },
  });

  let referrerName: string | null = null;
  if (mine?.referrerId) {
    const up = await prisma.user.findUnique({ where: { id: mine.referrerId }, select: { name: true } });
    referrerName = up?.name?.trim() ? up.name.trim() : null;
  }

  return {
    inviteCode,
    directCount,
    activatedCount,
    boundAt: mine ? mine.boundAt.toISOString() : null,
    referrerName,
  };
}
