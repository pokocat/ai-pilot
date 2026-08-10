import { createHash } from 'node:crypto';
import {
  Prisma,
  UserFactSourceType,
  UserFactStatus,
  type UserFact,
} from '@prisma/client';
import type {
  FactConfirmationCard,
  FactConfirmationRequest,
  FactConfirmationResult,
  UserFactView,
} from '../../../shared/contracts';
import { prisma } from '../db.js';

const ACTIVE_HARD = [UserFactStatus.asserted, UserFactStatus.confirmed] as const;
const ACTIVE_ANY = [UserFactStatus.asserted, UserFactStatus.confirmed, UserFactStatus.pending] as const;
const HYPOTHETICAL_CUE = /(?:如果|假设|假如|比如|举例|要是).{0,18}(?:家店|门店|人团队|年营收|预算)/;
const DIRECT_CUE = /(?:我们|我这边|我公司|公司|团队|目前|现在|当前|已经|实际|帮我记住|不是)/;

interface FactCandidate {
  factKey: string;
  valueText: string;
  confidence: number;
}

function normalize(value: string): string {
  return value.replace(/[\s，。；、：:！？!?.]/g, '').toLowerCase();
}

function chineseNumber(value: string): number | null {
  if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value);
  const digits: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (value === '十') return 10;
  if (value.includes('百')) {
    const [a, b = ''] = value.split('百');
    const high = a ? (digits[a] ?? 0) : 1;
    const rest = chineseNumber(b) ?? 0;
    return high * 100 + rest;
  }
  if (value.includes('十')) {
    const [a, b = ''] = value.split('十');
    return (a ? (digits[a] ?? 0) : 1) * 10 + (b ? (digits[b] ?? 0) : 0);
  }
  if ([...value].every((char) => char in digits)) return Number([...value].map((char) => digits[char]).join(''));
  return null;
}

function lastMatch(text: string, pattern: RegExp): RegExpMatchArray | null {
  const matches = [...text.matchAll(pattern)];
  return matches[matches.length - 1] ?? null;
}

/**
 * 第一版只收代码能稳定判 key 的高影响硬事实。无法确定 key 的内容继续留在语义 Memory，
 * 宁可少记也不能用向量相似度猜替代链。
 */
export function extractKnownFactCandidates(text: string): FactCandidate[] {
  const source = text.trim();
  if (!source || HYPOTHETICAL_CUE.test(source)) return [];
  const out: FactCandidate[] = [];
  const number = '[0-9]+(?:\\.[0-9]+)?|[一二两三四五六七八九十百]+';

  const stores = lastMatch(source, new RegExp(`(${number})\\s*家(?:直营|加盟|连锁)?(?:门店|店)`, 'g'));
  if (stores) {
    const n = chineseNumber(stores[1]);
    if (n != null) out.push({ factKey: 'company.store_count', valueText: `目前有${n}家门店`, confidence: 0.99 });
  }
  const years = lastMatch(source, new RegExp(`(?:经营|成立|创业|做(?:这个)?行业)(?:已经|了|约|近)?\\s*(${number})\\s*年`, 'g'));
  if (years) {
    const n = chineseNumber(years[1]);
    if (n != null) out.push({ factKey: 'company.operating_years', valueText: `已经营${n}年`, confidence: 0.96 });
  }
  const team = lastMatch(source, new RegExp(`(?:团队|员工|公司)(?:(?:目前|现在|当前|有|约|大概|一共|共)\\s*)*(${number})\\s*(?:人|名)`, 'g'));
  if (team) {
    const n = chineseNumber(team[1]);
    if (n != null) out.push({ factKey: 'company.team_size', valueText: `团队目前${n}人`, confidence: 0.98 });
  }
  const revenue = lastMatch(source, /(?:年营收|年度营收|一年营收|营收)(?:目前|现在|大概|约|是|有|做到)?\s*([0-9]+(?:\.[0-9]+)?)\s*(万|亿)(?:元)?/g);
  if (revenue) out.push({ factKey: 'company.annual_revenue', valueText: `年营收约${revenue[1]}${revenue[2]}元`, confidence: 0.97 });
  const budget = lastMatch(source, /(?:预算|可投入|能投入)(?:目前|现在|大概|约|是|有|只有)?\s*([0-9]+(?:\.[0-9]+)?)\s*(万|亿|千)?(?:元)?/g);
  if (budget) out.push({ factKey: 'constraint.current_budget', valueText: `当前预算${budget[1]}${budget[2] || ''}元`, confidence: 0.95 });
  const equity = lastMatch(source, /(?:我|创始人|本人)?(?:持股|股权|股份)(?:目前|现在|占|是|有)?\s*([0-9]+(?:\.[0-9]+)?)\s*%/g);
  if (equity) out.push({ factKey: 'company.founder_equity', valueText: `创始人持股${equity[1]}%`, confidence: 0.95 });
  return out;
}

