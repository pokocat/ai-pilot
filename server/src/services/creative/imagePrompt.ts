// 影像主导路线的 **prompt 拼装器**：把风格档案 + 模型给的英文主体描述 + brief 拼成一条送给
// 顶级生图模型的「全幅无文字主视觉」提示词。纯函数，无 IO —— 整条 photo 链里最值得单测的一段。
//
// 三个调研发现全部落在本文件（另有 styleLibrary 侧的 negativeSpaceClause 必填约束）：
//
//   ① **负空间禁入侵子句必须进 prompt 正文**（不是只塞负向框）。
//      只声明「左三分之一留白」不够：模型会把阴影边缘、家具轮廓、渐变条带、发丝塞进去，
//      而那片区域正是我们要压中文标题的地方。禁入侵子句是海报与普通图的唯一分界。
//      负向框（negativePrompt）是**第二道**，不是替代品——它对「不要在这个区域里出现 X」这种
//      带空间条件的约束基本无效。
//
//   ② **`no text anywhere in the image` 必须是正文最后一句**。
//      Seedream / 即梦这类文字渲染能力强的模型会主动往留白区写标题（它以为自己在帮忙做海报），
//      而那正好毁掉我们的叠加层。只写进负向框不够；写在骨架中间也不够（会被后面的负空间子句
//      挤到中段，权重下降）。所以由本文件在最末尾统一追加，骨架里**不许**自带这句
//      （styleLibrary 完整性单测钉住）。
//
//   ③ **提示词卫生**：模型填的 subject 槽是不可信文本。
//      · 禁用词剥除：2026 年主流模型（MJ V7+/V8、Seedream 4+）对 `masterpiece / 8k / highly detailed`
//        这类词已不再响应，甚至反向拉低成片质量（社区实测共识）。模型很爱塞，所以剥掉。
//      · **景别互斥**：一条 prompt 只能有一个景别词。混用两个（骨架已写 `waist-up framing`，
//        subject 里又来一个 `close-up`）是社区公认的首要失败原因。骨架的景别是我们调过的，
//        所以冲突时**剥 subject 的**，不动骨架。
import type { NormalizedPosterBrief } from './schema.js';
import type { PosterStyle } from './styleLibrary.js';

/** 正文最后一句（发现②）。改这里必须同步改 styleLibrary 的完整性单测。 */
export const NO_TEXT_CLAUSE = 'no text anywhere in the image';
/** 画幅后缀（固定 3:4；MJ 用 --ar 3:4，即梦/Seedream 用画幅选项，两边都吃这个字面量）。 */
export const RATIO_SUFFIX = '3:4';

/** subject 槽名（styleLibrary 已把 12 档的主体槽统一归一成这一个）。 */
export const SUBJECT_SLOT = '{SUBJECT}';

/**
 * 通用负向基座（底稿「通用负向基座」段）。风格专属忌讳在 PosterStyle.negatives，拼装时合并去重。
 * 分开放的理由：加一档新风格不该抄一遍这 20 个词，抄漏一个就是一次线上翻车。
 */
export const BASE_NEGATIVES = [
  'text', 'lettering', 'typography', 'watermark', 'signature', 'logo', 'brand marks',
  'QR code', 'UI elements', 'caption bars',
  'deformed hands', 'extra fingers', 'malformed face', 'over-symmetrical AI face',
  'plastic skin', 'waxy skin', 'oversharpened HDR', 'compression artifacts',
  'cluttered background',
] as const;

/**
 * 已失效 / 反而降质的质量词（底稿「已失效 / 反而降质（禁用列表）」段）。
 * 多词短语放在前面（先长后短匹配，避免 `8k` 先把 `ultra HD` 的场面吃掉之类的顺序坑）。
 */
export const BANNED_QUALITY_WORDS = [
  'trending on artstation', 'intricate details', 'award-winning', 'super realistic',
  'highly detailed', 'hyper detailed', 'best quality', 'ultra hd', 'masterpiece',
  'breathtaking', 'beautiful', 'stunning', 'gorgeous', 'amazing', '8k', '4k',
] as const;

/**
 * 景别词族（底稿「景别 —— 每条 prompt 只能出现一个」）。
 * 顺序 = 匹配优先级，**必须先长后短**：`medium close-up` 要在 `close-up` 与 `medium shot` 之前，
 * 否则 `medium close-up` 会被拆成两处命中，剥词时留下一句 `medium ` 的残骸。
 */
export const SHOT_SIZE_TERMS = [
  'extreme wide shot', 'extreme close-up', 'medium close-up', 'head-and-shoulders',
  'three-quarter body', 'wide shot', 'full shot', 'full body', 'medium shot',
  'close-up', 'waist-up', 'chest-up',
] as const;

