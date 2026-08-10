// 会话上下文快照（批次 3）：长会话的「带来源的结构化摘要层」。
//
// 问题：普通轮只带最近 16 条原文（routes/sessions.ts RECENT_HISTORY_MESSAGES），第 3 轮确认过的
// 「注册资本 300 万」到第 60 轮就掉出窗口了；报告轮尤其受害——它最需要早期那些约束与决策。
//
// 口径（三条铁律，改这个文件前先读）：
//  1) 原始消息始终是事实源，本层只是索引 + 压缩。故每条摘要必须能溯源回消息 id，
//     且 sourceMessageIds 只认「本批列出的 id」——模型编一个批外 id 就整条丢弃（伪造溯源比没有溯源更糟）。
//  2) 只追加，绝不改写/删除既有条目。「门店 3 家」后来变成 5 家，两条都留着按时间排序，
//     由模型按「时间靠后为准」自行判断；系统不替客户裁决哪条是真的。
//  3) 宁缺勿假：无 live provider（测试/mock）或校验不过 → 不落任何条目，也不推进游标
//     （推进了就等于永久跳过这批消息），返回现状即可。抽取失败绝不影响生成主流程。
//
// 时间口径：at 由代码从来源消息的 createdAt 算，绝不让模型产出时间（模型编时间无法校验）。
// 展示用的日历字段一律走 clock 的 Asia/Shanghai 派生（P1-4），不裸用 Date 的本地方法。

import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { structured } from '../llm/gateway.js';
import { calendarParts } from './clock.js';
import { noteSessionDigestCompaction, noteSessionDigestState } from './metrics.js';
import type { SessionDigestItem, SessionDigestKind, SessionDigestStatus } from '../../../shared/contracts';

export type { SessionDigestItem, SessionDigestKind, SessionDigestStatus };

const BATCH_MESSAGES = 20;        // 每批喂给抽取器的消息条数
const DEFAULT_MAX_BATCHES = 5;    // 单次调用最多处理几批（报告轮传 3，控制同步补齐的延迟）
const MAX_ITEMS_PER_BATCH = 10;   // 每批最多采纳几条（多了截断——一批 20 条消息抽不出 10 条以上的硬信息）
const MAX_ACTIVE_ITEMS = 120;
const COMPACT_TOTAL_THRESHOLD = 350;
const MAX_SOURCE_IDS = 8;
const MAX_ITEM_CHARS = 160;       // 提示词要 ≤80 字，代码侧按 160 字符 clamp（模型超一点不至于整条丢）
/** 条目总量上限。到顶只停抽取、不丢既有条目——合并/压缩是后续工作，先守住上限别让注入无限膨胀。 */
const MAX_ITEMS_TOTAL = 400;

export interface SessionDigestState {
  items: SessionDigestItem[];
  version: number;
  /** 兼容既有调用；新代码与 trace 以 status 为准。 */
  caughtUp: boolean;
  status: SessionDigestStatus;
  coveredThroughMessageId: string | null;
  coveredThroughAt: string | null;
  pendingMessages: number;
  activeItems: SessionDigestItem[];
  segmentItems: SessionDigestItem[];
  segment: number;
}

interface DigestStoreV2 {
  schemaVersion: 2;
  activeItems: SessionDigestItem[];
  segmentItems: SessionDigestItem[];
  segment: number;
}

const DIGEST_KINDS = [
  'fact', 'goal', 'constraint', 'metric', 'decision',
  'advice', 'open_question', 'action_item', 'quote', 'deliverable_ref',
] as const;

const KIND_LABEL: Record<SessionDigestKind, string> = {
  fact: '事实', goal: '目标', constraint: '约束', metric: '数据', decision: '决策',
  advice: '已给建议', open_question: '待确认', action_item: '行动项', quote: '原话', deliverable_ref: '已出方案',
};

/* ─────────────── 抽取器 seam ─────────────── */

export interface DigestBatchMessage { id: string; role: string; text: string; at: Date }
export interface DigestExtraction { items: { kind: SessionDigestKind; text: string; sourceMessageIds: string[] }[] }
export type DigestExtractor = (p: { existing: SessionDigestItem[]; batch: DigestBatchMessage[] }) => Promise<DigestExtraction | null>;
export type DigestCompactor = (p: { active: SessionDigestItem[]; segment: SessionDigestItem[] }) => Promise<DigestExtraction | null>;

