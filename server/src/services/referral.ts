// 邀请关系链：注册时绑定推荐人、全程留痕、读数。
//
// 本期**只记录关系，不发任何奖励**（奖励机制后定，见 §「运营配置」的预留）。
// 关系数据物化存满三级（运营侧的邀请关系树要看完整链路），但对用户的呈现与将来的激励口径
// 只看一级——多级 + 利益是微信审核最敏感的形状。
import { prisma } from '../db.js';
import type { Prisma } from '@prisma/client';
import { featureFlagPayload } from './featureFlag.js';
import { isExpired } from './planTime.js';
import { now } from './clock.js';
import { INVITE_ALPHABET } from './community.js';
import type { ReferralSummary } from '../../../shared/contracts';

/**
 * 邀请码形状。**字母表直接引用生成侧的 `INVITE_ALPHABET`**（services/community.ts），
 * 不再各写一份：两处独立维护时，只改生成规则就会造出「本系统认为非法、因而永远归不了因」的合法码。
 */
export const INVITE_CODE_SHAPE = new RegExp(`^JS[${INVITE_ALPHABET}]{4}$`);

export function isInviteCodeShape(value: unknown): value is string {
  return typeof value === 'string' && INVITE_CODE_SHAPE.test(value);
}

/**
 * 归因结果。除 `bound` 外都不建边，但**每种都要落一行 attribution**。
 *
 * `cycle` 与 `self` 刻意分开：都拒绝建边，但运营看到 `self` 会以为用户在拿自己的码，
 * 而 `cycle` 说明对方在自己的下级链上（多半是脏数据或人工补绑造成），两者的排查方向完全不同。
 */
export type ReferralOutcome =
  | 'bound'
  | 'self'
  | 'cycle'
  | 'unknown_code'
  | 'expired'
  | 'already_bound'
  /**
   * 运营配置读取失败，本次**不建边**。
   *
   * 为什么不回落默认值硬绑：关系一旦建立就不可变更。配置是 7 天、而故障时按 30 天算，
   * 就会建出一条本不该存在的永久关系，事后告警也改不回来（反向同理：配置 60 天却按 30 天判过期）。
   * 「这次不绑」是可恢复的——用户再点一次分享、或运营按这条留痕人工补绑都行。
   */
  | 'config_unavailable'
  /**
   * 带了码但**没有可信的捕获时间**（客户端没带、或带了个脏值被拒），本次不建边。
   *
   * 不能像早先那样「没时间戳就按不过期处理」——那条路径会让
   * `inviteCode=合法 + inviteCodeAt="abc"` 绕过归因窗口，直接建出一条不可变更的永久关系。
   * 正常客户端一定会带（services/invite.js 的 inviteParams 有码必带时间），
   * 所以走到这里说明请求本身不可信；用户重新点一次分享即可恢复。
   * 运营人工补绑（source='manual'）不受此限。
   */
  | 'no_timestamp';

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
/**
 * 归因窗口与奖励配置**刻意分两个 flag id**。
 *
 * 原因：`PATCH /admin/flags/:id` 走 `setFeatureFlagPayload(id, { [payloadKey]: v })`，
 * 而那个函数是 `update: { payload }` —— **整块覆盖**，不是合并。
 * 两个数值挤在同一个 payload 里时，运营在后台改「邀请归因窗口」就会把奖励配置整片抹掉。
 * 今天所有奖励键都还是 null，看不出问题；等奖励机制真上线，那就是一次静默的配置丢失。
 * （同一条约束也是 routes/adminReferral.ts 的风控阈值单独用 `referral-risk` 的原因。）
 */
export const REFERRAL_WINDOW_FLAG = 'referral-window';
/** 奖励配置（本期全部占位不生效，键见 ReferralConfig）。 */
export const REFERRAL_REWARD_FLAG = 'referral';
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
/**
 * 并发下主键冲突时抛出：事务已失败，留痕必须由调用方在事务外补。
 * 带上 referrerId，让事务外那条 attribution 仍然记得是谁。
 */
export class ReferralAlreadyBound extends Error {
  constructor(public readonly referrerId: string) { super('referral already bound'); }
}

/** 读配置时抛出：调用方据此落 `config_unavailable` 并跳过本次绑定。 */
export class ReferralConfigUnavailable extends Error {}

