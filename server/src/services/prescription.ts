// WO-12 处方引擎：军师在方案里开出的「问题→打法→工具」三元组 + 转化状态机。
// 处方由服务端确定性写入（认可方案时从 deliverable.prescriptions 落库）；toolKey 只能取自服务端白名单，表外一律丢弃。
import { prisma } from '../db.js';
import type { Prisma } from '@prisma/client';
import { now } from './clock.js';
import type { PrescriptionView, AdminPrescriptionFunnelRow } from '../../../shared/contracts';

/**
 * 可开方白名单构成（D-3-7）：启用的 Agent.key（内部智能体）∪ 启用的 EcoTool.id（外部小程序跳转位）。
 * LLM 只能从中点菜；表外 toolKey 落库时丢弃。ecoKeys 用于落库时归属 toolType。
 */
export async function toolClassification(): Promise<{ agentKeys: Set<string>; ecoKeys: Set<string>; whitelist: Set<string> }> {
  const [agents, ecos] = await Promise.all([
    prisma.agent.findMany({ where: { enabled: true }, select: { key: true } }),
    prisma.ecoTool.findMany({ where: { enabled: true }, select: { id: true } }),
  ]);
  const agentKeys = new Set(agents.map((r) => r.key));
  const ecoKeys = new Set(ecos.map((r) => r.id));
  return { agentKeys, ecoKeys, whitelist: new Set([...agentKeys, ...ecoKeys]) };
}

