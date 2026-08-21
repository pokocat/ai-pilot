import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { isoSecond } from './audit.js';
import type {
  AdminDateRange,
  AdminSessionDetail,
  AdminSessionItem,
  AdminSessionListView,
  AdminTraceItem,
} from '../../../shared/contracts';

const ACTIVE_GENERATION = ['queued', 'running'] as const;

function pageNumber(value: number | undefined, fallback: number, max?: number): number {
  const n = Math.max(1, Math.floor(value ?? fallback));
  return max ? Math.min(max, n) : n;
}

function preview(content: Prisma.JsonValue, max = 180): string {
  if (typeof content === 'string') return content.slice(0, max);
  if (!content || typeof content !== 'object' || Array.isArray(content)) return '';
  const row = content as Record<string, Prisma.JsonValue>;
  const candidate = [row.text, row.title, row.summary, row.markdown].find((v) => typeof v === 'string');
  if (typeof candidate === 'string') return candidate.length > max ? `${candidate.slice(0, max)}…` : candidate;
  const serialized = JSON.stringify(content);
  return serialized.length > max ? `${serialized.slice(0, max)}…` : serialized;
}

type SessionRow = Awaited<ReturnType<typeof readSessionBase>>;

async function readSessionBase(id: string) {
  return prisma.session.findUnique({
    where: { id },
    include: {
      user: { select: { id: true, name: true, phone: true } },
      tenant: { select: { id: true, name: true } },
      agent: { select: { key: true, name: true } },
      project: { select: { id: true, name: true } },
      activeGeneration: { select: { id: true, status: true, phase: true, updatedAt: true } },
    },
  });
}

function phoneText(phone: string): string {
  return phone.startsWith('wx_') ? '微信账号' : phone;
}

async function enrichSessionRows(rows: NonNullable<SessionRow>[]): Promise<AdminSessionItem[]> {
  if (!rows.length) return [];
  const ids = rows.map((s) => s.id);
  const [messageGroups, generationGroups, latestMessages] = await Promise.all([
    prisma.message.groupBy({
      by: ['sessionId', 'role'],
      where: { sessionId: { in: ids } },
      _count: { _all: true },
    }),
    prisma.generationJob.groupBy({
      by: ['sessionId', 'status'],
      where: { sessionId: { in: ids } },
      _count: { _all: true },
    }),
    prisma.message.findMany({
      where: { sessionId: { in: ids } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      distinct: ['sessionId'],
      select: { sessionId: true, role: true, contentJson: true, createdAt: true },
    }),
  ]);
  const messageMap = new Map<string, Record<string, number>>();
  for (const g of messageGroups) {
    const row = messageMap.get(g.sessionId) ?? {};
    row[g.role] = g._count._all;
    messageMap.set(g.sessionId, row);
  }
  const generationMap = new Map<string, { total: number; failed: number }>();
  for (const g of generationGroups) {
    const row = generationMap.get(g.sessionId) ?? { total: 0, failed: 0 };
    row.total += g._count._all;
    if (g.status === 'failed') row.failed += g._count._all;
    generationMap.set(g.sessionId, row);
  }
  const latestMap = new Map(latestMessages.map((m) => [m.sessionId, m]));
  return rows.map((s) => {
    const msg = messageMap.get(s.id) ?? {};
    const gen = generationMap.get(s.id) ?? { total: 0, failed: 0 };
    const latest = latestMap.get(s.id);
    return {
      id: s.id,
      title: s.title,
      mode: s.mode,
      userId: s.userId,
      userName: s.user.name || null,
      userPhone: phoneText(s.user.phone),
      tenantId: s.tenantId,
      tenantName: s.tenant.name || null,
      agentKey: s.agentKey,
      agentName: s.agent.name || null,
      projectId: s.projectId,
      projectName: s.project?.name ?? null,
      messageCount: Object.values(msg).reduce((sum, n) => sum + n, 0),
      userMessageCount: msg.user ?? 0,
      assistantMessageCount: (msg.assistant ?? 0) + (msg.report ?? 0),
      generationCount: gen.total,
      failedGenerationCount: gen.failed,
      activeGeneration: s.activeGeneration ? {
        id: s.activeGeneration.id,
        status: s.activeGeneration.status,
        phase: s.activeGeneration.phase,
        updatedAt: isoSecond(s.activeGeneration.updatedAt),
      } : null,
      lastMessage: latest ? {
        role: latest.role,
        preview: preview(latest.contentJson),
        at: isoSecond(latest.createdAt),
      } : null,
      createdAt: isoSecond(s.createdAt),
      updatedAt: isoSecond(s.updatedAt),
    };
  });
}

export async function listAdminSessions(opts: {
  from: Date;
  toExclusive: Date;
  range: AdminDateRange;
  q?: string;
  status?: string;
  agentKey?: string;
  page?: number;
  pageSize?: number;
}): Promise<AdminSessionListView> {
  const page = pageNumber(opts.page, 1);
  const pageSize = pageNumber(opts.pageSize, 30, 100);
  const q = opts.q?.trim();
  const dateWhere = { gte: opts.from, lt: opts.toExclusive };
  const where: Prisma.SessionWhereInput = {
    updatedAt: dateWhere,
    ...(opts.agentKey ? { agentKey: opts.agentKey } : {}),
    ...(opts.status === 'active' ? { activeGenerationId: { not: null } } : {}),
    ...(opts.status === 'failed' ? { generationJobs: { some: { status: 'failed' } } } : {}),
    ...(opts.status === 'completed' ? { activeGenerationId: null, generationJobs: { some: { status: 'completed' } } } : {}),
    ...(q ? {
      OR: [
        { id: { contains: q, mode: 'insensitive' } },
        { title: { contains: q, mode: 'insensitive' } },
        { user: { name: { contains: q, mode: 'insensitive' } } },
        { user: { phone: { contains: q, mode: 'insensitive' } } },
        { tenant: { name: { contains: q, mode: 'insensitive' } } },
        { agent: { name: { contains: q, mode: 'insensitive' } } },
        { project: { name: { contains: q, mode: 'insensitive' } } },
      ],
    } : {}),
  };
  const [rows, total, messages, activeGenerations, failedGenerations] = await Promise.all([
    prisma.session.findMany({
      where,
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        user: { select: { id: true, name: true, phone: true } },
        tenant: { select: { id: true, name: true } },
        agent: { select: { key: true, name: true } },
        project: { select: { id: true, name: true } },
        activeGeneration: { select: { id: true, status: true, phase: true, updatedAt: true } },
      },
    }),
    prisma.session.count({ where }),
    prisma.message.count({ where: { session: where } }),
    prisma.generationJob.count({ where: { session: where, status: { in: [...ACTIVE_GENERATION] } } }),
    prisma.generationJob.count({ where: { session: where, status: 'failed' } }),
  ]);
  return {
    range: opts.range,
    page,
    pageSize,
    total,
    pages: Math.max(1, Math.ceil(total / pageSize)),
    summary: { sessions: total, messages, activeGenerations, failedGenerations },
    items: await enrichSessionRows(rows),
  };
}