/** subject 上界：一句英文主体描述，超过就是模型在写小作文（整条 prompt 会被稀释）。 */
const MAX_SUBJECT_CHARS = 240;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 词边界匹配。`8k` / `close-up` 这类含数字与连字符的词不能用 `\b` 直接包（`\b` 在 `-` 处会命中，
 * 于是 `close-up` 能匹配到 `close-upward` 的一部分），所以两侧用「非字母数字连字符」断言。
 */
function termRe(term: string): RegExp {
  return new RegExp(`(^|[^A-Za-z0-9-])${escapeRe(term)}(?![A-Za-z0-9-])`, 'gi');
}

/**
 * 收拾剥词后的标点残骸：`, ,` / 双空格 / 行首尾逗号 / `( )` 空括号。
 * 剥词只是把词删掉，留下的 "photograph of  , calm and still" 会让模型读到一个断句。
 */
function tidy(s: string): string {
  return s
    .replace(/\s+/g, ' ')
    .replace(/\(\s*\)/g, '')
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/([,;:])\s*(?=[,.;:])/g, '')
    .replace(/^[\s,;:.]+/, '')
    .replace(/[\s,;:]+$/, '')
    .trim();
}

/**
 * 剥词专用的二次收拾：**悬空冠词**。
 *
 * 剥掉一个词不只是留下空格 —— `a masterpiece close-up of a lawyer` 剥完变成 `a of a lawyer`，
 * 拼进骨架就是 "portrait of a of a lawyer"（模型读到一个坏句子，画面质量随之下降）。
 * 所以冠词后面紧跟介词/逗号时把冠词也去掉；整段只剩一个冠词时视为空（由路线门禁③降级到 graphic）。
 */
function tidySubject(raw: string): string {
  let s = tidy(raw);
  s = s.replace(/\b(a|an|the)\s+(of|in|at|with|and|,)\b/gi, '$2');
  // 悬空介词：上一步把 `a masterpiece close-up of …` 收成 `of …`，而骨架的槽位前面本来就有一个
  // `of` —— 拼起来是 "portrait of of a lawyer"。subject 以介词开头一律去掉那个介词。
  s = s.replace(/^(of|in|at|with|and)\s+/i, '');
  s = s.replace(/\s+\b(a|an|the)$/i, '');
  s = s.replace(/^(a|an|the)$/i, '');
  return tidy(s);
}

export interface SubjectHygieneResult {
  subject: string;
  /** 被剥掉的禁用质量词（原样小写，去重）。 */
  strippedWords: string[];
  /** 被剥掉的重复景别词（原样小写，去重）。 */
  strippedShotSizes: string[];
}

/**
 * 文本里出现的景别词，**按出现顺序**返回、每个词只记一次。
 *
 * 为什么是逐位置扫描而不是「对每个词各跑一遍正则」：后者会把 `medium close-up` 同时算成
 * `medium close-up` **和** `close-up` 两处命中（子串），于是剥词时先剥掉短的那个，
 * 留下 `medium ` 的残骸 —— 这正是本函数第一版的 bug，被单测抓住。
 * 现在的规则是「在每个词边界位置上取能匹配的最长词，然后跳过它」。
 */
export function shotSizesIn(text: string): string[] {
  const out: string[] = [];
  const lower = String(text ?? '').toLowerCase();
  const wordish = /[a-z0-9-]/;
  for (let i = 0; i < lower.length; i++) {
    if (i > 0 && wordish.test(lower[i - 1])) continue;   // 不在词边界上
    for (const term of SHOT_SIZE_TERMS) {                 // 表本身先长后短
      if (!lower.startsWith(term, i)) continue;
      const next = lower[i + term.length] ?? '';
      if (next && wordish.test(next)) continue;           // 右侧也要是词边界
      if (!out.includes(term)) out.push(term);
      i += term.length - 1;
      break;
    }
  }
  return out;
}

/**
 * subject 卫生（发现③）。顺序有讲究：
 *   1. 截断 → 2. 剥禁用质量词 → 3. 景别互斥剥除 → 4. 收拾标点。
 * 先剥词再收拾标点，才不会留下 "a , woman" 这种断句。
 *
 * @param skeletonShots 骨架里已有的景别词。非空时 subject 里的**所有**景别词都剥掉（骨架优先）；
 *        为空时保留 subject 里出现的**第一个**、剥掉其余（仍然是「一条 prompt 一个景别」）。
 */
