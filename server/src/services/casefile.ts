// 战略案卷服务（PR-EX 执行闭环落库）：认可方案 → 案卷（判断/风险锁）→ 军令 → 回填。
// 军令/风险从用户认可的真实成果分节提取（与原前端本地版同一套启发式，保证迁移前后口径一致），
// 不预置任何业务结论；对齐率/连续天数等计数一律由服务端从这些事件行算出（禁止 AI 现编）。
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { now, dateKey } from './clock.js';
import { structured } from '../llm/gateway.js';
import type { OrderActionType, OrderMetric, GoalLadder } from '../../../shared/contracts';

export interface DeliverableSectionInput {
  h: string;
  b?: string;
  list?: string[];
  // 报告 V2 类型化组件字段（松散读取；phases.actions / gantt.rows 也是军令来源）
  type?: string;
  paras?: string[];
  items?: Array<{ tab?: string; when?: string; h?: string; d?: string; kpi?: string; label?: string; note?: string; actions?: string[] }>;
  rows?: Array<{ label?: string; note?: string } | Array<string | { text?: string }>>;
  quads?: Array<{ title?: string; items?: string[] }>;
}

export interface DeliverableInput {
  title?: string;
  sections?: DeliverableSectionInput[];
}

/** 案卷军令视图（V7-05：含结构化字段，缺省 null/空，前端缺省不渲染）。 */
export interface CasefileOrderView {
  id: string; text: string; from: string; tag: string; date: string; done: boolean; aligned: boolean | null;
  ownerName: string | null; dueAt: string | null; etaMinutes: number | null;
  sourceQuote: string | null; steps: string[]; metrics: OrderMetric[]; actionType: OrderActionType;
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
  goals: GoalLadder | null; // V7-10：目标阶梯
  orders: CasefileOrderView[];
  backfill: Record<string, { leads: string; consults: string; deals: string; savedAt?: string }>;
}

export function todayStr(): string {
  return dateKey(); // 上海时区日历日（P1-4）
}

function normalizeOrderText(text: string): string {
  // 行内强调标记（**==!!##）不进军令文本——报告正文富排版是渲染层的事，军令要的是干净动作句
  return text
    .replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/==([^=\n]+)==/g, '$1')
    .replace(/!!([^!\n]+)!!/g, '$1').replace(/##([^#\n]+)##/g, '$1')
    .trim().replace(/\s+/g, ' ');
}

function orderDedupeKey(date: string, text: string): string {
  return `${date}\0${normalizeOrderText(text)}`;
}

// 从认可的成果中提取「可执行动作」：优先取标题含 行动/动作/下一步/清单/计划/建议 的分节列表，
// 兜底取任意列表分节；报告 V2 类型化成果（白卡 list 缺位）再兜底 phases.actions → gantt 行；最多 3 条作为今日军令。
export function extractOrders(d: DeliverableInput): string[] {
  const actionHint = /行动|动作|下一步|清单|计划|建议|怎么做|7 ?天|30 ?天/;
  const sections = d.sections ?? [];
  const listSections = sections.filter((s) => s.list && s.list.length);
  const preferred = listSections.filter((s) => actionHint.test(s.h ?? ''));
  let source = (preferred.length ? preferred : listSections).flatMap((s) => s.list || []);
  if (!source.length) {
    source = sections.filter((s) => s.type === 'phases')
      .flatMap((s) => (s.items ?? []).flatMap((it) => it.actions ?? []));
  }
  if (!source.length) {
    source = sections.filter((s) => s.type === 'gantt')
      .flatMap((s) => (s.rows ?? []).map((r) => (Array.isArray(r) ? '' : r.label ?? '')).filter(Boolean));
  }
  const seen = new Set<string>();
  return source
    .map(normalizeOrderText)
    .filter(Boolean)
    .filter((text) => {
      if (seen.has(text)) return false;
      seen.add(text);
      return true;
    })
    .slice(0, 3);
}

