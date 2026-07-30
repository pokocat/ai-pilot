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
import { calendarParts, dateKey, now, yearOf } from './clock.js';
import { isFeatureEnabled } from './featureFlag.js';
import { loadChart } from './paipan.js';
import { composeAnnualVerse } from './mingpan.js';
import { recordProphecy } from './prophecyLog.js';
import type { ForcesView, ForceVerdict, ForceView, StrategicProfile, StrategicProfilePatch, VerseMoment } from '../../../shared/contracts';
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

// —— 谶语 · 周期陪伴（谶不是挂一年的一句话，是军师全年把真实事件对到谶上的一条线）——
/** 点谶来源：认可方案 / 复盘 / 预言应验。每天每来源至多一条，防同一天被三条链路重复点。 */
export type VerseMomentSource = 'accept' | 'review' | 'prophecy';
/**
 * 库内点谶记录。比契约（`VerseMoment` = at/clause/note）多一个内部键 `src`：
 * 「同一天同来源最多一条」的去重要按来源判，但来源属于实现细节（前台只看点谶次数与白话），
 * 故只存不下发——loadStrategicProfile 落地成契约形状时显式丢掉它。
 */
interface VerseMomentRow extends VerseMoment { src?: VerseMomentSource }
/** 归档的旧谶（换谶/升级/跨年时整句连同它的点谶一起进 verseHistory；岁验要对的是「去年那句」）。 */
interface VerseArchive { verse: string; verseYear: number | null; verseSource: VerseSource; moments: VerseMomentRow[] }
/** extraJson 的谶语相关形状（schema 层仍是一个 Json 列，无迁移）。 */
interface VerseExtra {
  narrative?: string;
  verse?: string;
  verseYear?: number;
  verseSource?: VerseSource;
  verseAt?: string; // 获谶时刻（ISO）：半验要算「满六个月」，只有年份不够
  verseMoments?: VerseMomentRow[];
  verseHistory?: VerseArchive[];
}

const MOMENT_LIMIT = 12; // 一年至多点谶 12 次（点得太密就不叫「点」了，也挡住 LLM 被反复触发）
const HISTORY_LIMIT = 10; // 归档上限，超出丢最旧
const HALF_TERM_MONTHS = 6; // 获谶满半年 → 复盘可带出「谶语过半，前半句已有眉目」

/** 读 extraJson（含旧行：字段缺失一律按未设置处理）。 */
function verseExtraOf(row: { extraJson: unknown } | null): VerseExtra {
  return { ...(((row?.extraJson as VerseExtra | null) ?? {}) as VerseExtra) };
}

/** 清洗库内点谶数组（脏数据/手工改库也不能让注入块炸）。 */
function verseMomentsOf(extra: VerseExtra): VerseMomentRow[] {
  const arr = Array.isArray(extra.verseMoments) ? extra.verseMoments : [];
  return arr
    .filter((m): m is VerseMomentRow => !!m && typeof m.at === 'string' && typeof m.note === 'string')
    .map((m): VerseMomentRow => ({ at: m.at.slice(0, 10), clause: m.clause === 2 ? 2 : 1, note: m.note.slice(0, 40), src: m.src }))
    .slice(0, MOMENT_LIMIT);
}

