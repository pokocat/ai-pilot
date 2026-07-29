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
import type { SessionDigestItem, SessionDigestKind } from '../../../shared/contracts';

export type { SessionDigestItem, SessionDigestKind };

const BATCH_MESSAGES = 20;        // 每批喂给抽取器的消息条数
const DEFAULT_MAX_BATCHES = 5;    // 单次调用最多处理几批（报告轮传 3，控制同步补齐的延迟）
const MAX_ITEMS_PER_BATCH = 10;   // 每批最多采纳几条（多了截断——一批 20 条消息抽不出 10 条以上的硬信息）
const MAX_SOURCE_IDS = 8;
const MAX_ITEM_CHARS = 160;       // 提示词要 ≤80 字，代码侧按 160 字符 clamp（模型超一点不至于整条丢）
/** 条目总量上限。到顶只停抽取、不丢既有条目——合并/压缩是后续工作，先守住上限别让注入无限膨胀。 */
const MAX_ITEMS_TOTAL = 400;

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

/** 测试 seam：注入确定性抽取器，不触真实模型（参照 alertConfig.__setFeishuTransportForTest 先例）。 */
export function __setDigestExtractorForTest(fn: DigestExtractor | null): void {
  extractor = fn ?? defaultExtractor;
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
}): Promise<{ items: SessionDigestItem[]; version: number; caughtUp: boolean }> {
  return withSessionLock(p.sessionId, () => runUpdate(p));
}

/**
 * 把 rows 切成批。每批 ≤20 条，但**绝不从同毫秒组中间切开**——游标是 (createdAt 严格大于)，
 * 从同毫秒组中间断开会让该组剩下的兄弟消息被下一次查询直接跳过（永久漏采）。
 * 代价是跨组的那一批可能略超 20 条，这个方向的偏差无害。
 */
function sliceBatches(rows: MessageRow[]): MessageRow[][] {
  const out: MessageRow[][] = [];
  let i = 0;
  while (i < rows.length) {
    let end = Math.min(i + BATCH_MESSAGES, rows.length);
    end = extendToMillisecondBoundary(rows, end);
    out.push(rows.slice(i, end));
    i = end;
  }
  return out;
}

/** 把切点往后推到「与 rows[end-1] 同毫秒的消息全部包含进来」为止。 */
function extendToMillisecondBoundary(rows: MessageRow[], end: number): number {
  if (end <= 0 || end >= rows.length) return end;
  const boundary = rows[end - 1].createdAt.getTime();
  let out = end;
  while (out < rows.length && rows[out].createdAt.getTime() === boundary) out++;
  return out;
}

async function runUpdate(p: {
  tenantId: string; userId: string; sessionId: string; maxBatches?: number;
}): Promise<{ items: SessionDigestItem[]; version: number; caughtUp: boolean }> {
  const snap = await prisma.sessionContextSnapshot.findUnique({ where: { sessionId: p.sessionId } });
  // 归属校验：快照行自带 userId，对不上说明调用方传错了会话（越权或串号），一律不写、也不回传条目。
  if (snap && snap.userId !== p.userId) {
    console.warn(`[sessionDigest] 会话 ${p.sessionId} 快照归属不符（快照属于 ${snap.userId}，调用方 ${p.userId}），拒绝更新`);
    return { items: [], version: snap.version, caughtUp: false };
  }
  let items = readItems(snap?.itemsJson);
  let version = snap?.version ?? 0;
  const cursor = snap?.lastMessageAt ?? null;

  const maxBatches = Math.max(1, p.maxBatches ?? DEFAULT_MAX_BATCHES);
  const capacity = maxBatches * BATCH_MESSAGES; // 本次最多消化多少条消息
  // 多取一批余量：既用来判断「本次处理完是否还有剩余」，也留出把 capacity 边界上的同毫秒组补齐的空间。
  const takeLimit = capacity + BATCH_MESSAGES + 1;
  const where = {
    sessionId: p.sessionId,
    role: { in: ['user', 'assistant', 'report'] },
    ...(cursor ? { createdAt: { gt: cursor } } : {}),
  };
  const select = { id: true, role: true, contentJson: true, createdAt: true } as const;
  let rows: MessageRow[] = await prisma.message.findMany({
    where, orderBy: { createdAt: 'asc' }, take: takeLimit, select,
  });

  // 本次要消化到哪：先按 capacity 截，再把边界上的同毫秒组补完整（同上，切在组中间=永久漏采）。
  let end = extendToMillisecondBoundary(rows, Math.min(capacity, rows.length));
  // 极端情况：整批余量都被同一毫秒占满，组在取数窗口处仍未闭合。补一次针对该毫秒的精确查询把组取全，
  // 否则推进游标就会把该组剩余部分永久跳过。（现实里同一毫秒 20+ 条只可能出现在批量造数场景。）
  if (end === rows.length && rows.length === takeLimit) {
    const groupAt = rows[rows.length - 1].createdAt;
    const whole: MessageRow[] = await prisma.message.findMany({
      where: { ...where, createdAt: groupAt }, orderBy: { id: 'asc' }, select,
    });
    const seen = new Set(rows.map((r) => r.id));
    rows = [...rows, ...whole.filter((r) => !seen.has(r.id))];
    end = rows.length;
  }
  const hasMore = rows.length > end;
  const pending = rows.slice(0, end);
  if (!pending.length) return { items, version, caughtUp: true };

  // 熔断冷却期：直接返回现状，一次真实调用都不发（见 noteExtractOutcome 的注释）。
  if (inExtractCooldown(p.sessionId)) return { items, version, caughtUp: false };

  let stopped = false;
  for (const batchRows of sliceBatches(pending)) {
    if (items.length >= MAX_ITEMS_TOTAL) {
      console.warn(`[sessionDigest] 会话 ${p.sessionId} 摘要条目已达上限 ${MAX_ITEMS_TOTAL}，停止继续抽取（待实现合并/压缩）`);
      stopped = true;
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
      noteExtractOutcome(p.sessionId, false, cursor);
      stopped = true;
      break;
    }
    noteExtractOutcome(p.sessionId, true, cursor);

    items = [...items, ...acceptItems(result.items ?? [], batchRows)];
    version += 1;
    const last = batchRows[batchRows.length - 1];
    await prisma.sessionContextSnapshot.upsert({
      where: { sessionId: p.sessionId },
      create: {
        sessionId: p.sessionId, tenantId: p.tenantId, userId: p.userId,
        version, lastMessageId: last.id, lastMessageAt: last.createdAt,
        itemsJson: items as unknown as Prisma.InputJsonValue,
      },
      update: {
        version, lastMessageId: last.id, lastMessageAt: last.createdAt,
        itemsJson: items as unknown as Prisma.InputJsonValue,
      },
    });
  }

  return { items, version, caughtUp: !stopped && !hasMore };
}

/** 纯读快照（不触发任何 LLM 调用）。无快照或归属不符 → null（userId 直接进 where，不给越权读的机会）。 */
export async function readSessionDigest(
  sessionId: string,
  userId: string,
): Promise<{ items: SessionDigestItem[]; version: number } | null> {
  const snap = await prisma.sessionContextSnapshot.findFirst({
    where: { sessionId, userId },
    select: { itemsJson: true, version: true },
  });
  if (!snap) return null;
  return { items: readItems(snap.itemsJson), version: snap.version };
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
