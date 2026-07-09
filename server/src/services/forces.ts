// V7-04：三势结构化（天势/市势/人势）。军师产出 level/结论/打法/说明，strength 由代码按 level 映射（禁止 AI 自算百分比）。
// 落 StrategicProfile.forcesJson.battle（与 L-6 的 shishi/renshi 同表不同键，互不覆盖）。mock/test 走确定性兜底。
import { z } from 'zod';
import { prisma } from '../db.js';
import { now } from './clock.js';
import { structured } from '../llm/gateway.js';
import type { BattleForce, ForceLevel } from '../../../shared/contracts';

// level → strength（纯代码映射，对齐效果图 75/45/35；可按行业基准/回填趋势 ±5 微调，仍不让模型自算）。
const STRENGTH_BY_LEVEL: Record<ForceLevel, number> = { strong: 75, mid: 45, weak: 35 };

// 确定性兜底（mock/test/无 LLM）：与效果图默认三势一致，保证「像原型」的首屏体验。
const DEFAULT_FORCES: BattleForce[] = [
  { kind: 'sky', level: 'strong', conclusion: '行业上行', tactic: '可以借势', tacticTone: 'ok', note: '少追热点，多沉淀判断框架。', strength: 75 },
  { kind: 'market', level: 'mid', conclusion: '对手抢位', tactic: '不能扩量', tacticTone: 'warn', note: '老板要少误判，不缺泛内容。', strength: 45 },
  { kind: 'people', level: 'weak', conclusion: '团队待整', tactic: '轻资产验证', tacticTone: 'danger', note: '先用内容和私域跑小闭环。', strength: 35 },
];

const ForceLevelZ = z.enum(['strong', 'mid', 'weak']);
const ForceToneZ = z.enum(['ok', 'warn', 'danger']);
const ForceKindZ = z.enum(['sky', 'market', 'people']);
const ForcesSchema = z.object({
  forces: z.array(z.object({
    kind: ForceKindZ,
    level: ForceLevelZ,
    conclusion: z.string().transform((s) => s.trim().slice(0, 20)),
    tactic: z.string().transform((s) => s.trim().slice(0, 20)),
    tacticTone: ForceToneZ.catch('ok'),
    note: z.string().transform((s) => s.trim().slice(0, 60)),
  })).transform((a) => a.slice(0, 3)),
});

const FORCES_SYS = `你是「军师参谋部」的战略研判官。基于客户档案与案卷判断，对三势各给一句研判：
- 天势(sky)：行业与外部大势；市势(market)：竞争与需求；人势(people)：团队与承载。
每势给：level(strong/mid/weak)、conclusion(≤8字结论)、tactic(≤8字打法)、tacticTone(ok/warn/danger)、note(≤20字说明)。
只输出 JSON：{"forces":[{"kind":"sky","level":"strong","conclusion":"…","tactic":"…","tacticTone":"ok","note":"…"}, …3条]}。禁止输出百分比或多余文字。`;

/** 读取已生成的结构化三势（无则 null）。 */
export async function loadBattleForces(userId: string): Promise<{ forces: BattleForce[]; at: string | null } | null> {
  const row = await prisma.strategicProfile.findUnique({ where: { userId }, select: { forcesJson: true } });
  const raw = (row?.forcesJson as { battle?: BattleForce[]; battleAt?: string } | null) ?? null;
  if (!raw?.battle?.length) return null;
  return { forces: raw.battle, at: raw.battleAt ?? null };
}

function applyStrength(forces: { kind: BattleForce['kind']; level: ForceLevel; conclusion: string; tactic: string; tacticTone: BattleForce['tacticTone']; note: string }[]): BattleForce[] {
  const byKind = new Map(forces.map((f) => [f.kind, f]));
  // 保证三势齐全、顺序稳定（sky→market→people），缺的用默认补。
  return (['sky', 'market', 'people'] as const).map((kind) => {
    const f = byKind.get(kind) ?? DEFAULT_FORCES.find((d) => d.kind === kind)!;
    const level = (f.level ?? 'mid') as ForceLevel;
    return {
      kind,
      level,
      conclusion: f.conclusion || DEFAULT_FORCES.find((d) => d.kind === kind)!.conclusion,
      tactic: f.tactic || DEFAULT_FORCES.find((d) => d.kind === kind)!.tactic,
      tacticTone: f.tacticTone ?? 'ok',
      note: f.note || DEFAULT_FORCES.find((d) => d.kind === kind)!.note,
      strength: STRENGTH_BY_LEVEL[level] ?? 45,
    };
  });
}

/** 生成并落库结构化三势。输入=战略档案 + 最新案卷判断 + 行业；LLM 不可用时用确定性兜底。 */
export async function generateForces(args: { tenantId: string; userId: string }): Promise<BattleForce[]> {
  const { tenantId, userId } = args;
  const [sp, cf, tenant] = await Promise.all([
    prisma.strategicProfile.findUnique({ where: { userId }, select: { mainContradiction: true, positioning: true, stage: true, track: true } }),
    prisma.casefile.findFirst({ where: { userId, status: 'active' }, orderBy: { updatedAt: 'desc' }, select: { judgment: true, title: true } }),
    prisma.tenant.findUnique({ where: { id: tenantId }, select: { industry: true } }),
  ]);
  const ctxLines = [
    tenant?.industry ? `行业：${tenant.industry}` : '',
    sp?.mainContradiction ? `主要矛盾：${sp.mainContradiction}` : '',
    sp?.positioning ? `战略定位：${sp.positioning}` : '',
    sp?.stage ? `经营阶段：${sp.stage}` : '',
    cf?.judgment ? `当前案卷判断：${cf.judgment}` : '',
  ].filter(Boolean).join('\n');

  const parsed = await structured(ForcesSchema, { system: FORCES_SYS, user: ctxLines || '暂无更多档案，按通用商业情形研判。', maxChars: 1500 }).catch(() => null);
  const forces = parsed?.forces?.length ? applyStrength(parsed.forces) : DEFAULT_FORCES;

  const existing = await prisma.strategicProfile.findUnique({ where: { userId }, select: { forcesJson: true } });
  const merged = { ...((existing?.forcesJson as Record<string, unknown> | null) ?? {}), battle: forces, battleAt: now().toISOString() };
  await prisma.strategicProfile.upsert({
    where: { userId },
    update: { forcesJson: merged as object },
    create: { tenantId, userId, forcesJson: merged as object },
  });
  return forces;
}

/** 注入【战略档案】的一行三势摘要（服务端结论，禁止 AI 自算强度）。 */
export function battleForcesLine(forces: BattleForce[] | null): string | null {
  if (!forces?.length) return null;
  const label: Record<BattleForce['kind'], string> = { sky: '天势', market: '市势', people: '人势' };
  const lv: Record<ForceLevel, string> = { strong: '强', mid: '中', weak: '弱' };
  const parts = forces.map((f) => `${label[f.kind]}${lv[f.level]}（${f.conclusion}·${f.tactic}）`);
  return `三势研判（系统结论，引用时以此为准，不要编造强度数字）：${parts.join('，')}`;
}