function explicitRememberCandidate(text: string): FactCandidate | null {
  const match = text.match(/(?:请)?帮我记住[：:,，\s]*(.{2,160})/);
  if (!match?.[1]) return null;
  const valueText = match[1].replace(/[。！!]+$/, '').trim();
  if (!valueText) return null;
  const suffix = createHash('sha256').update(normalize(valueText)).digest('hex').slice(0, 16);
  return { factKey: `user.explicit.${suffix}`, valueText, confidence: 1 };
}

function messageIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && !!item).slice(0, 8) : [];
}

export function userFactView(row: UserFact): UserFactView {
  return {
    id: row.id,
    factKey: row.factKey,
    valueText: row.valueText,
    status: row.status,
    sourceType: row.sourceType,
    sourceMessageIds: messageIds(row.sourceMessageIds),
    sourceSessionId: row.sourceSessionId,
    sourceDocumentId: row.sourceDocumentId,
    supersedesId: row.supersedesId,
    confidence: row.confidence,
    assertedAt: row.assertedAt?.toISOString() ?? null,
    confirmedAt: row.confirmedAt?.toISOString() ?? null,
    supersededAt: row.supersededAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function withFactLock<T>(tx: Prisma.TransactionClient, userId: string, factKey: string, fn: () => Promise<T>): Promise<T> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${userId}:${factKey}`}))`;
  return fn();
}

async function upsertFact(args: {
  tenantId: string;
  userId: string;
  sessionId?: string | null;
  sourceDocumentId?: string | null;
  sourceMessageIds: string[];
  candidate: FactCandidate;
  sourceType: UserFactSourceType;
  status: 'asserted' | 'pending';
}): Promise<{ fact: UserFact; created: boolean; conflict: boolean }> {
  return prisma.$transaction((tx) => withFactLock(tx, args.userId, args.candidate.factKey, async () => {
    const current = await tx.userFact.findMany({
      where: { userId: args.userId, tenantId: args.tenantId, factKey: args.candidate.factKey, status: { in: [...ACTIVE_ANY] } },
      orderBy: { createdAt: 'desc' },
    });
    const same = current.find((row) => normalize(row.valueText) === normalize(args.candidate.valueText));
    if (same) {
      const promote = args.status === UserFactStatus.asserted && same.status === UserFactStatus.pending;
      const fact = await tx.userFact.update({
        where: { id: same.id },
        data: {
          reinforcedAt: new Date(),
          sourceMessageIds: Array.from(new Set([...messageIds(same.sourceMessageIds), ...args.sourceMessageIds])).slice(0, 8),
          ...(promote ? {
            status: UserFactStatus.asserted,
            sourceType: UserFactSourceType.user_message,
            assertedAt: new Date(),
          } : {}),
        },
      });
      return { fact, created: false, conflict: false };
    }
    const hardConflict = current.some((row) => ACTIVE_HARD.includes(row.status as typeof ACTIVE_HARD[number]));
    const replaced = current[0] ?? null;
    if (args.status === UserFactStatus.asserted && current.length) {
      await tx.userFact.updateMany({
        where: { id: { in: current.map((row) => row.id) } },
        data: { status: UserFactStatus.superseded, supersededAt: new Date() },
      });
    }
    const fact = await tx.userFact.create({
      data: {
        tenantId: args.tenantId,
        userId: args.userId,
        factKey: args.candidate.factKey,
        valueText: args.candidate.valueText,
        status: args.status,
        sourceType: args.sourceType,
        sourceMessageIds: args.sourceMessageIds,
        sourceSessionId: args.sessionId ?? null,
        sourceDocumentId: args.sourceDocumentId ?? null,
        supersedesId: args.status === UserFactStatus.asserted ? replaced?.id ?? null : null,
        confidence: args.candidate.confidence,
        assertedAt: args.status === UserFactStatus.asserted ? new Date() : null,
      },
    });
    return { fact, created: true, conflict: hardConflict };
  }));
}

/** 用户亲口陈述直接进入 asserted，不重复弹卡；更正会按同 factKey 建替代链。 */
export async function captureDirectUserFacts(args: {
  tenantId: string;
  userId: string;
  sessionId: string;
  userMessageId: string;
  text: string;
}): Promise<UserFact[]> {
  const text = args.text.trim();
  if (!text) return [];
  if (/(?:这条|刚才这条|上一条)(?:别记|不要记|不用记)|(?:别|不要)把这条记住/.test(text)) {
    const latest = await prisma.userFact.findFirst({
      where: { tenantId: args.tenantId, userId: args.userId, sourceSessionId: args.sessionId, status: { in: [...ACTIVE_ANY] } },
      orderBy: { createdAt: 'desc' },
    });
    if (latest) {
      await prisma.userFact.update({ where: { id: latest.id }, data: { status: UserFactStatus.rejected, rejectedAt: new Date() } });
    }
    return [];
  }
  const known = extractKnownFactCandidates(text);
  const explicit = explicitRememberCandidate(text);
  const candidates = [...known, ...(explicit && !known.some((item) => normalize(item.valueText) === normalize(explicit.valueText)) ? [explicit] : [])];
  if (!candidates.length || (!DIRECT_CUE.test(text) && !explicit)) return [];
  const facts: UserFact[] = [];
  for (const candidate of candidates) {
    const result = await upsertFact({
      ...args,
      sourceMessageIds: [args.userMessageId],
      candidate,
      sourceType: UserFactSourceType.user_message,
      status: UserFactStatus.asserted,
    });
    facts.push(result.fact);
  }
  return facts;
}

/**
 * 军师回复中凡出现“当前事实库没有的高影响硬事实”，一律按推断放进 pending；
 * 不能依赖模型恰好说出“我推测”才保护。已有同值硬事实只会强化来源，不重复弹卡。
 */
export async function captureAssistantFactCandidates(args: {
  tenantId: string;
  userId: string;
  sessionId: string;
  userMessageId: string;
  assistantMessageId: string;
  assistantText: string;
}): Promise<FactConfirmationCard | null> {
  const sentences = args.assistantText.split(/[。！？!\n]+/).map((item) => item.trim()).filter(Boolean);
  const candidates = sentences
    .flatMap(extractKnownFactCandidates)
    .filter((item, index, all) => all.findIndex((other) => other.factKey === item.factKey) === index)
    .slice(0, 3);
  if (!candidates.length) return null;
  const items: FactConfirmationCard['items'] = [];
  for (const candidate of candidates) {
    const result = await upsertFact({
      ...args,
      sourceMessageIds: [args.userMessageId, args.assistantMessageId],
      candidate,
      sourceType: UserFactSourceType.assistant_inference,
      status: UserFactStatus.pending,
    });
    if (result.fact.status === UserFactStatus.pending) {
      items.push({
        id: result.fact.id,
        factKey: result.fact.factKey,
        valueText: result.fact.valueText,
        reason: result.conflict ? 'conflict' : 'assistant_inference',
      });
    }
  }
  return items.length ? { title: items.length === 1 ? '这条是我的推断，想请你核一下' : '这几条是我的推断，想请你核一下', items } : null;
}

/** 资料确认入库后只提取代码能稳定识别的硬事实，统一进入 pending，绝不直接注入模型。 */
export async function captureDocumentFactCandidates(args: {
  tenantId: string;
  userId: string;
  documentId: string;
  text: string;
}): Promise<UserFact[]> {
  const candidates = extractKnownFactCandidates(args.text)
    .filter((item, index, all) => all.findIndex((other) => other.factKey === item.factKey) === index)
    .slice(0, 8);
  const facts: UserFact[] = [];
  for (const candidate of candidates) {
    const result = await upsertFact({
      tenantId: args.tenantId,
      userId: args.userId,
      sessionId: null,
      sourceDocumentId: args.documentId,
      sourceMessageIds: [],
      candidate,
      sourceType: UserFactSourceType.document,
      status: UserFactStatus.pending,
    });
    if (result.fact.status === UserFactStatus.pending) facts.push(result.fact);
  }
  return facts;
}

/** 下一次军师回复附带尚未核对的资料事实；按钮走事实接口，不制造聊天文本。 */
export async function pendingDocumentFactCard(userId: string): Promise<FactConfirmationCard | null> {
  const rows = await prisma.userFact.findMany({
    where: { userId, status: UserFactStatus.pending, sourceType: UserFactSourceType.document },
    orderBy: { createdAt: 'desc' },
    take: 3,
  });
  if (!rows.length) return null;
  return {
    title: rows.length === 1 ? '资料里识别到这条信息，请你核一下' : '资料里识别到这几条信息，请你核一下',
    items: rows.map((row) => ({
      id: row.id,
      factKey: row.factKey,
      valueText: row.valueText,
      reason: 'document_extraction',
    })),
  };
}

export async function resolveFactConfirmation(args: {
  tenantId: string;
  userId: string;
  factId: string;
  request: FactConfirmationRequest;
}): Promise<FactConfirmationResult | null> {
  const pending = await prisma.userFact.findFirst({ where: { id: args.factId, tenantId: args.tenantId, userId: args.userId } });
  if (!pending || pending.status !== UserFactStatus.pending) return null;
  return prisma.$transaction((tx) => withFactLock(tx, args.userId, pending.factKey, async () => {
    const fresh = await tx.userFact.findUnique({ where: { id: pending.id } });
    if (!fresh || fresh.status !== UserFactStatus.pending) return null;
    if (args.request.action === 'session_only') {
      const fact = await tx.userFact.update({ where: { id: fresh.id }, data: { status: UserFactStatus.rejected, rejectedAt: new Date() } });
      return { fact: userFactView(fact), resolution: 'session_only' as const };
    }
    const replacementText = args.request.action === 'edit' ? (args.request.valueText ?? '').trim() : fresh.valueText;
    if (!replacementText) throw Object.assign(new Error('修正内容不能为空'), { statusCode: 400, code: 'EMPTY_FACT_VALUE' });
    const others = await tx.userFact.findMany({
      where: { tenantId: args.tenantId, userId: args.userId, factKey: fresh.factKey, id: { not: fresh.id }, status: { in: [...ACTIVE_ANY] } },
      orderBy: { createdAt: 'desc' },
    });
    if (others.length) {
      await tx.userFact.updateMany({
        where: { id: { in: others.map((row) => row.id) } },
        data: { status: UserFactStatus.superseded, supersededAt: new Date() },
      });
    }
    if (args.request.action === 'confirm') {
      const fact = await tx.userFact.update({ where: { id: fresh.id }, data: { status: UserFactStatus.confirmed, confirmedAt: new Date() } });
      return { fact: userFactView(fact), resolution: 'confirmed' as const };
    }
    await tx.userFact.update({ where: { id: fresh.id }, data: { status: UserFactStatus.superseded, supersededAt: new Date() } });
    const fact = await tx.userFact.create({
      data: {
        tenantId: fresh.tenantId,
        userId: fresh.userId,
        factKey: fresh.factKey,
        valueText: replacementText,
        status: UserFactStatus.confirmed,
        sourceType: UserFactSourceType.manual_edit,
        sourceMessageIds: fresh.sourceMessageIds as Prisma.InputJsonValue,
        sourceSessionId: fresh.sourceSessionId,
        sourceDocumentId: fresh.sourceDocumentId,
        supersedesId: fresh.id,
        confidence: 1,
        confirmedAt: new Date(),
      },
    });
    return { fact: userFactView(fact), resolution: 'edited' as const };
  }));
}

export async function activeUserFactsBlock(userId: string, maxChars = 2_000): Promise<string | null> {
  const rows = await prisma.userFact.findMany({
    where: { userId, status: { in: [...ACTIVE_HARD] } },
    orderBy: [{ status: 'desc' }, { updatedAt: 'desc' }],
    take: 60,
  });
  if (!rows.length) return null;
  const lines: string[] = [];
  let used = 0;
  for (const row of rows) {
    const line = `- [${row.status === UserFactStatus.confirmed ? '已确认' : '用户已陈述'}] ${row.valueText}`;
    if (lines.length && used + line.length > maxChars) break;
    lines.push(line);
    used += line.length;
  }
  return lines.length
    ? `【客户硬事实（有来源；优先于语义记忆）】\n${lines.join('\n')}\n只可把本块视为客户事实；不得把军师推断补写进本块。`
    : null;
}
