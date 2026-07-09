// WO-09 经营体检：财务表 → 结构化抽取（structured()）→ 派生指标（纯代码算，不交给 LLM）→ 5 段体检成果。
// 数字铁律：报告正文数字必须来自这里的结构化数据，不新增/不推算。
import { z } from 'zod';
import { structured } from '../llm/gateway.js';
import type { DeliverableSection } from '../../../shared/contracts';

const NumArr = z.array(z.number()).catch([]).default([]);
export const FinancialsSchema = z.object({
  periods: z.array(z.string()).catch([]).default([]), // 月份
  revenue: NumArr,
  cogs: NumArr,
  expenses: z.array(z.object({ name: z.string(), values: NumArr })).catch([]).default([]),
  cash: NumArr,
});
export type Financials = z.output<typeof FinancialsSchema>;

const FIN_SYS =
  '你是财务解析器。从下面的财务表文本抽取：periods(月份数组)、revenue(收入)、cogs(成本)、expenses(费用，每项 {name, values})、cash(现金)。' +
  '数值数组尽量与 periods 等长；抽不出的字段置空数组，不要编造。只输出 JSON：' +
  '{"periods":[],"revenue":[],"cogs":[],"expenses":[{"name":"","values":[]}],"cash":[]}。';

/** 结构化抽取（无 provider/失败 → null，调用方兜底）。 */
export async function parseFinancials(tableText: string): Promise<Financials | null> {
  return structured(FinancialsSchema, { system: FIN_SYS, user: tableText, maxChars: 6000 });
}

export interface FinMetrics { grossMargin: (number | null)[]; expenseRatio: (number | null)[]; cashNet: number[] }

/** 派生指标（纯代码）：毛利率、费用率、现金净流。数字全部由输入算出。 */
export function deriveMetrics(fin: Financials): FinMetrics {
  const n = fin.periods.length;
  const at = (arr: number[], i: number): number | null => (i < arr.length ? arr[i] : null);
  const round1 = (v: number) => Math.round(v * 10) / 10;
  const grossMargin: (number | null)[] = [];
  const expenseRatio: (number | null)[] = [];
  for (let i = 0; i < n; i++) {
    const rev = at(fin.revenue, i);
    const cogs = at(fin.cogs, i);
    grossMargin.push(rev && rev !== 0 && cogs != null ? round1(((rev - cogs) / rev) * 100) : null);
    const exp = fin.expenses.reduce((s, e) => s + (at(e.values, i) ?? 0), 0);
    expenseRatio.push(rev && rev !== 0 ? round1((exp / rev) * 100) : null);
  }
  return { grossMargin, expenseRatio, cashNet: fin.cash.slice(0, n) };
}

/** 经营体检 5 段（纯代码，数字来自 analysisJson，禁推算新数字）：收入结构｜成本与毛利｜费用异动｜现金流信号｜三个最该动手的地方。 */
export function finReportSections(fin: Financials, m: FinMetrics): DeliverableSection[] {
  const last = fin.periods.length - 1;
  const pct = (v: number | null) => (v == null ? '—' : `${v}%`);
  return [
    { h: '收入结构', b: `覆盖 ${fin.periods.length} 期（${fin.periods.join(' / ') || '表内未见期数'}）。最新一期收入 ${last >= 0 ? (fin.revenue[last] ?? '表内未见') : '表内未见'}。` },
    { h: '成本与毛利', list: fin.periods.map((p, i) => `${p}：毛利率 ${pct(m.grossMargin[i])}`) },
    { h: '费用异动', list: fin.periods.map((p, i) => `${p}：费用率 ${pct(m.expenseRatio[i])}`) },
    { h: '现金流信号', b: m.cashNet.length ? `各期现金：${m.cashNet.join(' / ')}${m.cashNet[last] != null && m.cashNet[last] < 0 ? ' · 最新一期现金为负，需警示' : ''}` : '表内未见现金数据。' },
    { h: '三个最该动手的地方', list: buildActions(m, last) },
  ];
}

function buildActions(m: FinMetrics, last: number): string[] {
  const acts: string[] = [];
  if (last >= 0) {
    if (m.grossMargin[last] != null && m.grossMargin[last]! < 30) acts.push('毛利率偏低：先看定价与供应链成本');
    if (m.expenseRatio[last] != null && m.expenseRatio[last]! > 40) acts.push('费用率偏高：把最大几笔费用逐项摊开核');
    if (m.cashNet[last] != null && m.cashNet[last] < 0) acts.push('现金净流为负：收紧账期与库存');
  }
  const fillers = ['把收入按客群/渠道拆开看结构', '设一个每周现金与毛利看板', '挑最大一笔成本谈价或换供给'];
  while (acts.length < 3) acts.push(fillers[acts.length]);
  return acts.slice(0, 3);
}
