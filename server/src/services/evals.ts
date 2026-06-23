// 评测harness（P5）：把某个版本（草稿/已发布/历史）跑过一套「黄金测试集」，
// 用 LLM 评委按评分标准逐条打 0-10 分，加权汇总成一个客观分数。
// 用途：让「调教得多好」可量化 → 客观支撑「调教越好卖越贵」（分数→建议定价档位）。
//
// 跑测复用调教沙盒的隔离上下文（buildSandboxContext）：不掺真实用户数据、不真扣额度、不污染计费。
// 单次 run 可能要 2N 次模型调用（N 用例 ×（产出 + 评分）），故在后台异步跑，前端轮询 run 状态。

import { prisma } from '../db.js';
import { buildSandboxContext } from './context.js';
import { generateDeliverable, chatComplete, completeJson } from '../llm/gateway.js';
import { getAiConfig } from './aiConfig.js';
import type { PreviewTarget } from './agentVersions.js';
import type { Deliverable, PricingTier, SuggestedTier } from '../../../shared/contracts';

// 评分 → 建议定价档位（token 消耗倍率）。从高到低取第一个达标的。
export const PRICING_TIERS: PricingTier[] = [
  { id: 'flagship', label: '旗舰', billingRatio: 2.0, minScore: 8.5 },
  { id: 'pro', label: '进阶', billingRatio: 1.5, minScore: 7.0 },
  { id: 'standard', label: '标准', billingRatio: 1.0, minScore: 0 },
];

export function suggestTier(score: number | null): SuggestedTier {
  // P1-A2：分数为空（未配真实模型 / 全部产出失败）时不给定价档，避免把「无结论」误读成「标准档」。
  if (score === null) return { score: null, tier: null };
  const tier = PRICING_TIERS.find((t) => score >= t.minScore) ?? PRICING_TIERS[PRICING_TIERS.length - 1];
  return { score, tier };
}

// P1-A2：回收卡死的 run（进程重启/异常导致永久 running），下次启动评测时清理。
const STALE_RUN_MS = 10 * 60 * 1000;
async function reapStaleRuns(agentKey: string): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_RUN_MS);
  await prisma.evalRun
    .updateMany({ where: { agentKey, status: 'running', createdAt: { lt: cutoff } }, data: { status: 'error', note: '运行超时被回收（进程重启或卡死）' } })
    .catch(() => {});
}

function deliverableToText(d: Deliverable): string {
  const head = `${d.title}\n`;
  const body = d.sections.map((s) => `${s.h}\n${s.b ?? ''}${(s.list ?? []).map((x) => `\n- ${x}`).join('')}`).join('\n\n');
  return `${head}${body}`;
}

// LLM 评委：根据评分标准给被测回答打 0-10 分。未配置真实模型（mock）→ 返回中性占位分。
async function judge(input: string, output: string, rubric: string | null): Promise<{ score: number | null; note: string }> {
  const sys = [
    '你是严格、客观的 AI 回答评测评委。根据【评分标准】给【被测回答】打 0-10 分（10=完全达标且出色，5=及格，0=完全跑题/有害）。',
    '重点看：是否切题、是否专业可执行、是否符合标准、有无编造。只输出 JSON：{"score": 数字, "note": "一句话理由"}。',
  ].join('\n');
  const user = `【用户问题】\n${input}\n\n【评分标准】\n${rubric || '回答是否专业、切题、可执行、无编造。'}\n\n【被测回答】\n${output.slice(0, 6000)}`;
  // P1-A2：评分用 temperature=0（可复现）+ 可选独立评委模型 JUDGE_MODEL（避免被测模型自评；留空=同全局模型）。
  const j = await completeJson(sys, user, { temperature: 0, model: process.env.JUDGE_MODEL || undefined });
  if (!j || typeof j.score !== 'number') return { score: null, note: '未配置真实模型，无法评分（mock）' };
  const score = Math.max(0, Math.min(10, j.score as number));
  return { score, note: typeof j.note === 'string' ? j.note : '' };
}

