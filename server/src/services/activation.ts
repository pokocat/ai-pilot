// D-1 开通来源归因：解锁 agent / 购买 SKU 成功时落一条 ActivationEvent（source 由前端请求体带入）。
// 与 UserAgent.source（gift|purchase|admin_grant，语义=如何获得）正交——此表记「从哪个位子来的」，供多来源漏斗报表。
import { prisma } from '../db.js';
import type { Prisma } from '@prisma/client';

// 归因来源枚举：prescription=处方位（军令语境开方）| catalog=货架/商城 | market=生态市场。缺省 catalog。
export const ACTIVATION_SOURCES = ['prescription', 'catalog', 'market'] as const;
export type ActivationSource = (typeof ACTIVATION_SOURCES)[number];

/** 解析 source + refId（refId 仅在 source=prescription 时有意义，其余丢弃）。 */
export function parseAttribution(rawSource: unknown, rawRefId: unknown): { source: ActivationSource; refId: string | null } {
  const source = typeof rawSource === 'string' && (ACTIVATION_SOURCES as readonly string[]).includes(rawSource)
    ? (rawSource as ActivationSource)
    : 'catalog';
  const refId = source === 'prescription' && typeof rawRefId === 'string' && rawRefId.trim()
    ? rawRefId.trim().slice(0, 64)
    : null;
  return { source, refId };
}

/** D-1 漏斗开通侧：ActivationEvent 按 source 分组计数（窗口 = createdAt 近 N 天）。 */
export async function activationSourceCounts(days: number): Promise<{ source: string; count: number }[]> {
  const cutoff = new Date(Date.now() - Math.max(1, days) * 86400_000);
  const grouped = await prisma.activationEvent.groupBy({
    by: ['source'],
    where: { createdAt: { gte: cutoff } },
    _count: { _all: true },
  });
  return grouped
    .map((g) => ({ source: g.source, count: g._count._all }))
    .sort((a, b) => b.count - a.count);
}

/** 落一条开通事件（fire-safe：绝不阻断购买主链路）。可传事务客户端与购买同事务。 */
export async function recordActivation(
  args: { tenantId: string; userId: string; itemType: 'agent' | 'sku' | 'plan'; itemKey: string; source: ActivationSource; refId?: string | null },
  db?: Prisma.TransactionClient,
): Promise<void> {
  const client = db ?? prisma;
  await client.activationEvent.create({
    data: {
      tenantId: args.tenantId, userId: args.userId,
      itemType: args.itemType, itemKey: args.itemKey,
      source: args.source, refId: args.refId ?? null,
    },
  });
}
