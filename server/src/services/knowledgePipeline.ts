// V7-06 智库三段式资料整理管道（服务端主体）。
//
// 产品语义：上传 →【待整理 staging】（不进检索、不嵌入）→ AI 粗分（去重 + 归类 + 摘要）→
//          【已优化 optimized】（等确认）→ 用户确认 →【知识库 confirmed】（此时才切片+嵌入，可被检索/引用）。
//
// 铁律：
//  • 一切计数由服务端算（份数/字节/文件夹计数），前端只展示。
//  • 嵌入只在 confirm 发生（省成本 + staging 天然对检索不可见——无 chunk 即召不回）。
//  • structured() 归类失败/mock/测试一律走确定性关键词兜底，绝不伪造。
//  • 每条查询按 tenantId + userId 双维隔离。

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../db.js';
import { monthStartOf } from './clock.js';
import { structured } from '../llm/gateway.js';
import { chunkAndEmbed } from './knowledge.js';
import { parseDocument, detectDocType } from './docParse.js';
import { BIZ_CATEGORIES, BIZ_CATEGORY_KEYS, bizCategoryLabel, isBizCategory, type BizCategoryKey } from '../data/bizCategories.js';
import type { KnowledgePipelineView, KnowledgePipelineFolder, KnowledgeBatch, KnowledgeBatchTypeStat } from '../../../shared/contracts';

// —— 免费额度（本月）：30 份 / 200MB（设计 §6.1「本月免费整理额度：30 份 / 200MB」，D-5 缺省）——
export const FREE_DOCS = 30;
export const FREE_BYTES = 200 * 1024 * 1024;

// 深度整理一次性服务凭据（购买后记为 UserModule.moduleKey='sku:deep-organize'，见 schema 注释）。
const DEEP_ORGANIZE_MODULE_KEY = 'sku:deep-organize';

/** 领域错误：{message, statusCode, code}（+ 可选 skuKey），供路由边界原样转发。 */
function pipelineError(message: string, statusCode: number, code: string, extra?: Record<string, unknown>): Error {
  return Object.assign(new Error(message), { statusCode, code, ...extra });
}

// 本月起点（Asia/Shanghai 固定时区，P1-4；与 casefile.todayStr / tokenQuota dayStart 同口径）。
function monthStart(): Date {
  return monthStartOf();
}

// fileType（pdf/docx/xlsx/csv/md/txt/…）→ 展示用类型标签（批次 typeStats 用）。
function fileTypeLabel(fileType: string | null | undefined): string {
  switch ((fileType || '').toLowerCase()) {
    case 'pdf': return 'PDF';
    case 'docx': case 'doc': return '文档';
    case 'xlsx': case 'xls': case 'csv': return '表格';
    case 'md': case 'markdown': return 'Markdown';
    case 'txt': case 'text': return '文本';
    case '': return '其他';
    default: return '其他';
  }
}

// ——————————————————————————————————————————————————————————————————————————
// 额度：本月 confirmed + staging 的份数与字节（optimized 是过渡态，不计；与设计「按月统计」一致）。
// ——————————————————————————————————————————————————————————————————————————
export interface QuotaState { usedDocs: number; freeDocs: number; usedBytes: number; freeBytes: number; }

export async function getQuota(args: { tenantId: string; userId: string }): Promise<QuotaState> {
  const { tenantId, userId } = args;
  const where = { tenantId, userId, stage: { in: ['staging', 'confirmed'] }, createdAt: { gte: monthStart() } };
  const [usedDocs, agg] = await Promise.all([
    prisma.knowledgeItem.count({ where }),
    prisma.knowledgeItem.aggregate({ _sum: { fileSize: true }, where }),
  ]);
  return { usedDocs, freeDocs: FREE_DOCS, usedBytes: agg._sum?.fileSize ?? 0, freeBytes: FREE_BYTES };
}

