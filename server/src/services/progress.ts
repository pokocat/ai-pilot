// 用户进度服务（M2 PR-10）：战略段位 + 里程碑，全部从真实账本派生（V6.0 §11）。
// 派生口径（服务端唯一事实源，AI 只引用）：
//   段位（只升不降）：新兵 → 尉官(连续复盘≥14天) → 校官(≥30天+做过月复盘) →
//                    将军(≥90天+决策准确率>60%) → 元帅(≥180天+准确率>70%+命中率>50%)
//   里程碑（使用天数解锁）：7/30/90/180/365 天（解锁内容由对话层承接，这里只管真实解锁事实）
// 准确率/命中率为 null（无已验证样本）时视为不达标——没有数据就没有段位，绝不放水。
import { prisma } from '../db.js';
import { now } from './clock.js';
import { reviewStreak } from './reviewLog.js';
import { decisionStats } from './decisionLog.js';
import { prophecyStats } from './prophecyLog.js';

export const RANKS = ['新兵', '尉官', '校官', '将军', '元帅'] as const;
export type Rank = (typeof RANKS)[number];
export const MILESTONE_DAYS = [7, 30, 90, 180, 365] as const;

export interface ProgressView {
  rank: Rank;
  rankAchievedAt: string;
  usageDays: number;
  streak: number;
  decisionAccuracy: number | null;
  prophecyHitRate: number | null;
  milestones: Record<string, string>; // 已解锁：天数 → 解锁日期
  nextRank: { rank: Rank; requirement: string } | null;
  promoted: boolean;          // 本次同步发生了晋升
  newMilestones: number[];    // 本次同步新解锁的里程碑
}

function rankIndex(r: string): number {
  const i = RANKS.indexOf(r as Rank);
  return i < 0 ? 0 : i;
}

/** 按真实数字算「当前应得段位」（不含只升不降逻辑）。 */
export function deriveRank(m: { streak: number; monthlyReviewed: boolean; accuracy: number | null; hitRate: number | null }): Rank {
  if (m.streak >= 180 && (m.accuracy ?? 0) > 70 && (m.hitRate ?? 0) > 50) return '元帅';
  if (m.streak >= 90 && (m.accuracy ?? 0) > 60) return '将军';
  if (m.streak >= 30 && m.monthlyReviewed) return '校官';
  if (m.streak >= 14) return '尉官';
  return '新兵';
}

function nextRankOf(current: Rank): { rank: Rank; requirement: string } | null {
  switch (current) {
    case '新兵': return { rank: '尉官', requirement: '连续复盘满 14 天' };
    case '尉官': return { rank: '校官', requirement: '连续复盘满 30 天并完成一次月度复盘' };
    case '校官': return { rank: '将军', requirement: '连续复盘满 90 天且决策准确率 > 60%' };
    case '将军': return { rank: '元帅', requirement: '连续复盘满 180 天、决策准确率 > 70%、天机命中率 > 50%' };
    default: return null;
  }
}

/** 同步进度：计算 → 与存量比较 → 晋升/解锁落库（幂等；晋升记审计=晋升卡素材）。 */
export async function syncProgress(userId: string): Promise<ProgressView | null> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, tenantId: true, createdAt: true } });
  if (!user) return null;
  const [streak, dStats, pStats, monthlyCount, stored] = await Promise.all([
    reviewStreak(userId),
    decisionStats(userId),
    prophecyStats(userId),
    prisma.reviewLog.count({ where: { userId, layer: 'month' } }),
    prisma.userProgress.findUnique({ where: { userId } }),
  ]);
  const usageDays = Math.max(1, Math.floor((now().getTime() - user.createdAt.getTime()) / 86400_000) + 1);
  const derived = deriveRank({ streak, monthlyReviewed: monthlyCount > 0, accuracy: dStats.accuracy, hitRate: pStats.hitRate });

  // 只升不降：取历史最高
  const currentStored = (stored?.rank as Rank) ?? '新兵';
  const promoted = rankIndex(derived) > rankIndex(currentStored);
  const rank = promoted ? derived : currentStored;

  // 里程碑：按使用天数解锁（记录首次解锁日期）
  const milestones: Record<string, string> = { ...((stored?.milestonesJson as Record<string, string>) ?? {}) };
  const newMilestones: number[] = [];
  const d = now();
  const todayIso = `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`;
  for (const days of MILESTONE_DAYS) {
    if (usageDays >= days && !milestones[String(days)]) {
      milestones[String(days)] = todayIso;
      newMilestones.push(days);
    }
  }

  // 无变化且已有存量 → 不写库（本函数在每轮对话注入前也会被调用，避免读路径产生写放大）
  const changed = promoted || newMilestones.length > 0 || !stored;
  const row = changed
    ? await prisma.userProgress.upsert({
        where: { userId },
        update: { rank, ...(promoted ? { rankAchievedAt: new Date() } : {}), milestonesJson: milestones },
        create: { tenantId: user.tenantId, userId, rank, milestonesJson: milestones },
      })
    : stored!;
  if (promoted) {
    const { recordAudit } = await import('./audit.js');
    await recordAudit({
      tenantId: user.tenantId, userId,
      action: 'user.rank.promoted',
      payload: { from: currentStored, to: rank, streak, accuracy: dStats.accuracy, hitRate: pStats.hitRate },
    }).catch(() => {});
  }

  return {
    rank: row.rank as Rank,
    rankAchievedAt: row.rankAchievedAt.toISOString(),
    usageDays,
    streak,
    decisionAccuracy: dStats.accuracy,
    prophecyHitRate: pStats.hitRate,
    milestones,
    nextRank: nextRankOf(row.rank as Rank),
    promoted,
    newMilestones,
  };
}

/** 注入对话的【段位·里程碑】块：真实数字 + 下一目标（激励与钩子素材，禁止 AI 自算）。 */
export async function progressBriefing(userId: string): Promise<string | null> {
  const p = await syncProgress(userId);
  if (!p) return null;
  // 全新用户（新兵、无里程碑、无复盘）不注入，避免每轮多一块噪音
  if (p.rank === '新兵' && p.streak === 0 && !Object.keys(p.milestones).length) return null;
  const unlocked = Object.keys(p.milestones).sort((a, b) => Number(a) - Number(b)).map((dStr) => `${dStr}天`).join('、');
  const lines = [
    '【段位·里程碑（系统计数，引用时以此为准，禁止自行推算）】',
    `战略段位：${p.rank}｜使用第 ${p.usageDays} 天｜连续复盘 ${p.streak} 天` +
      `${p.decisionAccuracy !== null ? `｜决策准确率 ${p.decisionAccuracy}%` : ''}` +
      `${p.prophecyHitRate !== null ? `｜天机命中率 ${p.prophecyHitRate}%` : ''}`,
  ];
  if (unlocked) lines.push(`已解锁里程碑：${unlocked}`);
  if (p.nextRank) lines.push(`下一段位：${p.nextRank.rank}（${p.nextRank.requirement}）`);
  return lines.join('\n');
}
