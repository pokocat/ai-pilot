// GET /creative/posters/brief-draft 的实现：从**客户与海报设计师的整段对话** + 已确认 BrandKit
// 预填 PosterBrief 草稿，并写一段给客户看的「设计说明」（designNote）。
//
// 为什么要预填：用户刚跟设计师聊完，再让他对着空表把刚说过的话重打一遍，
// 是把他找军师的理由原样退回给他。确认页的主视图是 designNote，表单收在「改一改」里。
// 三层兜底，任一层失败都还能给出可用草稿：
//   ① LLM 结构化抽取（zod 约束）→ 文案 + templateKey + templateReason + designNote；
//   ② 老会话里若还留着「成品图版式推荐：xxx（key）—— 理由」行 → 正则兜住 templateKey/理由；
//   ③ 全失败：字段留空、scene 按 agent 推断、templateKey 按 scene 默认，designNote 不下发。
// BrandKit 只在 approvedAt 非空时合并（与 BrandKit 现有口径一致：生态产品只读 approved 的资产包）。
import { z } from 'zod';
import { prisma } from '../../db.js';
import { structured } from '../../llm/gateway.js';
import { getBrandKit } from '../brandKit.js';
import {
  TEMPLATE_KEYS, TEMPLATE_CATALOG, getCreativeConfig, premiumTierAvailable,
  type TemplateKey, type TemplateDensity,
} from './config.js';
import { SCENE_DEFAULT_TEMPLATE, LIMITS } from './schema.js';
import { CreativeError } from './jobs.js';
import { defaultDirectionKey, directionFor, isPosterDirectionKey } from './directions.js';
import {
  artDirectionNote, mergeArtDirection, normalizeArtDirection,
  type ArtDirection, type ArtDirectionKey,
} from './imagePrompt.js';
import type {
  Deliverable, PosterBrief, PosterBriefDraft, PosterScene, BrandKitView,
  PosterDirectionKey, PosterTier,
} from '../../../../shared/contracts';

/** 推荐组合（= PosterBriefDraft['recommendation'] 的非空形态）。 */
export type PosterRecommendation = NonNullable<PosterBriefDraft['recommendation']>;

/** agentKey → 默认场景（成果来自哪个顾问，海报大概是干什么用的）。 */
const AGENT_SCENE: Record<string, PosterScene> = {
  poster: 'personal_brand',
  ip: 'personal_brand',
  promo: 'event',
  copy: 'service',
  shortvideo: 'personal_brand',
};

const DraftSchema = z.object({
  scene: z.enum(['personal_brand', 'event', 'service', 'product']).optional().catch(undefined),
  goal: z.string().catch('').default(''),
  audience: z.string().catch('').default(''),
  headline: z.string().catch('').default(''),
  subheadline: z.string().catch('').default(''),
  proofPoints: z.array(z.string()).catch([]).default([]),
  cta: z.string().catch('').default(''),
  visualDirection: z.string().catch('').default(''),
  templateKey: z.string().catch('').default(''),
  templateReason: z.string().catch('').default(''),
  // 军师推荐组合的三个候选 + 理由（2026-08-16）：**不新增一次调用**，由这同一次抽取顺带产出。
  // 全部按裸字符串收，白名单校验与兜底一律在服务端做（见 resolveRecommendation）——
  // 模型给什么值都不该让确认页拿到一个下不了单的组合。
  tier: z.string().catch('').default(''),
  directionKey: z.string().catch('').default(''),
  recommendReason: z.string().catch('').default(''),
  designNote: z.string().catch('').default(''),
  // 结构化艺术指导：形态与宣言那份完全一致（同一套字段名、同一个归一函数）。
  // 这里抽的是**客户在对话里真的说过**的画面承诺，下游宣言与生图提示词都以它为准。
  artDirection: z.unknown().catch(undefined).default(undefined),
});

/**
 * 推荐理由长度上限（契约里也写着 ≤60 字）：确认页原样展示一行，超了就换行挤掉下面的操作区。
 * 提示词与服务端截断读同一个常量——两处各写一个数字，迟早只改一处。
 */
export const RECOMMEND_REASON_LIMIT = 60;