export async function referralConfig(opts: { fresh?: boolean } = {}): Promise<ReferralConfig> {
  // **读失败不再伪装成默认值**：缺行（从未配置过）是正常态，走代码默认；
  // 但查询真的失败（DB 抖动、权限异常）时必须抛出去，由调用方把这次绑定挂起并留痕——
  // 用未知配置去算一个**不可变更**的永久关系，是不可逆的错误。
  let raw: Record<string, unknown> | null;
  let rewards: Record<string, unknown> | null;
  try {
    // 两个 flag 各读一次（见上方 REFERRAL_WINDOW_FLAG 的注释：payload 是整块覆盖写的）。
    raw = (await featureFlagPayload(REFERRAL_WINDOW_FLAG, opts)) as Record<string, unknown> | null;
    rewards = (await featureFlagPayload(REFERRAL_REWARD_FLAG, opts)) as Record<string, unknown> | null;
  } catch (err) {
    console.warn(`[referral] 运营配置读取失败，本次不建边: ${(err as Error).message}`);
    throw new ReferralConfigUnavailable((err as Error).message);
  }
  const days = Number(raw?.window);
  return {
    // 越界/脏值回落默认，不让一个错配把归因窗口带到沟里（沿用告警阈值配置化的处理方式）。
    windowDays: Number.isFinite(days) && days > 0 && days <= 3650 ? days : DEFAULT_WINDOW_DAYS,
    rewardInviter: rewards?.rewardInviter ?? null,
    rewardInvitee: rewards?.rewardInvitee ?? null,
    rewardOnPaid: rewards?.rewardOnPaid ?? null,
    dailyCap: rewards?.dailyCap ?? null,
    ladder: rewards?.ladder ?? null,
  };
}

type Db = Prisma.TransactionClient | typeof prisma;

/**
 * 环检测的上溯上限。
 *
 * 刻意取一个**小**值：这段递归跑在注册请求路径上，每跳一次就是一条 DB 查询。
 * 若真出现环（只可能来自脏数据或人工补绑），上限过大会让注册接口卡上几十秒——
 * 用户看到的是「注册失败」，比拒绝一次归因严重得多。
 * 正常邀请链不可能有 64 级（关系链对外只用一级、物化只存三级），到顶即按「疑似成环」保守拒绝。
 */
const MAX_HOPS = 64;

/**
 * 沿 referrerId 一路向上找，看 `candidate` 的祖先链里是否出现 `userId`。
 *
 * **必须递归**：物化路径只存三级，A→B→C→D 这条链上 D 用 A 的码注册时，
 * 只比 lv1/lv2/lv3 会漏判（A 在 D 的四级之外），于是建出环来。
 */
async function wouldFormCycle(db: Db, userId: string, candidate: string): Promise<boolean> {
  let cursor: string | null = candidate;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    if (cursor === userId) return true;
    if (!cursor) return false; // 走到链顶（无推荐人）= 干净，可以建边
    const row: { referrerId: string } | null = await db.referral.findUnique({
      where: { userId: cursor },
      select: { referrerId: true },
    });
    cursor = row?.referrerId ?? null;
  }
  // 跑满上限后再看一次游标：
  //   · cursor 已经是 null → 恰好在最后一跳走到了链顶，这条链是**干净**的，放行；
  //     （只写 `return true` 会把「链长正好等于上限」的合法用户误记成成环，
  //      他不但绑不上，还会在归因日志里留下一条假的 cycle 告警。）
  //   · cursor 非 null → 还没到顶就用完了预算，这条链要么异常长、要么本身有环
  //     （脏数据或人工补绑造成）→ **fail-closed 保守拒绝**，绝不放行去亲手建一个环。
  return cursor !== null;
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
 * 事务约定（注意与直觉相反）：`db` 传进来的是一个**独立于建号的**事务客户端，不是建号那个 tx。
 * 建号提交之后才另开一个只包「建边 + 留痕」的小事务，原因写在 `auth.ts` 的
 * `bindReferralAfterRegister` 上：Postgres 事务里任一语句失败即整体 aborted，
 * 把建号裹进来就做不到「绑定失败不影响注册」。调用方必须 catch 住本函数的异常，注册永远优先；
 * 并发主键冲突会抛 `ReferralAlreadyBound`，那条留痕只能由调用方在事务外补。
 */
