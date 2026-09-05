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
import { recordAudit } from './audit.js';
import type {
  ReferralBindingOutcome, ReferralSource as ContractReferralSource, ReferralSummary,
} from '../../../shared/contracts';

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
export type ReferralOutcome = ReferralBindingOutcome;

/** 运营配置读取失败或捕获凭证暂不可用时不建边；登录侧只允许有本次注册失败留痕的账号重试。 */

/** 建边来源。前端分享通道 + 海报扫码 + 运营人工补绑。 */
export type ReferralSource = ContractReferralSource;

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
 * 当初拆开的原因：`PATCH /admin/flags/:id` 的 number 分支曾是整块 payload 覆盖写，运营在后台改
 * 「邀请归因窗口」会把同 payload 的奖励配置整片抹掉（奖励键当时全是 null，所以看不出来）。
 * 那条已于 2026-08-18 修掉——number / arms 分支改走 `mergeFeatureFlagPayload`，只覆盖自己那个键，
 * 守卫见 test/featureFlagPayload.test.ts。
 * 现在**仍分两个 id**：一个 flag 一个语义（窗口是归因规则、奖励是发放规则），运营后台各自一行、
 * 审计各自一条，比挤在一个 payload 里清楚。搬迁前的存量旧键 `referral.window` 仍按下方回退兼容。
 * （routes/adminReferral.ts 的风控阈值单独用 `referral-risk` 同理。）
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
    // 两个 flag 各读一次（分两个 id 的理由见上方 REFERRAL_WINDOW_FLAG 的注释）。
    raw = (await featureFlagPayload(REFERRAL_WINDOW_FLAG, opts)) as Record<string, unknown> | null;
    rewards = (await featureFlagPayload(REFERRAL_REWARD_FLAG, opts)) as Record<string, unknown> | null;
  } catch (err) {
    console.warn(`[referral] 运营配置读取失败，本次不建边: ${(err as Error).message}`);
    throw new ReferralConfigUnavailable((err as Error).message);
  }
  // 窗口取值顺序：新键 → **旧键回退** → 代码默认。
  //
  // 旧键回退不是多余的谨慎：窗口原本就住在 `referral` 这个 payload 里（与奖励键同住），
  // 是当初为了躲开「整块覆盖写」才搬到 `referral-window` 的。如果运营在搬迁前已经把窗口
  // 调成过 7 天，而升级后只读新键，就会静默回落 30 天——于是 20 天前捕获的码从「过期」
  // 变成建立一条**不可变更**的关系，关系与漏斗口径一起写错，事后无法修正。
  // 回退时打 warn 提示把值搬到新键（搬完这段可以删，删之前先确认线上旧键已无 window）。
  const valid = (v: unknown) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 && n <= 3650 ? n : null;
  };
  const fromNew = valid(raw?.window);
  const fromLegacy = fromNew === null ? valid((rewards as Record<string, unknown> | null)?.window) : null;
  if (fromLegacy !== null) {
    console.warn(`[referral] 归因窗口仍存在旧键 ${REFERRAL_REWARD_FLAG}.window=${fromLegacy}（新键 ${REFERRAL_WINDOW_FLAG} 未设）——本次按旧值生效，请在运营后台重新保存一次以迁移到新键`);
  }
  return {
    // 越界/脏值回落默认，不让一个错配把归因窗口带到沟里（沿用告警阈值配置化的处理方式）。
    windowDays: fromNew ?? fromLegacy ?? DEFAULT_WINDOW_DAYS,
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

/**
 * 「查环 → 建边」这段 check-then-act 的串行化闸（2026-09-02 补，原 AGENTS.md §13 的 TOCTOU 项）。
 *
 * 症状：A 用 B 的码、B 用 A 的码**同时**进线时，两侧的 `wouldFormCycle` 都可能还看不到对方
 * 那条边（各自事务里对方尚未提交），于是两条边都建成 → 一个二元环。环一旦落库，`Referral`
 * 是**不可变更**账本，物化路径与后续的上溯递归都跟着坏掉（`wouldFormCycle` 只能 fail-closed
 * 保守拒绝，运营侧那个人从此谁也绑不上）。
 *
 * 口径：**按 id 字典序排序后依次取 `pg_advisory_xact_lock`**，注册路径与运营补绑路径共用这一把。
 *   · 为什么两个 id 都要锁：环的成立条件涉及双方，只锁被邀人挡不住反向那条边；
 *   · 为什么必须排序：两侧各自按「先自己后对方」的顺序取锁就是教科书死锁
 *     （A 事务持 A 等 B、B 事务持 B 等 A）。排序后两个事务的取锁顺序一致，后到的那个排队。
 *   · advisory lock 是**事务级**的，随提交/回滚自动释放；`hashtext` 返回 int4，适配单参重载
 *     （与 wechatPay / credits / activation 同一套路，不另发明锁表）。
 *   · 传裸 `prisma`（非事务）时每条语句自成事务，锁取完立即释放 = 无保护。生产两条路径都在
 *     事务里调；测试里传裸 prisma 的用例不测并发，故不额外设防。
 */
async function lockReferralPair(db: Db, ids: string[]): Promise<void> {
  for (const id of [...new Set(ids)].sort()) {
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`referral:${id}`}))`;
  }
}

export interface BindArgs {
  db: Db;
  userId: string;
  tenantId: string;
  inviteCode: string;
  /** 服务端签名捕获凭证里的时刻（ms epoch）；绝不能直接取客户端请求体自报值。 */
  capturedAt?: number;
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
  return (await bindReferral(args)).outcome;
}

/**
 * `bindOnRegister` 的完整形态：多回一个**解析出来的码主 id**。
 *
 * 拆出来只为运营补绑（`bindManually`）能拿到 referrerId 去落审计与回显新建的边——
 * 判定逻辑（形状 / already_bound / self / 窗口 / 查环 / 建边 / 留痕）**只有这一份**，
 * 补绑路径绝不复制一遍（复制出来的第二份查环迟早与这份漂移，而它建出来的关系改不回去）。
 * `bindOnRegister` 的签名与返回保持不变，注册链路与既有测试一行不用改。
 */
export async function bindReferral(args: BindArgs): Promise<{ outcome: ReferralOutcome; referrerId: string | null }> {
  const { db, userId, tenantId, inviteCode, capturedAt, clientIp, userAgent } = args;
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
    return { outcome, referrerId };
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

  // ── 从这里开始进入临界区（原 §13 的 TOCTOU）：先按 id 有序取双方的 advisory lock ──
  // 锁点刻意放在 self 判定之后、窗口与查环之前：
  //   · 之前的三个分支（码形状 / 已绑 / 自邀）都不写关系，不需要串行化；
  //   · 之后的「查环 → 建边」是一段 check-then-act，必须在同一把锁内完成，
  //     否则两个未绑用户互邀时双方都读不到对方那条未提交的边，环就建成了。
  await lockReferralPair(db, [userId, referrer.id]);
  // 等锁期间对方可能刚提交完（同一个新号两次带码进线，或运营与注册撞在一起）：
  // 必须重读一次，否则往下走会撞主键，而主键冲突会把整个事务打成 aborted、连留痕一起丢。
  const settled = await db.referral.findUnique({ where: { userId }, select: { referrerId: true } });
  if (settled) return trace('already_bound', settled.referrerId);

  // 归因窗口：时间只能来自服务端签名捕获凭证，窗口天数归运营配置。这里再校验一次未来时间，
  // 即使调用方误把客户端字段接进来，也不能用未来时间绕过窗口。
  const at = now();
  const hasTrustedAt = typeof capturedAt === 'number' && Number.isSafeInteger(capturedAt)
    && capturedAt > 0 && capturedAt <= at.getTime() + 5 * 60_000;
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
    const deadline = new Date(capturedAt + windowDays * 86_400_000);  // eslint-disable-line
    // 用 clock.now() 而不是 new Date()：沙箱靠 x-test-now 头快进时间做离线验证，
    // 直接 new Date() 会让这条判定与 planGate / getPlanStatus 用的时钟不一致。
    if (isExpired(deadline, at)) return trace('expired', referrer.id);
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

/** 补绑目标不存在时抛出：路由据此回 404（不是 400——运营敲错 userId 与「码不存在」是两件事）。 */
export class ReferralUserNotFound extends Error {
  statusCode = 404;
  code = 'USER_NOT_FOUND';
  constructor() { super('用户不存在'); }
}

export interface ManualBindArgs {
  /** 补绑对象（必须尚无推荐人；已有则回 already_bound，不改绑） */
  userId: string;
  inviteCode: string;
  /** 操作者展示名，进审计 payload.by */
  operator: string;
  /** 运营这次请求的 IP（落 ReferralAttribution.clientIp，与注册侧同一列） */
  clientIp?: string | null;
  /** 补绑原因，进审计 */
  reason: string;
}

/**
 * 运营人工补绑（`POST /admin/invites/manual-bind`，requireSuper）。
 *
 * **关系不可变更公理不破**：这里只给「尚无推荐人」的用户建边，不提供改绑/解绑。
 * 判定完全走 `bindReferral`（同一份 self / already_bound / unknown_code / cycle 判定 +
 * 同一把有序 advisory lock），本函数只负责三件外围事：
 *   ① 解析目标用户拿 tenantId（关系行的租户跟着被邀人走，与注册侧一致）；
 *   ② `source='manual'` —— 它同时是**免归因窗口**的开关：运营补绑手上没有签名捕获凭证，
 *      `bindReferral` 里 `no_timestamp` 那道闸对 manual 放行（规划 §3.2 明写「不受归因窗口限制」）。
 *      所以这里**不传 capturedAt**，也不该传：补绑的新鲜度由运营的 reason 与审计承担，不由窗口判。
 *   ③ 落审计 `admin.invite.manual_bind`（含 outcome —— 失败的补绑尝试也必须留下操作痕迹）。
 *
 * 留痕（`ReferralAttribution`）由 `bindReferral` 在同事务内写，与注册侧同一张表同一组 outcome，
 * 所以运营在「归因日志」里看得到这条 `source='manual'` 的记录，不需要第二个日志面。
 */
export async function bindManually(args: ManualBindArgs): Promise<{ outcome: ReferralOutcome; referrerId: string | null }> {
  const user = await prisma.user.findUnique({ where: { id: args.userId }, select: { id: true, tenantId: true } });
  if (!user) throw new ReferralUserNotFound();

  let result: { outcome: ReferralOutcome; referrerId: string | null };
  try {
    result = await prisma.$transaction((tx) => bindReferral({
      db: tx,
      userId: user.id,
      tenantId: user.tenantId,
      inviteCode: args.inviteCode,
      source: 'manual',
      clientIp: args.clientIp ?? null,
      // 运营的 UA 是后台浏览器指纹，与风控看的「新号从哪台设备进线」无关，不入库。
      userAgent: null,
    }));
  } catch (err) {
    // 加锁后这条几乎不可达（锁内重读会先命中 already_bound），保留是因为 P2002 会把事务打成
    // aborted：那时留痕只能在事务外补，丢了这段运营就看不到自己刚做过什么。
    if (err instanceof ReferralAlreadyBound) {
      await traceOutsideTransaction({
        tenantId: user.tenantId, userId: user.id, inviteCode: args.inviteCode,
        source: 'manual', outcome: 'already_bound', referrerId: err.referrerId,
        clientIp: args.clientIp ?? null,
      });
      result = { outcome: 'already_bound', referrerId: err.referrerId };
    } else throw err;
  }

  await recordAudit({
    tenantId: user.tenantId,
    userId: user.id,
    action: 'admin.invite.manual_bind',
    payload: {
      userId: user.id,
      inviteCode: args.inviteCode,
      referrerId: result.referrerId,
      outcome: result.outcome,
      reason: args.reason,
      by: args.operator,
    },
  });
  return result;
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

/**
 * 注销用户时清理邀请数据，但保留仍然有效的后代直邀边。
 *
 * 例：A→B→C→D，删 A 只删除 B→A 这条直接边；B→C、C→D 仍有效。删除直接指向 A 的行后，
 * 用剩余直接边重新投影受影响行的 lv2/lv3。此前直接 delete lv2/lv3 命中的行会把整条后代链删光。
 */
/**
 * 注销到期清理：**只抹掉个人可识别字段，关系链与归因记录整体保留**（2026-08-19 决策）。
 *
 * 为什么不删关系链（原先是删的，那是错的）：
 * ① 邀请关系是**第三方的账本**——A 邀请了 B，B 注销跟 A 的邀请业绩没关系。删掉等于让 A 的
 *    直邀数、已开通数凭空缩水，还会把 A→B→C 的三级链条截断、把 C 的 lv2 变成 null。
 * ② `Referral` 表里根本没有个人可识别数据：只有内部 cuid、邀请码、时间戳。`user` 行一删，
 *    那些 cuid 就是无意义标识符，**它天然已经是去标识化的**，不需要任何处理。
 * ③ 与本仓既有口径一致：账本类（paymentOrder / tokenUsage / clientEvent / auditLog…）一律
 *    去标识保留，只有个人内容（reportHtml / profile / userAgent）才删。
 *
 * 唯一必须处理的是 `ReferralAttribution` 的 `clientIp` / `userAgent`：那是网络与设备标识符，
 * 属个人数据，隐私政策承诺「期满后删除或匿名化」。置 null 而不删行——邀请码、outcome、时间、
 * 双方 id 全部留着，归因历史完整。业务上零损失：这两个字段只服务风控视图的「同 IP 批量注册」，
 * 那是**实时**判断，30 天前的 IP 对风控已无价值。
 *
 * `InviteActivationOutbox` 同样保留：字段只有 outTradeNo / userId / itemType / itemKey，无个人数据。
 */
export async function scrubUserReferralPii(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  await tx.referralAttribution.updateMany({
    where: { OR: [{ newUserId: userId }, { referrerId: userId }] },
    data: { clientIp: null, userAgent: null },
  });
}

