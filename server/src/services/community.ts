// V7-13 社群 / 档案工作台服务：邀请码惰性生成、社群服务分配（老师/班级/群码）、我的页档案工作台。
// 规则：所有查询按 tenantId + userId 行级隔离；份数 = V7-06 bizCategory 真实计数；宁缺勿假。
import { prisma } from '../db.js';
import { buildClientUnderstanding } from './understanding.js';
import type {
  ServiceAssignmentView,
  ServiceAssignmentUpdate,
  WorkbenchView,
  WorkbenchSection,
  WorkbenchMissing,
} from '../../../shared/contracts';

// ── 邀请码 ──────────────────────────────────────────────────────────────
// "JS" + 4 位 base32（Crockford：去掉易混的 I/L/O/U），如 JS2K7P。
const INVITE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function randomInviteCode(): string {
  let s = 'JS';
  for (let i = 0; i < 4; i++) s += INVITE_ALPHABET[Math.floor(Math.random() * INVITE_ALPHABET.length)];
  return s;
}

/**
 * 惰性生成用户邀请码：已存在直接返回（幂等）；否则生成唯一码并持久化。
 * inviteCode 有 @unique 约束——撞码（P2002）时换一个重试；并发下若本用户已被写入则读回。
 */
export async function ensureInviteCode(userId: string): Promise<string> {
  const existing = await prisma.user.findUnique({ where: { id: userId }, select: { inviteCode: true } });
  if (existing?.inviteCode) return existing.inviteCode;

  for (let attempt = 0; attempt < 8; attempt++) {
    const code = randomInviteCode();
    try {
      const updated = await prisma.user.update({
        where: { id: userId },
        data: { inviteCode: code },
        select: { inviteCode: true },
      });
      return updated.inviteCode ?? code;
    } catch {
      // 撞 @unique 或并发：先读回——若本用户已有码（并发已写入）直接返回，否则换码重试。
      const again = await prisma.user.findUnique({ where: { id: userId }, select: { inviteCode: true } });
      if (again?.inviteCode) return again.inviteCode;
    }
  }
  throw Object.assign(new Error('邀请码生成失败，请重试'), { statusCode: 500, code: 'INVITE_CODE_FAILED' });
}

// ── 社群服务分配 ────────────────────────────────────────────────────────
function toServiceView(row: {
  teacherName: string; teacherWechat: string; className: string;
  groupQrUrl: string; taskDone: number; taskTotal: number; note: string;
}): ServiceAssignmentView {
  return {
    teacherName: row.teacherName,
    teacherWechat: row.teacherWechat,
    className: row.className,
    groupQrUrl: row.groupQrUrl,
    taskDone: row.taskDone,
    taskTotal: row.taskTotal,
    note: row.note,
  };
}

/** 读取用户社群服务分配视图；无分配 → null（前端展示「待分配」空态）。 */
export async function buildServiceView(userId: string): Promise<ServiceAssignmentView | null> {
  const row = await prisma.serviceAssignment.findUnique({ where: { userId } });
  return row ? toServiceView(row) : null;
}

function clampCount(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : 0;
  return Math.max(0, Math.min(999, v));
}

function trimTo(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

/** 运营端 upsert 社群服务分配（按 userId @unique）。只覆盖 body 中给出的字段。 */
export async function setService(
  userId: string,
  tenantId: string,
  update: ServiceAssignmentUpdate,
): Promise<ServiceAssignmentView> {
  const data: Record<string, string | number> = {};
  if (update.teacherName !== undefined) data.teacherName = trimTo(update.teacherName, 40);
  if (update.teacherWechat !== undefined) data.teacherWechat = trimTo(update.teacherWechat, 60);
  if (update.className !== undefined) data.className = trimTo(update.className, 40);
  if (update.groupQrUrl !== undefined) data.groupQrUrl = trimTo(update.groupQrUrl, 500);
  if (update.taskDone !== undefined) data.taskDone = clampCount(update.taskDone);
  if (update.taskTotal !== undefined) data.taskTotal = clampCount(update.taskTotal);
  if (update.note !== undefined) data.note = trimTo(update.note, 500);

  const row = await prisma.serviceAssignment.upsert({
    where: { userId },
    update: data,
    create: { tenantId, userId, ...data },
  });
  return toServiceView(row);
}

// ── 档案工作台 ──────────────────────────────────────────────────────────
// 完整度：由 understanding.maturity 确定性映射（空/初形成/成型）。
const COMPLETENESS: Record<'empty' | 'forming' | 'ready', number> = { empty: 20, forming: 55, ready: 85 };

// 4 固定档案分区。key 供前端定位；biz = 计数所用 V7-06 bizCategory。
// 「产品服务」无独立 bizCategory，用 growth（增长资料，含价格/交付/客户画像素材）近似。
const SECTIONS: { key: string; label: string; hint: string; biz: string }[] = [
  { key: 'founder', label: '老板档案', hint: '目标、优势、表达风格', biz: 'founder' },
  { key: 'company', label: '企业档案', hint: '组织结构、发展历程、核心产品', biz: 'company' },
  { key: 'product', label: '产品服务', hint: '价格体系、交付流程、客户画像', biz: 'growth' },
  { key: 'finance', label: '财务经营', hint: '预算表、现金流、利润估算', biz: 'finance' },
];

// nextQuestions 为空时的兜底「当前最该补」3 行（design §10.4）。
const FALLBACK_MISSING: WorkbenchMissing[] = [
  { key: 'pricing', title: '产品价格体系', desc: '影响方案报价、成交判断和复购建议。' },
  { key: 'funnel', title: '近 30 天成交漏斗表', desc: '战局页会用它判断卡点和优先级。' },
  { key: 'proof', title: '案例结果与客户反馈', desc: '用于生成信任证明和内容选题。' },
];

/**
 * 我的页「档案工作台」：完整度 + 4 分区真实计数 + 当前最该补。
 * 计数只统计已入库（stage='confirmed'）的知识条目，按 tenantId+userId 隔离。
 */
export async function buildWorkbench(args: { tenantId: string; userId: string }): Promise<WorkbenchView> {
  const { tenantId, userId } = args;
  const user = await prisma.user.findUnique({ where: { id: userId }, include: { tenant: true } });
  if (!user) throw Object.assign(new Error('用户不存在'), { statusCode: 404, code: 'USER_NOT_FOUND' });

  const understanding = await buildClientUnderstanding(user);
  const completeness = COMPLETENESS[understanding.maturity] ?? 20;

  const sections: WorkbenchSection[] = await Promise.all(
    SECTIONS.map(async (s): Promise<WorkbenchSection> => {
      const count = await prisma.knowledgeItem.count({
        where: { tenantId, userId, stage: 'confirmed', bizCategory: s.biz },
      });
      return { key: s.key, label: s.label, hint: s.hint, count, ready: count > 0 };
    }),
  );

  const top = understanding.nextQuestions.slice(0, 3);
  const missing: WorkbenchMissing[] = top.length
    ? top.map((q, i) => ({ key: `next-${i + 1}`, title: q, desc: '补齐后会刷新战局判断和案卷完整度。' }))
    : FALLBACK_MISSING;

  return { completeness, sections, missing };
}
