// 版本化报告服务：按「报告名(slug)」归一，同名再产出/编辑 = 新版本；
// 内容哈希去重（同内容不重复成版），并自动生成「相对上一版」的变更摘要 + section 级 diff。
//
// 取舍：报告是小 JSON 文档，最务实的是「全量快照 + 内容寻址去重 + 读时实时 diff」，
// 无需 Dolt/prolly-tree 这类给 TB 级表行 diff 的重型方案。

import { createHash } from 'node:crypto';
import { prisma } from '../db.js';
import type { Prisma } from '@prisma/client';
import { notifyReportReady } from './wechatSubscribe.js';
import type {
  Deliverable, DeliverableSection, ReportDiff, SectionDiff, WordOp, SaveReportResult,
} from '../llm/schema.js';

// —— 词级 diff（LCS）：把一段 section 的文本细到「句内增删」高亮 ——
function tokenize(s: string): string[] {
  return s.match(/[a-z0-9]+|[一-鿿]|[^\sa-z0-9一-鿿]+|\s+/gi) ?? [];
}
export function wordDiff(before: string, after: string): WordOp[] {
  const a = tokenize(before), b = tokenize(after);
  const n = a.length, m = b.length;
  // LCS 长度表
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops: WordOp[] = [];
  const push = (t: WordOp['t'], s: string) => {
    const last = ops[ops.length - 1];
    if (last && last.t === t) last.s += s; else ops.push({ t, s });
  };
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { push('eq', a[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { push('del', a[i]); i++; }
    else { push('add', b[j]); j++; }
  }
  while (i < n) { push('del', a[i]); i++; }
  while (j < m) { push('add', b[j]); j++; }
  return ops;
}
function sectionText(sec?: DeliverableSection): string {
  if (!sec) return '';
  return [sec.b, ...(sec.list ?? [])].filter(Boolean).join('\n');
}

/** 报告名归一化：去空白、压多空格、截断；中文保留，拉丁转小写。 */
export function slugify(title: string): string {
  return (title || '未命名报告')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\w一-鿿-]/g, '')
    .slice(0, 80) || 'report';
}

// 稳定序列化（键排序）→ 内容哈希，保证同内容 = 同 hash。
function canonical(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(canonical).join(',')}]`;
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((obj as Record<string, unknown>)[k])}`).join(',')}}`;
}
function hashContent(content: object): string {
  return createHash('sha256').update(canonical(content)).digest('hex');
}

function sectionsOf(content: unknown): DeliverableSection[] {
  const c = content as { sections?: DeliverableSection[] } | null;
  return c?.sections ?? [];
}
function sameSection(a: DeliverableSection, b: DeliverableSection): boolean {
  return canonical(a) === canonical(b);
}

/** 计算 from→to 两版的 section 级差异。 */
export function diffContents(before: object, after: object): { sections: SectionDiff[]; summary: string; titleBefore: string; titleAfter: string } {
  const bs = sectionsOf(before);
  const as = sectionsOf(after);
  // 报告 V2 的 quote/letter 等 section 按设计没有 h（不用标题），s.h 恒为 undefined；
  // 若直接用 s.h 当 key，同一版里出现多个无 h 的 section（如两段 quote）会全部折叠进
  // 同一个 undefined key，互相覆盖、错配 diff。无 h 时按「同 type 内第几个出现」兜底出
  // 一个稳定 key，保证前后版按位置配对，不与其它 section 冲突。每次调用 makeKeyer() 起一套
  // 独立计数器，分别应用到 before/after 两个数组，互不干扰。
  const makeKeyer = () => {
    const seenTypeIdx = new Map<string, number>();
    return (s: DeliverableSection): string => {
      if (s.h) return s.h;
      const type = (s as { type?: string }).type ?? '';
      const idx = seenTypeIdx.get(type) ?? 0;
      seenTypeIdx.set(type, idx + 1);
      return `__untitled_${type}_${idx}`;
    };
  };
  const toMap = (arr: DeliverableSection[]) => {
    const keyer = makeKeyer();
    return new Map(arr.map((s) => [keyer(s), s]));
  };
  const bMap = toMap(bs);
  const aMap = toMap(as);

  const out: SectionDiff[] = [];
  let added = 0, removed = 0, changed = 0;

  // 以「新版顺序」为主轴，标 新增/修改/未变
  const keyOfAfter = makeKeyer();
  for (const s of as) {
    const prev = bMap.get(keyOfAfter(s));
    if (!prev) { out.push({ change: 'added', h: s.h ?? '', after: s }); added++; }
    else if (!sameSection(prev, s)) { out.push({ change: 'changed', h: s.h ?? '', before: prev, after: s, words: wordDiff(sectionText(prev), sectionText(s)) }); changed++; }
    else out.push({ change: 'unchanged', h: s.h ?? '', before: prev, after: s });
  }
  // 旧版有、新版没有 = 删除
  const keyOfBefore = makeKeyer();
  for (const s of bs) {
    if (!aMap.has(keyOfBefore(s))) { out.push({ change: 'removed', h: s.h ?? '', before: s }); removed++; }
  }

  const titleBefore = (before as { title?: string }).title ?? '';
  const titleAfter = (after as { title?: string }).title ?? '';
  const parts = [`新增 ${added} 段`, `修改 ${changed} 段`, `删除 ${removed} 段`];
  if (titleBefore && titleAfter && titleBefore !== titleAfter) parts.unshift('标题有变');
  const summary = parts.join(' · ');
  return { sections: out, summary, titleBefore, titleAfter };
}

export interface SaveVersionOpts {
  tenantId: string;
  userId: string;
  projectId?: string | null;
  title: string;
  type: string;
  agentKey?: string | null;
  content: object; // Deliverable
  authorKind?: 'agent' | 'user';
  sessionId?: string | null;
}

async function lockReportVersion(db: Prisma.TransactionClient, tenantId: string, slug: string): Promise<void> {
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`report:${tenantId}:${slug}`}))`;
}

