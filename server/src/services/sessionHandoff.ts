import { Prisma, UserFactStatus } from '@prisma/client';
import type { SessionDigestItem } from '../../../shared/contracts';
import { prisma } from '../db.js';
import { userFactView } from './userFacts.js';

interface StoredDigest {
  activeItems: SessionDigestItem[];
  segmentItems: SessionDigestItem[];
}

function digestItems(raw: unknown): SessionDigestItem[] {
  if (Array.isArray(raw)) return raw as SessionDigestItem[];
  if (!raw || typeof raw !== 'object') return [];
  const value = raw as Partial<StoredDigest>;
  return [
    ...(Array.isArray(value.activeItems) ? value.activeItems : []),
    ...(Array.isArray(value.segmentItems) ? value.segmentItems : []),
  ];
}

function messageText(content: unknown): string {
  if (!content || typeof content !== 'object') return '';
  const value = content as Record<string, unknown>;
  if (typeof value.text === 'string') return value.text.trim().slice(0, 320);
  if (typeof value.title === 'string') return `已交付《${value.title.trim()}》`;
  return '';
}

function capRows<T>(rows: T[], textOf: (row: T) => string, maxChars: number): T[] {
  const out: T[] = [];
  let used = 0;
  for (const row of rows) {
    const size = textOf(row).length;
    if (out.length && used + size > maxChars) break;
    out.push(row);
    used += size;
  }
  return out;
}

/** 建新 Session 时从现成检查点组装交接包；不临时调用模型，不阻塞在全量总结。 */
export async function createSessionHandoffInTransaction(args: {
  tx: Prisma.TransactionClient;
  tenantId: string;
  userId: string;
  sourceSessionId: string;
  targetSessionId: string;
}): Promise<void> {
  const [snapshot, messages, facts] = await Promise.all([
    args.tx.sessionContextSnapshot.findUnique({ where: { sessionId: args.sourceSessionId } }),
    args.tx.message.findMany({
      where: { sessionId: args.sourceSessionId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 16,
      select: { id: true, role: true, contentJson: true, createdAt: true },
    }),
    args.tx.userFact.findMany({
      where: {
        tenantId: args.tenantId,
        userId: args.userId,
        status: { in: [UserFactStatus.asserted, UserFactStatus.confirmed] },
      },
      orderBy: [{ status: 'desc' }, { updatedAt: 'desc' }],
      take: 40,
    }),
  ]);
  const items = digestItems(snapshot?.itemsJson).sort((a, b) => a.at.localeCompare(b.at));
  const newest = [...items].reverse();
  const decisions = capRows(newest.filter((item) => item.kind === 'decision'), (item) => item.text, 1_200);
  const constraints = capRows(newest.filter((item) => ['goal', 'constraint'].includes(item.kind)), (item) => item.text, 1_200);
  const openItems = capRows(newest.filter((item) => ['open_question', 'action_item'].includes(item.kind)), (item) => item.text, 1_000);
  const recentMessages = messages
    .map((message) => ({ id: message.id, role: message.role, text: messageText(message.contentJson), at: message.createdAt.toISOString() }))
    .filter((message) => message.text)
    .reverse();
  const recentContext = capRows(
    [...openItems.map((item) => ({ kind: item.kind, text: item.text, sourceMessageIds: item.sourceMessageIds, at: item.at })), ...recentMessages],
    (item) => item.text,
    1_800,
  );
  const sourceIds = Array.from(new Set([
    ...decisions.flatMap((item) => item.sourceMessageIds),
    ...constraints.flatMap((item) => item.sourceMessageIds),
    ...openItems.flatMap((item) => item.sourceMessageIds),
    ...recentMessages.map((item) => item.id),
  ])).slice(-80);
  await args.tx.sessionHandoff.create({
    data: {
      sessionId: args.targetSessionId,
      sourceSessionId: args.sourceSessionId,
      handoffVersion: 1,
      lastSourceMessageId: messages[0]?.id ?? snapshot?.lastMessageId ?? null,
      factsJson: facts.map(userFactView) as unknown as Prisma.InputJsonValue,
      decisionsJson: decisions as unknown as Prisma.InputJsonValue,
      constraintsJson: constraints as unknown as Prisma.InputJsonValue,
      recentContextJson: recentContext as unknown as Prisma.InputJsonValue,
      sourceMessageIdsJson: sourceIds,
    },
  });
}

function list(raw: unknown): Array<Record<string, unknown>> {
  return Array.isArray(raw) ? raw.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object') : [];
}

function textRows(raw: unknown, max: number): string[] {
  return list(raw).map((item) => typeof item.text === 'string' ? item.text.trim() : '').filter(Boolean).slice(0, max);
}

export async function sessionHandoffBlock(sessionId?: string | null): Promise<string | null> {
  if (!sessionId) return null;
  const row = await prisma.sessionHandoff.findUnique({ where: { sessionId } });
  if (!row) return null;
  // factsJson 保留建会谈时的审计快照，但 prompt 使用 userFacts.ts 实时筛选后的当前事实块。
  // 这样既不重复花上下文预算，也不会在事实被更正后从旧交接包复活 superseded 值。
  const decisions = textRows(row.decisionsJson, 12);
  const constraints = textRows(row.constraintsJson, 12);
  const recent = textRows(row.recentContextJson, 12);
  const lines = [
    decisions.length ? `已定决策：${decisions.join('；')}` : '',
    constraints.length ? `目标与约束：${constraints.join('；')}` : '',
    recent.length ? `上次谈到：${recent.join('；')}` : '',
  ].filter(Boolean);
  if (!lines.length) return null;
  return `【上一主线会谈交接包（有来源；不是新推断）】\n${lines.join('\n').slice(0, 4_000)}\n衔接上次脉络即可，不要要求客户从头介绍；若与本轮原话冲突，以本轮为准。`;
}