/** 额度门禁（staged 上传前调用）：超 30 份 / 200MB → 402 KNOWLEDGE_QUOTA。 */
export async function checkQuota(args: { tenantId: string; userId: string; addBytes?: number }): Promise<void> {
  const q = await getQuota({ tenantId: args.tenantId, userId: args.userId });
  if (q.usedDocs >= q.freeDocs) {
    throw pipelineError(`本月免费整理额度已用完（${q.freeDocs} 份）`, 402, 'KNOWLEDGE_QUOTA');
  }
  if (q.usedBytes + (args.addBytes ?? 0) > q.freeBytes) {
    throw pipelineError('本月免费存储空间已用完（200MB）', 402, 'KNOWLEDGE_QUOTA');
  }
}

// ——————————————————————————————————————————————————————————————————————————
// staged 上传：建 staging 条目 + docParse 存文本，**不切片不嵌入**（isolation 关键：无 chunk 即检索不可见）。
// ——————————————————————————————————————————————————————————————————————————
export async function ingestStagedFile(opts: {
  tenantId: string;
  userId: string;
  projectId?: string | null;
  fileName: string;
  mime?: string;
  buf: Buffer;
  batchId: string;
}): Promise<{ id: string; status: string; stage: string; batchId: string }> {
  // 额度门禁：本次要新增一份 + opts.buf.length 字节。
  await checkQuota({ tenantId: opts.tenantId, userId: opts.userId, addBytes: opts.buf.length });

  const type = detectDocType(opts.fileName, opts.mime);
  // 同步解析文本（失败不致命：落 status=failed，条目仍进待整理区，正文为空——确认时切 0 片）。
  let text = '';
  let status = 'ready';
  let error: string | null = null;
  try {
    const parsed = await parseDocument(opts.buf, opts.fileName, opts.mime);
    text = parsed.text;
  } catch (e) {
    status = 'failed';
    error = ((e as Error).message ?? '解析失败').slice(0, 500);
  }

  const item = await prisma.knowledgeItem.create({
    data: {
      tenantId: opts.tenantId,
      userId: opts.userId,
      projectId: opts.projectId ?? null,
      kind: 'document',
      title: opts.fileName,
      text,
      sourceType: 'upload',
      stage: 'staging', // ← 待整理：不进检索
      status,
      fileName: opts.fileName,
      fileType: type ?? null,
      fileSize: opts.buf.length,
      batchId: opts.batchId,
      error,
      tagsJson: [],
    },
  });
  return { id: item.id, status: item.status, stage: 'staging', batchId: opts.batchId };
}

// ——————————————————————————————————————————————————————————————————————————
// 管道总览：counts + quota + folders（confirmed 按 bizCategory）+ batches（staging 按 batchId）。
// ——————————————————————————————————————————————————————————————————————————
export async function buildPipeline(args: { tenantId: string; userId: string }): Promise<KnowledgePipelineView> {
  const { tenantId, userId } = args;

  const [staging, optimized, confirmed, quota, grouped, stagingRows] = await Promise.all([
    prisma.knowledgeItem.count({ where: { tenantId, userId, stage: 'staging' } }),
    prisma.knowledgeItem.count({ where: { tenantId, userId, stage: 'optimized' } }),
    prisma.knowledgeItem.count({ where: { tenantId, userId, stage: 'confirmed' } }),
    getQuota({ tenantId, userId }),
    prisma.knowledgeItem.groupBy({
      by: ['bizCategory'],
      where: { tenantId, userId, stage: 'confirmed', bizCategory: { not: null } },
      _count: { _all: true },
    }),
    prisma.knowledgeItem.findMany({
      where: { tenantId, userId, stage: 'staging', batchId: { not: null } },
      select: { batchId: true, fileType: true },
    }),
  ]);

  // folders：confirmed 的 bizCategory 真实计数，按目录顺序展示（只保留有内容的类目）。
  const countByKey = new Map<string, number>();
  for (const g of grouped) if (g.bizCategory) countByKey.set(g.bizCategory, g._count._all);
  const folders: KnowledgePipelineFolder[] = BIZ_CATEGORIES
    .filter((c) => (countByKey.get(c.key) ?? 0) > 0)
    .map((c) => ({ key: c.key, label: c.label, count: countByKey.get(c.key) ?? 0, stage: 'confirmed' as const }));

  // batches：staging 条目按 batchId 分组（未整理批次，status=uploaded）。
  const byBatch = new Map<string, { count: number; types: Map<string, number> }>();
  for (const r of stagingRows) {
    if (!r.batchId) continue;
    const b = byBatch.get(r.batchId) ?? { count: 0, types: new Map<string, number>() };
    b.count += 1;
    const lbl = fileTypeLabel(r.fileType);
    b.types.set(lbl, (b.types.get(lbl) ?? 0) + 1);
    byBatch.set(r.batchId, b);
  }
  const batches: KnowledgeBatch[] = [...byBatch.entries()].map(([id, b]) => ({
    id,
    count: b.count,
    status: 'uploaded' as const,
    typeStats: [...b.types.entries()].map(([label, count]): KnowledgeBatchTypeStat => ({ label, count })),
  }));

  return {
    counts: { staging, optimized, confirmed },
    quota,
    folders,
    batches,
  };
}

