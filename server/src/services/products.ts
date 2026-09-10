/**
 * 产品归属码。
 *
 * 这一套取值与统一账号中心 aibuzz-id 的 `product_code` **同一个命名空间**
 * （见该仓 `deploy/env/id-server-clients.yml.example`：一个 OAuth 客户端只属于一个
 * product_code，混用会让 product_link 记到别人账上）。这里复用它，是为了「令牌来自哪个产品」
 * 和「这笔钱花在哪个产品」用的是同一把尺子，对账时不必再做一层映射。
 *
 * 为什么钱包不按产品拆：
 *   · 拆了之后用户在军师充的钻石在爱速拍花不了，反过来也一样，得逼他充两次；
 *   · 每加一个跨产品功能（军师调爱速拍出片）就要设计一次转账协议；
 *   · AIStar 的 ipstudio 就是拆开的反例 —— 它自己有一套钱包，军师已经扣过钻石之后
 *     它还会在内网账本上再扣一次，这条链因此接不进来。
 * 所以：**一个账号一个钱包，归属记在流水行上**。「独立运营」独立的是定价、SKU、
 * 充值入口和账本切片，不是钱包。
 */
export const PRODUCT = {
  /** 军师本体：报告、智能体、海报、能力模块、套餐。 */
  junshi: 'junshi',
  /** 爱速拍：出片、分段生成、数字人克隆、素材扩容。 */
  quickreel: 'quickreel',
} as const;

export type ProductCode = (typeof PRODUCT)[keyof typeof PRODUCT];

const ALL: readonly string[] = Object.values(PRODUCT);

/** 是不是一个已知产品码。运营后台按它校验筛选参数，避免把任意字符串当成产品去查。 */
export function isProductCode(value: unknown): value is ProductCode {
  return typeof value === 'string' && ALL.includes(value);
}

/** 已知产品码全集（运营后台的下拉、分产品汇总的行序都用它）。 */
export function productCodes(): ProductCode[] {
  return ALL.slice() as ProductCode[];
}

/* ── 分产品算账 ──────────────────────────────────────────────────────────
 *
 * 同一列既记收入归属也记消耗归属，靠 delta 的正负分开：
 *   delta > 0  这笔钻石是**从哪个产品的充值入口卖出去的**（收入归属）
 *   delta < 0  这笔钻石是**花在哪个产品上的**（消耗归属）
 *
 * 「军师打通爱速拍出片」因此不需要任何跨钱包转账：同一个钱包付钱，那行流水
 * 记 quickreel，收入仍算在当初卖出这批钻石的那个产品头上。两笔各归各的，账是通的。
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';

export interface ProductLedgerSlice {
  productCode: string;
  /** 卖出（delta>0 之和）。 */
  granted: number;
  /** 消耗（delta<0 之和的绝对值）。 */
  spent: number;
  /** 流水条数，用来判断这个产品有没有在动。 */
  entries: number;
}

/**
 * 按产品切一段时间的账。
 *
 * 归属为空的历史流水单独归到 `unattributed` 一行，**不摊进任何产品** ——
 * 摊了就等于编造归属，而这一列上线之前的流水确实无从追认。
 *
 * 用 Prisma 的分组聚合而不是原生 SQL：`credit_ledger.createdAt` 是
 * `timestamp without time zone`，原生 SQL 里拿 JS Date 去比会按会话时区做一次隐式转换，
 * 时区一偏窗口就整体错位，查出来是空的（实测踩过）。走 Prisma 由它统一映射，
 * 这一类问题从根上没有。
 */
export async function productLedgerSlices(
  from: Date,
  to?: Date,
): Promise<ProductLedgerSlice[]> {
  // `to` 不传 = 没有上界，也就是「从 from 到此刻」。
  //
  // 不要用 `lt: new Date()` 兜底：createdAt 是数据库用 CURRENT_TIMESTAMP 写的，
  // 应用进程的时钟只要比库慢一点点，刚落的那几笔就落在上界之外，报表看起来像少了钱。
  // 没有上界就没有这个偏差，也少一处需要解释的行为。
  const createdAt = to ? { gte: from, lt: to } : { gte: from };
  const window = { createdAt };
  // 三次聚合必须在**同一个快照**里。各查各的时，营业时间里随时可能有新流水落在两次查询之间：
  // 先跑 counts 的话，新产品有金额却没有行，整行丢失；先跑金额聚合的话，返回 entries>0
  // 而 granted/spent 少钱。刷新一下又对了 —— 是最难查的那种间歇性对不上账。
  //
  // **只开事务不够，必须指定 RepeatableRead。** PostgreSQL 默认的 Read Committed
  // 是「每条语句各取一次快照」，同一个事务里的三条语句照样会看见不同的数据，
  // 包起来只是看着安全。RepeatableRead 才是在事务的第一条语句取一次快照、后续复用。
  // 用交互式事务而不是数组式：数组式在 groupBy 的可选 where 字段上类型对不齐。
  const { positive, negative, counts } = await prisma.$transaction(async (tx) => ({
    positive: await tx.creditLedger.groupBy({
      by: ['productCode'], where: { ...window, delta: { gt: 0 } }, _sum: { delta: true },
    }),
    negative: await tx.creditLedger.groupBy({
      by: ['productCode'], where: { ...window, delta: { lt: 0 } }, _sum: { delta: true },
    }),
    counts: await tx.creditLedger.groupBy({
      by: ['productCode'], where: window, _count: { _all: true },
    }),
  }), { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  const key = (code: string | null) => code ?? 'unattributed';
  const granted = new Map(positive.map((r) => [key(r.productCode), r._sum.delta ?? 0]));
  const spent = new Map(negative.map((r) => [key(r.productCode), Math.abs(r._sum.delta ?? 0)]));
  return counts
    .map((r) => ({
      productCode: key(r.productCode),
      granted: granted.get(key(r.productCode)) ?? 0,
      spent: spent.get(key(r.productCode)) ?? 0,
      entries: r._count._all,
    }))
    .sort((a, b) => a.productCode.localeCompare(b.productCode));
}