/** 测试 seam：注入确定性抽取器，不触真实模型（参照 alertConfig.__setFeishuTransportForTest 先例）。 */
export function __setDigestExtractorForTest(fn: DigestExtractor | null): void {
  extractor = fn ?? defaultExtractor;
}

/** 测试 seam：滚动合并必须能覆盖崩溃恢复与幂等，不依赖真实模型。 */
export function __setDigestCompactorForTest(fn: DigestCompactor | null): void {
  compactor = fn ?? defaultCompactor;
}

/* ─────────────── 默认抽取器（走 structured() 原语） ─────────────── */

const ExtractResultZ = z.object({
  items: z.array(z.object({
    kind: z.enum(DIGEST_KINDS),
    text: z.string().min(1),
    sourceMessageIds: z.array(z.string()).min(1).max(MAX_SOURCE_IDS),
  })).default([]),
});

const EXTRACT_SYS = `你是「军师」商业咨询系统的会话索引器。任务：把本批对话里「值得跨轮复用的硬信息」抽成结构化条目，供后续对话与报告引用。

条目类型（kind）只能取这十种：
- fact 客户经营事实（主体/业务/规模/渠道/团队）
- goal 客户明确说出的目标
- constraint 约束与红线（预算、人手、时间、不能做什么）
- metric 具体经营数据（营收、复购率、客单价、门店数等带数字的）
- decision 客户已拍板的决定
- advice 军师已经给过的关键建议（避免后续重复建议）
- open_question 还没确认、需要客户回答的问题
- action_item 已认领的行动项
- quote 客户的关键原话（只在原话本身有判断价值时用）
- deliverable_ref 已产出的方案/报告及其主题

硬规则：
1. 只抽「具体、含数字或专有名词、可跨轮复用」的信息。寒暄、情绪、泛泛而谈、纯过程话术一律不抽。抽不出就返回空数组，不要凑数。
2. 每条必须给 sourceMessageIds：这条信息来自哪几条消息。只能填【本批消息】里方括号内列出的消息 id，一个字符都不能改，也不许引用没列出的 id。做不到就不要输出这条。
3. 与【既有摘要】已有的信息重复的，不要再抽一遍。
4. 与【既有摘要】矛盾的（例如既有「门店 3 家」，本批说「门店 5 家」），**新开一条**如实记录新说法，不要解释、不要合并、不要说明哪条对。
5. 每条 text 一句话、≤80 字，含具体数字/名词，不要写「客户提到」这类前缀。
6. 最多 10 条。
7. 只输出 JSON，形如 {"items":[{"kind":"fact","text":"…","sourceMessageIds":["…"]}]}，不要任何解释文字。`;

const pad2 = (n: number): string => String(n).padStart(2, '0');
/** 上海时区「MM-DD HH:mm」（P1-4：日历字段必须走 clock，不裸用 Date 本地方法）。 */
function stampOf(at: Date): string {
  const p = calendarParts(at);
  return `${pad2(p.month)}-${pad2(p.day)} ${pad2(p.hour)}:${pad2(p.minute)}`;
}
/** 上海时区「MM-DD」（注入块的行内日期）。 */
function monthDayOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '??-??';
  const p = calendarParts(d);
  return `${pad2(p.month)}-${pad2(p.day)}`;
}

const EXISTING_LIST_CAP = 3_000;

/** 既有摘要压缩清单（超 cap 取最新的——早期条目多半已被后来的说法覆盖，留新的更有用）。 */
function existingBlock(existing: SessionDigestItem[]): string {
  if (!existing.length) return '（暂无既有摘要）';
  const lines: string[] = [];
  let used = 0;
  for (let i = existing.length - 1; i >= 0; i--) {
    const line = `${KIND_LABEL[existing[i].kind] ?? existing[i].kind}：${existing[i].text}`;
    if (lines.length && used + line.length > EXISTING_LIST_CAP) break;
    lines.push(line);
    used += line.length;
  }
  return lines.reverse().join('\n');
}

function batchBlock(batch: DigestBatchMessage[]): string {
  return batch
    .map((m) => `[${m.id}] ${m.role === 'user' ? '客户' : '军师'}（${stampOf(m.at)}）：${m.text}`)
    .join('\n');
}

