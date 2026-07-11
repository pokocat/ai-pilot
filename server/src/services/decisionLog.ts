// 决策日志服务（M2 PR-7）：记录 → 到期验证 → 准确率统计（全部服务端计算，AI 只引用）。
// 写入源（v1）：① 认可方案自动记一条（决策=采纳该方案主判断）；② 手动/前端接口；
// ③ AI 工具位与 LLM 抽取管道随 PR-9 共建。序号 seq 按用户自增（决策 #N 的展示口径）。
import { prisma } from '../db.js';
import { now, dateKey } from './clock.js';
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
  disputeNote?: string | null; // WO-11：用户异议（列表回显，复盘时军师带出确认）
  disputedAt?: string | null;
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
  verifyNote: string; fast: boolean | null; createdAt: Date; disputeNote?: string | null; disputedAt?: Date | null;
}): DecisionView {
  return {
    id: r.id, seq: r.seq, scene: r.scene, decision: r.decision,
    reasons: (r.reasons as string[]) ?? [], tianshiRef: r.tianshiRef,
    expected: r.expected, verifyStandard: r.verifyStandard, verifyByDate: r.verifyByDate,
    status: r.status as DecisionView['status'], verifyNote: r.verifyNote, fast: r.fast,
    createdAt: r.createdAt.toISOString(),
    disputeNote: r.disputeNote ?? null, disputedAt: r.disputedAt ? r.disputedAt.toISOString() : null,
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

/**
 * 认可方案 → 自动记一条决策（决策=采纳主判断；验证标准=当日军令与回填数据）。
 * P1-1 幂等：同一用户重复认可同一方案（方案指纹 = decision 文本，由 title + 主判断确定性拼出）不再重复插入，
 * 否则每次重复 accept 都多记一条待验证决策，直接污染准确率统计的分母。
 * 双检 + 按用户 advisory 锁串行 check→seq→insert，堵住并发双提交窗口（与 reports/purchase 同一并发范式）。
 */
export async function recordDecisionFromAccept(args: {
  tenantId: string;
  userId: string;
  deliverable: DeliverableInput;
  agentName: string;
}): Promise<DecisionView | null> {
  const judgment = firstJudgment(args.deliverable);
  if (!judgment) return null;
  const scene = '战略规划';
  const decision = `采纳《${(args.deliverable.title || '军师方案').slice(0, 60)}》：${judgment.slice(0, 200)}`.slice(0, 500);
  const verifyBy = new Date(now().getTime() + 30 * 86400_000); // 默认 30 天验证期（月复盘对账）
  const verifyByDate = dateKey(verifyBy); // 上海时区日历日（P1-4）

  // 快路径：无锁存在性检查（命中即返回旧记录，覆盖顺序重复 accept 这一主场景）。
  const dup = await prisma.decisionLog.findFirst({ where: { userId: args.userId, scene, decision } });
  if (dup) return toView(dup);

  // 慢路径：并发双提交时按「用户级」advisory 锁串行「再检查 → 取 seq → 落库」——
  // 用户级（非方案级）粒度：同一用户并发认可「不同方案」的两条 insert 也串行，避免各自读到同一 MAX(seq) 撞唯一键。
  const lockKey = `decision-accept:${args.userId}`;
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
    const again = await tx.decisionLog.findFirst({ where: { userId: args.userId, scene, decision } });
    if (again) return toView(again);
    const last = await tx.decisionLog.findFirst({ where: { userId: args.userId }, orderBy: { seq: 'desc' }, select: { seq: true } });
    const row = await tx.decisionLog.create({
      data: {
        tenantId: args.tenantId,
        userId: args.userId,
        scene,
        decision,
        reasons: [`由${args.agentName}产出并经客户认可`],
        verifyStandard: '按该方案拆出的军令完成情况与线索/咨询/成交回填数据验证',
        verifyByDate,
        fast: false,
        seq: (last?.seq ?? 0) + 1,
      },
    });
    return toView(row);
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

/** WO-11：用户对某决策提异议（不改状态，复盘时军师带出确认后再走既有验证更新）。 */
export async function disputeDecision(userId: string, id: string, note: string): Promise<boolean> {
  const r = await prisma.decisionLog.updateMany({ where: { id, userId }, data: { disputeNote: note.trim().slice(0, 500), disputedAt: new Date() } });
  return r.count > 0;
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
  const disputed = await prisma.decisionLog.findMany({ where: { userId, disputedAt: { not: null } }, select: { seq: true, disputeNote: true }, orderBy: { seq: 'desc' }, take: 5 });
  const disputeLine = disputed.length
    ? `\n用户有异议（复盘时先确认再更新，勿视作已定论）：${disputed.map((d) => `#${d.seq}${d.disputeNote ? '：' + d.disputeNote : ''}`).join('；')}`
    : '';
  return `【决策账本（系统计数，引用时以此为准，禁止自行推算）】\n${lines.join('\n')}\n${accLine}${disputeLine}`;
}