const DRAFT_SYS = [
  '你是「军师参谋部」的海报需求整理助手。读一段**客户与海报设计师的对话**，',
  '抽出可直接填进「成品图需求单」的字段。',
  '对话里客户可能改过主意——**以最后一次说法为准**，不要把中途被否掉的版本抽出来。',
  '设计师替客户拟的措辞（主标题、行动号召等）如果客户没反对，视为已确认，照抽。',
  '三个版式的语义：',
  '- person_hero（人物主视觉）：人物占主要画面，适合创始人/专家做个人品牌与信任背书；',
  '- editorial（编辑杂志）：大留白、强标题，适合观点、定位、专业服务这类需要克制质感的内容；',
  '- business_launch（商业发布）：信息明确、层级清楚，适合活动、课程、发布会、咨询服务报名。',
  '',
  '规则：',
  `- headline 不超过 ${LIMITS.headline} 字，subheadline 不超过 ${LIMITS.subheadline} 字；`,
  `- proofPoints 最多 ${LIMITS.proofPoints} 条、每条不超过 ${LIMITS.proofPoint} 字；`,
  `- cta 不超过 ${LIMITS.cta} 字；visualDirection 不超过 ${LIMITS.visualDirection} 字，只写画面属性`,
  '  （结构/色彩/材质/光线/构图），不指名任何在世创作者；',
  '- templateKey 由你按上面三条语义判断，并写一句**给客户看**的理由',
  '  （不出现参数、模型、渲染、模板 key 之类技术说法）；',
  '- 抽不出的字段留空字符串，不要编造。',
  '',
  // ★ 2026-08-15：artDirection 与 designNote 的分工是**承诺同源**的关键。
  //   在此之前 designNote 由模型自由发挥「什么气质与配色」，而那句话下游一个字都读不到 ——
  //   于是确认页承诺「沉稳深灰 + 柔暖光」，生图提示词照旧发 pure black。现在色彩/光线这类
  //   画面承诺**只走 artDirection**，由服务端确定性地渲染成一句话贴在 designNote 后面，
  //   同一份字段再往下走进宣言与生图提示词——用户读到的和模型收到的是同一个对象。
  '【artDirection：客户对画面本身的要求，结构化抽出来】',
  '七个字段名固定：figure（人物气质）、props（道具）、backdrop（背景基调）、lighting（光质与方向）、',
  'palette（色彩关系）、material（材质质感）、mood（情绪）。',
  '每个字段写成 {"zh":"中文短语","en":"english phrase"}，两边说同一件事；zh 会原样念给客户听，',
  'en 会原样进出图环节。**对话里没提到的字段一律留空或不给**——这里不是让你替客户设计，',
  '是把他说过的话归位。他没提配色就别编一个配色：编了他会在确认页读到，然后在成品图上找不到。',
  '',
  '【designNote：写给客户看的设计说明，2–3 句，确认页会把它放在最上面】',
  '用人话讲清这张海报会长什么样，让客户**不用看下面的表格**就知道对不对。要说到：',
  '① 这张讲的是什么（主题）；② 画面上会放哪些内容（主标题、几条卖点、行动号召、有没有二维码）；',
  '③ 为什么用这个版式（一句话）。',
  '按海报的通用设计原则来描述，别写成参数清单：',
  '- 对齐：元素咬住同一条轴，不是各摆各的；',
  '- 分组：相关的信息贴在一起、不相关的拉开，间距本身在表达从属关系；',
  '- 识别性：主标题一眼可读，层级靠字号与位置拉开；',
  '- 颜色搭配：一主色一辅色一强调色，强调色只用在最该被看见的那一处；',
  '- 风格统一：整张图只有一套形状语言（圆角、线宽、字体族保持一致）。',
  '不要出现「渲染」「模板」「参数」「模型」这类技术说法，也不要复述客户原话。',
  '**不要在 designNote 里写具体配色与光线**（「深灰底」「暖光」这类）——那句话由服务端从 artDirection',
  '统一拼在后面，你再写一遍只会和它打架，也可能承诺一个出图环节收不到的颜色。',
  '对话太短、信息不足以描述画面时，designNote 留空字符串——**宁可不写，也不要编一个看起来很像的**。',
  '',
  // ★ 2026-08-16：确认页不再逼用户做三次选择（方式 / 方向 / 版式）——那三项的差别他感知不到。
  //   这里顺带产出一套可直接下单的组合，用户不改也能出图。规则写死在提示词里，
  //   服务端再做一次白名单与一致性校验（模型说了不算，见 resolveRecommendation）。
  '【军师推荐组合：tier / directionKey / recommendReason】',
  '确认页会把这套组合直接预选上，用户不改也能出图——所以不要推一个"还得再问问客户"的组合。',
  // 2026-08-17 口径反转（产品决定）：以前这里写「standard 默认，只有必须靠实拍才推 premium」。
  // 现在默认 premium。服务端 resolveRecommendation 同步改了，两处必须一致——否则模型按 standard
  // 写的理由会配到 premium 的组合上，用户读到的是自相矛盾的一句话。
  '- tier 两档：premium（默认）与 standard。**默认推 premium**：它先出实拍质感主视觉再排中文，多数商业海报吃这一套；',
  '  只有当这张画面的说服力靠一句话、字号、留白或一个图形母题就已经立住、再加一张实拍反而是干扰时，才退回 standard；',
  '- directionKey 按语义选，且**必须与 tier 同档**：',
  '  standard 档 —— graphic_bold_type（让一句主张当画面主角）、graphic_symbol（提炼一个专属图形母题）、',
  '  graphic_portrait（用客户本人照片，**只有他确实上传了本人照才可以推**）；',
  '  premium 档 —— photo_character（AI 演绎一个人物气场）、photo_product（产品或成果物大片）、',
  '  photo_scene（读得出时间地点的场景叙事）；',
  '- templateKey 按**内容密度**选：只有一句观点/主张 → airy 档（manifesto_min、quote_card、person_hero）；',
  '  有两三条卖点要摆 → balanced 档（editorial、business_launch、data_stat）；',
  '  活动、议程、时间地点这类要一屏交代完 → dense 档（info_list、agenda_event）；',
  `- recommendReason 一句话、不超过 ${RECOMMEND_REASON_LIMIT} 字，写给客户看：说清为什么用这个方式、这张图靠什么立住；`,
  '  不出现 key、参数、模型、渲染这类技术说法，也不要写成"我们推荐您选择……"的客套话。',
  '',
  // ★ 2026-08-17：这里原来给的是一份**值全为空串的 JSON 壳**，实测被模型当成答案模板照抄回来 ——
  //   返回 553 字符、括号闭合、zod 全过，但 15 个字段全是空，确认页于是整张表单空着且查不出错
  //   （生产 aux 档 deepseek-v4-flash 上稳定复现）。所以只给**键名清单**，不给可以照抄的空值，
  //   并把「不许原样交回空值」写成一条明规则。designNote 仍固定排在最后一位
  //   （既有单测钉住这个位置：它是最容易被后加字段挤走的一项）。
  '只输出一个 JSON 对象，不要任何解释或围栏。键固定为这 15 个，顺序照此排列：',
  'scene, goal, audience, headline, subheadline, proofPoints, cta, visualDirection, artDirection,',
  'templateKey, templateReason, tier, directionKey, recommendReason, designNote',
  '其中 proofPoints 是字符串数组，artDirection 是对象（子字段见上），其余都是字符串。',
  '⚠️ 上面是**键名清单，不是答案模板**：不要把空字符串原样填回来交差。',
  '只有「这段对话里确实找不到」的字段才留空——凡是客户或设计师说过的，都必须落到对应字段里。',
].join('\n');