const defaultExtractor: DigestExtractor = async ({ existing, batch }) => {
  const user = `【既有摘要（已记录过，不要重复抽取；矛盾处新开一条）】\n${existingBlock(existing)}\n\n【本批消息（sourceMessageIds 只能用下面方括号里的 id）】\n${batchBlock(batch)}`;
  // maxChars 必须显式给大：structured 默认只截 4000 字符，20 条消息（每条上限 600 字）会被拦腰截断，
  // 后半批的消息 id 连出现都没出现过，抽出来的条目全会因「批外 id」被丢弃。
  return structured(ExtractResultZ, { system: EXTRACT_SYS, user, maxChars: 20_000 });
};

let extractor: DigestExtractor = defaultExtractor;

const COMPACT_SYS = `你是「军师」会话索引的滚动合并器。把【当前活跃态】与【本段增量】合并为下一版受限活跃态。

只保留仍值得跨轮使用的：客户事实、目标、约束、最新经营数据、已拍板决策、未完成行动和待确认问题。历史建议、已完成行动、重复表述优先删除；同一事实有新旧说法时保留较新的说法，必要时保留冲突说明。

硬规则：
1. 最多 ${MAX_ACTIVE_ITEMS} 条；每条 text ≤80 字；kind 仍只能用既有十种类型。
2. sourceMessageIds 只能从输入条目已有的来源 id 中选择，最多 8 个；必须至少保留一个可验证来源，禁止编造。
3. 合并相近条目时保留最能支撑结论的来源；不要输出任何没有来源的概括。
4. 只输出 JSON：{"items":[{"kind":"fact","text":"…","sourceMessageIds":["…"]}]}。`;

function compactBlock(items: SessionDigestItem[]): string {
  return items.map((item, index) => `[${index}] ${item.kind} ${item.at} ${item.text} | sources=${item.sourceMessageIds.join(',')}`).join('\n');
}

const defaultCompactor: DigestCompactor = async ({ active, segment }) => structured(ExtractResultZ, {
  system: COMPACT_SYS,
  user: `【当前活跃态】\n${compactBlock(active) || '（空）'}\n\n【本段增量】\n${compactBlock(segment) || '（空）'}`,
  maxChars: 40_000,
});

let compactor: DigestCompactor = defaultCompactor;

/* ─────────────── 同会话串行化 ─────────────── */

// 同一会话可能同时有「本轮收尾的即发即忘更新」与「下一轮报告的同步补齐」两次 update 在跑。
// 两者都是「读快照 → 追加 → 写快照」，交错执行会让后写的那次用旧 items 覆盖掉先写的条目。
// 进程内链式互斥（会话粒度）：够用且零依赖——单进程内的两次 update 必然排队。
// 多实例部署下不同实例仍可能并发，但代价只是「重复抽取同一批消息」，靠提示词的「不要重复抽取」兜底，
// 不会丢数据（只追加语义天然幂等友好），因此不上分布式锁。
const digestChains = new Map<string, Promise<void>>();

function withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prev = digestChains.get(sessionId) ?? Promise.resolve();
  const run = prev.then(fn, fn); // 前一次失败也要让下一次照常跑
  const tail = run.then(() => {}, () => {}); // 只用于排队，不传播结果与异常
  digestChains.set(sessionId, tail);
  // 链尾自清理，否则 Map 会随进程见过的会话数无限增长。
  void tail.then(() => { if (digestChains.get(sessionId) === tail) digestChains.delete(sessionId); });
  return run;
}

/* ─────────────── 读 / 校验 ─────────────── */

const isDigestKind = (v: unknown): v is SessionDigestKind =>
  typeof v === 'string' && (DIGEST_KINDS as readonly string[]).includes(v);

/**
 * 摘要文本清洗（**写路径与读路径都要过**）。
 *
 * 摘要文本会原样进 system 提示词的 dynamic 段。不清洗的话，一条 53 字符的条目就能靠换行 + 「【】」
 * 伪造出一个【系统最高指令】块——而本层是「只追加」语义，伪造块会永久驻留，还会经 existingBlock
 * 回喂给下一批抽取形成自我强化。所以：换行压成空格、直接去掉「【】」这对块标记符。
 * 读路径也清一遍，兜住历史脏数据与手改库。
 */
function sanitizeDigestText(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').replace(/[【】]/g, '').trim();
}