export async function bindOnRegister(args: BindArgs): Promise<ReferralOutcome> {
  const { db, userId, tenantId, inviteCode, inviteCodeAt, clientIp, userAgent } = args;
  const source: ReferralSource = args.source ?? 'share_friend';

  const trace = async (outcome: ReferralOutcome, referrerId: string | null) => {
    await db.referralAttribution.create({
      data: {
        tenantId,
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
  const hasTrustedAt = typeof inviteCodeAt === 'number' && Number.isInteger(inviteCodeAt) && inviteCodeAt > 0;
  // 没有可信时间戳就不建边（运营人工补绑除外）：判不了新鲜度就不要建一条改不回来的关系。
  if (!hasTrustedAt && source !== 'manual') return trace('no_timestamp', referrer.id);
  if (hasTrustedAt) {
    let windowDays: number;
    try {
      ({ windowDays } = await referralConfig());
    } catch (err) {
      if (err instanceof ReferralConfigUnavailable) return trace('config_unavailable', referrer.id);
      throw err;
    }
    const deadline = new Date(inviteCodeAt + windowDays * 86_400_000);  // eslint-disable-line
    // 用 clock.now() 而不是 new Date()：沙箱靠 x-test-now 头快进时间做离线验证，
    // 直接 new Date() 会让这条判定与 planGate / getPlanStatus 用的时钟不一致。
    if (isExpired(deadline, now())) return trace('expired', referrer.id);
  }

  if (await wouldFormCycle(db, userId, referrer.id)) {
    // 成环只可能出现在脏数据或人工补绑上，正常分享链路走不到；照样留痕便于排查。
    return trace('cycle', referrer.id);
  }

  // 物化路径：取邀请人自己那行的 lv1/lv2 平移下来，不递归。
  const up = await db.referral.findUnique({
    where: { userId: referrer.id },
    select: { lv1: true, lv2: true },
  });

  try {
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
  } catch (err) {
    // 并发：同一个新号的两次带码请求同时走到这里，主键冲突（P2002）。
    // 这不是错误，是单推荐人公理生效了。
    //
    // **但绝不能在这里 trace()**：Postgres 里唯一约束一失败，整个事务就进入失败态，
    // 之后的 attribution insert 同样会失败、并把这个事务整体回滚——留痕反而丢了。
    // 所以把它包成一个可识别的异常抛出去，由调用方在**事务外**补这条 already_bound 留痕。
    // （此前这里直接 trace()，测试因为传的是裸 prisma 而不是生产用的 tx，才显得通过。）
    if ((err as { code?: string }).code === 'P2002') {
      throw new ReferralAlreadyBound(referrer.id);
    }
    throw err;
  }
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
  // 同一把时钟：沙箱 x-test-now 快进后，这里的「已开通」判定要和套餐页一致。
  const at = now();
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
      OR: [{ planExpiresAt: null }, { planExpiresAt: { gt: at } }],
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

/**
 * 在**事务外**补一条归因留痕。给两种场景用：
 *   · 并发 P2002（事务已失败，事务内写不进去）；
 *   · 绑定整体抛错后，至少让「有人带着这个码进来过」这件事留下痕迹。
 * 自身失败只记日志——留痕的兜底不该再把调用链带崩。
 */
export async function traceOutsideTransaction(args: {
  tenantId: string;
  userId: string;
  inviteCode: string;
  source: ReferralSource;
  outcome: ReferralOutcome;
  referrerId?: string | null;
  clientIp?: string | null;
  userAgent?: string | null;
}): Promise<void> {
  try {
    await prisma.referralAttribution.create({
      data: {
        tenantId: args.tenantId,
        inviteCode: args.inviteCode,
        source: args.source,
        newUserId: args.userId,
        referrerId: args.referrerId ?? null,
        outcome: args.outcome,
        clientIp: args.clientIp ?? null,
        userAgent: args.userAgent ? args.userAgent.slice(0, 500) : null,
      },
    });
  } catch (err) {
    console.error(`[referral] 事务外补留痕失败（${args.outcome}）: ${(err as Error).message}`);
  }
}