function isTemplateKey(v: unknown): v is TemplateKey {
  return typeof v === 'string' && (TEMPLATE_KEYS as readonly string[]).includes(v);
}

/* ───────────────── 军师推荐组合：白名单校验 + 确定性兜底 ───────────────── */

/** 推荐组合的上下文：能不能推 premium、能不能推需要本人照的方向、内容有多密。 */
export interface RecommendationContext {
  scene: PosterScene;
  /** brief 里已确认的卖点条数（内容密度的唯一依据，不看对话字数）。 */
  proofPointCount: number;
  /** brief 是否真的挂着本人照素材（requiresPortrait 方向的硬前提）。 */
  hasPortrait: boolean;
  /** 高级档此刻能不能下单（premiumTierAvailable，图片供应商没配就是不能）。 */
  premiumAvailable: boolean;
}

/**
 * 一致性硬约束：一套组合下不下得了单，只看这几条，任一不过即整组不可用。
 *
 * 为什么要有它：推荐是**默认预选**，用户可以一次都不改就下单。推一个 direction.tier 与 tier
 * 不匹配的组合，等于把 schema 那句 422「所选创作方向与当前路线不匹配」直接甩到用户脸上；
 * 推一个 requiresPortrait 的方向而他没传过照片，同理。校验和兜底都在服务端，模型说了不算。
 */