/** 谶中两个半句（谶语恒为「七言，七言」或「五言，五言」；退化输入按整句处理）。 */
function verseClauses(verse: string): [string, string] {
  const parts = verse.split(/[，,]/).map((s) => s.trim()).filter(Boolean);
  return [parts[0] ?? verse, parts[1] ?? ''];
}

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
 *
 * 周期陪伴（本次叠加）：谶语真正落库/换句时还要
 *   ① 记 verseAt（获谶时刻，半验算「满六个月」用）；
 *   ② 把旧谶连同它的点谶归档进 verseHistory（岁验要对的是「去年那句」——跨年 auto 兜底谶一落库
 *      旧谶就没了，不归档等于把去年的账烧掉），并清空 verseMoments（点谶属于那一句谶）；
 *   ③ fire-safe 登记一条「岁验」预言，到期后自然骑上现成的 prophecy-due-scan 提醒链路。
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
  const extra = verseExtraOf(existing);
  if (narrative) extra.narrative = narrative.slice(0, 500);
  const thisYear = yearOf(); // 走可注入时钟：沙箱/测试要能把时间快进到次年验证换谶
  let stamped: { verse: string; year: number; at: string } | null = null;
  if (verse) {
    const next = verse.slice(0, 40);
    const src = args.verseSource ?? 'auto';
    const cur: VerseSource = extra.verseSource && extra.verseSource in VERSE_RANK ? extra.verseSource : 'auto';
    const held = !!extra.verse && extra.verseYear === thisYear; // 当年已有谶 → 进优先级判
    if (!held || src === 'manual' || (VERSE_RANK[src] > VERSE_RANK[cur] && next !== extra.verse)) {
      // 「换了句」或「换了谶年」才算换谶；同句同年重新盖章（如 manual 复写原句）不该把点谶清掉，
      // 也不该重记获谶时刻——否则老板手点一下「保存」就把半年的陪伴账清零。
      const rotated = extra.verse !== next || extra.verseYear !== thisYear;
      if (rotated && extra.verse) {
        const history = Array.isArray(extra.verseHistory) ? extra.verseHistory.slice() : [];
        history.push({
          verse: extra.verse,
          verseYear: typeof extra.verseYear === 'number' ? extra.verseYear : null,
          verseSource: extra.verseSource && extra.verseSource in VERSE_RANK ? extra.verseSource : 'auto',
          moments: verseMomentsOf(extra),
        });
        extra.verseHistory = history.slice(-HISTORY_LIMIT); // 超上限丢最旧
      }
      extra.verse = next;
      extra.verseYear = thisYear;
      extra.verseSource = src;
      if (rotated) {
        extra.verseAt = now().toISOString();
        extra.verseMoments = [];
      } else if (!extra.verseAt) {
        extra.verseAt = now().toISOString(); // 存量谶（本次上线前盖的章）补记一次获谶时刻
      }
      stamped = { verse: next, year: thisYear, at: extra.verseAt };
    }
  }
  await prisma.strategicProfile.upsert({
    where: { userId: args.userId },
    update: { ...columns, extraJson: extra as object },
    create: { tenantId: args.tenantId, userId: args.userId, ...columns, extraJson: extra as object },
  });
  // 岁验锚点：谶语盖章成功才登记（幂等，一人一「谶年」至多一条）。fire-safe——登记失败绝不回滚谶语。
  if (stamped) {
    await registerVerseOmen({ tenantId: args.tenantId, userId: args.userId, ...stamped })
      .catch((err) => console.error('[verse] 岁验登记失败:', (err as Error).message));
  }
}

/**
 * 岁验锚点（谶语版「预言到期对账」）：把当年那句谶登记成一条 ProphecyLog，到期后由现成的
 * prophecy-due-scan（scheduler.ts，6h 一轮，行级 dueNotifiedAt 幂等）自然提醒，无需另造一套调度。
 *
 * 取舍：ProphecyLog 没有 kind/source 这类分类字段（读 schema 确认），也不该为一条语义就加列。
 * 因此用 `basis` 列承载约定值 `年度谶语·岁验·<谶年>`：它既是人可读的「依据」（谶语本身就是这条预言的依据），
 * 又天然是幂等键——「一人一谶年至多一条」= (userId, basis) 唯一。同年升级换句时更新同一行的 prophecy
 * 文本，不再建新行；跨年谶年变了 → basis 变了 → 才登记新的一条。
 *
 * 到期日 = min(获谶 + 1 年, 次年立春 2-04)：谶按流年走，立春是命理换岁点，谁先到算谁。
 */
async function registerVerseOmen(args: { tenantId: string; userId: string; verse: string; year: number; at: string }): Promise<void> {
  if (!(await isFeatureEnabled('fortune'))) return; // 命理下线：不产生天机账本条目
  const basis = `年度谶语·岁验·${args.year}`;
  const p2 = (n: number) => String(n).padStart(2, '0');
  const born = calendarParts(new Date(args.at));
  const anniversary = `${born.year + 1}-${p2(born.month)}-${p2(born.day)}`;
  const lichun = `${born.year + 1}-02-04`;
  const dueDate = anniversary < lichun ? anniversary : lichun;
  const existing = await prisma.prophecyLog.findFirst({ where: { userId: args.userId, basis }, select: { id: true } });
  if (existing) {
    await prisma.prophecyLog.update({ where: { id: existing.id }, data: { prophecy: args.verse, dueDate } });
    return;
  }
  await recordProphecy({
    tenantId: args.tenantId,
    userId: args.userId,
    prophecy: args.verse,
    basis,
    verifyStandard: '到期回看这一年：谶中两句各自应验了没有（全年点谶记录为凭）。',
    dueDate,
  });
}

