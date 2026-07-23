// V7-04：三势结构化（天势/市势/人势）。军师产出 level/结论/打法/说明，strength 由代码按 level 映射（禁止 AI 自算百分比）。
// 落 StrategicProfile.forcesJson.battle（与 L-6 的 shishi/renshi 同表不同键，互不覆盖）。mock/test 走确定性兜底。
import { z } from 'zod';
import { prisma } from '../db.js';
import { now } from './clock.js';
import { structured } from '../llm/gateway.js';
import { isAiTestMode } from '../env.js';
import { loadChart } from './paipan.js';
import type { ChartView } from './paipan.js';
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
- 天势(sky)：行业与外部大势（若给了命盘天时可参，但以行业实势为主，不得堆砌命理术语）；市势(market)：竞争与需求；人势(people)：团队与承载。
每势给：level(strong/mid/weak)、conclusion(≤8字结论)、tactic(≤8字打法)、tacticTone(ok/warn/danger)、note(≤20字说明)。
只输出 JSON：{"forces":[{"kind":"sky","level":"strong","conclusion":"…","tactic":"…","tacticTone":"ok","note":"…"}, …3条]}。禁止输出百分比或多余文字。`;

/** 读取已生成的结构化三势（无则 null）。 */
export async function loadBattleForces(userId: string): Promise<{ forces: BattleForce[]; at: string | null } | null> {
  const row = await prisma.strategicProfile.findUnique({ where: { userId }, select: { forcesJson: true } });
  const raw = (row?.forcesJson as { battle?: BattleForce[]; battleAt?: string } | null) ?? null;
  if (!raw?.battle?.length) return null;
  return { forces: raw.battle, at: raw.battleAt ?? null };
}

// LLM 只给出部分势时的诚实占位（不编造结论文本，如实标注「信息不足」）。
const PLACEHOLDER_BY_KIND: Record<BattleForce['kind'], { conclusion: string; tactic: string; note: string }> = {
  sky: { conclusion: '待研判', tactic: '先补档案', note: '外部大势信息不足，补充后再研判。' },
  market: { conclusion: '待研判', tactic: '先补档案', note: '竞争/需求信息不足，补充后再研判。' },
  people: { conclusion: '待研判', tactic: '先补档案', note: '团队/承载信息不足，补充后再研判。' },
};

function applyStrength(forces: { kind: BattleForce['kind']; level: ForceLevel; conclusion: string; tactic: string; tacticTone: BattleForce['tacticTone']; note: string }[]): BattleForce[] {
  const byKind = new Map(forces.map((f) => [f.kind, f]));
  // 保证三势齐全、顺序稳定（sky→market→people）；缺的用「诚实占位」补（不借 DEFAULT_FORCES 的捏造结论）。
  return (['sky', 'market', 'people'] as const).map((kind) => {
    const ph = PLACEHOLDER_BY_KIND[kind];
    const f = byKind.get(kind);
    if (!f) return { kind, level: 'mid' as ForceLevel, conclusion: ph.conclusion, tactic: ph.tactic, tacticTone: 'warn', note: ph.note, strength: STRENGTH_BY_LEVEL.mid };
    const level = (f.level ?? 'mid') as ForceLevel;
    return {
      kind,
      level,
      conclusion: f.conclusion || ph.conclusion,
      tactic: f.tactic || ph.tactic,
      tacticTone: f.tacticTone ?? 'ok',
      note: f.note || ph.note,
      strength: STRENGTH_BY_LEVEL[level] ?? 45,
    };
  });
}

/**
 * 命盘 → 天势研判上下文（压缩两行，供 LLM 参考；strength 仍由代码映射，禁 AI 自算）。
 * 只取格局 + 日主强弱 + 当年逐月攻守概览（拐点月 / 进攻月），不整段贴 chartBriefing。
 */
function chartContextLines(chart: ChartView): string[] {
  const dm = chart.dayMaster;
  const byPhase = (k: '进攻' | '防守') =>
    chart.monthlyOutlook.months.filter((m) => m.phase === k).map((m) => `${m.month}`).join('、') || '无';
  const turning = chart.monthlyOutlook.months.filter((m) => m.turning).map((m) => `${m.month}`).join('、') || '无';
  return [
    `命盘：${chart.pattern.name}·${dm.strength}（日主${dm.gan}${dm.element}）`,
    `${chart.monthlyOutlook.year}年逐月攻守：拐点月 ${turning}；进攻月 ${byPhase('进攻')}；防守月 ${byPhase('防守')}`,
  ];
}

/**
 * 组装三势研判上下文（战略档案 + 案卷判断 + 行业 + 命盘天时）。
 * 命理开关：believe=false（用户不用命理视角）→ 不查不注入命盘。抽出便于单测。
 */
export async function buildForcesContext(args: { tenantId: string; userId: string }): Promise<string> {
  const { tenantId, userId } = args;
  const [sp, cf, tenant, profile] = await Promise.all([
    prisma.strategicProfile.findUnique({ where: { userId }, select: { mainContradiction: true, positioning: true, stage: true, track: true } }),
    prisma.casefile.findFirst({ where: { userId, status: 'active' }, orderBy: { updatedAt: 'desc' }, select: { judgment: true, title: true } }),
    prisma.tenant.findUnique({ where: { id: tenantId }, select: { industry: true } }),
    prisma.profile.findFirst({ where: { tenantId }, orderBy: { updatedAt: 'desc' }, select: { extraJson: true } }),
  ]);
  // 业务现状（决定是否有可研判素材）：命盘只作天势补充，不能独自救活零档案（P0-3 零档案不臆造）。
  const baseLines = [
    tenant?.industry ? `行业：${tenant.industry}` : '',
    sp?.mainContradiction ? `主要矛盾：${sp.mainContradiction}` : '',
    sp?.positioning ? `战略定位：${sp.positioning}` : '',
    sp?.stage ? `经营阶段：${sp.stage}` : '',
    cf?.judgment ? `当前案卷判断：${cf.judgment}` : '',
  ].filter(Boolean);
  if (!baseLines.length) return '';
  // 命理开关与 dossier gather 同口径：extraJson.bazi.believe 未显式 false 即视为使用命理视角。
  const believe = ((profile?.extraJson as { bazi?: { believe?: boolean } } | null)?.bazi?.believe) !== false;
  const chart = believe ? await loadChart(userId).catch(() => null) : null;
  return [...baseLines, ...(chart ? chartContextLines(chart) : [])].join('\n');
}

/**
 * 生成并落库结构化三势。输入=战略档案 + 最新案卷判断 + 行业 + 命盘天时。
 * P0-3（服务端）：拒绝捏造——
 *  - 零档案（ctxLines 为空）：不调 LLM、不落库，返回 null（前端走空态引导卡）。
 *  - LLM 失败：生产环境返回 null 不落库（绝不把 DEFAULT_FORCES 捏造结论写进档案）；
 *    仅 mock/test（isAiTestMode）走 DEFAULT_FORCES 确定性兜底，保证测试可复现。
 */
export async function generateForces(args: { tenantId: string; userId: string }): Promise<BattleForce[] | null> {
  const { tenantId, userId } = args;
  const ctxLines = await buildForcesContext(args);
  // 零档案：没有任何可研判的现状 → 不臆造三势（不调 LLM、不落库）。
  if (!ctxLines) return null;

  const parsed = await structured(ForcesSchema, { system: FORCES_SYS, user: ctxLines, maxChars: 1500 }).catch(() => null);
  let forces: BattleForce[];
  if (parsed?.forces?.length) forces = applyStrength(parsed.forces);
  else if (isAiTestMode()) forces = DEFAULT_FORCES; // mock/test 确定性兜底
  else return null; // 生产：LLM 失败不落库捏造默认

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
