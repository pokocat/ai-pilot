// WO-09 经营体检 · 端到端接线（决策 A）：知识条目（财务/表格）→ 解析 → 纯代码派生指标 → analysisJson 落库
// → 组装上下文（派生指标 + 行业基准）→ structured() 只出「三个最该动手的地方」的行动建议（禁算口径）
// → finReportSections 出 5 段（数字全部来自 analysisJson）→ saveReport 成版。
//
// 数字铁律：报告正文里的每一个数字都来自本流程 deriveMetrics 的结果（analysisJson），LLM 只写不含数字的行动建议；
// 抽不出的字段如实写「表内未见」（由 finReportSections 负责）。
import { z } from 'zod';
import { prisma } from '../db.js';
import { structuredMetered } from '../llm/gateway.js';
import { resolveIndustryPack } from '../data/industryPacks.js';
import { saveReportVersion } from './reports.js';
import { TRUST_NOTE } from '../data/deliverables.js';
import {
  FinancialsSchema, parseFinancials, parseFinancialsHeuristic, deriveMetrics, finReportSections,
  type Financials, type FinMetrics,
} from './finParse.js';
import type { Deliverable } from '../llm/schema.js';

export class NotAnalyzableError extends Error {
  statusCode = 422; code = 'NOT_ANALYZABLE';
  constructor(msg = '该资料不是可体检的财务/经营表') { super(msg); }
}

// LLM 只产出「三个最该动手的地方」的行动条目——不含任何数字（禁算口径见 prompt）。
const ActionsSchema = z.object({
  actions: z.array(z.string().trim().min(1)).catch([]).default([]).transform((a) => a.slice(0, 3).map((s) => s.slice(0, 120))),
});
const ACTIONS_SYS =
  '你是「军师参谋部」的经营体检参谋。下面给你【系统已算好的经营指标】和【行业基准】。' +
  '请只据此给出「三个最该动手的地方」，每条一句、具体可执行、落到经营动作。' +
  '硬约束（禁算口径）：① 只能引用我给你的数字，绝对不要自己计算、推算或编造任何数字；' +
  '② 缺失的指标就不要提，不臆测；③ 不用八字/命理/玄学措辞；④ 只输出 JSON：{"actions":["…","…","…"]}。';

function metricsContext(fin: Financials, m: FinMetrics, benchmark: string): string {
  const pct = (v: number | null) => (v == null ? '表内未见' : `${v}%`);
  const lines = fin.periods.map((p, i) => `${p}：毛利率 ${pct(m.grossMargin[i])}，费用率 ${pct(m.expenseRatio[i])}，现金 ${m.cashNet[i] ?? '表内未见'}`);
  return `期数：${fin.periods.join(' / ') || '（表内未见）'}\n各期指标：\n${lines.join('\n') || '（无）'}\n\n行业基准：${benchmark}`;
}

export interface FinCheckupResult {
  reportId: string;
  version: number;
  ok: boolean;      // 真实模型出了合规行动建议（P1-3 计费口径）
  attempts: number; // 已发生的真实调用轮次
}

/**
 * 跑一次经营体检并成版。text=知识条目正文；title=报告名（同名再产出=新版本，内容不变则去重不成新版）。
 * industry 用于注入行业基准；tenantId/userId/projectId 用于落库与行级隔离。
 */
export async function runFinCheckup(args: {
  tenantId: string;
  userId: string;
  itemId: string;
  projectId?: string | null;
  title: string;
  text: string;
  fileName?: string | null;
  industry?: string | null;
}): Promise<FinCheckupResult> {
  // 1) 解析：先纯代码启发式（CSV/表格，确定性、离线可用）；抽不出期数再退回 LLM 结构化抽取；仍不行则空表（如实报缺）。
  let fin = parseFinancialsHeuristic(args.text);
  if (!fin.periods.length) {
    const viaLlm = await parseFinancials(args.text);
    fin = viaLlm ? FinancialsSchema.parse(viaLlm) : fin;
  }

  // 2) 纯代码派生指标（数字铁律的唯一数字来源）。
  const metrics = deriveMetrics(fin);

  // 3) analysisJson 落库（重跑覆盖）。
  await prisma.knowledgeItem.update({
    where: { id: args.itemId },
    data: { analysisJson: { financials: fin, metrics } as object },
  });

  // 4) 组装上下文（派生指标 + 行业基准）→ structured() 只出行动建议（禁算）。mock/测试无 live provider → attempts=0，走纯代码兜底。
  const pack = resolveIndustryPack(args.industry);
  const { data: aiActions, attempts } = await structuredMetered(ActionsSchema, {
    system: ACTIONS_SYS,
    user: metricsContext(fin, metrics, pack.benchmark),
    maxChars: 2000,
  });
  const ok = !!(aiActions && aiActions.actions.length);

  // 5) 5 段成果：数字段（收入/毛利/费用/现金）全部来自 finReportSections（analysisJson）；
  //    「三个最该动手的地方」优先用 LLM 的行动建议（不含数字），否则纯代码阈值兜底。
  const sections = finReportSections(fin, metrics);
  if (ok) sections[4] = { h: '三个最该动手的地方', list: aiActions!.actions };

  const deliverable: Deliverable = {
    title: args.title,
    icon: 'chart',
    meta: `军师参谋部 · 经营体检 · ${pack.label}行业基准对照`,
    sections,
    trust: TRUST_NOTE,
    actions: ['save_to_library'],
  };

  // 6) 成版（同名内容哈希去重：重复 analyze 同一份数据不会重复成版）。
  // 报告归属 ops（经营参谋）：4+1 保留科室中语义匹配（经营/复盘/财务分析）的既有 agent；
  // report_doc.agentKey 有外键约束，不得虚构不存在的 agent key、也不置 null。
  const saved = await saveReportVersion({
    tenantId: args.tenantId,
    userId: args.userId,
    projectId: args.projectId ?? null,
    title: args.title,
    type: '经营体检',
    agentKey: 'ops',
    content: deliverable as object,
    authorKind: 'agent',
  });

  return { reportId: saved.reportId, version: saved.version, ok, attempts };
}
