// WO-12 处方引擎：军师在方案里开出的「问题→打法→工具」三元组 + 转化状态机。
// 处方由服务端确定性写入（认可方案时从 deliverable.prescriptions 落库）；toolKey 只能取自服务端白名单，表外一律丢弃。
import { prisma } from '../db.js';
import type { Prisma } from '@prisma/client';
import { now } from './clock.js';
import type { PrescriptionView } from '../../../shared/contracts';

/** 可开方工具白名单：启用的生态能力 key（Agent.key）。LLM 只能从中点菜；表外 toolKey 丢弃。 */
export async function toolWhitelist(): Promise<Set<string>> {
  const rows = await prisma.agent.findMany({ where: { enabled: true }, select: { key: true } });
  return new Set(rows.map((r) => r.key));
}

interface RawRx { problem?: unknown; playbook?: unknown; toolKey?: unknown }
function normalize(list: unknown): { problem: string; playbook: string; toolKey: string }[] {
  if (!Array.isArray(list)) return [];
  return (list as RawRx[])
    .filter((p) => typeof p?.problem === 'string' && typeof p?.playbook === 'string' && typeof p?.toolKey === 'string')
    .map((p) => ({ problem: (p.problem as string).trim().slice(0, 300), playbook: (p.playbook as string).trim().slice(0, 300), toolKey: (p.toolKey as string).trim() }))
    .filter((p) => p.problem && p.playbook && p.toolKey)
    .slice(0, 3); // 最多 3 条
}

/** 认可方案时落处方：白名单过滤 + 去重（同案卷同工具留一条）+ 挂案卷。返回落库/丢弃计数。 */
export async function persistPrescriptions(args: {
  tenantId: string; userId: string; casefileId: string | null; deliverableId?: string | null; prescriptions?: unknown;
}): Promise<{ saved: number; dropped: number }> {
  const list = normalize(args.prescriptions);
  if (!list.length) return { saved: 0, dropped: 0 };
  const wl = await toolWhitelist();
  const valid = list.filter((p) => wl.has(p.toolKey));
  let saved = 0;
  const seen = new Set<string>();
  for (const p of valid) {
    if (seen.has(p.toolKey)) continue;
    seen.add(p.toolKey);
    const dup = await prisma.prescription.findFirst({ where: { userId: args.userId, casefileId: args.casefileId, toolKey: p.toolKey, status: { not: 'dismissed' } } });
    if (dup) continue;
    await prisma.prescription.create({ data: {
      tenantId: args.tenantId, userId: args.userId, casefileId: args.casefileId, deliverableId: args.deliverableId ?? null,
      problem: p.problem, playbook: p.playbook, toolKey: p.toolKey,
    } });
    saved++;
  }
  return { saved, dropped: list.length - saved };
}

// P0-4 状态机单调化：转化状态是「等级序」，只能前进不能回退，杜绝重复上报的 seen 把已 verified 的处方打回。
//   proposed(0) < seen(1) < clicked(2) < activated(3) < used(4) < verified(5)
//   dismissed = 独立终态（用户主动作废），只能从 proposed/seen 进入；一旦作废不被任何埋点回退。
const LEVEL: Record<string, number> = { proposed: 0, seen: 1, clicked: 2, activated: 3, used: 4, verified: 5 };
const STAMP = { seen: 'seenAt', clicked: 'clickedAt', activated: 'activatedAt', dismissed: 'dismissedAt' } as const;
export const RX_ACTIONS = Object.keys(STAMP);

// 目标状态允许的前置状态集合：严格低于目标等级者（dismissed 及更高终态天然不在内 → 不可回退）。
function belowStatuses(target: number): string[] {
  return Object.keys(LEVEL).filter((s) => LEVEL[s] < target);
}