/** 启动一次评测：同步建 run（拿到 id），后台异步逐条跑分。返回 runId 供前端轮询。 */
export async function startEvalRun(opts: {
  agentKey: string;
  setId: string;
  target?: PreviewTarget;
  targetLabel: string;
  accountId?: string | null;
}): Promise<string> {
  await reapStaleRuns(opts.agentKey); // P1-A2：先回收卡死的旧 run
  const set = await prisma.evalSet.findUnique({ where: { id: opts.setId }, include: { cases: { orderBy: { sort: 'asc' } } } });
  if (!set || set.agentKey !== opts.agentKey) throw Object.assign(new Error('评测集不存在'), { statusCode: 404, code: 'SET_NOT_FOUND' });
  if (!set.cases.length) throw Object.assign(new Error('评测集为空，请先添加用例'), { statusCode: 400, code: 'EMPTY_SET' });

  const cfg = await getAiConfig();
  const run = await prisma.evalRun.create({
    data: {
      agentKey: opts.agentKey, setId: opts.setId,
      targetRef: typeof opts.target === 'object' ? opts.target.versionId : opts.target === 'draft' ? 'draft' : 'published',
      targetLabel: opts.targetLabel, status: 'running', judgeModel: process.env.JUDGE_MODEL || cfg.label || cfg.model, createdBy: opts.accountId ?? null,
    },
  });
  // 后台异步跑分（不阻塞请求）。失败写进 run.note。
  void processRun(run.id, set.agentKey, set.cases, opts.target).catch(async (e) => {
    console.error('[evals] run failed:', (e as Error).message);
    await prisma.evalRun.update({ where: { id: run.id }, data: { status: 'error', note: (e as Error).message } }).catch(() => {});
  });
  return run.id;
}

type CaseRow = { id: string; input: string; rubric: string | null; weight: number; contextJson: unknown };

async function processRun(runId: string, agentKey: string, cases: CaseRow[], target?: PreviewTarget): Promise<void> {
  let weightedSum = 0;
  let weightTotal = 0;
  let scored = 0;
  for (const c of cases) {
    const profile = (c.contextJson as { companyName?: string; industry?: string; stage?: string; pain?: string } | null) ?? undefined;
    const built = await buildSandboxContext({ agentKey, userMessage: c.input, target, profile });
    if (!built) continue;
    const t0 = Date.now();
    let output = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let failed = false;
    try {
      if (built.effective.deliverableKey) {
        const r = await generateDeliverable(built.ctx, { agentKey, sandbox: true });
        output = deliverableToText(r.result);
        inputTokens = r.usage.inputTokens; outputTokens = r.usage.outputTokens;
      } else {
        const r = await chatComplete(built.ctx, { agentKey, sandbox: true });
        output = r.result.text;
        inputTokens = r.usage.inputTokens; outputTokens = r.usage.outputTokens;
      }
    } catch (e) {
      output = `（产出失败：${(e as Error).message}）`;
      failed = true;
    }
    const latencyMs = Date.now() - t0;
    // P1-A2：产出失败不送评委打分（否则把「基建失败」混成「答得差」，污染均分），标记 unscored。
    const { score, note } = failed
      ? { score: null as number | null, note: '产出失败，本条不计分' }
      : await judge(c.input, output, c.rubric);
    await prisma.evalCaseResult.create({
      data: { runId, caseId: c.id, input: c.input, output: output.slice(0, 8000), judgeScore: score, judgeNote: note, inputTokens, outputTokens, latencyMs },
    });
    if (score !== null) {
      const w = c.weight > 0 ? c.weight : 1;
      weightedSum += score * w; weightTotal += w; scored++;
    }
  }
  const score = weightTotal > 0 ? Math.round((weightedSum / weightTotal) * 100) / 100 : null;
  await prisma.evalRun.update({
    where: { id: runId },
    data: { status: 'done', score, note: scored < cases.length ? `${scored}/${cases.length} 条可评分（其余未配置模型或产出失败）` : null },
  });
}
