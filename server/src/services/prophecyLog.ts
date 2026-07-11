// 预言账本服务（M2 PR-9）：V6.0 §4.8 天机验证——记录 → 到期 → 对账 → 命中率（服务端统计）。
// 真实性铁律：预言只来自 ① 真实模型的结构化抽取（gateway.extractProphecies，测试/mock 环境返回空）
// ② 显式记录接口。绝不从文本模糊猜测生成，宁缺毋滥——伪预言比没有预言更糟（V6.0 自己的原则）。
import { prisma } from '../db.js';
import { extractProphecies } from '../llm/gateway.js';

export interface ProphecyView {
  id: string;
  seq: number;
  prophecy: string;
  basis: string;
  verifyStandard: string;
  dueDate: string | null;
  status: 'pending' | 'hit' | 'miss';
  verifyNote: string;
  createdAt: string;
  disputeNote?: string | null; // WO-11：用户异议（列表回显，复盘时军师带出确认）
  disputedAt?: string | null;
}

export interface ProphecyStats {
  total: number;
  pending: number;
  hit: number;
  miss: number;
  hitRate: number | null; // hit/(hit+miss)；无已验证样本 = null（不编 0%）
}

function toView(r: {
  id: string; seq: number; prophecy: string; basis: string; verifyStandard: string;
  dueDate: string | null; status: string; verifyNote: string; createdAt: Date; disputeNote?: string | null; disputedAt?: Date | null;
}): ProphecyView {
  return {
    id: r.id, seq: r.seq, prophecy: r.prophecy, basis: r.basis, verifyStandard: r.verifyStandard,
    dueDate: r.dueDate, status: r.status as ProphecyView['status'], verifyNote: r.verifyNote,
    createdAt: r.createdAt.toISOString(),
    disputeNote: r.disputeNote ?? null, disputedAt: r.disputedAt ? r.disputedAt.toISOString() : null,
  };
}

export async function recordProphecy(args: {
  tenantId: string;
  userId: string;
  prophecy: string;
  basis?: string;
  verifyStandard?: string;
  dueDate?: string | null;
}): Promise<ProphecyView> {
  const prophecy = args.prophecy.trim().slice(0, 300);
  if (!prophecy) throw Object.assign(new Error('预言内容不能为空'), { statusCode: 400 });
  for (let attempt = 0; ; attempt++) {
    const last = await prisma.prophecyLog.findFirst({ where: { userId: args.userId }, orderBy: { seq: 'desc' }, select: { seq: true } });
    try {
      const row = await prisma.prophecyLog.create({
        data: {
          tenantId: args.tenantId,
          userId: args.userId,
          seq: (last?.seq ?? 0) + 1,
          prophecy,
          basis: (args.basis ?? '').trim().slice(0, 200),
          verifyStandard: (args.verifyStandard ?? '').trim().slice(0, 300),
          dueDate: args.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(args.dueDate) ? args.dueDate : null,
        },
      });
      return toView(row);
    } catch (e) {
      if (attempt >= 2) throw e; // (userId,seq) 唯一冲突重试
    }
  }
}

/** 从总军师输出抽取并落库（有命盘的用户才值得抽；真实模型不可用时抽取器返回空 → 无副作用）。 */
export async function extractAndRecordProphecies(args: {
  tenantId: string;
  userId: string;
  text: string;
}): Promise<number> {
  if (!args.text || args.text.length < 120) return 0;
  const hasChart = await prisma.natalChart.findUnique({ where: { userId: args.userId }, select: { id: true } });
  if (!hasChart) return 0;
  const items = await extractProphecies(args.text);
  let recorded = 0;
  for (const p of items) {
    // 去重：同一用户相同预言文本不重复记
    const dup = await prisma.prophecyLog.findFirst({ where: { userId: args.userId, prophecy: p.prophecy }, select: { id: true } });
    if (dup) continue;
    await recordProphecy({ tenantId: args.tenantId, userId: args.userId, ...p }).catch(() => {});
    recorded += 1;
  }
  return recorded;
}

export async function verifyProphecy(args: {
  userId: string;
  prophecyId: string;
  outcome: 'hit' | 'miss';
  note?: string;
}): Promise<ProphecyView | null> {
  const row = await prisma.prophecyLog.findFirst({ where: { id: args.prophecyId, userId: args.userId } });
  if (!row) return null;
  const updated = await prisma.prophecyLog.update({
    where: { id: row.id },
    data: { status: args.outcome, verifiedAt: new Date(), verifyNote: (args.note ?? '').trim().slice(0, 500) },
  });
  return toView(updated);
}

/** WO-11：用户对某预言提异议（不改状态，复盘时军师带出确认）。 */
export async function disputeProphecy(userId: string, id: string, note: string): Promise<boolean> {
  const r = await prisma.prophecyLog.updateMany({ where: { id, userId }, data: { disputeNote: note.trim().slice(0, 500), disputedAt: new Date() } });
  return r.count > 0;
}

export async function listProphecies(userId: string, limit = 30): Promise<ProphecyView[]> {
  const rows = await prisma.prophecyLog.findMany({ where: { userId }, orderBy: { seq: 'desc' }, take: limit });
  return rows.map(toView);
}

export async function prophecyStats(userId: string): Promise<ProphecyStats> {
  const rows = await prisma.prophecyLog.findMany({ where: { userId }, select: { status: true } });
  const hit = rows.filter((r) => r.status === 'hit').length;
  const miss = rows.filter((r) => r.status === 'miss').length;
  return {
    total: rows.length,
    pending: rows.length - hit - miss,
    hit,
    miss,
    hitRate: hit + miss >= 5 ? Math.round((hit / (hit + miss)) * 100) : null, // P-2 最小样本：<5 条不出命中率
  };
}

/** 注入对话的【天机账本】块：待验证预言 + 命中率（月复盘对账与悬念钩子的真实素材）。 */
export async function prophecyBriefing(userId: string): Promise<string | null> {
  const [recent, stats] = await Promise.all([listProphecies(userId, 3), prophecyStats(userId)]);
  if (!recent.length) return null;
  const lines = recent.map((p) => {
    const st = p.status === 'hit' ? '✓命中' : p.status === 'miss' ? '✗未命中' : `待验证${p.dueDate ? `(${p.dueDate})` : ''}`;
    return `#${p.seq} ${p.prophecy.slice(0, 80)} → ${st}`;
  });
  const verified = stats.hit + stats.miss;
  const rateLine = stats.hitRate !== null
    ? `天机命中率 ${stats.hitRate}%（命中 ${stats.hit} / 未命中 ${stats.miss}，待验证 ${stats.pending}）`
    : verified > 0
      ? `已验证 ${verified} 条（先攒够 5 条才出命中率；未命中时按「人谋可以改命」口径表达）`
      : `已验证 0 条（共 ${stats.total} 条，尚无命中率——不要编造数字；未命中时按「人谋可以改命」口径表达）`;
  const disputed = await prisma.prophecyLog.findMany({ where: { userId, disputedAt: { not: null } }, select: { seq: true, disputeNote: true }, orderBy: { seq: 'desc' }, take: 5 });
  const disputeLine = disputed.length
    ? `\n用户有异议（复盘时先确认）：${disputed.map((p) => `#${p.seq}${p.disputeNote ? '：' + p.disputeNote : ''}`).join('；')}`
    : '';
  return `【天机账本（系统计数，引用时以此为准，禁止自行推算）】\n${lines.join('\n')}\n${rateLine}${disputeLine}`;
}
