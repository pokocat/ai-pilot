// 版本化报告服务：按「报告名(slug)」归一，同名再产出/编辑 = 新版本；
// 内容哈希去重（同内容不重复成版），并自动生成「相对上一版」的变更摘要 + section 级 diff。
//
// 取舍：报告是小 JSON 文档，最务实的是「全量快照 + 内容寻址去重 + 读时实时 diff」，
// 无需 Dolt/prolly-tree 这类给 TB 级表行 diff 的重型方案。

import { createHash } from 'node:crypto';
import { prisma } from '../db.js';
import type {
  Deliverable, DeliverableSection, ReportDiff, SectionDiff, SaveReportResult,
} from '../llm/schema.js';

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
  const byH = (arr: DeliverableSection[]) => new Map(arr.map((s) => [s.h, s]));
  const bMap = byH(bs);
  const aMap = byH(as);

  const out: SectionDiff[] = [];
  let added = 0, removed = 0, changed = 0;

  // 以「新版顺序」为主轴，标 新增/修改/未变
  for (const s of as) {
    const prev = bMap.get(s.h);
    if (!prev) { out.push({ change: 'added', h: s.h, after: s }); added++; }
    else if (!sameSection(prev, s)) { out.push({ change: 'changed', h: s.h, before: prev, after: s }); changed++; }
    else out.push({ change: 'unchanged', h: s.h, before: prev, after: s });
  }
  // 旧版有、新版没有 = 删除
  for (const s of bs) {
    if (!aMap.has(s.h)) { out.push({ change: 'removed', h: s.h, before: s }); removed++; }
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

/** 保存一版报告：同名归一、同内容去重、自动变更摘要。返回 {reportId, version, created, changed}。 */
export async function saveReportVersion(opts: SaveVersionOpts): Promise<SaveReportResult & { reportId: string }> {
  const slug = slugify(opts.title);
  const hash = hashContent(opts.content);

  let doc = await prisma.reportDoc.findFirst({ where: { tenantId: opts.tenantId, slug } });
  let created = false;
  if (!doc) {
    doc = await prisma.reportDoc.create({
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
  const latest = await prisma.reportVersion.findFirst({
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
  await prisma.reportVersion.create({
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
  await prisma.reportDoc.update({
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
