// 决策日志服务（M2 PR-7）：记录 → 到期验证 → 准确率统计（全部服务端计算，AI 只引用）。
// 写入源（v1）：① 认可方案自动记一条（决策=采纳该方案主判断）；② 手动/前端接口；
// ③ AI 工具位与 LLM 抽取管道随 PR-9 共建。序号 seq 按用户自增（决策 #N 的展示口径）。
import { prisma } from '../db.js';
import { now } from './clock.js';
import type { DeliverableInput } from './casefile.js';
import { firstJudgment } from './casefile.js';

export interface DecisionView {
  id: string;
  seq: number;
  scene: string;
  decision: string;
  reasons: string[];
  tianshiRef: string;
  expected: string;
  verifyStandard: string;
  verifyByDate: string | null;
  status: 'pending' | 'correct' | 'revise';
  verifyNote: string;
  fast: boolean | null;
  createdAt: string;
}

export interface DecisionStats {
  total: number;
  pending: number;
  correct: number;
  revise: number;
  accuracy: number | null;      // correct/(correct+revise)，无已验证样本 = null（不编 0%）
  fastAccuracy: number | null;  // 快决策准确率
  slowAccuracy: number | null;  // 慢决策准确率
}

function toView(r: {
  id: string; seq: number; scene: string; decision: string; reasons: unknown; tianshiRef: string;
  expected: string; verifyStandard: string; verifyByDate: string | null; status: string;
  verifyNote: string; fast: boolean | null; createdAt: Date;
}): DecisionView {
  return {
    id: r.id, seq: r.seq, scene: r.scene, decision: r.decision,
    reasons: (r.reasons as string[]) ?? [], tianshiRef: r.tianshiRef,
    expected: r.expected, verifyStandard: r.verifyStandard, verifyByDate: r.verifyByDate,
    status: r.status as DecisionView['status'], verifyNote: r.verifyNote, fast: r.fast,
    createdAt: r.createdAt.toISOString(),
  };
}

/** 记一条决策（seq 用户内自增；并发下重试一次即可满足单用户操作频率）。 */
export async function recordDecision(args: {
  tenantId: string;
  userId: string;
  scene?: string;
  decision: string;
  reasons?: string[];
  tianshiRef?: string;
  expected?: string;
  verifyStandard?: string;
  verifyByDate?: string | null;
  fast?: boolean | null;
}): Promise<DecisionView> {
  const clip = (s: string | undefined, n: number) => (s ?? '').trim().slice(0, n);
  const data = {
    tenantId: args.tenantId,
    userId: args.userId,
    scene: clip(args.scene, 20) || '战略规划',
    decision: clip(args.decision, 500),
    reasons: (args.reasons ?? []).slice(0, 3).map((r) => String(r).slice(0, 200)),
    tianshiRef: clip(args.tianshiRef, 200),
    expected: clip(args.expected, 500),
    verifyStandard: clip(args.verifyStandard, 500),
    verifyByDate: args.verifyByDate && /^\d{4}-\d{2}-\d{2}$/.test(args.verifyByDate) ? args.verifyByDate : null,
    fast: args.fast ?? null,
  };
  if (!data.decision) throw Object.assign(new Error('决策内容不能为空'), { statusCode: 400 });
  for (let attempt = 0; ; attempt++) {
    const last = await prisma.decisionLog.findFirst({ where: { userId: args.userId }, orderBy: { seq: 'desc' }, select: { seq: true } });
    try {
      const row = await prisma.decisionLog.create({ data: { ...data, seq: (last?.seq ?? 0) + 1 } });
      return toView(row);
    } catch (e) {
      if (attempt >= 2) throw e; // (userId,seq) 唯一冲突 → 重试
    }
  }
}