/**
 * 点谶（周期陪伴的核心动作）：把刚发生的一件真事对到当年谶的某半句上，命中才记一条。
 *
 * 判严不判宽——含糊、牵强、只是情绪相近的一律不算：点谶的分量全在「真切相应」，
 * 军师宁可一年只点两次，也不能靠硬圆把谶语做成星座运势。
 *
 * 全部短路条件都在 LLM 之前判完（无当年谶 / 命理关 / 已满 12 条 / 当日同来源已点过），
 * 避免热路径为一次注定无用的判定去调模型。整个函数 fire-safe：任何异常吞掉，绝不拖慢调用方。
 *
 * @param judge 仅供测试注入确定性判官（生产不传，走 llmJson）。测试环境 liveProvider 恒为 null，
 *              真实 llmJson 只会返回 null，命中路径无从验证——故留这一个注入口。
 */
export async function maybeMarkVerseMoment(args: {
  tenantId: string;
  userId: string;
  eventText: string;
  source: VerseMomentSource;
  judge?: VerseJudge;
}): Promise<VerseMoment | null> {
  try {
    const text = (args.eventText || '').trim();
    if (!text) return null;
    if (!(await isFeatureEnabled('fortune'))) return null; // 命理下线：谶语链路整条静默
    const row = await prisma.strategicProfile.findUnique({ where: { userId: args.userId }, select: { extraJson: true } });
    const extra = verseExtraOf(row);
    const verse = (extra.verse ?? '').trim();
    if (!verse || extra.verseYear !== yearOf()) return null; // 无当年谶：没有可点的谶
    const moments = verseMomentsOf(extra);
    if (moments.length >= MOMENT_LIMIT) return null;
    const today = dateKey();
    if (moments.some((m) => m.at === today && m.src === args.source)) return null; // 同一天同来源只点一次

    const judged = await (args.judge ?? judgeVerseMoment)(verse, text.slice(0, 500));
    if (!judged?.hit) return null;
    const note = (judged.note ?? '').trim().slice(0, 40);
    if (!note) return null; // 说不清怎么应的，就不算点谶

    // LLM 判定期间档案可能被别的链路写过（认可回写等）→ 重读后再校验一遍守卫，避免整块 extraJson 回压。
    const fresh = verseExtraOf(await prisma.strategicProfile.findUnique({ where: { userId: args.userId }, select: { extraJson: true } }));
    if ((fresh.verse ?? '').trim() !== verse || fresh.verseYear !== yearOf()) return null;
    const list = verseMomentsOf(fresh);
    if (list.length >= MOMENT_LIMIT || list.some((m) => m.at === today && m.src === args.source)) return null;
    const moment: VerseMomentRow = { at: today, clause: judged.clause, note, src: args.source };
    fresh.verseMoments = [...list, moment];
    await prisma.strategicProfile.upsert({
      where: { userId: args.userId },
      update: { extraJson: fresh as object },
      create: { tenantId: args.tenantId, userId: args.userId, extraJson: fresh as object },
    });
    return { at: moment.at, clause: moment.clause, note: moment.note };
  } catch (err) {
    console.error('[verse] 点谶失败（已忽略）:', (err as Error).message);
    return null;
  }
}

/** 认可的成果 → 点谶事件文本（标题 + 各分节正文；判定侧还会再截到 500 字）。 */
export function verseEventFromDeliverable(d: DeliverableInput): string {
  const body = normalizedSections(d)
    .map((s) => [s.h, s.b || (s.list?.join('；') ?? '')].filter(Boolean).join('：'))
    .filter(Boolean)
    .join('\n');
  return [d.title ? `老板认可了方案《${d.title}》` : '老板认可了一份方案', body].filter(Boolean).join('\n').slice(0, 600);
}

export interface VerseJudgement { hit: boolean; clause: 1 | 2; note: string }
export type VerseJudge = (verse: string, eventText: string) => Promise<VerseJudgement | null>;

