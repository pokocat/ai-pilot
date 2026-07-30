// 战略档案服务（M1 PR-3 统一状态层）：客户已确认的战略事实的唯一存放处。
// 回写触发点（v1，只记确认过的事，不记推断）：
//   ① 认可方案（/casefile/accept）→ 从认可的成果分节提取 主要矛盾/定位/赛道/阶段 + 封面/谶语分节里的年度谶语；
//   ② 用户在「我的-档案」手动编辑（PUT /profile/strategic）；
//   ③ 读老板页档案时按命盘补当年谶语（ensureAnnualVerse，零 LLM 兜底）。
// 逐轮 LLM 结构化抽取与 M2 决策日志共用同一抽取管道（AGENTS §13 TODO），不在 v1 造第二套。
import { prisma } from '../db.js';
import type { DeliverableInput } from './casefile.js';
import { cardSection } from './deliverableSection.js';
import { llmJson } from '../llm/gateway.js';
import { yearOf } from './clock.js';
import { isFeatureEnabled } from './featureFlag.js';
import { loadChart } from './paipan.js';
import { composeAnnualVerse } from './mingpan.js';
import type { ForcesView, ForceVerdict, ForceView, StrategicProfile, StrategicProfilePatch } from '../../../shared/contracts';
import type { DeliverableSection } from '../llm/schema.js';

/** 与 casefile.ts 同一份修复：d.sections 实际是报告 V2 类型化 section，读前先归一化。 */
function normalizedSections(d: DeliverableInput) {
  return ((d.sections ?? []) as unknown as DeliverableSection[]).map(cardSection);
}

export type StrategicView = StrategicProfile;

/** 可写字段：updatedAt 由库维护，verseYear 由服务端随谶语盖章，都不接受外部传入。 */
export type StrategicPatch = StrategicProfilePatch;

/**
 * 谶语来源（低→高）：`auto` 按命盘确定性出谶（ensureAnnualVerse 兜底）＜ `llm` 模型在交底报告里亲写
 * ＜ `manual` 老板手改（PUT /profile/strategic，最终解释权）。同年只许向上升级，不许向下回压。
 */
export type VerseSource = 'auto' | 'llm' | 'manual';
const VERSE_RANK: Record<VerseSource, number> = { auto: 1, llm: 2, manual: 3 };

/**
 * 谶语形状闸门（strat.v6.md §4.4）：七言或五言两句、两句等长、纯汉字。
 * 只在「从模型输出里猜」这一步用——封面 motto 也可能是毛选语录/定场诗（§4.4 明说两者并列），
 * 谶语一旦收下就锁一整年，宁可漏收也不能把一句语录当成老板的谶。
 * 返回归一化后的规范句（剥引号、统一全角逗号、去句末句号），与 composeAnnualVerse 同口径。
 */
