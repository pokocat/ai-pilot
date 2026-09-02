// 代理分销佣金：计提 / 冻结 / 冲销 / 追回的唯一收口（2026-09-02，规划见
// docs/[FABLE5]ADMIN_GROWTH_DISTRIBUTION_PLAN_2026-09-02.md §3.1）。
//
// ── 这套机制是什么、不是什么 ────────────────────────────────────────────────
// 代理 = **运营在后台登记的签约渠道合作方（B2B）**。佣金在服务端按已支付订单计提，
// 由运营在后台生成结算单、**线下打款后回填凭证号**。小程序端本期零暴露（没有「我的佣金 /
// 提现」），不触碰「小程序内现金裂变返利」这条微信审核红线。普通用户的邀请激励是另一套
// （AGENTS §13 ①，后定），两者互不混用——别把这里的比例配置当成用户侧奖励。
//
// **佣金只发给代理，不发给普通邀请人**：一笔订单沿买家 `Referral.lv1/lv2/lv3` 上溯，
// 只有当某一级祖先是 `status='active'` 的代理、且其等级在该层级有 `rateBp>0` 的启用规则时
// 才计提。三级是上限（与物化路径同深，不是另定的规则）。
//
// ── 代码里没有任何默认比例 ──────────────────────────────────────────────────
// 「对外数据归运营」：等级目录（DistributorTier）与比例（DistributionRule）**不 seed、
// 不写默认值**。空规则集 = 不计提，这是正确行为而不是待补的 TODO。唯一在代码里的数字是
// 冻结期兜底（DISTRIBUTION_HOLD_DEF），且它在运营后台「功能开关」页可改、`holdConfigured`
// 会如实告诉运营「你还没配过，现在用的是兜底值」。
//
// ── 为什么走 outbox 而不是在支付事务里直接算 ─────────────────────────────────
// 与 services/activation.ts 的 invite 归因**同一套路、同一理由**（那份长注释是本文件的前传）：
// Postgres 里事务内任一语句失败即整个事务 aborted，`.catch(() => {})` 救不回来。把「查 Referral
// + 查代理 + 查规则 + 写流水」塞进 `markPaidAndApply` 的事务，等于让「查规则时抖一下」回滚
// 已经算成功的真金入账。所以支付/退款事务内只 upsert 一行 CommissionOutbox（与权益同事务提交，
// 意图不会因进程退出而丢），提交后派发异步处理一次，失败由 scheduler 的
// `pay-reconcile-sweep` 续扫。**绝不 await、绝不往支付响应上抛错。**
import type { Prisma as PrismaTypes } from '@prisma/client';
import { prisma } from '../db.js';
import { now } from './clock.js';
import { featureFlagPayload, isFeatureEnabled } from './featureFlag.js';

/* ── 功能开关：两个 id，一个管开合、一个管冻结期 ─────────────────────────────
   常量由 routes/admin.ts 的 FEATURE_FLAG_CATALOG 引用（同 REFERRAL_RISK_* 的做法），
   保证「功能开关页能改的区间」与「计提时判定用的区间」是同一份，不会各写一遍后漂移。 */
/** 总开关。**默认关**：分销是商务决策，不该因为代码上线就自动开始计提。 */
export const DISTRIBUTION_FLAG = 'distribution';
/** 冻结期（退款观察窗）开关 id。 */
export const DISTRIBUTION_HOLD_FLAG = 'distribution-hold';
export const DISTRIBUTION_HOLD_KEY = 'days';
/** 兜底冻结期：7 天。微信支付的常见退款争议都发生在下单一周内，先冻一周再放可结算。 */
export const DISTRIBUTION_HOLD_DEF = 7;
/** 0 = 不冻结（立刻可结算）。运营真要这么配也允许，但得是他显式配的。 */
export const DISTRIBUTION_HOLD_MIN = 0;
export const DISTRIBUTION_HOLD_MAX = 90;

const DAY_MS = 86_400_000;
/** 万分比分母。`amount = floor(baseAmount × rateBp / 10000)`。 */
const BP_DENOM = 10_000;
/** 计提/冲销可及的最大层级 = Referral 物化路径深度。 */
export const MAX_COMMISSION_LEVEL = 3;