// ——————————————————————————————————————————————————————————————————————————
// AI 粗分：规则去重 + 归类（structured，mock/测试确定性关键词兜底）+ 摘要；条目置 optimized。
// ——————————————————————————————————————————————————————————————————————————

// 确定性归类：按文件名/类型关键词命中 bizCategories（无真实模型或兜底时用）。
const KEYWORD_RULES: { key: BizCategoryKey; kws: string[] }[] = [
  { key: 'founder', kws: ['老板', '创始人', '个人', '简历', '自我介绍', 'founder', '主理人'] },
  { key: 'finance', kws: ['财务', '利润', '成本', '现金', '经营', '预算', '报表', '营收', '账', 'finance', 'budget'] },
  { key: 'proof', kws: ['案例', '证明', '评价', '成交', '截图', '好评', '结果', 'proof', 'case'] },
  { key: 'growth', kws: ['增长', '漏斗', '转化', '流量', '线索', '投放', '私域', 'growth', 'funnel'] },
  { key: 'content', kws: ['内容', '脚本', '选题', '文案', '视频', 'ip', '同行', 'content', 'script'] },
  { key: 'customer', kws: ['客户', '问答', '咨询', '反馈', '聊天', '私聊', '问卷', 'customer', 'chat', 'qa'] },
  { key: 'company', kws: ['公司', '企业', '组织', '团队', '介绍', '产品', '服务', '历程', 'company'] },
];

function classifyDeterministic(fileName: string, fileType: string | null, text: string): BizCategoryKey {
  const hay = `${fileName} ${text.slice(0, 200)}`.toLowerCase();
  for (const rule of KEYWORD_RULES) {
    if (rule.kws.some((kw) => hay.includes(kw.toLowerCase()))) return rule.key;
  }
  // 表格类文件默认视为财务经营数据（漏斗/预算/经营表最常见）。
  if (['xlsx', 'xls', 'csv'].includes((fileType || '').toLowerCase())) return 'finance';
  return 'unknown';
}

function summaryFor(category: BizCategoryKey, fileName: string, text: string): string {
  const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 60);
  const label = bizCategoryLabel(category);
  return snippet ? `${label} · ${snippet}` : `${label} · ${fileName}`;
}

// structured 归类 schema：每条给出 index（对应输入顺序）+ 归到某类 + 一句摘要。
const ClassifyResult = z.object({
  items: z.array(
    z.object({
      index: z.number().int(),
      category: z.enum(BIZ_CATEGORY_KEYS),
      summary: z.string().nullish(),
    }),
  ),
});

const CLASSIFY_SYS = [
  '你是资料归档助手。把每份资料归到下列 8 个业务类目之一，并给一句不超过 40 字的摘要。',
  ...BIZ_CATEGORIES.map((c) => `- ${c.key}（${c.label}）：${c.hint}`),
  '严格输出 JSON：{"items":[{"index":序号,"category":"类目key","summary":"一句摘要"}]}，无法判断填 "unknown"。',
].join('\n');

