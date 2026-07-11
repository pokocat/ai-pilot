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
import { structured, structuredMetered } from '../llm/gateway.js';
import { chunkAndEmbed } from './knowledge.js';
import { saveReportVersion } from './reports.js';
import { TRUST_NOTE } from '../data/deliverables.js';
import { parseDocument, detectDocType } from './docParse.js';
import { BIZ_CATEGORIES, BIZ_CATEGORY_KEYS, bizCategoryLabel, isBizCategory, type BizCategoryKey } from '../data/bizCategories.js';
import type { Deliverable } from '../llm/schema.js';
import type { KnowledgePipelineView, KnowledgePipelineFolder, KnowledgeBatch, KnowledgeBatchTypeStat, KnowledgeBatchFile, OrganizeItem } from '../../../shared/contracts';

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

  const [staging, optimized, confirmed, quota, grouped, stagingRows, optimizedRows] = await Promise.all([
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
      // 逐份清单需要 id/文件名/状态/字节（此前只 select batchId+fileType，前端拿不到文件列表——本次缺陷根因）。
      select: { id: true, batchId: true, fileType: true, fileName: true, title: true, status: true, fileSize: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.knowledgeItem.findMany({
      where: { tenantId, userId, stage: 'optimized' },
      select: { id: true, fileName: true, title: true, bizCategory: true, tagsJson: true, dupOfId: true },
      orderBy: { createdAt: 'asc' },
    }),
  ]);

  // folders：confirmed 的 bizCategory 真实计数，按目录顺序展示（只保留有内容的类目）。
  const countByKey = new Map<string, number>();
  for (const g of grouped) if (g.bizCategory) countByKey.set(g.bizCategory, g._count._all);
  const folders: KnowledgePipelineFolder[] = BIZ_CATEGORIES
    .filter((c) => (countByKey.get(c.key) ?? 0) > 0)
    .map((c) => ({ key: c.key, label: c.label, count: countByKey.get(c.key) ?? 0, stage: 'confirmed' as const }));

  // 已优化区持久数据：optimized 条目重建为逐份 items + 覆盖同一 folders 列表（带 stage='optimized'）。
  // 这样前端「已优化」区改由 pipeline 查询驱动，刷新后不丢（此前只有 organize 瞬时返回、无持久源——本次缺陷根因）。
  const optimizedItems: OrganizeItem[] = optimizedRows.map(itemMeta);
  const optCountByKey = new Map<string, number>();
  for (const r of optimizedRows) if (r.bizCategory) optCountByKey.set(r.bizCategory, (optCountByKey.get(r.bizCategory) ?? 0) + 1);
  for (const c of BIZ_CATEGORIES) {
    const n = optCountByKey.get(c.key) ?? 0;
    if (n > 0) folders.push({ key: c.key, label: c.label, count: n, stage: 'optimized' });
  }

  // batches：staging 条目按 batchId 分组（未整理批次，status=uploaded）+ 逐份文件清单。
  const byBatch = new Map<string, { count: number; types: Map<string, number>; files: KnowledgeBatchFile[] }>();
  for (const r of stagingRows) {
    if (!r.batchId) continue;
    const b = byBatch.get(r.batchId) ?? { count: 0, types: new Map<string, number>(), files: [] };
    b.count += 1;
    const lbl = fileTypeLabel(r.fileType);
    b.types.set(lbl, (b.types.get(lbl) ?? 0) + 1);
    b.files.push({ id: r.id, fileName: r.fileName ?? r.title ?? '未命名', status: r.status, fileSize: r.fileSize });
    byBatch.set(r.batchId, b);
  }
  const batches: KnowledgeBatch[] = [...byBatch.entries()].map(([id, b]) => ({
    id,
    count: b.count,
    status: 'uploaded' as const,
    typeStats: [...b.types.entries()].map(([label, count]): KnowledgeBatchTypeStat => ({ label, count })),
    files: b.files,
  }));

  return {
    counts: { staging, optimized, confirmed },
    quota,
    folders,
    batches,
    optimizedItems,
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

// 深度整理打的控制标（非摘要），parse 摘要时需排除。
const DEEP_TAG = '深度整理';

/** 从库内条目（含 tagsJson）重建逐份归类项：分类取 bizCategory 列，摘要取 tagsJson 里第一条非「类目标签/控制标」的文本。 */
function itemMeta(r: { id: string; fileName: string | null; title?: string | null; bizCategory: string | null; tagsJson: unknown; dupOfId: string | null }): OrganizeItem {
  const tags = Array.isArray(r.tagsJson) ? (r.tagsJson as string[]) : [];
  const category = r.bizCategory ?? 'unknown';
  const label = bizCategoryLabel(category);
  const summary = tags.find((t) => typeof t === 'string' && t !== label && t !== DEEP_TAG) ?? '';
  return { id: r.id, fileName: r.fileName ?? r.title ?? '未命名', category, summary, isDup: r.dupOfId != null };
}

/** 取某批全部条目、映射为逐份归类项（organize/深度整理回传的数据源）。 */
async function buildBatchItems(tenantId: string, userId: string, batchId: string): Promise<OrganizeItem[]> {
  const rows = await prisma.knowledgeItem.findMany({
    where: { tenantId, userId, batchId },
    select: { id: true, fileName: true, title: true, bizCategory: true, tagsJson: true, dupOfId: true },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map(itemMeta);
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
  items: OrganizeItem[]; // 逐份归类（分类 + 摘要 + 去重标记），前端「已优化」区逐份渲染
  reportId?: string;      // 深度整理时回传《资料整理报告》id
  reportVersion?: number; // 该报告版本号
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

  // 逐份归类回传（从库内重建，含摘要+去重标记）——此前只回类目计数，前端看不到每份的分类/摘要（本次缺陷根因）。
  const resultItems = await buildBatchItems(tenantId, userId, batchId);

  return { batchId, status: 'organized', total: items.length, dedup, folders, items: resultItems };
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
// 深度整理差异化产出：逐份精炼摘要（structuredMetered）+ 一份《资料整理报告》方案（saveReportVersion）。
// ——————————————————————————————————————————————————————————————————————————

// 逐份精炼摘要：输入=该份解析文本截断，输出 {summary≤60字, tags[]≤3}；LLM 不可用（mock/测试）时保留既有摘要不编造。
const RefineSchema = z.object({
  summary: z.string().trim().catch('').default('').transform((s) => s.slice(0, 60)),
  tags: z.array(z.string().trim().min(1)).catch([]).default([]).transform((a) => a.slice(0, 3)),
});
const REFINE_SYS =
  '你是资料归档助手。为下面这份资料写一句不超过 60 字的精炼摘要（点明它讲了什么、对经营有什么用），' +
  '并给最多 3 个关键词标签。只输出 JSON：{"summary":"…","tags":["…"]}。不要编造资料里没有的信息。';

// 类目缺口 → 建议补传什么（确定性规则，不走 LLM）。顺序即建议优先级。
const GAP_SUGGEST: { key: BizCategoryKey; text: string }[] = [
  { key: 'finance', text: '财务经营：近几个月的经营流水、利润表或成本预算表' },
  { key: 'founder', text: '老板档案：创始人经历、个人定位与核心优势介绍' },
  { key: 'company', text: '企业档案：公司/产品介绍、团队与发展历程' },
  { key: 'proof', text: '案例证明：成交案例、客户评价与结果截图' },
  { key: 'growth', text: '增长资料：流量来源、转化漏斗、投放或私域打法' },
  { key: 'content', text: '内容IP：选题、脚本、文案或短视频素材' },
  { key: 'customer', text: '客户问答：客户咨询记录、私聊问答与服务反馈' },
];

interface OrganizeReportRow { fileName: string; category: string; summary: string; isDup: boolean; dupOfName: string | null }

/** 《资料整理报告》5 节（数字/清单全部来自库内事实；摘要文本来自 LLM 或既有兜底，不在此编造数字）。 */
function organizeReportDeliverable(title: string, rows: OrganizeReportRow[]): Deliverable {
  const kept = rows.filter((r) => !r.isDup);
  const dups = rows.filter((r) => r.isDup);

  // ① 本批收到什么（逐份清单）
  const receivedList = rows.map((r) => `《${r.fileName}》· ${bizCategoryLabel(r.category)}${r.isDup ? '（重复）' : ''}`);

  // ② 怎么归档的（类目 + 理由）：按目录顺序，仅列有内容的类目
  const catCount = new Map<string, number>();
  for (const r of kept) catCount.set(r.category, (catCount.get(r.category) ?? 0) + 1);
  const filedList = BIZ_CATEGORIES
    .filter((c) => (catCount.get(c.key) ?? 0) > 0)
    .map((c) => `${c.label}（${catCount.get(c.key)} 份）：${c.hint}`);

  // ③ 去重了什么（对照）
  const dedupList = dups.length
    ? dups.map((r) => `《${r.fileName}》与${r.dupOfName ? `《${r.dupOfName}》` : '已有资料'}重复，已只保留 1 份`)
    : ['本批未发现重复资料。'];

  // ④ 重点资料精炼摘要（有摘要的非重复份，最多 8 条）
  const summaryList = kept
    .filter((r) => r.summary.trim())
    .slice(0, 8)
    .map((r) => `《${r.fileName}》：${r.summary}`);

  // ⑤ 军师建议补充的资料（基于类目缺口，确定性生成）
  const present = new Set(kept.map((r) => r.category));
  const missing = GAP_SUGGEST.filter((g) => !present.has(g.key)).map((g) => g.text);
  const adviceList = missing.length ? missing : ['本批资料类目已较齐全，暂无明显缺口。'];

  const sections = [
    { h: '本批收到什么', b: `本批共收到 ${rows.length} 份资料，其中有效 ${kept.length} 份、重复 ${dups.length} 份。`, list: receivedList },
    { h: '怎么归档的', b: filedList.length ? '按业务类目归档如下：' : undefined, list: filedList.length ? filedList : ['暂无可归档资料。'] },
    { h: '去重了什么', list: dedupList },
    { h: '重点资料精炼摘要', list: summaryList.length ? summaryList : ['本批暂无可提炼的重点资料摘要。'] },
    { h: '军师建议补充的资料', list: adviceList },
  ];

  return {
    title,
    icon: 'folder',
    meta: `军师参谋部 · 资料整理报告 · 共 ${rows.length} 份`,
    sections,
    trust: TRUST_NOTE,
    actions: ['save_to_library'],
  };
}

// ——————————————————————————————————————————————————————————————————————————
// 深度整理：v1 门禁——未购 sku:deep-organize → 402 SKU_REQUIRED；已购 → organize + 逐份精炼摘要 + 资料整理报告。
// meterAttempts/meterOk 供路由层按保守结算口径接额度（ratio 0.3）；失败退款。
// ——————————————————————————————————————————————————————————————————————————
export async function deepOrganize(args: { tenantId: string; userId: string; batchId: string }): Promise<OrganizeResult & { deep: true; meterAttempts: number; meterOk: boolean }> {
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
    // 已购：先跑标准粗分，再对本批 optimized 条目补一层逐份精炼摘要（LLM），最后汇总一份《资料整理报告》。
    const base = await organizeBatch({ tenantId, userId, batchId, deep: true });

    const optimized = await prisma.knowledgeItem.findMany({
      where: { tenantId, userId, batchId, stage: 'optimized' },
      orderBy: { createdAt: 'asc' },
    });

    // 逐份精炼摘要：仅对「尚未精炼过」(无 DEEP_TAG) 的份调用 LLM——幂等：重试时已精炼的不重复调用。
    let meterAttempts = 0;
    let meterOk = false;
    for (const it of optimized) {
      const existing = Array.isArray(it.tagsJson) ? (it.tagsJson as string[]) : [];
      if (existing.includes(DEEP_TAG)) continue; // 已精炼过（幂等），跳过 LLM

      const label = bizCategoryLabel(it.bizCategory);
      // 既有摘要（第一条非类目标签的 tag），LLM 不可用时保留、不编造。
      const prevSummary = existing.find((t) => typeof t === 'string' && t !== label) ?? '';

      let summary = prevSummary;
      const tags: string[] = [];
      if (it.text.trim()) {
        const { data, attempts } = await structuredMetered(RefineSchema, {
          system: REFINE_SYS,
          user: it.text.slice(0, 1500),
          maxChars: 1500,
        });
        meterAttempts += attempts;
        if (data && data.summary.trim()) {
          summary = data.summary.trim();
          tags.push(...data.tags);
          meterOk = true;
        }
      }

      // tagsJson 约定：[类目label, 摘要, ...精炼标签, DEEP_TAG]——itemMeta 取第一条非 label/DEEP_TAG 者为摘要。
      const nextTags = [label, summary, ...tags.filter((t) => t !== label && t !== DEEP_TAG), DEEP_TAG]
        .filter((t, i, a) => t && a.indexOf(t) === i);
      await prisma.knowledgeItem.update({ where: { id: it.id }, data: { tagsJson: nextTags } });
    }

    // 汇总《资料整理报告》：数字/清单全部来自库内事实；同批稳定标题 → 版本化去重（重试不重复成版）。
    const rows = await prisma.knowledgeItem.findMany({
      where: { tenantId, userId, batchId },
      select: { id: true, fileName: true, title: true, bizCategory: true, tagsJson: true, dupOfId: true },
      orderBy: { createdAt: 'asc' },
    });
    const nameById = new Map(rows.map((r) => [r.id, r.fileName ?? r.title ?? '未命名']));
    const reportRows: OrganizeReportRow[] = rows.map((r) => {
      const m = itemMeta(r);
      return { fileName: m.fileName, category: m.category, summary: m.summary, isDup: m.isDup, dupOfName: r.dupOfId ? (nameById.get(r.dupOfId) ?? null) : null };
    });
    const reportTitle = `资料整理报告 · ${batchId.slice(0, 8)}`;
    const deliverable = organizeReportDeliverable(reportTitle, reportRows);
    // 报告归属 ops（经营参谋，与经营体检同口径：report_doc.agentKey 有外键约束，复用既有 agent key）。
    const saved = await saveReportVersion({
      tenantId, userId, title: reportTitle, type: '资料整理报告',
      agentKey: 'ops', content: deliverable as object, authorKind: 'agent',
    });

    const items = reportRows.map((r, i): OrganizeItem => ({
      id: rows[i].id, fileName: r.fileName, category: r.category, summary: r.summary, isDup: r.isDup,
    }));

    return { ...base, items, deep: true, reportId: saved.reportId, reportVersion: saved.version, meterAttempts, meterOk };
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
