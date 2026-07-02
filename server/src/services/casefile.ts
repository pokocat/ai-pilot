// 战略案卷服务（PR-EX 执行闭环落库）：认可方案 → 案卷（判断/风险锁）→ 军令 → 回填。
// 军令/风险从用户认可的真实成果分节提取（与原前端本地版同一套启发式，保证迁移前后口径一致），
// 不预置任何业务结论；对齐率/连续天数等计数一律由服务端从这些事件行算出（禁止 AI 现编）。
import { prisma } from '../db.js';
import { now } from './clock.js';

export interface DeliverableSectionInput {
  h: string;
  b?: string;
  list?: string[];
}

export interface DeliverableInput {
  title?: string;
  sections?: DeliverableSectionInput[];
}

/** 案卷对外形状 —— 与小程序端 services/dossier.ts 的 Dossier 契约一致（页面口径不变）。 */
export interface CasefileView {
  id: string;
  title: string;
  sourceAgent: string;
  createdAt: string;
  updatedAt: string;
  judgment: string;
  risks: string[];
  orders: { id: string; text: string; from: string; tag: string; date: string; done: boolean; aligned: boolean | null }[];
  backfill: Record<string, { leads: string; consults: string; deals: string; savedAt?: string }>;
}

export function todayStr(): string {
  const d = now();
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

// 从认可的成果中提取「可执行动作」：优先取标题含 行动/动作/下一步/清单/计划/建议 的分节列表，
// 兜底取任意列表分节；最多 3 条作为今日军令。
export function extractOrders(d: DeliverableInput): string[] {
  const actionHint = /行动|动作|下一步|清单|计划|建议|怎么做|7 ?天|30 ?天/;
  const sections = d.sections ?? [];
  const listSections = sections.filter((s) => s.list && s.list.length);
  const preferred = listSections.filter((s) => actionHint.test(s.h));
  const source = (preferred.length ? preferred : listSections).flatMap((s) => s.list || []);
  return source.slice(0, 3).map((t) => t.trim()).filter(Boolean);
}

// 「现在不能做」：取标题含 风险/不能/不要/避免/禁 的分节内容。
export function extractRisks(d: DeliverableInput): string[] {
  const riskHint = /风险|不能|不要|避免|禁|红线/;
  const out: string[] = [];
  (d.sections ?? []).forEach((s) => {
    if (!riskHint.test(s.h)) return;
    if (s.list?.length) out.push(...s.list);
    else if (s.b) out.push(s.b);
  });
  return out.slice(0, 3).map((t) => t.trim()).filter(Boolean);
}

// 方案首段正文作为案卷主判断。
export function firstJudgment(d: DeliverableInput): string {
  const withBody = (d.sections ?? []).find((s) => s.b);
  return (withBody?.b || d.title || '').trim();
}

/** 当前活跃案卷（每用户最多一个）。 */
export async function activeCasefile(userId: string) {
  return prisma.casefile.findFirst({ where: { userId, status: 'active' }, orderBy: { updatedAt: 'desc' } });
}

/** 案卷 → 前端视图（军令/回填只取最近 days 天，控制载荷）。 */
export async function casefileView(userId: string, days = 14): Promise<CasefileView | null> {
  const cf = await activeCasefile(userId);
  if (!cf) return null;
  const since = new Date(now().getTime() - days * 86400_000);
  const sinceStr = `${since.getFullYear()}-${`${since.getMonth() + 1}`.padStart(2, '0')}-${`${since.getDate()}`.padStart(2, '0')}`;
  const [orders, metrics] = await Promise.all([
    prisma.casefileOrder.findMany({
      where: { casefileId: cf.id, date: { gte: sinceStr } },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
    }),
    prisma.casefileMetric.findMany({ where: { casefileId: cf.id, date: { gte: sinceStr } } }),
  ]);
  const backfill: CasefileView['backfill'] = {};
  metrics.forEach((m) => {
    backfill[m.date] = { leads: String(m.leads || ''), consults: String(m.consults || ''), deals: String(m.deals || ''), savedAt: m.savedAt.toISOString() };
  });
  return {
    id: cf.id,
    title: cf.title,
    sourceAgent: cf.sourceAgent,
    createdAt: cf.createdAt.toISOString(),
    updatedAt: cf.updatedAt.toISOString(),
    judgment: cf.judgment,
    risks: (cf.risksJson as string[]) ?? [],
    orders: orders.map((o) => ({ id: o.id, text: o.text, from: o.fromAgent, tag: o.tag, date: o.date, done: o.done, aligned: o.aligned })),
    backfill,
  };
}

/** 认可方案 → 生成/更新案卷（同一案卷持续累积军令；新方案覆盖判断与风险）。 */
export async function acceptDeliverable(args: {
  tenantId: string;
  userId: string;
  deliverable: DeliverableInput;
  agentName: string;
}): Promise<{ casefileId: string; newOrders: number }> {
  const { tenantId, userId, deliverable, agentName } = args;
  const orderTexts = extractOrders(deliverable);
  const judgment = firstJudgment(deliverable);
  const risks = extractRisks(deliverable);
  const existing = await activeCasefile(userId);

  const cf = existing
    ? await prisma.casefile.update({
        where: { id: existing.id },
        data: {
          title: deliverable.title || existing.title,
          sourceAgent: agentName,
          judgment: judgment || existing.judgment,
          risksJson: risks.length ? risks : ((existing.risksJson as string[]) ?? []),
        },
      })
    : await prisma.casefile.create({
        data: {
          tenantId,
          userId,
          title: deliverable.title || '战略案卷',
          sourceAgent: agentName,
          judgment,
          risksJson: risks,
        },
      });

  if (orderTexts.length) {
    await prisma.casefileOrder.createMany({
      data: orderTexts.map((text) => ({
        tenantId,
        userId,
        casefileId: cf.id,
        date: todayStr(),
        text,
        fromAgent: agentName,
        tag: `军令 · ${agentName}`,
        // 来自「认可的方案」的军令视为对齐当前判断（方案本身即围绕主要矛盾产出）。
        // 更细的逐条 AI 标注（部分对齐/偏离）在 M2 复盘阶段接入。
        aligned: true,
      })),
    });
  }
  return { casefileId: cf.id, newOrders: orderTexts.length };
}

/** 本地案卷一次性导入（前端 storage → 服务端；服务端已有活跃案卷则跳过，保证幂等）。 */
export async function importLocalDossier(args: {
  tenantId: string;
  userId: string;
  dossier: {
    title?: string;
    sourceAgent?: string;
    judgment?: string;
    risks?: string[];
    orders?: { text?: string; from?: string; tag?: string; date?: string; done?: boolean }[];
    backfill?: Record<string, { leads?: string; consults?: string; deals?: string; savedAt?: string }>;
  };
}): Promise<{ imported: boolean; casefileId?: string }> {
  const { tenantId, userId, dossier } = args;
  const existing = await activeCasefile(userId);
  if (existing) return { imported: false, casefileId: existing.id };
  if (!dossier || typeof dossier !== 'object' || !dossier.title) return { imported: false };

  const dateOk = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  const cf = await prisma.casefile.create({
    data: {
      tenantId,
      userId,
      title: String(dossier.title).slice(0, 120),
      sourceAgent: String(dossier.sourceAgent || '军师').slice(0, 40),
      judgment: String(dossier.judgment || '').slice(0, 2000),
      risksJson: (Array.isArray(dossier.risks) ? dossier.risks : []).slice(0, 5).map((r) => String(r).slice(0, 200)),
    },
  });
  const orders = (Array.isArray(dossier.orders) ? dossier.orders : [])
    .filter((o) => o && typeof o.text === 'string' && o.text.trim() && dateOk(o.date))
    .slice(0, 60);
  if (orders.length) {
    await prisma.casefileOrder.createMany({
      data: orders.map((o) => ({
        tenantId,
        userId,
        casefileId: cf.id,
        date: o.date as string,
        text: String(o.text).trim().slice(0, 500),
        fromAgent: String(o.from || '我').slice(0, 40),
        tag: String(o.tag || '军令 · 自定').slice(0, 40),
        done: !!o.done,
      })),
    });
  }
  const backfill = dossier.backfill && typeof dossier.backfill === 'object' ? dossier.backfill : {};
  const toInt = (v: unknown) => {
    const n = parseInt(String(v ?? ''), 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };
  const entries = Object.entries(backfill).filter(([date]) => dateOk(date)).slice(0, 60);
  for (const [date, v] of entries) {
    await prisma.casefileMetric.create({
      data: { tenantId, userId, casefileId: cf.id, date, leads: toInt(v?.leads), consults: toInt(v?.consults), deals: toInt(v?.deals) },
    });
  }
  return { imported: true, casefileId: cf.id };
}