// 「现在不能做」：取标题含 风险/不能/不要/避免/禁 的分节内容（含 tone=风险 的 callout）。
export function extractRisks(d: DeliverableInput): string[] {
  const riskHint = /风险|不能|不要|避免|禁|红线/;
  const out: string[] = [];
  (d.sections ?? []).forEach((s) => {
    const tone = (s as { tone?: string }).tone;
    if (!riskHint.test(s.h ?? '') && tone !== '风险') return;
    if (s.list?.length) out.push(...s.list);
    else if (s.b) out.push(s.b);
  });
  return out.slice(0, 3).map((t) => normalizeOrderText(t)).filter(Boolean);
}

// 方案首段正文作为案卷主判断。
export function firstJudgment(d: DeliverableInput): string {
  const withBody = (d.sections ?? []).find((s) => s.b);
  return (withBody?.b || d.title || '').trim();
}

// V7-05：actionType 关键词映射（LLM 不可用时的确定性缺省）。
const ACTION_BY_KEYWORD: [RegExp, OrderActionType][] = [
  [/补资料|上传|资料|表格|截图|漏斗表|证据|案例/, 'upload'],
  [/回填|录入|数据|三数|线索|咨询数|成交数/, 'backfill'],
  [/复盘|反馈|记录.*(反馈|关键词)|私聊/, 'review'],
  [/选题|内容|主题|脚本|发布|短视频/, 'topics'],
];
function actionTypeFor(text: string, tag: string): OrderActionType {
  const hay = `${text} ${tag}`;
  for (const [re, t] of ACTION_BY_KEYWORD) if (re.test(hay)) return t;
  return 'none';
}

export interface StructuredOrder {
  text: string; owner: string | null; due: string | null; eta: number | null;
  actionType: OrderActionType; steps: string[]; metrics: OrderMetric[]; sourceQuote: string | null; aligned: boolean;
}

const OrderZ = z.object({
  text: z.string(),
  owner: z.string().nullish(),
  due: z.string().nullish(),
  eta: z.number().nullish(),
  actionType: z.enum(['upload', 'backfill', 'review', 'topics', 'none']).catch('none'),
  steps: z.array(z.string()).nullish(),
  metrics: z.array(z.object({ label: z.string(), value: z.string() })).nullish(),
  sourceQuote: z.string().nullish(),
  aligned: z.boolean().nullish(),
}).transform((o): StructuredOrder => ({
  text: o.text.trim().slice(0, 200),
  owner: o.owner?.trim().slice(0, 20) || null,
  due: o.due?.trim().slice(0, 40) || null,
  eta: typeof o.eta === 'number' && o.eta > 0 ? Math.min(Math.round(o.eta), 600) : null,
  actionType: o.actionType ?? 'none',
  steps: (o.steps ?? []).map((s) => s.trim()).filter(Boolean).slice(0, 3),
  metrics: (o.metrics ?? []).slice(0, 3).map((m) => ({ label: String(m.label).slice(0, 12), value: String(m.value).slice(0, 24) })),
  sourceQuote: o.sourceQuote?.trim().slice(0, 300) || null,
  aligned: o.aligned ?? true,
})).refine((o) => o.text.length > 0).nullable().catch(null);

const OrdersResultZ = z.object({
  orders: z.preprocess((v) => (Array.isArray(v) ? v : []), z.array(OrderZ)).transform((a) => a.filter((x): x is StructuredOrder => x !== null).slice(0, 3)),
});

const ORDERS_SYS = `你是「军师参谋部」的执行拆解官。把已认可的方案拆成不超过 3 条今日/本周可执行军令。
每条给：text(动作，≤20字)、owner(负责人称呼，可空)、due(截止标签，如"18:00"/"今日"/"本周")、eta(预计耗时分钟数，整数)、
actionType(upload=补资料/backfill=回填数据/review=复盘反馈/topics=内容选题/none)、steps(准备/处理/回写三步，各≤30字)、
metrics(≤3组{label,value}指标对)、sourceQuote(来源引用，方案里的依据一句)、aligned(是否对齐主要矛盾 true/false)。
只输出 JSON：{"orders":[{"text":"…","owner":"…","due":"…","eta":30,"actionType":"upload","steps":["…"],"metrics":[{"label":"…","value":"…"}],"sourceQuote":"…","aligned":true}]}。无则空数组，禁止编造。`;