export async function getAdminSession(id: string, before?: string, limit = 80): Promise<AdminSessionDetail | null> {
  const session = await readSessionBase(id);
  if (!session) return null;
  const pageSize = pageNumber(limit, 80, 200);
  const messages = await prisma.message.findMany({
    where: { sessionId: id },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: pageSize + 1,
    ...(before ? { cursor: { id: before }, skip: 1 } : {}),
  });
  const hasMore = messages.length > pageSize;
  const page = messages.slice(0, pageSize);
  const nextMessageCursor = hasMore ? page[page.length - 1]?.id ?? null : null;
  const [item] = await enrichSessionRows([session]);
  const [messagesTotal, generations, traceRows] = await Promise.all([
    prisma.message.count({ where: { sessionId: id } }),
    prisma.generationJob.findMany({ where: { sessionId: id }, orderBy: { createdAt: 'desc' }, take: 100 }),
    prisma.llmTrace.findMany({ where: { sessionId: id }, orderBy: { createdAt: 'desc' }, take: 100 }),
  ]);
  const traces: AdminTraceItem[] = traceRows.map((t) => ({
    id: t.id,
    at: isoSecond(t.createdAt),
    agentKey: t.agentKey,
    agentName: item.agentName,
    versionId: t.versionId,
    userId: t.userId,
    userName: item.userName,
    userPhone: item.userPhone,
    tenantId: t.tenantId,
    tenantName: item.tenantName,
    sessionId: t.sessionId,
    kind: t.kind,
    provider: t.provider,
    model: t.model,
    endpointId: t.endpointId,
    endpointLabel: t.endpointLabel,
    status: t.status === 'error' ? 'error' : 'ok',
    latencyMs: t.latencyMs,
    toolCalls: t.toolCalls,
    totalTokens: t.totalTokens,
    cachedInput: t.cachedInput,
    errorMessage: t.errorMessage,
  }));
  return {
    session: item,
    messages: [...page].reverse().map((m) => ({
      id: m.id,
      role: m.role,
      content: m.contentJson,
      textPreview: preview(m.contentJson, 1000),
      refs: m.refsJson,
      at: isoSecond(m.createdAt),
    })),
    messagesTotal,
    nextMessageCursor,
    generations: generations.map((g) => ({
      id: g.id,
      status: g.status,
      phase: g.phase,
      kind: g.kind,
      requestedOutput: g.requestedOutput,
      deliveryMode: g.deliveryMode,
      priority: g.priority,
      quotaReserved: g.quotaReserved,
      quotaCharged: g.quotaCharged,
      creditReserved: g.creditReserved,
      settlementStatus: g.settlementStatus,
      creditSettlementStatus: g.creditSettlementStatus,
      terminationReason: g.terminationReason,
      usage: g.usageJson,
      createdAt: isoSecond(g.createdAt),
      startedAt: g.startedAt ? isoSecond(g.startedAt) : null,
      completedAt: g.completedAt ? isoSecond(g.completedAt) : null,
      updatedAt: isoSecond(g.updatedAt),
    })),
    traces,
  };
}