export type CommissionOutboxKind = 'paid' | 'refunded';

/**
 * 总开关。`fresh: true` 绕过 60s 缓存：运营在后台刚拨开开关，下一笔支付就该开始计提；
 * 反过来更要紧——**拨关必须立刻停止计提**（这是资金动作，不能容忍一分钟的缓存窗口）。
 * 默认值 false：库里没这行 = 没开过 = 不计提。
 */
export async function distributionEnabled(): Promise<boolean> {
  return isFeatureEnabled(DISTRIBUTION_FLAG, false, { fresh: true });
}

/**
 * 冻结期天数。区间外/未配 → 回兜底值并 `configured:false`，后台据此显示「这不是运营核定的值」。
 * **读失败照抛**：宁可让后台显示「加载失败」，也不要拿兜底值算出一份看着正常的账。
 */
export async function distributionHoldDays(): Promise<{ days: number; configured: boolean }> {
  const raw = (await featureFlagPayload(DISTRIBUTION_HOLD_FLAG, { fresh: true })) as Record<string, unknown> | null;
  const n = Number(raw?.[DISTRIBUTION_HOLD_KEY]);
  const ok = Number.isFinite(n) && n >= DISTRIBUTION_HOLD_MIN && n <= DISTRIBUTION_HOLD_MAX;
  return { days: ok ? Math.floor(n) : DISTRIBUTION_HOLD_DEF, configured: ok };
}

/** 后台 `GET /admin/distribution/config` 的取数（形状即契约 AdminDistributionConfig）。 */
export async function distributionConfig(): Promise<{
  enabled: boolean; holdDays: number; holdConfigured: boolean;
  flagKeys: { enabled: string; hold: string };
}> {
  const [enabled, hold] = await Promise.all([distributionEnabled(), distributionHoldDays()]);
  return {
    enabled,
    holdDays: hold.days,
    holdConfigured: hold.configured,
    flagKeys: { enabled: DISTRIBUTION_FLAG, hold: DISTRIBUTION_HOLD_FLAG },
  };
}

/* ── outbox ──────────────────────────────────────────────────────────────── */

/**
 * 与权益/退款终态**同事务**落一行意图。幂等：主键 (outTradeNo, kind)。
 *
 * 已完成行（completedAt 有值）**不会被重置**：重复回调、历史订单补建都只是碰一下 updatedAt，
 * 不会让同一件事再处理一遍（真正的幂等仍靠 CommissionEntry 的唯一键，这里只是不制造无效工作）。
 */
export async function enqueueCommission(
  db: PrismaTypes.TransactionClient,
  outTradeNo: string,
  kind: CommissionOutboxKind,
): Promise<void> {
  await db.commissionOutbox.upsert({
    where: { outTradeNo_kind: { outTradeNo, kind } },
    create: { outTradeNo, kind },
    update: {},
  });
}

/* ── 事务提交后的即时派发（生产不 await；测试用两个句柄等它落地）─────────────
   形状照 services/wechatPay.ts 的 dispatchInviteActivation：尾链每次 `.then(() => undefined)`
   收掉结果，避免把历次结果一路串起来常驻内存。 */
let commissionTail: Promise<unknown> = Promise.resolve();
let commissionInflight = 0;

/**
 * 派发一次处理。**同步返回、绝不抛错**——调用方（支付/退款收口）此刻真钱已经动了，
 * 佣金算不出来是后续可重试的账务问题，不许反过来影响支付响应。
 */
export function dispatchCommission(outTradeNo: string, kind: CommissionOutboxKind): void {
  commissionInflight += 1;
  const started = processCommissionOutbox(outTradeNo, kind)
    .catch((err: unknown) => {
      console.warn(`[commission] outbox 处理异常 outTradeNo=${outTradeNo} kind=${kind}: ${(err as Error)?.message}`);
    })
    .finally(() => { commissionInflight -= 1; });
  commissionTail = Promise.all([commissionTail, started]).then(() => undefined);
}