export function isRecommendationConsistent(
  rec: PosterRecommendation,
  ctx: Pick<RecommendationContext, 'hasPortrait' | 'premiumAvailable'>,
): boolean {
  if (rec.tier !== 'standard' && rec.tier !== 'premium') return false;
  if (!isPosterDirectionKey(rec.directionKey)) return false;
  if (!isTemplateKey(rec.templateKey)) return false;
  const dir = directionFor(rec.directionKey);
  if (dir.tier !== rec.tier) return false;
  if (dir.requiresPortrait && !ctx.hasPortrait) return false;
  if (rec.tier === 'premium' && !ctx.premiumAvailable) return false;
  const reason = (rec.reason ?? '').trim();
  return !!reason && reason.length <= RECOMMEND_REASON_LIMIT;
}

/** 每档密度的代表版式（scene 默认版式不在该档时用它）。 */
const DENSITY_TEMPLATE: Record<TemplateDensity, TemplateKey> = {
  airy: 'manifesto_min',
  balanced: 'editorial',
  dense: 'agenda_event',
};

/**
 * 确定性版式：先按内容密度定档，再在该档里挑版式。
 * · 一句观点（一条卖点都没有）→ airy；有卖点要摆 → balanced；活动/议程 → dense。
 * scene 的默认版式恰好落在该档时优先用它——同一个场景在两处给出不同版式，是给用户看的分裂。
 */
function fallbackTemplateKey(scene: PosterScene, proofPointCount: number): TemplateKey {
  const density: TemplateDensity = scene === 'event' ? 'dense' : proofPointCount >= 1 ? 'balanced' : 'airy';
  const sceneDefault = SCENE_DEFAULT_TEMPLATE[scene];
  return TEMPLATE_CATALOG[sceneDefault].density === density ? sceneDefault : DENSITY_TEMPLATE[density];
}

/**
 * 确定性理由：LLM 不可用、没给理由、或推荐被服务端改写（premium 降级）时用它。
 * 说的是「这套组合靠什么立住」，不是「我们建议您选择」——确认页那行字要能替用户做完判断。
 */
function fallbackReason(o: {
  tier: PosterTier; directionKey: PosterDirectionKey; templateKey: TemplateKey; downgraded: boolean;
}): string {
  const dirName = directionFor(o.directionKey).name;
  const tplName = TEMPLATE_CATALOG[o.templateKey].name;
  if (o.downgraded) return clip(`高级出图暂时用不了，先按「${dirName}」配「${tplName}」，靠排版和留白立住`, RECOMMEND_REASON_LIMIT);
  if (o.tier === 'premium') return clip(`这张要靠实拍质感立住，用「${dirName}」出主视觉，配「${tplName}」排信息`, RECOMMEND_REASON_LIMIT);
  return clip(`按你说的内容量选「${tplName}」，用「${dirName}」，不额外出图也立得住`, RECOMMEND_REASON_LIMIT);
}

/**
 * 把模型给的候选归一成一套**必定可下单**的组合（永不 throw、永不返回非法值）。
 *
 * 兜底顺序（每一项独立回退，不因为一项非法就整组丢掉模型的判断）：
 *   tier         premium 且 premiumTierAvailable → premium；其余一律 standard（默认不推贵档）；
 *   directionKey 白名单 + 同档 + 肖像约束都过 → 用模型的；否则 defaultDirectionKey(tier, scene, hasPortrait)；
 *   templateKey  白名单过 → 用模型的；否则按 scene / 卖点条数映射密度（fallbackTemplateKey）；
 *   reason       模型给了就截到上限；没给、或 premium 被降级 → 确定性模板句（降级后原理由已经不成立）。
 */