// 喂给 LLM 的成果全文：拍平所有类型化组件字段（phases.actions/gantt 行/quads 等），不然类型化报告在这里只剩标题。
function deliverableText(d: DeliverableInput): string {
  const sectionText = (s: DeliverableSectionInput): string => {
    const parts: (string | undefined)[] = [s.h, s.b, ...(s.list ?? []), ...(s.paras ?? [])];
    for (const it of s.items ?? []) parts.push([it.tab, it.when, it.h, it.label, it.d, it.kpi, it.note, ...(it.actions ?? [])].filter(Boolean).join(' '));
    for (const r of s.rows ?? []) parts.push(Array.isArray(r) ? r.map((c) => (typeof c === 'string' ? c : c?.text ?? '')).join(' ') : [r.label, r.note].filter(Boolean).join(' '));
    for (const q of s.quads ?? []) parts.push([q.title, ...(q.items ?? [])].filter(Boolean).join(' '));
    return parts.filter(Boolean).join('\n');
  };
  return [d.title, ...(d.sections ?? []).map(sectionText)].filter(Boolean).join('\n\n').slice(0, 3000);
}

// 认可路径 LLM 限时预算：拆军令/抽目标是「锦上添花」，预算内没回来就走启发式/留空，
// 绝不让「认可 · 去执行」按钮同步吊在慢网关上（2026-07-22 事故：claudeRaw 无超时把 /casefile/accept 挂死）。
const ACCEPT_LLM_BUDGET_MS = 10_000;
function withBudget<T>(p: Promise<T | null>, ms = ACCEPT_LLM_BUDGET_MS): Promise<T | null> {
  return Promise.race([p, new Promise<T | null>((res) => { setTimeout(() => res(null), ms).unref?.(); })]);
}

/** 结构化拆军令：LLM 可用则走 structured()（限时预算），否则退回启发式 extractOrders + 确定性缺省。 */
export async function structureOrders(d: DeliverableInput, opts: { userName: string; agentName: string }): Promise<StructuredOrder[]> {
  const parsed = await withBudget(structured(OrdersResultZ, { system: ORDERS_SYS, user: deliverableText(d), maxChars: 3000 }).catch(() => null));
  if (parsed?.orders?.length) return parsed.orders.map((o) => ({ ...o, owner: o.owner ?? opts.userName }));
  return extractOrders(d).map((text) => ({
    text, owner: opts.userName, due: null, eta: null,
    actionType: actionTypeFor(text, `军令 · ${opts.agentName}`), steps: [], metrics: [], sourceQuote: null, aligned: true,
  }));
}

// V7-10：目标阶梯抽取（只在方案明确提到时给，抽不出留空，禁止编造）。
const GoalZ = z.object({
  longTerm: z.string().nullish(), annual: z.string().nullish(), quarterly: z.string().nullish(), weekly: z.string().nullish(),
});
const GOALS_SYS = `从方案中抽取目标阶梯：longTerm(3-5年)/annual(年度)/quarterly(季度)/weekly(本周)。只在方案明确提到时给对应值，抽不出留空，禁止编造。只输出 JSON：{"longTerm":"…","annual":"…","quarterly":"…","weekly":"…"}`;
export async function extractGoals(d: DeliverableInput): Promise<GoalLadder | null> {
  const parsed = await withBudget(structured(GoalZ, { system: GOALS_SYS, user: deliverableText(d), maxChars: 2000 }).catch(() => null));
  if (!parsed) return null;
  const g: GoalLadder = {
    longTerm: parsed.longTerm?.trim().slice(0, 60) || null,
    annual: parsed.annual?.trim().slice(0, 60) || null,
    quarterly: parsed.quarterly?.trim().slice(0, 60) || null,
    weekly: parsed.weekly?.trim().slice(0, 60) || null,
  };
  if (!g.longTerm && !g.annual && !g.quarterly && !g.weekly) return null;
  return { ...g, updatedAt: now().toISOString() };
}

/** V7-10：目标阶梯注入行（活跃案卷的目标，客户确认、跨期沿用；无则不注入）。 */
export async function goalsInjectionLine(userId: string): Promise<string | null> {
  const cf = await activeCasefile(userId);
  const g = (cf?.goalsJson as GoalLadder | null) ?? null;
  if (!g) return null;
  const parts = [
    g.longTerm && `3-5年：${g.longTerm}`, g.annual && `年度：${g.annual}`,
    g.quarterly && `季度：${g.quarterly}`, g.weekly && `本周：${g.weekly}`,
  ].filter(Boolean);
  return parts.length ? parts.join('；') : null;
}