/** 测试用：等已派发的佣金处理全部落地。生产路径**不得**调用（那就等于把 await 加回来了）。 */
export function settleCommissions(): Promise<unknown> {
  return commissionTail;
}

/** 测试用：还在飞的佣金处理条数（用来把「支付响应没有 await 佣金」钉成断言）。 */
export function pendingCommissions(): number {
  return commissionInflight;
}

export type CommissionOutboxResult =
  | 'accrued' | 'reversed' | 'disabled' | 'no_referrer' | 'no_distributor'
  | 'order_not_found' | 'order_refunded' | 'failed';

/** 处理需要的订单最小信息（accrue/reverse 都只读这些列）。 */
export interface CommissionOrder {
  id: string;
  outTradeNo: string;
  tenantId: string;
  userId: string;
  planId: string;
  skuKey: string | null;
  amount: number;
  status: string;
  paidAt: Date | null;
  refundedAt: Date | null;
}

const ORDER_SELECT = {
  id: true, outTradeNo: true, tenantId: true, userId: true,
  planId: true, skuKey: true, amount: true, status: true, paidAt: true, refundedAt: true,
} as const;

/** 商品维度：SKU 单认 skuKey、套餐单认 planId（schema 上二选一），与入账/归因路径同源。 */
function itemOf(order: CommissionOrder): { itemType: 'plan' | 'sku'; itemKey: string } {
  return order.skuKey
    ? { itemType: 'sku', itemKey: order.skuKey }
    : { itemType: 'plan', itemKey: order.planId };
}

/**
 * 抢占并处理一条 outbox。抢占租约 60 秒：并发的 scheduler / 回调派发只有一方执行；
 * 进程中途退出后由 nextAttemptAt 自动重试。语义与 processInviteActivationOutbox 逐条对齐。
 */
export async function processCommissionOutbox(
  outTradeNo: string,
  kind: CommissionOutboxKind,
): Promise<CommissionOutboxResult | 'not_due'> {
  const at = now();
  const claimed = await prisma.commissionOutbox.updateMany({
    where: { outTradeNo, kind, completedAt: null, nextAttemptAt: { lte: at } },
    data: { attempts: { increment: 1 }, nextAttemptAt: new Date(at.getTime() + 60_000) },
  });
  if (claimed.count !== 1) return 'not_due';
  const row = await prisma.commissionOutbox.findUnique({ where: { outTradeNo_kind: { outTradeNo, kind } } });
  if (!row || row.completedAt) return 'not_due';

  let result: CommissionOutboxResult;
  try {
    const order = await prisma.paymentOrder.findUnique({ where: { outTradeNo }, select: ORDER_SELECT });
    result = !order ? 'order_not_found'
      : kind === 'paid' ? await accrueForOrder(order)
        : await reverseForOrder(order);
  } catch (err) {
    console.warn(`[commission] ${kind} 处理失败 outTradeNo=${outTradeNo}: ${(err as Error).message}`);
    result = 'failed';
  }

  if (result !== 'failed') {
    // 账号注销/测试清理可能与事务外 worker 同时发生：行已被清掉时视为无需再写，
    // 不要让一个已完成的任务制造未处理异常（与 activation.ts 同一处理）。
    await prisma.commissionOutbox.updateMany({
      where: { outTradeNo, kind, completedAt: null },
      data: { completedAt: now(), lastError: null },
    });
  } else {
    const delay = Math.min(6 * 3600_000, 30_000 * 2 ** Math.min(row.attempts, 8));
    await prisma.commissionOutbox.updateMany({
      where: { outTradeNo, kind, completedAt: null },
      data: { lastError: `commission_${kind}_failed`, nextAttemptAt: new Date(now().getTime() + delay) },
    });
  }
  return result;
}