/** 认可方案 → 自动记一条决策（决策=采纳主判断；验证标准=当日军令与回填数据）。 */
export async function recordDecisionFromAccept(args: {
  tenantId: string;
  userId: string;
  deliverable: DeliverableInput;
  agentName: string;
}): Promise<DecisionView | null> {
  const judgment = firstJudgment(args.deliverable);
  if (!judgment) return null;
  const d = now();
  const verifyBy = new Date(d.getTime() + 30 * 86400_000); // 默认 30 天验证期（月复盘对账）
  const pad = (n: number) => `${n}`.padStart(2, '0');
  return recordDecision({
    tenantId: args.tenantId,
    userId: args.userId,
    scene: '战略规划',
    decision: `采纳《${(args.deliverable.title || '军师方案').slice(0, 60)}》：${judgment.slice(0, 200)}`,
    reasons: [`由${args.agentName}产出并经客户认可`],
    verifyStandard: '按该方案拆出的军令完成情况与线索/咨询/成交回填数据验证',
    verifyByDate: `${verifyBy.getFullYear()}-${pad(verifyBy.getMonth() + 1)}-${pad(verifyBy.getDate())}`,
    fast: false,
  });
}

/** 验证决策：correct（判断正确）/ revise（需修正），带事实记录。 */
export async function verifyDecision(args: {
  userId: string;
  decisionId: string;
  outcome: 'correct' | 'revise';
  note?: string;
}): Promise<DecisionView | null> {
  const row = await prisma.decisionLog.findFirst({ where: { id: args.decisionId, userId: args.userId } });
  if (!row) return null;
  const updated = await prisma.decisionLog.update({
    where: { id: row.id },
    data: { status: args.outcome, verifiedAt: new Date(), verifyNote: (args.note ?? '').trim().slice(0, 500) },
  });
  return toView(updated);
}

export async function listDecisions(userId: string, limit = 20): Promise<DecisionView[]> {
  const rows = await prisma.decisionLog.findMany({ where: { userId }, orderBy: { seq: 'desc' }, take: limit });
  return rows.map(toView);
}

/** 准确率统计（服务端计数；无已验证样本返回 null，绝不编数字）。 */
export async function decisionStats(userId: string): Promise<DecisionStats> {
  const rows = await prisma.decisionLog.findMany({ where: { userId }, select: { status: true, fast: true } });
  const total = rows.length;
  const correct = rows.filter((r) => r.status === 'correct').length;
  const revise = rows.filter((r) => r.status === 'revise').length;
  const acc = (c: number, r: number) => (c + r >= 5 ? Math.round((c / (c + r)) * 100) : null); // P-2 最小样本：<5 条已验证不出比率（避免 1 条即 100% 直接喂晋升）
  const fastRows = rows.filter((r) => r.fast === true);
  const slowRows = rows.filter((r) => r.fast === false);
  return {
    total,
    pending: total - correct - revise,
    correct,
    revise,
    accuracy: acc(correct, revise),
    fastAccuracy: acc(fastRows.filter((r) => r.status === 'correct').length, fastRows.filter((r) => r.status === 'revise').length),
    slowAccuracy: acc(slowRows.filter((r) => r.status === 'correct').length, slowRows.filter((r) => r.status === 'revise').length),
  };
}

/** 注入对话的【决策账本】块：近期决策 + 服务端算出的准确率；无记录返回 null。 */
export async function decisionBriefing(userId: string): Promise<string | null> {
  const [recent, stats] = await Promise.all([listDecisions(userId, 5), decisionStats(userId)]);
  if (!recent.length) return null;
  const lines = recent.map((d) => {
    const st = d.status === 'correct' ? '✓正确' : d.status === 'revise' ? '✗需修正' : `待验证${d.verifyByDate ? `(${d.verifyByDate})` : ''}`;
    return `#${d.seq} [${d.createdAt.slice(0, 10)}] ${d.decision.slice(0, 80)} → ${st}`;
  });
  const verified = stats.correct + stats.revise;
  const accLine = stats.accuracy !== null
    ? `决策准确率 ${stats.accuracy}%（正确 ${stats.correct} / 需修正 ${stats.revise}，待验证 ${stats.pending}）`
    : verified > 0
      ? `已验证 ${verified} 条（先攒够 5 条才出准确率，不要编造数字）`
      : `已验证 0 条（共 ${stats.total} 条，尚无准确率——不要编造数字）`;
  return `【决策账本（系统计数，引用时以此为准，禁止自行推算）】\n${lines.join('\n')}\n${accLine}`;
}