/** 默认判官：模型严判「这件真事应了谶的哪半句」。无 live provider（测试/mock）时 llmJson 返回 null → 不点。 */
const judgeVerseMoment: VerseJudge = async (verse, eventText) => {
  const [first, second] = verseClauses(verse);
  const raw = await llmJson(
    `老板今年的年度谶语是「${verse}」：前半句（clause=1）「${first}」${second ? `，后半句（clause=2）「${second}」` : ''}。\n` +
    '下面是他刚发生的一件真事。只有这件事与其中某半句**真切相应**（事实对得上、不用绕、老板一看就点头）时才算「点谶」；' +
    '含糊、牵强、只是气氛相近、或事情还没发生的一律不算。\n' +
    '命中输出 {"hit":true,"clause":1或2,"note":"≤40字白话，说清这件事怎么应了那半句"}；' +
    '不命中输出 {"hit":false}。只输出 JSON。',
    eventText,
  );
  if (!raw || raw.hit !== true) return null;
  const note = typeof raw.note === 'string' ? raw.note : '';
  return { hit: true, clause: raw.clause === 2 || raw.clause === '2' ? 2 : 1, note };
};

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
  const extra = verseExtraOf(row); // verseSource / verseHistory 只服务写侧守卫与岁验，不下发
  return {
    mainContradiction: row.mainContradiction,
    positioning: row.positioning,
    track: row.track,
    stage: row.stage,
    narrative: extra.narrative ?? '',
    verse: extra.verse ?? '',
    verseYear: typeof extra.verseYear === 'number' ? extra.verseYear : null,
    verseAt: extra.verseAt ?? null,
    // 落成契约形状：内部去重键 src 不下发（前台只关心点了几次、最近一次说了什么）
    verseMoments: verseMomentsOf(extra).map((m) => ({ at: m.at, clause: m.clause, note: m.note })),
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

/** 从获谶到现在满了几个整月（按上海日历；差一天不算满，宁可晚说半验也不早说）。 */
function monthsSinceVerse(atIso: string): number {
  const at = new Date(atIso);
  if (Number.isNaN(at.getTime())) return 0;
  const a = calendarParts(at);
  const n = calendarParts();
  const gross = (n.year - a.year) * 12 + (n.month - a.month);
  return n.day >= a.day ? gross : gross - 1;
}

/**
 * 谶语注入行（周期陪伴）：谶语不只是挂一年的一句话，而是军师全年主动把真实事件对到谶上的一条线。
 * 除了谶句本身，还给出周期上下文（获谶月份 / 已点谶次数 / 最近一次点谶）与点谶的行为指引；
 * 获谶满半年且当年还没点到后半句时追加半验提示。增量整体压在 ~150 字内（注入块是热路径预算）。
 *
 * 跨年还没换谶（verseYear ≠ 今年）时只报句子：那些点谶属于去年那句，不能拿来当今年的陪伴账。
 */
function verseLines(p: StrategicView): string[] {
  const gotMonth = p.verseAt && !Number.isNaN(new Date(p.verseAt).getTime())
    ? `${calendarParts(new Date(p.verseAt)).month}月获谶，` : '';
  const head = `年度谶语：「${p.verse}」（${gotMonth}全年沿用这一句，不要另造）`;
  if (typeof p.verseYear === 'number' && p.verseYear !== yearOf()) return [head];
  const moments = p.verseMoments ?? [];
  const out = [head];
  if (moments.length) {
    const last = moments[moments.length - 1];
    out.push(`已点谶 ${moments.length} 次；最近一次 ${Number(last.at.slice(5, 7))}月：${last.note}`);
  }
  if (p.verseAt && monthsSinceVerse(p.verseAt) >= HALF_TERM_MONTHS && !moments.some((m) => m.clause === 2)) {
    out.push('半验（获谶已过半年，后半句尚无着落）：复盘时可带出「谶语过半，前半句已有眉目」。');
  }
  out.push('点谶：复盘或重大节点上，若当下事件与谶中某半句真切相应，引原句半联 + 一句白话点一次；一次对话至多一次，对不上不硬圆，平时不提。');
  return out;
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
  if (p.verse) lines.push(...verseLines(p));
  if (!lines.length) return null;
  return `【战略档案（客户已确认的战略事实，优先于任何推断；与客户新表述冲突时先求证再更新）】\n${lines.join('\n')}`;
}