/** scheduler 扫描入口（并入 `pay-reconcile-sweep`）；单轮有界，失败行由 nextAttemptAt 退避。 */
export async function scanCommissionOutbox(limit = 100): Promise<{ scanned: number; completed: number }> {
  const rows = await prisma.commissionOutbox.findMany({
    where: { completedAt: null, nextAttemptAt: { lte: now() } },
    select: { outTradeNo: true, kind: true },
    orderBy: { nextAttemptAt: 'asc' },
    take: Math.max(1, Math.min(500, limit)),
  });
  let completed = 0;
  for (const row of rows) {
    const result = await processCommissionOutbox(row.outTradeNo, row.kind as CommissionOutboxKind);
    if (result !== 'failed' && result !== 'not_due') completed += 1;
  }
  return { scanned: rows.length, completed };
}

/* ── 计提 ────────────────────────────────────────────────────────────────── */

interface RuleRow { id: string; level: number; itemType: string; rateBp: number; enabled: boolean }
interface TierRow { id: string; name: string; enabled: boolean; rules: RuleRow[] }

/**
 * 选中该层级该商品类型适用的规则：**精确 itemType 优先于 'all'**。
 * `enabled=false` 与 `rateBp<=0` 都视为「没配」——运营把某层比例留 0 就是「这一层不计提」，
 * 不需要改代码（决策 §8 ①：合规上若只许一级，把 2/3 级留 0 即可）。
 */
function pickRule(tier: TierRow, level: number, itemType: 'plan' | 'sku'): RuleRow | null {
  const usable = tier.rules.filter((r) => r.level === level && r.enabled && r.rateBp > 0);
  return usable.find((r) => r.itemType === itemType) ?? usable.find((r) => r.itemType === 'all') ?? null;
}

/**
 * 一笔已支付订单的计提。**幂等**：靠 CommissionEntry 的
 * `(outTradeNo, beneficiaryUserId, level, kind)` 唯一键 + `skipDuplicates`，重复处理不会重复计提。
 *
 * ## 四条判定口径（都写在这里，别在别处再写一遍）
 *
 * ① **开关关 → 不计提，且不追溯**。outbox 行照常置完成：等运营哪天拨开开关，历史订单的 outbox
 *    已经是完成态，不会被扫回来补算。这是刻意的——追溯计提意味着一次开关操作就凭空产生一笔
 *    对外负债，金额还没人核过。功能开关的 desc 里写明了这一条。
 * ② **已退款订单不计提**。退款的 outbox 与支付的 outbox 是两行，正常顺序是先 paid 后 refunded；
 *    但 paid 那行若失败退避过、重试时订单已退款，这里必须自己短路，否则会先凭空计一笔再冲销掉。
 * ③ **suspended 代理不计提（不是延后计提）**。suspended 的语义是「这段时间的成交不算他的」——
 *    若改成延后，运营解除暂停时就会突然冒出一批本该没有的佣金。terminated 同理。
 * ④ **非代理祖先直接跳过**，不占层级也不顺延：lv1 不是代理时，lv2 拿的仍是「二级」比例，
 *    不会升格成一级。层级是关系链上的位置，不是「第几个拿到钱的人」。
 */