export function resolveRecommendation(
  raw: { tier?: unknown; directionKey?: unknown; templateKey?: unknown; reason?: unknown },
  ctx: RecommendationContext,
): PosterRecommendation {
  // ★ 2026-08-17 产品决定：**高级档可下单时默认推 premium**，反转此前「默认不推贵档」的口径
  //   （旧实现：只有模型明确说 premium 才认，其余一律 standard）。确认页的默认扣费因此从 10 钻变 25 钻。
  //
  //   副作用必须一起处理：模型的理由是**按它自己选的那一档**写的。如果它选了 standard 而我们改推
  //   premium，那句理由就在替另一档说话（"不额外出图也立得住" 配着一张实拍主视觉），用户会读出矛盾。
  //   所以档位与模型的选择不一致时整条理由作废、退回确定性模板句。提示词那边已同步改成默认 premium，
  //   正常情况下模型会直接给 premium，理由仍用它写的那句 —— 那句更贴这次对话。
  const tier: PosterTier = ctx.premiumAvailable ? 'premium' : 'standard';
  const wantsPremium = raw.tier === 'premium';
  const downgraded = wantsPremium && !ctx.premiumAvailable;
  const tierMatchesModel = wantsPremium === (tier === 'premium');

  let directionKey: PosterDirectionKey | null = isPosterDirectionKey(raw.directionKey) ? raw.directionKey : null;
  if (directionKey) {
    const dir = directionFor(directionKey);
    // 档位对不上（含 premium 被降级的情形）或没有本人照 → 丢掉模型的选择，走确定性默认。
    if (dir.tier !== tier || (dir.requiresPortrait && !ctx.hasPortrait)) directionKey = null;
  }
  const finalDirection = directionKey ?? defaultDirectionKey(tier, ctx.scene, ctx.hasPortrait);

  const templateKey = isTemplateKey(raw.templateKey)
    ? raw.templateKey
    : fallbackTemplateKey(ctx.scene, ctx.proofPointCount);

  const aiReason = tierMatchesModel ? clip(typeof raw.reason === 'string' ? raw.reason : '', RECOMMEND_REASON_LIMIT) : '';
  const reason = !downgraded && aiReason
    ? aiReason
    : fallbackReason({ tier, directionKey: finalDirection, templateKey, downgraded });

  return { tier, directionKey: finalDirection, templateKey, reason };
}

/**
 * 定位要读的会话。**归属校验一次都不能省**：sessionId 与 messageId 都是客户端传来的，
 * 不校验就等于允许任何人读别人的对话去拼海报。
 */
async function resolveDraftSession(opts: {
  userId: string; sessionId?: string | null; messageId?: string | null;
}): Promise<{ id: string; agentKey: string } | null> {
  if (opts.sessionId) {
    return prisma.session.findFirst({
      where: { id: opts.sessionId, userId: opts.userId },
      select: { id: true, agentKey: true },
    });
  }
  if (opts.messageId) {
    const msg = await prisma.message.findFirst({
      where: { id: opts.messageId, session: { userId: opts.userId } },
      select: { session: { select: { id: true, agentKey: true } } },
    });
    return msg?.session ?? null;
  }
  return null;
}

/** 抽取素材的上限：够覆盖一轮需求澄清，又不至于把整段长对话塞进抽取模型。 */
const DRAFT_MESSAGE_LIMIT = 24;
const DRAFT_TEXT_LIMIT = 6000;
/**
 * 抽取产出的 token 预算。**必须显式给**：这份壳有 15 个字段（含 artDirection 七个 {zh,en}
 * 子对象）+ 2–3 句 designNote，中文 JSON 稳定要 1500+ token，而 rawText 的辅助档缺省只有 700。
 */
const DRAFT_MAX_TOKENS = 3000;
/**
 * 抽取的单次挂钟预算。**必须显式给**，理由和 maxTokens 是两回事：
 *
 * 退出辅助档（`allowAux: false`）之后这次调用落到运营配的主模型上——线上是七牛 Claude 且开着
 * adaptive thinking。**典型耗时约 22s**（2026-08-17 生产连测两次：23.7s / 21.6s），但**方差很大**，
 * 实测出现过整整 60s 还没回来的尖峰。而 `cfg.timeoutMs` 缺省取的是
 * `OPENAI_TIMEOUT_MS=60000`，`rawText` 的 phase 又是 `chat_completion`（`requestTimeoutMs` 只给
 * `chat_sync`/`deliverable` 兜 150s/300s 下限，这一档吃原值），claude provider 那条非流式补全
 * 同样用 `ep.timeoutMs` 原值 —— 于是恒定 60.0s 抛 `Request timed out.`，structured 返回 null，
 * 确认页又变回空表单（2026-08-17 21:38 生产实锤：请求 21:38:47，60 秒后一行超时）。
 *
 * 150s 是拍在「客户端 180s 之内、又给足思考模型时间」这个夹缝里的。它不是为了等那 22s，
 * 而是为了**吸收尖峰**：60s 这个缺省会把一次偶发的慢响应变成一张空表单，而用户看不出区别
 * ——只会以为「聊了半天没带过来」。宁可偶尔转圈久一点，也不要把方差伪装成「抽不出来」。
 */
const DRAFT_TIMEOUT_MS = 150_000;