export interface OrganizeResult {
  batchId: string;
  status: 'organized' | 'organizing';
  total: number;
  dedup: number; // 本批被标记为重复的份数
  folders: KnowledgePipelineFolder[]; // 本批归类结果（设计 organized-row 四行的数据源）
}

export async function organizeBatch(args: { tenantId: string; userId: string; batchId: string; deep?: boolean }): Promise<OrganizeResult> {
  const { tenantId, userId, batchId } = args;

  // 取该批全部条目（staging + 可能已 optimized 的重跑），严格 tenant+user 隔离。
  const items = await prisma.knowledgeItem.findMany({
    where: { tenantId, userId, batchId },
    orderBy: { createdAt: 'asc' },
  });
  if (!items.length) throw pipelineError('批次不存在或已清空', 404, 'BATCH_NOT_FOUND');

  // ① 规则去重：同名 + 同大小 → 后来者标 dupOfId 指向第一份（幂等：已标过的不重标）。
  const firstByKey = new Map<string, string>();
  let dedup = 0;
  for (const it of items) {
    const key = `${it.fileName ?? ''}::${it.fileSize ?? 0}`;
    const first = firstByKey.get(key);
    if (!first) {
      firstByKey.set(key, it.id);
    } else if (it.dupOfId == null && it.id !== first) {
      await prisma.knowledgeItem.updateMany({ where: { id: it.id, tenantId, userId }, data: { dupOfId: first } });
      it.dupOfId = first;
      dedup += 1;
    } else if (it.dupOfId != null) {
      dedup += 1;
    }
  }

  // 只对仍在 staging 的条目跑归类（optimized 的重跑视为幂等，保留原归类）。
  const staging = items.filter((it) => it.stage === 'staging');

  // ② 归类：优先 structured（真实模型），失败/mock/测试 → 逐条确定性关键词兜底。
  const modelOut = staging.length
    ? await structured(ClassifyResult, {
        system: CLASSIFY_SYS,
        user: staging.map((it, i) => `[${i}] 文件名：${it.fileName ?? '未命名'}\n正文摘录：${it.text.slice(0, 300)}`).join('\n\n'),
        maxChars: 4000,
      }).catch(() => null)
    : null;
  const modelByIndex = new Map<number, { category: BizCategoryKey; summary?: string | null }>();
  if (modelOut) for (const m of modelOut.items) modelByIndex.set(m.index, { category: m.category, summary: m.summary });

  for (let i = 0; i < staging.length; i++) {
    const it = staging[i];
    const picked = modelByIndex.get(i);
    const category: BizCategoryKey = picked && isBizCategory(picked.category)
      ? picked.category
      : classifyDeterministic(it.fileName ?? '', it.fileType, it.text);
    const summary = (picked?.summary && picked.summary.trim()) || summaryFor(category, it.fileName ?? '', it.text);
    // ③ 写 bizCategory + 摘要（摘要落 tagsJson：无 summary 列，标签是最贴切的落点）+ 置 optimized。
    await prisma.knowledgeItem.update({
      where: { id: it.id },
      data: { bizCategory: category, stage: 'optimized', tagsJson: [bizCategoryLabel(category), summary] },
    });
    it.bizCategory = category;
    it.stage = 'optimized';
  }

  // 归类统计（本批 optimized 条目按类目计数，供前端 organized-row 展示）。
  const countByKey = new Map<string, number>();
  for (const it of items) {
    if (it.stage === 'optimized' && it.bizCategory) countByKey.set(it.bizCategory, (countByKey.get(it.bizCategory) ?? 0) + 1);
  }
  const folders: KnowledgePipelineFolder[] = BIZ_CATEGORIES
    .filter((c) => (countByKey.get(c.key) ?? 0) > 0)
    .map((c) => ({ key: c.key, label: c.label, count: countByKey.get(c.key) ?? 0, stage: 'optimized' as const }));

  return { batchId, status: 'organized', total: items.length, dedup, folders };
}