/** 当前活跃案卷（每用户最多一个）。 */
export async function activeCasefile(userId: string) {
  return prisma.casefile.findFirst({ where: { userId, status: 'active' }, orderBy: { updatedAt: 'desc' } });
}

/** 案卷 → 前端视图（军令/回填只取最近 days 天，控制载荷）。 */
export async function casefileView(userId: string, days = 14): Promise<CasefileView | null> {
  const cf = await activeCasefile(userId);
  if (!cf) return null;
  const sinceStr = dateKey(new Date(now().getTime() - days * 86400_000)); // 上海时区（P1-4）
  const [ordersRaw, metrics] = await Promise.all([
    prisma.casefileOrder.findMany({
      where: { casefileId: cf.id, date: { gte: sinceStr } },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
    }),
    prisma.casefileMetric.findMany({ where: { casefileId: cf.id, date: { gte: sinceStr } } }),
  ]);
  const seenOrders = new Set<string>();
  const orders = ordersRaw.filter((o) => {
    const key = orderDedupeKey(o.date, o.text);
    if (seenOrders.has(key)) return false;
    seenOrders.add(key);
    return true;
  });
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
    goals: (cf.goalsJson as GoalLadder | null) ?? null,
    orders: orders.map((o) => ({
      id: o.id, text: o.text, from: o.fromAgent, tag: o.tag, date: o.date, done: o.done, aligned: o.aligned,
      ownerName: o.ownerName ?? null, dueAt: o.dueAt ?? null, etaMinutes: o.etaMinutes ?? null,
      sourceQuote: o.sourceQuote ?? null, steps: (o.stepsJson as string[] | null) ?? [],
      metrics: (o.metricsJson as OrderMetric[] | null) ?? [], actionType: (o.actionType as OrderActionType | null) ?? 'none',
    })),
    backfill,
  };
}

/** 认可方案 → 生成/更新案卷（同一案卷持续累积军令；新方案覆盖判断与风险）。 */
export async function acceptDeliverable(args: {
  tenantId: string;
  userId: string;
  deliverable: DeliverableInput;
  agentName: string;
}): Promise<{ casefileId: string; newOrders: number; skippedOrders: number }> {
  const { tenantId, userId, deliverable, agentName } = args;
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
  const userName = (u?.name || '我').slice(0, 20);
  // V7-05：结构化拆军令（LLM 可用则富字段，否则启发式缺省）；V7-10：抽取目标阶梯（抽不出留空）。
  const [structured, goals] = await Promise.all([
    structureOrders(deliverable, { userName, agentName }),
    extractGoals(deliverable),
  ]);
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
          ...(goals ? { goalsJson: goals as object } : {}),
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
          ...(goals ? { goalsJson: goals as object } : {}),
        },
      });

  const date = todayStr();
  const existingOrderKeys = new Set(
    (await prisma.casefileOrder.findMany({
      where: { casefileId: cf.id, date },
      select: { text: true },
    })).map((o) => orderDedupeKey(date, o.text)),
  );
  const newOrders = structured.filter((o) => {
    const key = orderDedupeKey(date, o.text);
    if (existingOrderKeys.has(key)) return false;
    existingOrderKeys.add(key);
    return true;
  });

  if (newOrders.length) {
    await prisma.casefileOrder.createMany({
      data: newOrders.map((o) => ({
        tenantId,
        userId,
        casefileId: cf.id,
        date,
        text: o.text,
        fromAgent: agentName,
        tag: `军令 · ${agentName}`,
        aligned: o.aligned, // V7-05：逐条对齐标注（LLM 拆解或缺省 true）
        ownerName: o.owner,
        dueAt: o.due,
        etaMinutes: o.eta,
        sourceQuote: o.sourceQuote,
        stepsJson: o.steps as Prisma.InputJsonValue,
        metricsJson: o.metrics as unknown as Prisma.InputJsonValue,
        actionType: o.actionType,
      })),
    });
  }
  return { casefileId: cf.id, newOrders: newOrders.length, skippedOrders: structured.length - newOrders.length };
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