/**
 * 把会话末尾若干条消息拼成抽取素材。
 *
 * 取**最后** N 条而不是最前 N 条：需求是在对话里逐步收敛的，最后几轮才是结论
 * （用户中途改主意说"主标题换成 X"，只有末尾那句是对的）。拼装顺序仍按时间正序，
 * 让抽取模型读得到"先说什么后说什么"。
 */
async function loadConversationText(sessionId: string): Promise<string> {
  const rows = await prisma.message.findMany({
    where: { sessionId },
    orderBy: { createdAt: 'desc' },
    take: DRAFT_MESSAGE_LIMIT,
    select: { role: true, contentJson: true },
  });
  const lines: string[] = [];
  for (const r of rows.reverse()) {
    const c = (r.contentJson ?? {}) as Record<string, unknown>;
    // 普通消息是 { text }；成果消息是 Deliverable（老会话里可能还有）——两种都收。
    const body = typeof c.text === 'string' && c.text
      ? c.text
      : deliverableText(c as unknown as Deliverable);
    const t = String(body ?? '').trim();
    if (!t) continue;
    lines.push(`${r.role === 'user' ? '客户' : '设计师'}：${t}`);
  }
  return lines.join('\n').slice(-DRAFT_TEXT_LIMIT);
}

/** 兜底解析设计师直出的「成品图版式推荐：人物主视觉（person_hero）—— 理由」行。 */
export function parseTemplateRecommendation(text: string): { templateKey: TemplateKey | null; reason: string } {
  const line = text.split(/\r?\n/).find((l) => l.includes('成品图版式推荐'));
  if (!line) return { templateKey: null, reason: '' };
  const keyMatch = line.match(/\(([a-z_]+)\)|（([a-z_]+)）/);
  const key = (keyMatch?.[1] ?? keyMatch?.[2] ?? '').trim();
  const reason = (line.split(/——|--|—/).slice(1).join('—') || '').trim();
  return { templateKey: isTemplateKey(key) ? key : null, reason };
}

/** 把成果消息压成可喂模型的纯文本（不含 htmlUrl 之类工程字段）。 */
function deliverableText(d: Deliverable): string {
  const parts: string[] = [`标题：${d.title ?? ''}`];
  if (d.meta) parts.push(`摘要：${d.meta}`);
  if (d.cover?.subtitle) parts.push(`副标：${d.cover.subtitle}`);
  for (const s of d.sections ?? []) {
    const sec = s as { h?: string; sub?: string; b?: string; list?: string[]; paras?: string[] };
    const chunk = [sec.h, sec.sub, sec.b, ...(sec.list ?? []), ...(sec.paras ?? [])].filter(Boolean).join('\n');
    if (chunk) parts.push(chunk);
  }
  if (d.actions?.length) parts.push(`建议行动：${d.actions.join('；')}`);
  return parts.join('\n').slice(0, 6000);
}

function clip(s: string, max: number): string {
  const t = (s ?? '').trim();
  return t.length > max ? t.slice(0, max) : t;
}

/**
 * AD → visualDirection 的确定性序列化。
 *
 * 顺序即重要性：`visualDirection` 只有 100 字，装不下就**整条丢弃末尾字段**，
 * 而不是让 clip 从中间截断 —— 半句「背景沉稳深」比少一个字段更糟，它是个说不完的承诺。
 * 背景/光线/色彩排在最前：那三项正是本次修复里「说了却进不了画面」的字段。
 */
const AD_SERIALIZE_ORDER: readonly ArtDirectionKey[] = [
  'backdrop', 'lighting', 'palette', 'material', 'mood', 'figure', 'props',
];
const AD_SERIALIZE_LABEL: Record<ArtDirectionKey, string> = {
  backdrop: '背景', lighting: '光线', palette: '色彩',
  material: '材质', mood: '情绪', figure: '人物', props: '道具',
};
function serializeArtDirection(ad: ArtDirection, max: number): string {
  let out = '';
  for (const k of AD_SERIALIZE_ORDER) {
    const zh = ad[k]?.zh;
    if (!zh) continue;
    const next = out ? `${out}；${AD_SERIALIZE_LABEL[k]}${zh}` : `${AD_SERIALIZE_LABEL[k]}${zh}`;
    if (next.length > max) break;
    out = next;
  }
  return out;
}