/** 保存一版报告：同名归一、同内容去重、自动变更摘要。返回 {reportId, version, created, changed}。 */
export async function saveReportVersion(opts: SaveVersionOpts): Promise<SaveReportResult & { reportId: string }> {
  const slug = slugify(opts.title);
  const hash = hashContent(opts.content);

  const saved = await prisma.$transaction(async (tx) => {
    await lockReportVersion(tx, opts.tenantId, slug);

    let doc = await tx.reportDoc.findFirst({ where: { tenantId: opts.tenantId, slug } });
    let created = false;
    if (!doc) {
      doc = await tx.reportDoc.create({
        data: {
          tenantId: opts.tenantId,
          userId: opts.userId,
          projectId: opts.projectId ?? null,
          title: opts.title,
          slug,
          type: opts.type,
          agentKey: opts.agentKey ?? null,
          currentVersion: 0,
        },
      });
      created = true;
    }

    // 内容未变（与最新版同 hash）→ 不重复成版
    const latest = await tx.reportVersion.findFirst({
      where: { reportId: doc.id },
      orderBy: { version: 'desc' },
    });
    if (latest && latest.contentHash === hash) {
      return { reportId: doc.id, version: latest.version, created, changed: false };
    }

    // 变更摘要：相对上一版
    let changeSummary: string | null = created ? '首个版本' : null;
    if (latest) {
      changeSummary = diffContents(latest.contentJson as object, opts.content).summary;
    }

    const nextVersion = (doc.currentVersion ?? 0) + 1;
    await tx.reportVersion.create({
      data: {
        reportId: doc.id,
        version: nextVersion,
        title: opts.title,
        contentJson: opts.content,
        contentHash: hash,
        changeSummary,
        authorKind: opts.authorKind ?? 'agent',
        sessionId: opts.sessionId ?? null,
      },
    });
    await tx.reportDoc.update({
      where: { id: doc.id },
      data: {
        currentVersion: nextVersion,
        title: opts.title,
        type: opts.type,
        ...(opts.projectId ? { projectId: opts.projectId } : {}),
        ...(opts.agentKey ? { agentKey: opts.agentKey } : {}),
      },
    });

    return { reportId: doc.id, version: nextVersion, created, changed: true };
  });
  if (saved.changed) {
    notifyReportReady({ tenantId: opts.tenantId, userId: opts.userId, title: opts.title, reportId: saved.reportId });
  }
  return saved;
}

/** 取两版差异（读时实时计算）。 */
export async function getReportDiff(
  tenantId: string, reportId: string, from: number, to: number,
): Promise<ReportDiff | null> {
  const doc = await prisma.reportDoc.findFirst({ where: { id: reportId, tenantId } });
  if (!doc) return null;
  const [vFrom, vTo] = await Promise.all([
    prisma.reportVersion.findFirst({ where: { reportId, version: from } }),
    prisma.reportVersion.findFirst({ where: { reportId, version: to } }),
  ]);
  if (!vFrom || !vTo) return null;
  const d = diffContents(vFrom.contentJson as object, vTo.contentJson as object);
  return {
    reportId, from, to,
    title: { before: d.titleBefore, after: d.titleAfter },
    sections: d.sections,
    summary: d.summary,
  };
}

export function deliverableFrom(content: unknown): Deliverable {
  return content as Deliverable;
}