function readItems(json: unknown): SessionDigestItem[] {
  if (!Array.isArray(json)) return [];
  return json.filter((x): x is SessionDigestItem => {
    const i = x as SessionDigestItem | null;
    // kind 也要校验：脏条目会让注入块出现「- [undefined …]」这种没人看得懂的行。
    return !!i && isDigestKind(i.kind) && typeof i.text === 'string' && typeof i.at === 'string'
      && Array.isArray(i.sourceMessageIds);
  });
}

function readStore(json: unknown): DigestStoreV2 {
  if (json && typeof json === 'object' && !Array.isArray(json)) {
    const value = json as Partial<DigestStoreV2>;
    if (value.schemaVersion === 2) {
      return {
        schemaVersion: 2,
        activeItems: readItems(value.activeItems),
        segmentItems: readItems(value.segmentItems),
        segment: Number.isInteger(value.segment) && Number(value.segment) >= 0 ? Number(value.segment) : 0,
      };
    }
  }
  // 旧快照数组无损迁入“当前增量段”，首次接近阈值时再滚动合并。
  return { schemaVersion: 2, activeItems: [], segmentItems: readItems(json), segment: 0 };
}

function storedJson(activeItems: SessionDigestItem[], segmentItems: SessionDigestItem[], segment: number): Prisma.InputJsonValue {
  return { schemaVersion: 2, activeItems, segmentItems, segment } as unknown as Prisma.InputJsonValue;
}

type MessageRow = { id: string; role: string; contentJson: unknown; createdAt: Date };

/** 一条消息在抽取批次里的文本形态。report 折叠成标题+小节标题（与 routes/sessions.ts historyMessage 同口径）。 */
function batchText(row: MessageRow): string {
  const c = row.contentJson as { text?: string; title?: string; sections?: { h?: string }[] } | null;
  if (row.role === 'report') {
    const heads = (c?.sections ?? []).map((s) => s.h).filter(Boolean).join('、');
    return `已产出《${c?.title ?? '成果'}》${heads ? '：' + heads : ''}`;
  }
  const raw = (c?.text ?? '').trim();
  return raw.length > 600 ? `${raw.slice(0, 600)}…` : raw;
}

/**
 * 代码级校验（不能只信提示词）：截断到每批上限、丢弃引用了批外消息 id 的条目（防伪造溯源）、
 * clamp 文本长度、at 由最早来源消息的 createdAt 算出。
 */
function acceptItems(raw: DigestExtraction['items'], batchRows: MessageRow[]): SessionDigestItem[] {
  const createdAtById = new Map(batchRows.map((r) => [r.id, r.createdAt]));
  const out: SessionDigestItem[] = [];
  for (const it of raw.slice(0, MAX_ITEMS_PER_BATCH)) {
    if (!isDigestKind(it?.kind)) continue;
    const ids = [...new Set(it.sourceMessageIds ?? [])];
    if (!ids.length || ids.length > MAX_SOURCE_IDS) continue;
    if (ids.some((id) => !createdAtById.has(id))) continue; // 批外 id：整条丢弃
    // 先清洗再截断：截断在清洗前做的话，去掉换行/块标记后长度会缩水，160 的口径就不准了。
    const text = sanitizeDigestText(it.text ?? '').slice(0, MAX_ITEM_CHARS);
    if (!text) continue;
    const earliest = Math.min(...ids.map((id) => createdAtById.get(id)!.getTime()));
    out.push({ kind: it.kind, text, sourceMessageIds: ids, at: new Date(earliest).toISOString() });
  }
  return out;
}