export async function accrueForOrder(order: CommissionOrder): Promise<CommissionOutboxResult> {
  if (!(await distributionEnabled())) return 'disabled';
  if (order.refundedAt || order.status === 'refunded') return 'order_refunded';

  const referral = await prisma.referral.findUnique({
    where: { userId: order.userId },
    select: { lv1: true, lv2: true, lv3: true },
  });
  if (!referral) return 'no_referrer';

  // 层级 → 祖先 userId。买家自己不会出现在自己的上溯链上（无环公理），不需要另做自邀防护。
  const ancestors: { level: number; userId: string }[] = [];
  if (referral.lv1) ancestors.push({ level: 1, userId: referral.lv1 });
  if (referral.lv2) ancestors.push({ level: 2, userId: referral.lv2 });
  if (referral.lv3) ancestors.push({ level: 3, userId: referral.lv3 });
  if (ancestors.length === 0) return 'no_referrer';

  // 一次查完三级的代理档案 + 等级 + 规则（最多 3 行，不存在 N+1）。
  const distributors = await prisma.distributor.findMany({
    where: { userId: { in: ancestors.map((a) => a.userId) }, status: 'active' },
    select: {
      id: true, userId: true,
      tier: { select: { id: true, name: true, enabled: true, rules: { select: { id: true, level: true, itemType: true, rateBp: true, enabled: true } } } },
    },
  });
  const byUser = new Map(distributors.map((d) => [d.userId, d]));

  const { itemType, itemKey } = itemOf(order);
  const hold = await distributionHoldDays();
  // 冻结期从**支付时刻**起算而不是从处理时刻：outbox 退避重试过的单不该因此多冻几天。
  const paidAt = order.paidAt ?? now();
  const holdUntil = new Date(paidAt.getTime() + hold.days * DAY_MS);

  const data: PrismaTypes.CommissionEntryCreateManyInput[] = [];
  for (const a of ancestors) {
    const d = byUser.get(a.userId);
    if (!d) continue;                       // 口径 ④：这一级不是生效中的代理
    const tier = d.tier;
    // 没挂等级 = 没有任何比例可依（等级目录是运营的，代码不替他挑一个）；
    // 等级被停用同样按「没配」处理——停用一个等级就是运营让这批代理暂时不计提的入口。
    if (!tier || !tier.enabled) continue;
    const rule = pickRule(tier, a.level, itemType);
    if (!rule) continue;
    const amount = Math.floor((order.amount * rule.rateBp) / BP_DENOM);
    // 比例大于 0 但订单太小、向下取整成 0 分：不落 0 元流水（那是噪音，也会让结算单条数虚高）。
    if (amount <= 0) continue;
    data.push({
      tenantId: order.tenantId,
      outTradeNo: order.outTradeNo,
      orderId: order.id,
      buyerUserId: order.userId,
      beneficiaryUserId: a.userId,
      distributorId: d.id,
      level: a.level,
      itemType,
      itemKey,
      baseAmount: order.amount,
      rateBp: rule.rateBp,
      amount,
      kind: 'accrual',
      status: 'pending',
      holdUntil,
      // 规则快照：运营明天改比例，今天这行的账面不许跟着漂。
      ruleSnapshotJson: { tierId: tier.id, tierName: tier.name, ruleId: rule.id, rateBp: rule.rateBp, holdDays: hold.days },
    });
  }
  if (data.length === 0) return 'no_distributor';
  await prisma.commissionEntry.createMany({ data, skipDuplicates: true });
  return 'accrued';
}

/* ── 退款：冲销 or 追回 ──────────────────────────────────────────────────── */

/**
 * 一笔订单退款后的账务处理。分两种，取决于那笔佣金**是否已经付出去了**：
 *
 * · `pending | confirmed`（钱还没打） → 直接 `reversed`（记 reversedAt）。若它已被挂进一张
 *   尚未打款的结算单（draft / approved），同时解绑 `settlementId` 并**重算那张单的
 *   entryCount / totalAmount**——否则运营会拿着一张金额已经不成立的单去付款。
 * · `settled`（钱已经打了） → **绝不去改那行**，另落一条 `kind='clawback'`、`amount=-原额`、
 *   `status='confirmed'`、`holdUntil=now` 的行，进下一张结算单做净额抵扣。账面必须同时留下
 *   「当初结了多少」和「后来追回多少」两笔，改写历史等于把已打款的事实抹掉。
 *
 * 幂等：clawback 行受 `(outTradeNo, beneficiaryUserId, level, 'clawback')` 唯一键保护；
 * 已 reversed 的行不在 where 里，重复处理是空操作。
 */