// ——————————————————————————————————————————————————————————————————————————
// 确认入库：optimized/staging → confirmed，此时（且仅此时）切片+嵌入；幂等、批量。
// ——————————————————————————————————————————————————————————————————————————
export interface ConfirmResult { count: number; ingested: number; ids: string[]; }

export async function confirmItems(args: { tenantId: string; userId: string; ids?: string[]; batchId?: string }): Promise<ConfirmResult> {
  const { tenantId, userId, ids, batchId } = args;
  if ((!ids || !ids.length) && !batchId) throw pipelineError('缺少 ids 或 batchId', 400, 'CONFIRM_TARGET_REQUIRED');

  const items = await prisma.knowledgeItem.findMany({
    where: {
      tenantId,
      userId,
      stage: { in: ['staging', 'optimized'] }, // 已 confirmed 的不再处理（幂等）
      ...(ids && ids.length ? { id: { in: ids } } : {}),
      ...(batchId ? { batchId } : {}),
    },
  });

  let ingested = 0;
  const doneIds: string[] = [];
  for (const it of items) {
    // 重复文件（dupOfId 已标）：只入库不嵌入——原件承载正文，避免检索重复召回。
    if (it.dupOfId == null && it.text.trim()) {
      await chunkAndEmbed(it.id, tenantId, it.text); // 唯一嵌入发生点；内部先删旧片，重跑安全
      ingested += 1;
    }
    await prisma.knowledgeItem.update({ where: { id: it.id }, data: { stage: 'confirmed', status: 'ready' } });
    doneIds.push(it.id);
  }
  return { count: doneIds.length, ingested, ids: doneIds };
}

// ——————————————————————————————————————————————————————————————————————————
// 深度整理：v1 门禁——未购 sku:deep-organize → 402 SKU_REQUIRED；已购 → organize + 额外摘要/标签。
// ——————————————————————————————————————————————————————————————————————————
export async function deepOrganize(args: { tenantId: string; userId: string; batchId: string }): Promise<OrganizeResult & { deep: true }> {
  const { tenantId, userId, batchId } = args;

  // 原子核销一次性凭据：仅当仍处于「已购未核销」(enabled=true) 时才可核销，
  // 防止同一笔 ¥39 购买被无限复用（此前只判存在、从不核销，见 TODO.md 2026-07-09）。
  const consumed = await prisma.userModule.updateMany({
    where: { tenantId, userId, moduleKey: DEEP_ORGANIZE_MODULE_KEY, enabled: true },
    data: { enabled: false },
  });
  if (consumed.count === 0) {
    throw pipelineError('深度整理需先购买', 402, 'SKU_REQUIRED', { skuKey: 'deep-organize' });
  }

  try {
    // 已购：先跑标准粗分，再对本批 optimized 条目补一层「深度」摘要/标签（mock 下确定性）。
    const base = await organizeBatch({ tenantId, userId, batchId, deep: true });

    const optimized = await prisma.knowledgeItem.findMany({
      where: { tenantId, userId, batchId, stage: 'optimized' },
    });
    for (const it of optimized) {
      const existing = Array.isArray(it.tagsJson) ? (it.tagsJson as string[]) : [];
      if (!existing.includes('深度整理')) {
        await prisma.knowledgeItem.update({
          where: { id: it.id },
          data: { tagsJson: [...existing, '深度整理'] },
        });
      }
    }
    return { ...base, deep: true };
  } catch (err) {
    // 执行失败不应白白吃掉用户已付费的一次性凭据：尽力恢复，允许重试。
    await prisma.userModule.updateMany({
      where: { tenantId, userId, moduleKey: DEEP_ORGANIZE_MODULE_KEY, enabled: false },
      data: { enabled: true },
    }).catch(() => {});
    throw err;
  }
}

/** 便捷：生成一个批次号（多文件同批上传时前端可共用，或后端逐请求生成）。 */
export function newBatchId(): string {
  return randomUUID();
}