/**
 * 转化埋点 / 作废：单调推进（只前进不回退；幂等）。
 * - seen/clicked/activated：仅当「当前等级 < 目标等级」时写入（updateMany + status in 允许前置集合，单语句避免读改竞态）。
 * - dismissed：独立终态，只能从 proposed/seen 进入（更靠后的状态不允许作废）。
 * 返回 true=处方存在（已推进或已是同/更高级的幂等 no-op，均不回退）；false=处方不存在（路由 404）。
 */
export async function advancePrescription(userId: string, id: string, action: string): Promise<boolean> {
  const stamp = (STAMP as Record<string, 'seenAt' | 'clickedAt' | 'activatedAt' | 'dismissedAt'>)[action];
  if (!stamp) return false;
  const allowed = action === 'dismissed' ? ['proposed', 'seen'] : belowStatuses(LEVEL[action]);
  const r = await prisma.prescription.updateMany({
    where: { id, userId, status: { in: allowed } },
    data: { status: action, [stamp]: now() },
  });
  if (r.count > 0) return true;
  // 未推进：可能是「已达/超过目标等级」的幂等 no-op（不回退、不 404），也可能是处方不存在（→ 404）。
  const exists = await prisma.prescription.findFirst({ where: { id, userId }, select: { id: true } });
  return !!exists;
}

export async function listPrescriptions(userId: string): Promise<PrescriptionView[]> {
  const rows = await prisma.prescription.findMany({ where: { userId, status: { not: 'dismissed' } }, orderBy: { proposedAt: 'desc' }, take: 50 });
  return rows.map((r) => ({
    id: r.id, problem: r.problem, playbook: r.playbook, toolKey: r.toolKey,
    toolType: r.toolType, externalUrl: r.externalUrl, status: r.status, proposedAt: r.proposedAt.toISOString(),
  }));
}

// —— WO-14 成果回流：处方开通后回填效果 → 复盘可引用（used→verified 闭环） ——
export interface OutcomeInput { period?: string; metrics?: { posts?: number; leads?: number; gmv?: number }; note?: string }
interface OutcomeEntry { period: string; metrics: { posts: number; leads: number; gmv: number }; note: string }
const nonNeg = (v: unknown): number => (typeof v === 'number' && v >= 0 && Number.isFinite(v) ? v : 0);
const hasPositive = (m: OutcomeEntry['metrics']): boolean => m.posts > 0 || m.leads > 0 || m.gmv > 0;

/** 回填一期效果：追加到 outcomeJson；首次 outcome → used；连续 ≥2 期有正指标 → verified。返回是否命中。 */
export async function recordOutcome(userId: string, id: string, input: OutcomeInput): Promise<boolean> {
  const rx = await prisma.prescription.findFirst({ where: { id, userId, status: { not: 'dismissed' } } });
  if (!rx) return false;
  const prev = (Array.isArray(rx.outcomeJson) ? rx.outcomeJson : []) as unknown as OutcomeEntry[];
  const m = input.metrics ?? {};
  const entry: OutcomeEntry = {
    period: (input.period || 'week').slice(0, 16),
    metrics: { posts: nonNeg(m.posts), leads: nonNeg(m.leads), gmv: nonNeg(m.gmv) },
    note: (input.note ?? '').trim().slice(0, 300),
  };
  const all = [...prev, entry];
  const positivePeriods = all.filter((e) => hasPositive(e.metrics)).length;
  const computed = positivePeriods >= 2 ? 'verified' : 'used';
  // P0-4 单调化：outcome 永远追加，但 status 不回退——只在计算值高于当前等级时前进
  //（例：已 verified 的处方补一期无正指标的 outcome，不应被打回 used）。
  const status = (LEVEL[computed] ?? 0) > (LEVEL[rx.status] ?? 0) ? computed : rx.status;
  await prisma.prescription.update({
    where: { id },
    data: { outcomeJson: all as unknown as Prisma.InputJsonValue, status, firstUsedAt: rx.firstUsedAt ?? now() },
  });
  return true;
}