export function sanitizeSubject(raw: unknown, skeletonShots: string[] = []): SubjectHygieneResult {
  let s = String(raw ?? '').replace(/[{}]/g, ' ').slice(0, MAX_SUBJECT_CHARS);
  const strippedWords: string[] = [];
  const strippedShotSizes: string[] = [];

  for (const w of BANNED_QUALITY_WORDS) {
    const re = termRe(w);
    if (!re.test(s)) continue;
    strippedWords.push(w);
    s = s.replace(termRe(w), '$1');
  }

  const present = shotSizesIn(s);
  // 骨架已有景别 → subject 的景别全剥；骨架没有 → 留 subject 里**出现最早**的那个，剥其余。
  const keep = skeletonShots.length ? null : present[0] ?? null;
  // 剥的顺序按词长从长到短：若 `close-up` 与 `medium close-up` 同时在场，先剥短的会把长的削成 `medium `。
  for (const term of [...present].sort((a, b) => b.length - a.length)) {
    if (term === keep) continue;
    strippedShotSizes.push(term);
    s = s.replace(termRe(term), '$1');
  }

  // 只在真的剥过词时做悬空冠词收拾：没剥过的 subject 不该被本函数改写一个字。
  const cleaned = strippedWords.length || strippedShotSizes.length ? tidySubject(s) : tidy(s);
  return { subject: cleaned, strippedWords, strippedShotSizes };
}

/**
 * 展开骨架槽位：`{SUBJECT}` 换成 subject；`{LABEL: 内容}` 去掉花括号只留内容（见 styleLibrary 偏离②）。
 * 光秃秃的 `{LABEL}`（没有内容）一律删除并留一条 warn —— 那是档案写错了，
 * 但把字面 `{LABEL}` 发给生图模型比删掉更糟。
 */
export function expandSlots(skeleton: string, subject: string): string {
  const withSubject = skeleton.split(SUBJECT_SLOT).join(subject);
  return withSubject
    .replace(/\{[A-Z_]+:\s*([^{}]*)\}/g, (_m, inner: string) => inner.trim())
    .replace(/\{[A-Z_]+\}/g, '');
}

export interface AssembledImagePrompt {
  /** 送给生图模型的正文（负空间子句在中段、no-text 在最末、画幅收尾）。 */
  prompt: string;
  /** 负向框（风格专属 + 通用基座 + brief 排除项，去重后逗号分隔）。 */
  negativePrompt: string;
  styleKey: string;
  /** 实际用的主体描述（已过卫生）。落资产 metadata，便于回看模型写了什么。 */
  subject: string;
  strippedWords: string[];
  strippedShotSizes: string[];
}

/**
 * 拼一条影像主导 prompt。
 *
 * 正文顺序是刻意的：
 *   [骨架（已填 subject）] → [负空间禁入侵子句] → [no text anywhere in the image] → [3:4]
 * 负空间子句必须在 no-text **之前**（它描述画面内容，属于正文主体）；
 * no-text 必须是**最后一句人话**（发现②），画幅只是个参数尾巴。
 */
export function assembleImagePrompt(input: {
  style: PosterStyle;
  /** 模型给的英文主体描述（不可信文本，本函数负责卫生）。 */
  subject: unknown;
  brief: NormalizedPosterBrief;
}): AssembledImagePrompt {
  const { style, brief } = input;
  const skeletonShots = shotSizesIn(style.imagePromptSkeleton);
  const hygiene = sanitizeSubject(input.subject, skeletonShots);

  // 兜底：槽位接缝处的重复介词/冠词（`of of` / `of a a`）。subject 侧已经收拾过一轮，
  // 但接缝是「骨架 + 模型文本」两边共同决定的，这里再压一次比在两边各猜一次可靠。
  const body = tidy(expandSlots(style.imagePromptSkeleton, hygiene.subject))
    .replace(/\b(of|in|at|with|and|a|an|the) \1\b/gi, '$1');
  const clause = tidy(style.negativeSpaceClause);
  const sentence = (s: string): string => (/[.!?]$/.test(s) ? s : `${s}.`);
  const prompt = [sentence(body), sentence(clause), `${NO_TEXT_CLAUSE}.`, RATIO_SUFFIX].join(' ');

  // 负向：风格专属在前（更贴题），通用基座在后，brief 排除项最后（用户显式要求，不能被去重吃掉语义）。
  const parts = [
    ...style.negatives,
    ...BASE_NEGATIVES,
    ...String(brief.negativePrompt ?? '').split(/[,，、;；\n]/),
  ];
  const seen = new Set<string>();
  const negatives: string[] = [];
  for (const p of parts) {
    const v = p.trim();
    if (!v) continue;
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    negatives.push(v);
  }

  return {
    prompt,
    negativePrompt: negatives.join(', '),
    styleKey: style.key,
    subject: hygiene.subject,
    strippedWords: hygiene.strippedWords,
    strippedShotSizes: hygiene.strippedShotSizes,
  };
}
