// 战略档案服务（M1 PR-3 统一状态层）：客户已确认的战略事实的唯一存放处。
// 回写触发点（v1，只记确认过的事，不记推断）：
//   ① 认可方案（/casefile/accept）→ 从认可的成果分节提取 主要矛盾/定位/赛道/阶段；
//   ② 用户在「我的-档案」手动编辑（PUT /profile/strategic）。
// 逐轮 LLM 结构化抽取与 M2 决策日志共用同一抽取管道（AGENTS §13 TODO），不在 v1 造第二套。
import { prisma } from '../db.js';
import type { DeliverableInput } from './casefile.js';

export interface StrategicView {
  mainContradiction: string;
  positioning: string;
  track: string;
  stage: string;
  narrative: string;  // 命运叙事线摘要（M4 PR-17：存档后跨月可复述，存 extraJson）
  verse: string;      // 年度谶语（七言/五言一句，存 extraJson；天时日历卡带出）
  updatedAt: string | null;
}

/** 从「认可的成果」分节提取战略事实（确定性规则；只取标题语义明确的分节，不猜）。 */
export function extractStrategicFacts(d: DeliverableInput): Partial<Omit<StrategicView, 'updatedAt'>> {
  const out: Partial<Omit<StrategicView, 'updatedAt'>> = {};
  const firstLine = (s?: string) => (s || '').split('\n')[0].trim().slice(0, 300);
  for (const sec of d.sections ?? []) {
    const h = sec.h || '';
    const body = sec.b || (sec.list?.length ? sec.list[0] : '');
    if (!body) continue;
    if (!out.mainContradiction && /矛盾|现状判断|核心问题/.test(h)) out.mainContradiction = firstLine(body);
    else if (!out.positioning && /定位/.test(h)) out.positioning = firstLine(body);
    else if (!out.track && /赛道|聚焦/.test(h)) out.track = firstLine(body);
    else if (!out.stage && /阶段|三步走/.test(h)) out.stage = firstLine(body).slice(0, 60);
  }
  return out;
}

/** 合并写入（只覆盖本次提取到的字段；空提取不动库）。narrative/verse 存 extraJson。 */
export async function upsertStrategicProfile(args: {
  tenantId: string;
  userId: string;
  patch: Partial<Omit<StrategicView, 'updatedAt'>>;
}): Promise<void> {
  const clean = Object.fromEntries(Object.entries(args.patch).filter(([, v]) => typeof v === 'string' && v.trim()));
  if (!Object.keys(clean).length) return;
  const { narrative, verse, ...columns } = clean as { narrative?: string; verse?: string } & Record<string, string>;
  const existing = await prisma.strategicProfile.findUnique({ where: { userId: args.userId } });
  const extra = { ...((existing?.extraJson as object) ?? {}) } as { narrative?: string; verse?: string };
  if (narrative) extra.narrative = narrative.slice(0, 500);
  if (verse) extra.verse = verse.slice(0, 40);
  await prisma.strategicProfile.upsert({
    where: { userId: args.userId },
    update: { ...columns, extraJson: extra },
    create: { tenantId: args.tenantId, userId: args.userId, ...columns, extraJson: extra },
  });
}

export async function loadStrategicProfile(userId: string): Promise<StrategicView | null> {
  const row = await prisma.strategicProfile.findUnique({ where: { userId } });
  if (!row) return null;
  const extra = (row.extraJson as { narrative?: string; verse?: string } | null) ?? {};
  return {
    mainContradiction: row.mainContradiction,
    positioning: row.positioning,
    track: row.track,
    stage: row.stage,
    narrative: extra.narrative ?? '',
    verse: extra.verse ?? '',
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** 战略档案 → 注入块（客户已确认的事实，优先于自动推断的 understanding）。空档案返回 null。 */
export function strategicBlock(p: StrategicView | null): string | null {
  if (!p) return null;
  const lines: string[] = [];
  if (p.mainContradiction) lines.push(`主要矛盾：${p.mainContradiction}`);
  if (p.positioning) lines.push(`战略定位：${p.positioning}`);
  if (p.track) lines.push(`聚焦赛道：${p.track}`);
  if (p.stage) lines.push(`当前阶段：${p.stage}`);
  if (p.narrative) lines.push(`命运叙事线：${p.narrative}（复盘时回顾「剧本走到第几幕」，保持前后一致，不得重生成矛盾版本）`);
  if (p.verse) lines.push(`年度谶语：「${p.verse}」（全年沿用这一句，不要另造）`);
  if (!lines.length) return null;
  return `【战略档案（客户已确认的战略事实，优先于任何推断；与客户新表述冲突时先求证再更新）】\n${lines.join('\n')}`;
}