function verseCandidate(raw?: string): string | undefined {
  const line = (raw || '').split('\n').map((s) => s.trim()).find(Boolean) ?? '';
  const s = line
    .replace(/^[^：:]{0,8}[：:]\s*/, '') // 去掉「年度谶语：」这类前缀（谶语本身不含冒号）
    .replace(/^[「『“”"'（(【\s]+/, '')
    .replace(/[」』“”"'）)】\s]+$/, '')
    .trim();
  const m = /^([㐀-鿿]{5,7})[，,]([㐀-鿿]{5,7})[。．.!！]?$/.exec(s);
  if (!m || m[1].length !== m[2].length) return undefined;
  return `${m[1]}，${m[2]}`;
}

/**
 * 从「认可的成果」分节提取战略事实（确定性规则；只取标题语义明确的分节，不猜）。
 *
 * 年度谶语（#16）：先认「谶语/箴言」分节，再退到封面 motto（§4.4 把谶语落在 A 级报告封面）。
 * 两处都过 verseCandidate 形状闸门；抽不出就不给 verse 键，由 ensureAnnualVerse 的算法谶兜底。
 */
export function extractStrategicFacts(d: DeliverableInput): StrategicPatch {
  const out: StrategicPatch = {};
  const firstLine = (s?: string) => (s || '').split('\n')[0].trim().slice(0, 300);
  let verseBody: string | undefined;
  for (const sec of normalizedSections(d)) {
    const h = sec.h || '';
    const body = sec.b || (sec.list?.length ? sec.list[0] : '');
    if (!body) continue;
    if (!verseBody && /谶|箴言/.test(h)) verseBody = body;
    else if (!out.mainContradiction && /矛盾|现状判断|核心问题/.test(h)) out.mainContradiction = firstLine(body);
    else if (!out.positioning && /定位/.test(h)) out.positioning = firstLine(body);
    else if (!out.track && /赛道|聚焦/.test(h)) out.track = firstLine(body);
    else if (!out.stage && /阶段|三步走/.test(h)) out.stage = firstLine(body).slice(0, 60);
  }
  const verse = verseCandidate(verseBody) ?? verseCandidate(d.cover?.motto);
  if (verse) out.verse = verse; // 抽不到就别塞 undefined（会污染 patch 的键集）
  return out;
}

/**
 * 合并写入（只覆盖本次提取到的字段；空提取不动库）。narrative/verse/verseYear/verseSource 存 extraJson。
 *
 * 一年一句（#16）：谶语的分量全在「不改不换」。跨年或从未有谶 → 直接立谶并盖当年章。
 * 当年已有谶时按来源优先级判：只允许 auto → llm → manual 单向升级一次，同级/降级一律不采
 * （其余字段照常合并）。理由：算法谶是老板首访老板页时的兜底，不该把后到的、真正个人化的
 * 交底谶语挡在门外；反过来，模型每次认可方案都可能再抽出一句，同级不采才守得住「不改不换」。
 * manual = 老板手改，罕见仪式，任何时候都能覆盖并重新盖章。
 * 同一句重复到达时不改来源——别让算法谶被一次回传镀成模型谶，占掉当年唯一的升级额度。
 */
export async function upsertStrategicProfile(args: {
  tenantId: string;
  userId: string;
  patch: StrategicPatch;
  verseSource?: VerseSource;
}): Promise<void> {
  const clean = Object.fromEntries(Object.entries(args.patch).filter(([, v]) => typeof v === 'string' && v.trim()));
  if (!Object.keys(clean).length) return;
  const { narrative, verse, ...columns } = clean as { narrative?: string; verse?: string } & Record<string, string>;
  const existing = await prisma.strategicProfile.findUnique({ where: { userId: args.userId } });
  const extra = { ...((existing?.extraJson as object) ?? {}) } as
    { narrative?: string; verse?: string; verseYear?: number; verseSource?: VerseSource };
  if (narrative) extra.narrative = narrative.slice(0, 500);
  const thisYear = yearOf(); // 走可注入时钟：沙箱/测试要能把时间快进到次年验证换谶
  if (verse) {
    const next = verse.slice(0, 40);
    const src = args.verseSource ?? 'auto';
    const cur: VerseSource = extra.verseSource && extra.verseSource in VERSE_RANK ? extra.verseSource : 'auto';
    const held = !!extra.verse && extra.verseYear === thisYear; // 当年已有谶 → 进优先级判
    if (!held || src === 'manual' || (VERSE_RANK[src] > VERSE_RANK[cur] && next !== extra.verse)) {
      extra.verse = next;
      extra.verseYear = thisYear;
      extra.verseSource = src;
    }
  }
  await prisma.strategicProfile.upsert({
    where: { userId: args.userId },
    update: { ...columns, extraJson: extra },
    create: { tenantId: args.tenantId, userId: args.userId, ...columns, extraJson: extra },
  });
}

/**
 * 有八字 → 当年必有谶（#16 M1 缺失的出谶触发点）。
 *
 * 根因（历史）：抽取管线那条从来产不出 verse，PUT /profile/strategic 小程序端也无调用，
 * 于是真实用户的 strategic.verse 恒为 ''，老板页「年度谶语」卡恒落空态（「你还没有今年的谶 ·
 * 去命盘 ›」），而命盘页也没有出谶动作 → 断头路。修法：谶语本该能由命盘确定性派生（同「天命速写」
 * 口径，零 LLM），此处把缺失的触发点补在读档案时：命理开 + 有命盘 + 当年无谶 → 按盘出谶。
 *
 * 这是最低一档的兜底谶（verseSource='auto'）：老板首访即有谶可看，之后交底报告里模型亲写的谶
 * （'llm'）仍可在当年升级它一次，老板手改（'manual'）永远压得住这条路——守卫统一在
 * upsertStrategicProfile。返回是否写过（调用方据此决定要不要重读）。
 */
export async function ensureAnnualVerse(args: { tenantId: string; userId: string }): Promise<boolean> {
  if (!(await isFeatureEnabled('fortune'))) return false; // 命理下线：不出谶（谶语属命理内容，也不该进注入块）
  const chart = await loadChart(args.userId);
  if (!chart) return false; // 无八字 → 老板页维持「去命盘求谶」引导
  await upsertStrategicProfile({
    tenantId: args.tenantId,
    userId: args.userId,
    patch: { verse: composeAnnualVerse(chart, yearOf()) },
  });
  return true;
}

/**
 * F-5：读用户当前诊断轮次（用户级持久化）。无战略档案行 → 0（尚未进入诊断）。
 * 换会话/删会话都不影响它，六轮主线不再被一次误操作清零。
 */
export async function getDiagRound(userId: string): Promise<number> {
  const row = await prisma.strategicProfile.findUnique({ where: { userId }, select: { diagRound: true } });
  return row?.diagRound ?? 0;
}

/**
 * F-5：推进诊断轮次（每次总军师战略一问一答开始时 +1，用户级 upsert 保证首轮即落库）。
 * 语义：diagRound = 当前进行到第几轮；首条战略消息把它从 0 抬到 1。
 */
export async function bumpDiagRound(args: { tenantId: string; userId: string; sessionId: string | null }): Promise<void> {
  await prisma.strategicProfile.upsert({
    where: { userId: args.userId },
    update: { diagRound: { increment: 1 }, diagSessionId: args.sessionId ?? undefined },
    create: { tenantId: args.tenantId, userId: args.userId, diagRound: 1, diagSessionId: args.sessionId ?? undefined },
  });
  // WO-07：诊断推进一轮 → journey new/scanned/diagnosing→diagnosing（diag.round）
  await import('./journey.js').then((m) => m.applyJourneyEvent(args.userId, args.tenantId, 'diag.round')).catch(() => {});
}

export async function loadStrategicProfile(userId: string): Promise<StrategicView | null> {
  const row = await prisma.strategicProfile.findUnique({ where: { userId } });
  if (!row) return null;
  const extra = (row.extraJson as { narrative?: string; verse?: string; verseYear?: number } | null) ?? {}; // verseSource 只服务写侧守卫，不下发
  return {
    mainContradiction: row.mainContradiction,
    positioning: row.positioning,
    track: row.track,
    stage: row.stage,
    narrative: extra.narrative ?? '',
    verse: extra.verse ?? '',
    verseYear: typeof extra.verseYear === 'number' ? extra.verseYear : null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

// —— L-6 三势真数据化：市势/人势研判结论（天势走命盘 monthlyOutlook，不入库）——
const FORCE_KEYS = { '市势': 'shishi', '人势': 'renshi' } as const;
type ForceCol = 'shishi' | 'renshi';
const VERDICTS: ForceVerdict[] = ['攻', '守', '等', '撤'];

/** 读三势结论（市势/人势，无则 null）。 */
export async function loadForces(userId: string): Promise<ForcesView | null> {
  const row = await prisma.strategicProfile.findUnique({ where: { userId }, select: { forcesJson: true } });
  const f = (row?.forcesJson as ForcesView | null) ?? null;
  return f && (f.shishi || f.renshi) ? f : null;
}

/** 从「市势/人势研判」成果提炼结论（LLM 优先、关键词兜底）。forceLabel = 市势 | 人势。 */
export async function extractForceVerdict(forceLabel: string, d: DeliverableInput): Promise<ForceView | null> {
  const sections = normalizedSections(d);
  const text = sections.map((s) => `${s.h || ''}\n${s.b || (s.list?.join('；') ?? '')}`).join('\n').slice(0, 3000);
  if (!text.trim()) return null;
  const raw = await llmJson(
    `你在读一份「${forceLabel}研判」。给出老板在${forceLabel === '市势' ? '市场端' : '资源/组织端'}该「攻/守/等/撤」的**一个**结论，` +
    '和一句话理由（≤30字，用报告里的真实判断，不要新编）。只输出 JSON：{"verdict":"攻|守|等|撤","note":"…"}。',
    text,
  );
  let verdict = raw && VERDICTS.includes(raw.verdict as ForceVerdict) ? (raw.verdict as ForceVerdict) : null;
  let note = raw && typeof raw.note === 'string' ? raw.note.slice(0, 40) : '';
  if (!verdict) {
    const hit = VERDICTS.find((v) => text.includes(`该${v}`) || text.includes(`宜${v}`) || text.includes(`${v}。`));
    if (hit) { verdict = hit; note = note || ((sections[0]?.b || '').split('\n')[0].slice(0, 40)); }
  }
  return verdict ? { verdict, note } : null;
}

/** 写入一路势的结论（市势→shishi，人势→renshi）。 */
export async function upsertForce(args: { tenantId: string; userId: string; forceLabel: string; force: ForceView }): Promise<void> {
  const col = FORCE_KEYS[args.forceLabel as keyof typeof FORCE_KEYS] as ForceCol | undefined;
  if (!col) return;
  const existing = await prisma.strategicProfile.findUnique({ where: { userId: args.userId }, select: { forcesJson: true } });
  const forces = { ...((existing?.forcesJson as ForcesView | null) ?? {}) };
  forces[col] = args.force;
  await prisma.strategicProfile.upsert({
    where: { userId: args.userId },
    update: { forcesJson: forces as object },
    create: { tenantId: args.tenantId, userId: args.userId, forcesJson: forces as object },
  });
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
