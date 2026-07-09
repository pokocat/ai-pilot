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

const STAMP = { seen: 'seenAt', clicked: 'clickedAt', activated: 'activatedAt' } as const;
export const RX_ACTIONS = Object.keys(STAMP);

/** 转化埋点：seen/clicked/activated（只按 userId 授权；幂等）。返回是否命中一条。 */
export async function advancePrescription(userId: string, id: string, action: string): Promise<boolean> {
  const stamp = (STAMP as Record<string, 'seenAt' | 'clickedAt' | 'activatedAt'>)[action];
  if (!stamp) return false;
  const r = await prisma.prescription.updateMany({ where: { id, userId }, data: { status: action, [stamp]: now() } });
  return r.count > 0;
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
  const status = positivePeriods >= 2 ? 'verified' : 'used';
  await prisma.prescription.update({
    where: { id },
    data: { outcomeJson: all as unknown as Prisma.InputJsonValue, status, firstUsedAt: rx.firstUsedAt ?? now() },
  });
  return true;
}