function acceptCompactedItems(raw: DigestExtraction['items'], existing: SessionDigestItem[]): SessionDigestItem[] {
  const atBySource = new Map<string, number>();
  for (const item of existing) for (const id of item.sourceMessageIds) {
    const at = new Date(item.at).getTime();
    if (Number.isFinite(at)) atBySource.set(id, Math.min(atBySource.get(id) ?? at, at));
  }
  const out: SessionDigestItem[] = [];
  const seen = new Set<string>();
  for (const item of raw.slice(0, MAX_ACTIVE_ITEMS)) {
    if (!isDigestKind(item?.kind)) continue;
    const ids = [...new Set(item.sourceMessageIds ?? [])];
    if (!ids.length || ids.length > MAX_SOURCE_IDS || ids.some((id) => !atBySource.has(id))) continue;
    const text = sanitizeDigestText(item.text ?? '').slice(0, MAX_ITEM_CHARS);
    if (!text) continue;
    const key = `${item.kind}\u0000${text}\u0000${ids.join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: item.kind, text, sourceMessageIds: ids, at: new Date(Math.min(...ids.map((id) => atBySource.get(id)!))).toISOString() });
  }
  return out;
}

/* ─────────────── 抽取持续失败的止血 ─────────────── */

// 为什么需要熔断：structured() 内部把异常全兜住、只返回 null，所以「抽不出来」和「上游一直 429/超时」
// 在调用方眼里长得一模一样。没有止血的话，同一个毒批次（内容触发审核、或上游持续故障）会在**每一轮**
// 对话里重烧 2 次真实调用（structured 自带一轮纠错重试），既烧钱又零告警。
// 连续 3 次拿到 null → 冷却 10 分钟，冷却期直接返回现状、根本不触发抽取；任意一次成功即清零。
const MAX_CONSECUTIVE_FAILURES = 3;
const FAILURE_COOLDOWN_MS = 10 * 60_000;
const extractFailures = new Map<string, { failures: number; nextTryAt: number; touchedAt: number }>();

function inExtractCooldown(sessionId: string): boolean {
  const rec = extractFailures.get(sessionId);
  return !!rec && rec.nextTryAt > Date.now();
}

function noteExtractOutcome(sessionId: string, ok: boolean, cursor: Date | null): void {
  if (ok) { extractFailures.delete(sessionId); return; }
  const now = Date.now();
  const rec = extractFailures.get(sessionId) ?? { failures: 0, nextTryAt: 0, touchedAt: now };
  rec.failures += 1;
  rec.touchedAt = now;
  if (rec.failures >= MAX_CONSECUTIVE_FAILURES) {
    rec.nextTryAt = now + FAILURE_COOLDOWN_MS;
    // 进冷却时告警一次（冷却期不再触发抽取，故不会刷屏）。带上游标位置，便于定位是哪批消息有毒。
    console.warn(`[sessionDigest] 会话 ${sessionId} 连续 ${rec.failures} 次抽取无结果，冷却 ${FAILURE_COOLDOWN_MS / 60_000} 分钟；游标=${cursor ? cursor.toISOString() : '(空，尚未消化过)'}`);
  }
  extractFailures.set(sessionId, rec);
  // 只在失败时才建条目，健康时这张表是空的；异常期给它一个上界，别让它随会话数无限长。
  if (extractFailures.size > 1_000) {
    for (const [k, v] of extractFailures) {
      if (v.touchedAt < now - FAILURE_COOLDOWN_MS * 2) extractFailures.delete(k);
    }
  }
}

/* ─────────────── 对外接口 ─────────────── */

/**
 * 增量更新会话快照：只处理游标之后的新消息，分批抽取，追加落库。
 * caughtUp=false 表示还有消息没消化完（本次批数用尽 / 抽取器不可用 / 条目到顶），调用方可再调一次。
 */
export async function updateSessionDigest(p: {
  tenantId: string;
  userId: string;
  sessionId: string;
  maxBatches?: number;
}): Promise<SessionDigestState> {
  const result = await withSessionLock(p.sessionId, async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return await runUpdate(p); }
      catch (error) {
        if (!(error instanceof DigestSnapshotConflictError) || attempt === 2) throw error;
      }
    }
    throw new DigestSnapshotConflictError();
  });
  noteSessionDigestState(result.status, result.items.length, result.pendingMessages);
  return result;
}

/**
 * 把 rows 切成固定批。游标已是 (createdAt,id) 复合键，同毫秒消息可安全跨批。
 */
function sliceBatches(rows: MessageRow[]): MessageRow[][] {
  const out: MessageRow[][] = [];
  let i = 0;
  while (i < rows.length) {
    const end = Math.min(i + BATCH_MESSAGES, rows.length);
    out.push(rows.slice(i, end));
    i = end;
  }
  return out;
}

function afterCursor(lastMessageAt: Date | null, lastMessageId: string | null): Prisma.MessageWhereInput {
  if (!lastMessageAt) return {};
  if (!lastMessageId) return { createdAt: { gt: lastMessageAt } }; // 兼容迁移前只写时间的旧快照
  return {
    OR: [
      { createdAt: { gt: lastMessageAt } },
      { createdAt: lastMessageAt, id: { gt: lastMessageId } },
    ],
  };
}

async function pendingMessageCount(sessionId: string, at: Date | null, id: string | null): Promise<number> {
  return prisma.message.count({
    where: {
      sessionId,
      role: { in: ['user', 'assistant', 'report'] },
      ...afterCursor(at, id),
    },
  });
}

function stateOf(args: {
  activeItems: SessionDigestItem[];
  segmentItems: SessionDigestItem[];
  segment: number;
  version: number;
  status: SessionDigestStatus;
  lastMessageAt: Date | null;
  lastMessageId: string | null;
  pendingMessages: number;
}): SessionDigestState {
  const items = [...args.activeItems, ...args.segmentItems];
  return {
    items,
    version: args.version,
    caughtUp: args.status === 'caught_up',
    status: args.status,
    coveredThroughMessageId: args.lastMessageId,
    coveredThroughAt: args.lastMessageAt?.toISOString() ?? null,
    pendingMessages: args.pendingMessages,
    activeItems: args.activeItems,
    segmentItems: args.segmentItems,
    segment: args.segment,
  };
}

class DigestSnapshotConflictError extends Error {
  constructor() { super('session digest snapshot changed concurrently'); }
}

async function persistSnapshot(args: {
  exists: boolean;
  sessionId: string;
  tenantId: string;
  userId: string;
  expectedVersion: number;
  lastMessageId: string | null;
  lastMessageAt: Date | null;
  activeItems: SessionDigestItem[];
  segmentItems: SessionDigestItem[];
  segment: number;
}): Promise<number> {
  const version = args.expectedVersion + 1;
  const data = {
    version,
    lastMessageId: args.lastMessageId,
    lastMessageAt: args.lastMessageAt,
    itemsJson: storedJson(args.activeItems, args.segmentItems, args.segment),
  };
  if (args.exists) {
    const updated = await prisma.sessionContextSnapshot.updateMany({
      where: { sessionId: args.sessionId, version: args.expectedVersion },
      data,
    });
    if (updated.count !== 1) throw new DigestSnapshotConflictError();
    return version;
  }
  try {
    await prisma.sessionContextSnapshot.create({
      data: {
        sessionId: args.sessionId, tenantId: args.tenantId, userId: args.userId,
        ...data,
      },
    });
    return version;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new DigestSnapshotConflictError();
    throw error;
  }
}

async function runUpdate(p: {
  tenantId: string; userId: string; sessionId: string; maxBatches?: number;
}): Promise<SessionDigestState> {
  const snap = await prisma.sessionContextSnapshot.findUnique({ where: { sessionId: p.sessionId } });
  // 归属校验：快照行自带 userId，对不上说明调用方传错了会话（越权或串号），一律不写、也不回传条目。
  if (snap && snap.userId !== p.userId) {
    console.warn(`[sessionDigest] 会话 ${p.sessionId} 快照归属不符（快照属于 ${snap.userId}，调用方 ${p.userId}），拒绝更新`);
    return stateOf({ activeItems: [], segmentItems: [], segment: 0, version: snap.version, status: 'failed', lastMessageAt: snap.lastMessageAt, lastMessageId: snap.lastMessageId, pendingMessages: 0 });
  }
  const store = readStore(snap?.itemsJson);
  let activeItems = store.activeItems;
  let segmentItems = store.segmentItems;
  let segment = store.segment;
  let snapshotExists = Boolean(snap);
  let version = snap?.version ?? 0;
  let cursorAt = snap?.lastMessageAt ?? null;
  let cursorId = snap?.lastMessageId ?? null;

  // 先滚动合并再读新消息：合并失败不推进消息游标；成功后即使进程在下一批抽取前退出，
  // 新活跃态也已按版本 CAS 原子落库，下次可从原游标继续。
  if (activeItems.length + segmentItems.length >= COMPACT_TOTAL_THRESHOLD) {
    let result: DigestExtraction | null = null;
    try { result = await compactor({ active: activeItems, segment: segmentItems }); } catch { result = null; }
    const compacted = result ? acceptCompactedItems(result.items ?? [], [...activeItems, ...segmentItems]) : [];
    if (!result || (!compacted.length && activeItems.length + segmentItems.length > 0)) {
      noteSessionDigestCompaction('failed');
      const count = await pendingMessageCount(p.sessionId, cursorAt, cursorId);
      const status: SessionDigestStatus = activeItems.length + segmentItems.length >= MAX_ITEMS_TOTAL ? 'capped' : 'failed';
      return stateOf({ activeItems, segmentItems, segment, version, status, lastMessageAt: cursorAt, lastMessageId: cursorId, pendingMessages: count });
    }
    version = await persistSnapshot({
      exists: snapshotExists, sessionId: p.sessionId, tenantId: p.tenantId, userId: p.userId,
      expectedVersion: version, lastMessageId: cursorId, lastMessageAt: cursorAt,
      activeItems: compacted, segmentItems: [], segment: segment + 1,
    });
    noteSessionDigestCompaction('succeeded');
    snapshotExists = true;
    activeItems = compacted;
    segmentItems = [];
    segment += 1;
  }

  const maxBatches = Math.max(1, p.maxBatches ?? DEFAULT_MAX_BATCHES);
  const capacity = maxBatches * BATCH_MESSAGES; // 本次最多消化多少条消息
  // 多取 1 条判断本次处理后是否还有剩余；复合游标不再需要整组同毫秒余量。
  const takeLimit = capacity + 1;
  const where: Prisma.MessageWhereInput = {
    sessionId: p.sessionId,
    role: { in: ['user', 'assistant', 'report'] },
    ...afterCursor(cursorAt, cursorId),
  };
  const select = { id: true, role: true, contentJson: true, createdAt: true } as const;
  const rows: MessageRow[] = await prisma.message.findMany({
    where, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: takeLimit, select,
  });
  const hasMore = rows.length > capacity;
  const pending = rows.slice(0, capacity);
  if (!pending.length) return stateOf({ activeItems, segmentItems, segment, version, status: 'caught_up', lastMessageAt: cursorAt, lastMessageId: cursorId, pendingMessages: 0 });

  // 熔断冷却期：直接返回现状，一次真实调用都不发（见 noteExtractOutcome 的注释）。
  if (inExtractCooldown(p.sessionId)) {
    const count = await pendingMessageCount(p.sessionId, cursorAt, cursorId);
    return stateOf({ activeItems, segmentItems, segment, version, status: 'cooldown', lastMessageAt: cursorAt, lastMessageId: cursorId, pendingMessages: count });
  }

  let stoppedStatus: SessionDigestStatus | null = null;
  for (const batchRows of sliceBatches(pending)) {
    const items = [...activeItems, ...segmentItems];
    if (items.length >= MAX_ITEMS_TOTAL) {
      console.warn(`[sessionDigest] 会话 ${p.sessionId} 摘要条目已达上限 ${MAX_ITEMS_TOTAL}，停止继续抽取（待实现合并/压缩）`);
      stoppedStatus = 'capped';
      break;
    }
    const batch: DigestBatchMessage[] = batchRows
      .map((r) => ({ id: r.id, role: r.role, text: batchText(r), at: r.createdAt }))
      .filter((m) => !!m.text);

    let result: DigestExtraction | null = null;
    if (batch.length) {
      // structured() 内部已经把异常全兜住（只返回 null），这层 try 是给注入的抽取器和将来换实现留的保险：
      // 摘要是增强层，抽取器抛什么都不能掀翻生成主流程。可观测性统一由下面的失败计数承担。
      try {
        result = await extractor({ existing: items, batch });
      } catch {
        result = null;
      }
    } else {
      result = { items: [] }; // 整批都是空文本消息：没什么可抽的，但游标要照常推进
    }

    if (!result) {
      // 无 live provider / 抽取失败 → 不落伪造条目，也不推进游标（推进了这批就永久没人再抽）。
      noteExtractOutcome(p.sessionId, false, cursorAt);
      stoppedStatus = 'failed';
      break;
    }
    noteExtractOutcome(p.sessionId, true, cursorAt);

    const accepted = acceptItems(result.items ?? [], batchRows);
    const remainingSlots = Math.max(0, MAX_ITEMS_TOTAL - items.length);
    segmentItems = [...segmentItems, ...accepted.slice(0, remainingSlots)];
    const last = batchRows[batchRows.length - 1];
    cursorAt = last.createdAt;
    cursorId = last.id;
    version = await persistSnapshot({
      exists: snapshotExists, sessionId: p.sessionId, tenantId: p.tenantId, userId: p.userId,
      expectedVersion: version, lastMessageId: cursorId, lastMessageAt: cursorAt,
      activeItems, segmentItems, segment,
    });
    snapshotExists = true;
  }

  const status: SessionDigestStatus = stoppedStatus ?? (hasMore ? 'pending' : 'caught_up');
  const count = status === 'caught_up' ? 0 : await pendingMessageCount(p.sessionId, cursorAt, cursorId);
  return stateOf({ activeItems, segmentItems, segment, version, status, lastMessageAt: cursorAt, lastMessageId: cursorId, pendingMessages: count });
}

/** 纯读快照（不触发任何 LLM 调用）。无快照或归属不符 → null（userId 直接进 where，不给越权读的机会）。 */
export async function readSessionDigest(
  sessionId: string,
  userId: string,
): Promise<SessionDigestState | null> {
  const snap = await prisma.sessionContextSnapshot.findFirst({
    where: { sessionId, userId },
    select: { itemsJson: true, version: true, lastMessageId: true, lastMessageAt: true },
  });
  if (!snap) return null;
  const store = readStore(snap.itemsJson);
  const items = [...store.activeItems, ...store.segmentItems];
  const pendingMessages = await pendingMessageCount(sessionId, snap.lastMessageAt, snap.lastMessageId);
  const status: SessionDigestStatus = pendingMessages === 0 ? 'caught_up' : items.length >= MAX_ITEMS_TOTAL ? 'capped' : 'pending';
  return stateOf({
    activeItems: store.activeItems, segmentItems: store.segmentItems, segment: store.segment,
    version: snap.version, status,
    lastMessageAt: snap.lastMessageAt, lastMessageId: snap.lastMessageId, pendingMessages,
  });
}

/* ─────────────── 注入块渲染（纯函数） ─────────────── */

const DIGEST_HEAD = '【会话既往脉络（系统按时间提取的结构化索引；事实以原始对话为准，前后矛盾处以时间靠后的为准但均已列出）】';
/** 注入总长上限：超了先整类丢低优先级，goal/fact/metric/decision/constraint 最后保。 */
const DIGEST_CHAR_CAP = 4_000;
const DROP_ORDER: SessionDigestKind[] = ['quote', 'deliverable_ref', 'advice', 'open_question', 'action_item'];

// 读路径同样清洗：写路径之前落下的脏条目、以及任何绕过写路径改库的内容，都不许把块标记带进 system 段。
const lineOf = (i: SessionDigestItem): string =>
  `- [${KIND_LABEL[i.kind] ?? i.kind} ${monthDayOf(i.at)}] ${sanitizeDigestText(i.text)}`;

/**
 * 组装注入 system 提示词的会话脉络块。空数组 → null（不注入空块）。
 * 按 at 升序（矛盾条目靠时间先后自证），总长超 cap 时按优先级丢整类并在块尾如实说明丢了多少。
 */
export function formatDigestBlock(items: SessionDigestItem[]): string | null {
  if (!items.length) return null;
  let kept = [...items].sort((a, b) => a.at.localeCompare(b.at));
  let lowDropped = 0;
  let oldDropped = 0;

  const notes = (): string[] => {
    const out: string[] = [];
    if (lowDropped) out.push(`（另有 ${lowDropped} 条较低优先级条目未列出）`);
    if (oldDropped) out.push(`（另有 ${oldDropped} 条较早条目未列出）`);
    return out;
  };
  const render = (): string => [DIGEST_HEAD, ...kept.map(lineOf), ...notes()].join('\n');

  for (const kind of DROP_ORDER) {
    if (render().length <= DIGEST_CHAR_CAP) break;
    const next = kept.filter((i) => i.kind !== kind);
    lowDropped += kept.length - next.length;
    kept = next;
  }
  // 只剩高优先级仍然超限：从最早的开始丢，保住时间靠后的（新说法优先于旧说法）。
  // 这条不在原始规格里，但 cap 不兜底就不是 cap——高优先级条目本身撑爆 4000 时得有个收口。
  while (kept.length > 1 && render().length > DIGEST_CHAR_CAP) {
    kept = kept.slice(1);
    oldDropped += 1;
  }
  return render();
}