export async function reverseForOrder(order: CommissionOrder): Promise<CommissionOutboxResult> {
  const rows = await prisma.commissionEntry.findMany({
    where: { outTradeNo: order.outTradeNo, kind: 'accrual' },
  });
  if (rows.length === 0) return 'no_distributor';

  const at = now();
  const touchedSettlements = new Set<string>();
  await prisma.$transaction(async (tx) => {
    for (const row of rows) {
      if (row.status === 'pending' || row.status === 'confirmed') {
        if (row.settlementId) {
          const st = await tx.commissionSettlement.findUnique({
            where: { id: row.settlementId }, select: { id: true, status: true },
          });
          // 已打款（paid）的单不该出现 pending/confirmed 的成员行；万一出现，也不去动那张单，
          // 只把这行冲销掉并留给对账——绝不静默改写一张已付款的凭证。
          if (st && (st.status === 'draft' || st.status === 'approved')) touchedSettlements.add(st.id);
        }
        await tx.commissionEntry.updateMany({
          where: { id: row.id, status: row.status },
          data: { status: 'reversed', reversedAt: at, settlementId: null },
        });
      } else if (row.status === 'settled') {
        await tx.commissionEntry.createMany({
          data: [{
            tenantId: row.tenantId,
            outTradeNo: row.outTradeNo,
            orderId: row.orderId,
            buyerUserId: row.buyerUserId,
            beneficiaryUserId: row.beneficiaryUserId,
            distributorId: row.distributorId,
            level: row.level,
            itemType: row.itemType,
            itemKey: row.itemKey,
            baseAmount: row.baseAmount,
            rateBp: row.rateBp,
            amount: -row.amount,
            kind: 'clawback',
            status: 'confirmed',
            holdUntil: at,
            ruleSnapshotJson: row.ruleSnapshotJson ?? undefined,
          }],
          skipDuplicates: true,
        });
      }
      // reversed：已经冲销过，什么都不做（幂等）。
    }
    for (const id of touchedSettlements) await recomputeSettlement(tx, id);
  });
  return 'reversed';
}

/**
 * 按当前挂在这张单上的流水重算条数与净额。**唯一真源是流水**，不是历史写下的那个数字——
 * 退款冲销、作废解绑都会改变成员集合，任何一处忘了重算就是一张金额说不通的结算单。
 */
export async function recomputeSettlement(tx: PrismaTypes.TransactionClient, settlementId: string): Promise<void> {
  const agg = await tx.commissionEntry.aggregate({
    where: { settlementId },
    _sum: { amount: true },
    _count: { _all: true },
  });
  await tx.commissionSettlement.update({
    where: { id: settlementId },
    data: { entryCount: agg._count._all, totalAmount: agg._sum.amount ?? 0 },
  });
}

/* ── 冻结期到点 ─────────────────────────────────────────────────────────── */

/**
 * `pending` 且 `holdUntil <= now` 且**订单未退款** → `confirmed`（可结算）。
 * scheduler 的 `commission-mature`（30 min）调它。
 *
 * 为什么要再查一次订单状态：退款侧已经会把行冲销掉，理论上到不了这里。但这个 job 是
 * 「钱能不能被结算出去」的最后一道门，多一次 O(候选行) 的订单核对换掉「退款 outbox 卡住时
 * 佣金照常成熟并进结算单」这个资损面，值得。用 Prisma where 判定，不下原生 SQL——
 * 时间边界一旦进原生 SQL 就要过 utcTimestamp（见 memory「Prisma raw SQL Date 参数时区偏移」），
 * 这里没必要给自己找那个坑。
 */
export async function confirmMatured(limit = 500): Promise<number> {
  const at = now();
  const candidates = await prisma.commissionEntry.findMany({
    where: { kind: 'accrual', status: 'pending', holdUntil: { lte: at } },
    select: { id: true, outTradeNo: true },
    orderBy: { holdUntil: 'asc' },
    take: Math.max(1, Math.min(2000, limit)),
  });
  if (candidates.length === 0) return 0;
  const orders = await prisma.paymentOrder.findMany({
    where: { outTradeNo: { in: [...new Set(candidates.map((c) => c.outTradeNo))] } },
    select: { outTradeNo: true, status: true, refundedAt: true },
  });
  const refunded = new Set(orders.filter((o) => o.refundedAt || o.status === 'refunded').map((o) => o.outTradeNo));
  const ids = candidates.filter((c) => !refunded.has(c.outTradeNo)).map((c) => c.id);
  if (ids.length === 0) return 0;
  const r = await prisma.commissionEntry.updateMany({
    where: { id: { in: ids }, status: 'pending' },
    data: { status: 'confirmed' },
  });
  return r.count;
}