/** BrandKit 合并（只在 approved 时调用）：tagline→副标候选、theme→视觉方向、taboos→排除项。 */
function mergeBrandKit(brief: Partial<PosterBrief>, kit: BrandKitView): Partial<PosterBrief> {
  const out = { ...brief };
  if (!out.subheadline && kit.persona?.tagline) out.subheadline = clip(kit.persona.tagline, LIMITS.subheadline);
  if (!out.visualDirection) {
    const hint = [...(kit.theme?.keywords ?? []), kit.theme?.colorHint ?? ''].filter(Boolean).join('、');
    if (hint) out.visualDirection = clip(hint, LIMITS.visualDirection);
  }
  if (!out.negativePrompt && (kit.voice?.taboos ?? []).length) {
    out.negativePrompt = clip(kit.voice!.taboos.join('、'), LIMITS.negativePrompt);
  }
  if (kit.version) out.brandKitVersion = kit.version;
  return out;
}

/**
 * 生成需求单草稿。
 * @throws CreativeError(404) 成果消息不存在或不属该用户。
 */
export async function buildPosterBriefDraft(opts: {
  userId: string;
  sessionId?: string | null;
  messageId?: string | null;
}): Promise<PosterBriefDraft> {
  // 定位会话：优先 sessionId（常驻入口就是从会话里点进来的），其次由 messageId 反查它所在的会话。
  // 两个都没有 → 空草稿（不是错误）：确认页会渲染成空白表单让用户手填。
  const session = await resolveDraftSession(opts);
  if (!session) return { brief: {} };

  // ★ 素材是**整段对话**，不再是一条成果消息（2026-08-13：海报设计师不再产出方案报告）。
  //   旧实现要求 messageId 且 role='report'，那是「先出一份方案、再从方案抽字段」的形态；
  //   现在海报设计师就是普通对话，需求散落在你问我答里，只能整段读。
  const text = await loadConversationText(session.id);
  const agentKey = session.agentKey;
  const fallbackScene = AGENT_SCENE[agentKey] ?? 'personal_brand';

  // 兜底层 ②：先从原文抓设计师直出的推荐行（LLM 不可用时也能给出带理由的推荐）。
  const rec = parseTemplateRecommendation(text);

  let ai: z.infer<typeof DraftSchema> | null = null;
  try {
    // ★ 两个上限都不能用缺省，2026-08-17 生产实测（同一段对话、同一个模型）：
    //   · 不给 maxTokens → 辅助档缺省 700，首轮与纠错轮一起被拦腰截断，structured() 返回 null，
    //     于是**每个字段都回退成空**，确认页看起来就是「聊了半天，进设计阶段全是空的」。
    //     给 3000 之后 goal / audience / cta / visualDirection / designNote / 推荐理由全部抽得出来。
    //     与 2026-07-30 海报宣言被 700 截断是同一个坑（见 gateway.ts structuredMetered 顶部注释）。
    //   · maxChars 不能小于 DRAFT_TEXT_LIMIT：structured() 内部是 `user.slice(0, maxChars)`，取的是
    //     **头部**，而 loadConversationText 刚按「结论在末尾」取过尾部——外层再切一刀头，等于把刚
    //     保下来的结尾又丢掉。实测 2176 字的对话被 1200 砍掉最后 976 字，丢的正好是设计师定稿那几句。
    //     两处上限统一到同一个常量，全链路只截一次，且截的是头。
    // allowAux: false —— 这一次抽取**不许落到辅助档小模型**。aux 是给「用户看不见的后台抽取」
    // 准备的（见 gateway.structuredMetered 上 allowAux 的注释），而这里是用户正盯着确认页等的
    // 一步：线上 aux 档是 deepseek-v4-flash，实测它会把字段清单原样回吐成一份全空 JSON，
    // 闭合合法、zod 全过、每个字段是空 —— 确认页于是整张表单空着，任何 token 预算都救不了。
    ai = await structured(DraftSchema, {
      system: DRAFT_SYS, user: text, maxChars: DRAFT_TEXT_LIMIT, maxTokens: DRAFT_MAX_TOKENS,
      allowAux: false, timeoutMs: DRAFT_TIMEOUT_MS,
    });
    // structured() 解析失败只返回 null、不抛，所以这行**不能省**：上一次就是因为这里静悄悄，
    // 线上空表单在 journalctl 里连一行 warn 都查不到，只能靠人肉复现才定位到截断。
    if (!ai) console.warn('[creative] brief 草稿抽取无结果（模型输出未通过校验），回退确定性预填');
  } catch (e) {
    console.warn('[creative] brief 草稿抽取失败，回退确定性预填：', (e as Error).message);
  }

  // 结构化艺术指导：归一（含卫生）后既拼给客户看的那句话，也序列化进 visualDirection 往下游走。
  const artDirection = normalizeArtDirection(ai?.artDirection);
  const adNote = clip(artDirectionNote(mergeArtDirection(null, artDirection)), 200);

  const scene: PosterScene = ai?.scene ?? fallbackScene;
  const aiKey = isTemplateKey(ai?.templateKey) ? (ai!.templateKey as TemplateKey) : null;
  const templateKey: TemplateKey = aiKey ?? rec.templateKey ?? SCENE_DEFAULT_TEMPLATE[scene];
  const templateReason = clip(ai?.templateReason || rec.reason, 80);

  let brief: Partial<PosterBrief> = {
    scene,
    goal: clip(ai?.goal ?? '', LIMITS.goal),
    audience: clip(ai?.audience ?? '', LIMITS.audience),
    // 抽不出主标题就留空，让用户在确认页自己写。
    // 旧实现这里兜底成「成果标题」，那是方案报告时代的产物——现在没有报告，也就没有标题可借；
    // 硬拿会话首句当主标题只会印出一句"帮我做个营销海报"。
    headline: clip(ai?.headline ?? '', LIMITS.headline),
    ...(ai?.subheadline ? { subheadline: clip(ai.subheadline, LIMITS.subheadline) } : {}),
    proofPoints: (ai?.proofPoints ?? [])
      .map((p) => clip(p, LIMITS.proofPoint))
      .filter(Boolean)
      .slice(0, LIMITS.proofPoints),
    cta: clip(ai?.cta ?? '', LIMITS.cta),
    // ★ 承诺同源：抽到结构化 AD 时，visualDirection 用它的确定性序列化 —— 客户在确认页读到的
    //   那句画面描述，和下游宣言/生图提示词读到的，必须是同一串字。抽不到才退回自由文本。
    //   （装不下时整条丢弃末尾字段，不做中途截断——序列化按重要性排序就是为了这一步。）
    visualDirection: clip(
      serializeArtDirection(artDirection, LIMITS.visualDirection) || (ai?.visualDirection ?? ''),
      LIMITS.visualDirection,
    ),
    templateKey,
    ratio: '3:4',
  };

  // 只用已确认（approvedAt 非空）的品牌资产包。
  const kitRow = await prisma.brandKit.findUnique({ where: { userId: opts.userId }, select: { approvedAt: true } });
  if (kitRow?.approvedAt) {
    const kit = await getBrandKit(opts.userId);
    if (kit) brief = mergeBrandKit(brief, kit);
  }

  // designNote 只有真抽出来才下发：抽不出时确认页退回表单打头，
  // 而不是显示一句模型编的、看起来很像但跟这张海报无关的话。
  //
  // AD 那句话**优先保留**：它是唯一一句「确认页说的」与「出图收到的」逐字相同的承诺，
  // 被 240 上限砍掉的应该是模型写的自由段落，不是它。
  const noteBody = clip(ai?.designNote ?? '', adNote ? Math.max(0, 240 - adNote.length - 1) : 240);
  const designNote = clip([noteBody, adNote].filter(Boolean).join(' '), 240);

  // 军师推荐组合：**恒下发**。它是确认页的默认预选，抽取失败时给不出组合，用户就又被推回
  // 「方式/方向/版式」三次必答——那正是这次要消灭的东西。premium 还要再过一次此刻的可下单判断，
  // 否则推荐一个建单必 422 的档位（brief.tier='premium' 而高级档不可用是硬错，不静默降标准）。
  const cfg = await getCreativeConfig();
  // 版式候选与 brief.templateKey 同源（AI 抽取 → 设计师推荐行），只有两处线索都没有时才分头兜底：
  // brief 保持既有的 scene 默认口径，推荐按内容密度另选一档——确认页以 recommendation 预选为准。
  const recommendation = resolveRecommendation(
    {
      tier: ai?.tier,
      directionKey: ai?.directionKey,
      templateKey: ai?.templateKey || rec.templateKey || undefined,
      reason: ai?.recommendReason,
    },
    {
      scene,
      proofPointCount: brief.proofPoints?.length ?? 0,
      hasPortrait: !!brief.portraitAssetId,
      premiumAvailable: premiumTierAvailable(cfg),
    },
  );

  return {
    brief,
    ...(templateReason ? { templateReason } : {}),
    ...(designNote ? { designNote } : {}),
    recommendation,
  };
}