/** 可开方工具白名单（enabled agents ∪ enabled EcoTool）。表外 toolKey 丢弃。 */
export async function toolWhitelist(): Promise<Set<string>> {
  return (await toolClassification()).whitelist;
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
  const { ecoKeys, whitelist } = await toolClassification();
  const valid = list.filter((p) => whitelist.has(p.toolKey));
  let saved = 0;
  const seen = new Set<string>();
  for (const p of valid) {
    if (seen.has(p.toolKey)) continue;
    seen.add(p.toolKey);
    const dup = await prisma.prescription.findFirst({ where: { userId: args.userId, casefileId: args.casefileId, toolKey: p.toolKey, status: { not: 'dismissed' } } });
    if (dup) continue;
    // D-3-7：按 key 归属定 toolType——命中启用 EcoTool → external（前端 navigateToMiniProgram），否则内部 agent。
    const toolType = ecoKeys.has(p.toolKey) ? 'external' : 'agent';
    await prisma.prescription.create({ data: {
      tenantId: args.tenantId, userId: args.userId, casefileId: args.casefileId, deliverableId: args.deliverableId ?? null,
      problem: p.problem, playbook: p.playbook, toolKey: p.toolKey, toolType,
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
  // D-3-7：external 处方的跳转目标（appId/path）实时从 EcoTool 解析（运营改配即时生效，不吃落库快照）。
  const extKeys = [...new Set(rows.filter((r) => r.toolType === 'external').map((r) => r.toolKey))];
  const ecoMap = new Map<string, { appId: string; path: string }>();
  if (extKeys.length) {
    const ecos = await prisma.ecoTool.findMany({ where: { id: { in: extKeys } }, select: { id: true, appId: true, path: true } });
    for (const e of ecos) ecoMap.set(e.id, { appId: e.appId, path: e.path });
  }
  return rows.map((r) => {
    const eco = r.toolType === 'external' ? ecoMap.get(r.toolKey) : undefined;
    return {
      id: r.id, problem: r.problem, playbook: r.playbook, toolKey: r.toolKey,
      toolType: r.toolType, externalUrl: r.externalUrl, status: r.status, proposedAt: r.proposedAt.toISOString(),
      appId: eco?.appId ?? null, path: eco?.path ?? null,
    };
  });
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

// —— D-1 / WO-12：多来源漏斗报表（按 toolKey 分组的六态时间戳聚合；开通侧计数在 activation.ts） ——
/** 处方六态漏斗（proposed→seen→clicked→activated→used→verified，另计 dismissed），按 toolKey 分组，窗口 = proposedAt 近 N 天。 */
export async function prescriptionFunnel(days: number): Promise<AdminPrescriptionFunnelRow[]> {
  const cutoff = new Date(now().getTime() - Math.max(1, days) * 86400_000);
  const rows = await prisma.prescription.findMany({
    where: { proposedAt: { gte: cutoff } },
    select: { toolKey: true, toolType: true, status: true, seenAt: true, clickedAt: true, activatedAt: true, firstUsedAt: true, dismissedAt: true },
  });
  const map = new Map<string, AdminPrescriptionFunnelRow>();
  for (const r of rows) {
    let f = map.get(r.toolKey);
    if (!f) { f = { toolKey: r.toolKey, toolType: r.toolType, proposed: 0, seen: 0, clicked: 0, activated: 0, used: 0, verified: 0, dismissed: 0 }; map.set(r.toolKey, f); }
    f.proposed++;
    if (r.seenAt) f.seen++;
    if (r.clickedAt) f.clicked++;
    if (r.activatedAt) f.activated++;
    if (r.firstUsedAt) f.used++;
    if (r.status === 'verified') f.verified++;
    if (r.dismissedAt) f.dismissed++;
  }
  return [...map.values()].sort((a, b) => b.proposed - a.proposed);
}

// —— WO-14：处方追踪闭环 ——
export const FOLLOWUP_AFTER_DAYS = 7;

/**
 * scheduler 扫描：status=activated 且 activatedAt 满 7 天且未打标 → 行级打 followupAt（每处方一次，靠 followupAt=null 幂等）。
 * 返回本轮新打标数量。
 */
export async function scanPrescriptionFollowups(): Promise<number> {
  const cutoff = new Date(now().getTime() - FOLLOWUP_AFTER_DAYS * 86400_000);
  const r = await prisma.prescription.updateMany({
    where: { status: 'activated', activatedAt: { lte: cutoff }, followupAt: null },
    data: { followupAt: now() },
  });
  return r.count;
}

/** toolKey → 展示名（内部 agent 取 Agent.name，外部取 EcoTool.name，缺失回落 key）。 */
async function resolveToolNames(keys: string[]): Promise<Map<string, string>> {
  const uniq = [...new Set(keys)];
  const out = new Map<string, string>();
  if (!uniq.length) return out;
  const [agents, ecos] = await Promise.all([
    prisma.agent.findMany({ where: { key: { in: uniq } }, select: { key: true, name: true } }),
    prisma.ecoTool.findMany({ where: { id: { in: uniq } }, select: { id: true, name: true } }),
  ]);
  for (const a of agents) out.set(a.key, a.name);
  for (const e of ecos) out.set(e.id, e.name); // EcoTool 优先覆盖（external 归属）
  for (const k of uniq) if (!out.has(k)) out.set(k, k);
  return out;
}

/** 已打标待追踪的处方工具名（followupAt 已打标、仍停在 activated 未回填 outcome）。供周复盘 modeLine 点名要效果。 */
export async function pendingFollowupTools(userId: string): Promise<string[]> {
  const rows = await prisma.prescription.findMany({
    where: { userId, status: 'activated', followupAt: { not: null } },
    select: { toolKey: true }, take: 5,
  });
  if (!rows.length) return [];
  const names = await resolveToolNames(rows.map((r) => r.toolKey));
  return [...new Set(rows.map((r) => names.get(r.toolKey) ?? r.toolKey))];
}

/**
 * WO-14 月战报注入块【处方效果】：有 outcome 的处方 → 累计发帖/线索/GMV，并对照 CasefileMetric 同期聚合算线索占比。
 * 无 outcome → 返回 null（不注入）。所有数字服务端算好，块尾禁 LLM 自算口径。
 */
export async function prescriptionEffectBlock(userId: string): Promise<string | null> {
  const rxs = await prisma.prescription.findMany({
    where: { userId, status: { in: ['used', 'verified'] } },
    select: { outcomeJson: true },
  });
  let count = 0, posts = 0, leads = 0, gmv = 0;
  for (const r of rxs) {
    const entries = (Array.isArray(r.outcomeJson) ? r.outcomeJson : []) as unknown as OutcomeEntry[];
    if (!entries.length) continue;
    count++;
    for (const e of entries) { posts += nonNeg(e.metrics?.posts); leads += nonNeg(e.metrics?.leads); gmv += nonNeg(e.metrics?.gmv); }
  }
  if (!count) return null; // 无 outcome 不注入
  // CasefileMetric 同期聚合：该用户全部案卷线索总量（作为占比分母；宁缺勿假，无则不算占比）。
  const cfs = await prisma.casefile.findMany({ where: { userId }, select: { id: true } });
  const agg = cfs.length
    ? await prisma.casefileMetric.aggregate({ where: { casefileId: { in: cfs.map((c) => c.id) } }, _sum: { leads: true } })
    : null;
  const totalLeads = agg?._sum.leads ?? 0;
  const share = totalLeads > 0 ? Math.round((leads / totalLeads) * 100) : null;
  const lines = [
    '【处方效果（系统统计，引用时以此为准，禁止自行推算指标或占比）】',
    `已见效处方：${count} 条 · 累计发帖 ${posts} · 线索 ${leads} · GMV ${gmv} 元`,
  ];
  if (share !== null) lines.push(`处方带来的线索占同期经营线索约 ${share}%（对照数据回填汇总）`);
  lines.push('以上为系统聚合口径，报告中直接引用即可，不要另算比率或重新累加。');
  return lines.join('\n');
}

/**
 * WO-12 遗留【可开方工具表】：方案生成时注入 enabled agents + EcoTool 的 key/名称/desc + 开方指令。
 * 与落库白名单过滤是双保险（都保留）。无可开方工具 → null 不注入。
 */
export async function toolMenu(): Promise<string | null> {
  const [agents, ecos] = await Promise.all([
    prisma.agent.findMany({ where: { enabled: true }, select: { key: true, name: true, role: true }, orderBy: { sort: 'asc' } }),
    prisma.ecoTool.findMany({ where: { enabled: true }, select: { id: true, name: true, desc: true }, orderBy: { sort: 'asc' } }),
  ]);
  const lines: string[] = [];
  for (const a of agents) lines.push(`- ${a.key}（${a.name}）：${a.role}`);
  for (const e of ecos) lines.push(`- ${e.id}（${e.name}）：${e.desc}`);
  if (!lines.length) return null;
  return `【可开方工具表（开方只能从本表选 toolKey）】\n${lines.join('\n')}\n开方规则：只准从上表挑 toolKey，最多 3 条；没有贴合客户当前问题的工具就不开方（宁缺勿滥）。`;
}
