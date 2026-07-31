// AI 排版引擎 · 阶段二：**模型自己写整张海报的 HTML/CSS**（第 3 档，2026-07-29 拍板）。
//
// 这一步是整条链路的画质来源，也是与上一代（三套固定模板 + 一句 ≤80 字的 visualPrompt）的根本差别：
// 上游 canvas-design 根本不用图片模型——「哲学长文 → 模型用代码在画布上创作 → 强制二次打磨」。
// 本模块就是那三步的自动化等价物：
//
//   generate（LLM #1 for HTML）
//     → sanitize（静态审计，不可信输入）
//     → fillPlaceholders + ensureAiMark（素材与合规标识是服务端的事，不交给模型的自觉）
//     → render(js 禁用 + 请求白名单) + measure（越界/边距/字号/重叠/文案在场/二维码/占位符残留）
//     → refine（LLM #2）：**首轮干净也照样打磨一轮**——这是上游 skill 的核心机制（"take a second pass"），
//                          不是可选优化；首轮有违规则把违规逐条回喂
//     → 最多再 refine 一轮（LLM #3）
//     → 仍不干净 → 返回 ok:false，由 worker 回落模板路径（付费任务永不因 AI 引擎失败）
//
// 三条不变式（改本文件前先读）：
//   ① **HTML 相关的 LLM 调用最多 3 次**（MAX_HTML_CALLS）。每轮都要跑一次真实渲染，成本与时延都在这里；
//      整段还压着一个 180s 预算，超了就用手上最好的结果或回落。
//   ② **打磨轮不许让画面变差**。若首轮干净、打磨轮反而量出违规，直接退回首轮那张干净图
//      （polishReverted），绝不为了"执行了打磨"而交一张更差的图。
//   ③ 失败一律**返回**而不是抛：调用方要靠返回值决定回落，抛异常会被 worker 归成 INTERNAL 并退款，
//      而那时用户本该拿到一张模板图。
import { completeText } from '../../llm/gateway.js';
import { moderate } from '../moderation.js';
import { AI_MARK_TEXT, CANVAS_CLASS, FONT_SANS, FONT_SERIF } from './templates.js';
import { DECOR_ATTR, MEASURE_LIMITS, violationsCritique, type PosterViolation } from './canvasMeasure.js';
import {
  CANVAS_PLACEHOLDER, CANVAS_SPEC, availablePlaceholders, ensureAiMark, fillPlaceholders,
  sanitizeCanvasHtml, type CanvasAssetUrls,
} from './canvasSanitize.js';
import { renderCanvasPoster } from './renderer.js';
import { SAFE_ZONE_HINTS, type PosterStyle } from './styleLibrary.js';
import type { NormalizedPosterBrief } from './schema.js';
import type { PosterManifesto } from './manifesto.js';

/** HTML 相关的 LLM 调用上限（生成 1 + 打磨/修复 2）。加上宣言那一次，整单 ≤4 次模型调用。 */
export const MAX_HTML_CALLS = 3;
/** 整段预算（含全部 LLM 往返与渲染）。超时即用手上最好的结果，没有就回落模板。 */
export const AI_ENGINE_BUDGET_MS = 180_000;
/** 单次 HTML 生成的 token 预算：一页 540×720 的手写 HTML/CSS 约 2–4k token。 */
const HTML_MAX_TOKENS = 6000;
/**
 * 失败留痕里 `lastHtml` 的截断上限。
 * 回落时把模型最后那份产物留下来（worker 写进 CreativeJob.metadataJson.aiDebug）：
 * 「量测器误伤了什么手法」这种问题，只有看到模型想画的东西才判得出来，靠 reason 里的违规码猜不出来。
 * 24k 字符约等于一页正常产物的全文（6–20KB），够看构图；再大就该去查资产 metadata 里的最终 HTML 了。
 */
export const MAX_DEBUG_HTML_CHARS = 24_000;

/* ───────────────── 提示词 ───────────────── */

// 上游 → 本提示词的移植对照（SKILL.upstream.md「CANVAS CREATION」段）：
//   "museum or magazine quality work"                          → 【标准】博物馆/杂志级
//   "use repeating patterns and perfect shapes"                → 【怎么画】重复图案与精确的形
//   "borrowing the visual language of systematic observation—
//    dense accumulation of marks, repeated elements, layered
//    patterns that build meaning through patient repetition"   → 【怎么画】密集刻度/层叠母题那句
//   "sparse, clinical typography and systematic reference
//    markers ... a diagram from an imaginary discipline"       → 【怎么画】假想学科图谱那句
//   "Text as a contextual element ... nothing falls off the
//    page and nothing overlaps ... non-negotiable"             → 【文字】+ 硬约束 8（并被量测器执行）
//   "make it appear as though someone at the absolute top of
//    their field labored over every detail"                    → 【标准】最后一句
//   "The topic is a subtle, niche reference embedded within
//    the art itself"                                          → 【隐性主题】
// 上游的「下载字体 / 用 ./canvas-fonts」在本项目不适用（镜像内置字体栈、渲染无网络），已改写为硬约束 4。
function canvasSystemPrompt(photo?: PosterStyle): string {
  const L = MEASURE_LIMITS;
  return [
    '你是「军师参谋部」的海报设计师，也是这一行最顶尖的手艺人。你要用代码在画布上**创作一件作品**：',
    '整张海报的 HTML/CSS 全部由你写，没有模板，没有占位版式。',
    '',
    '【标准】做出博物馆或杂志级的东西。成品要看起来像花了很久——精工细作、反复推敲、大师级执行，',
    '像是这一行最顶尖的人对每一个细节都苛刻过。任何「一眼像自动生成」的画面都不合格。',
    '',
    ...(photo ? photoHowTo(photo) : [
      '【怎么画】',
      '- 先读下面那篇视觉哲学宣言，把它当作这张海报的美学法律：气质、取舍、色彩关系、层级都由它决定。',
      '- 用重复的图案与精确的形作画：几何母题、密集排列的刻度与标记、层叠的色域——靠耐心的重复累积出意义，',
      '  让画面经得起久看。可以像一本假想学科的图谱：克制的、近乎临床的小字标注与系统性编号，',
      '  用分析性的视觉语言去讲一件关乎人的事。',
      '- 画面 ≈ 90% 视觉 + 10% 必要文字。信息活在设计里，不活在段落里。',
      '- 只用纯 CSS/SVG 作画：渐变、图案、网格、几何形、遮罩、混合模式、字重与字距对比。没有照片也要成立。',
      '- 隐性主题：把这门生意的灵魂藏进纹理、色彩关系与重复母题里——懂的人会心一笑，不懂的人也看到一件好作品。',
      '  **不要直白复述卖点**，也不得为了「艺术性」牺牲主标题可读性、CTA 显著性或二维码可扫性。',
    ]),
    '',
    '【文字】文字本身就是图形。音量由场景决定：可以是有力的大字排印，也可以是耳语般的小字。',
    '字号敢差出一个量级，字距敢拉开。但无论怎么排——**任何元素都不出画、信息文字之间不互相压字**',
    '（装饰性叠层是允许的，按硬约束 10 声明），每个元素都有呼吸空间。这是专业执行的底线，不可协商。',
    '',
    `【硬约束（渲染后会被机器逐条量测，违反即打回重写）】`,
    `1. 画布固定 ${CANVAS_SPEC.width}×${CANVAS_SPEC.height} px（3:4，@${CANVAS_SPEC.scale}x 输出）。`,
    `   根元素必须是 <div class="${CANVAS_CLASS}">，且 width:${CANVAS_SPEC.width}px;height:${CANVAS_SPEC.height}px;`,
    `   overflow:hidden;position:relative。body 与 html 也钉成这个尺寸、margin:0。`,
    '2. 只输出一个完整 HTML 文档，<!DOCTYPE html> 开头、</html> 结尾。<head> 里只允许',
    '   <meta charset>、<meta name="viewport">、<title>、<style>。CSS 全部写在 <style> 里。',
    '3. 禁 JavaScript（任何 <script> 或 on* 事件属性一律打回）；禁一切外链——不许 <link>、@import、',
    '   url(http…)、不许下载字体、不许引用任何网络图片。渲染环境**没有网络**。',
    '4. 字体只能用这两个栈，原样复制，不要增删（镜像内已装，含 Pan-CJK family 名）：',
    `   无衬线：${FONT_SANS}`,
    `   衬线：${FONT_SERIF}`,
    '5. 图片只有两种合法来源：下面告知你的占位符，或你自己写的 data:image URI（如内联 SVG）。',
    '   **没告知你的占位符绝对不要写**（写了会留下一个空洞并被判违规）。',
    `   二维码 <img> 必须带 data-role="qr"，本体 ≥${L.qrMinPx}px，其父容器 padding ≥${L.qrQuietPx}px 且背景纯白（静区，保证可扫）。`,
    '   Logo <img> 只限高、必须 object-fit:contain（禁拉伸变形）。',
    '6. 文案只能用下面给的原文，**一个字都不许自创、改写或翻译**：不许自己编承诺、数字、时间、地点、联系方式。',
    '   主标题必须原样出现在画面上（可以拆字、竖排、调字距，但字符本身不能改）。宁可少放信息，也不许多造信息。',
    `7. 底部或角落必须有 AI 生成标识，文字原样为「${AI_MARK_TEXT}」（合规要求：不可省略、不可改写、不可用 CSS 隐藏）。`,
    '8. 版面预算（逐条量测）：',
    `   · 所有可见元素完整落在画布内（容差 ${L.boundsTolerancePx}px）；画布内容不得溢出（溢出部分会被裁掉）；`,
    `   · 可见文字距画布边 ≥${L.minMarginPx}px；文字块之间间距 ≥${L.minGapPx}px；`,
    `   · 任何可见文字字号 ≥${L.minFontPx}px；`,
    '   · 任何两块文字的包围盒不得重叠（唯一例外是按第 10 条声明的装饰叠层）。',
    '   文案装不下时**压缩排版、精简层级或加大留白**，不要靠缩小字号硬塞。',
    '9. 色板：用宣言给的色板或与之同源的推导色。禁止大面积高饱和互补色硬碰（例如墨绿页头压一块大红），',
    '   对比靠明度与面积经营，不靠两个对立色对撞。',
    `10. 文字叠层是受欢迎的设计手法（大字当背景图形、层叠的标注与编号、压在色域上的排印），`
    + `但装饰层必须带 ${DECOR_ATTR}="1" 属性声明「这层文字是图形元素」——`,
    '   量测器只放行带这个标记的重叠，没标记的重叠一律判违规打回。',
    '   而**信息层之间禁止真重叠**：主标题、副标题、卖点、CTA、落款彼此必须各自完整可读、互不压字；',
    `   不许给这些信息文字加 ${DECOR_ATTR} 来绕过量测（打磨轮里也一样，别把信息文字标成装饰）。`,
    '   声明为装饰也**只豁免重叠这一项**：装饰字同样不许出画、不许贴边、不许低于最小字号。',
    ...(photo ? [
      `11. **全幅背景层（本张是影像主导版）**：${CANVAS_PLACEHOLDER.visual} 必须作为画布最底层铺满整张画布——`,
      `   <img src="${CANVAS_PLACEHOLDER.visual}"> 写成 position:absolute;left:0;top:0;`,
      `   width:${CANVAS_SPEC.width}px;height:${CANVAS_SPEC.height}px;object-fit:cover;object-position:center;z-index:0。`,
      '   不许把它缩成一张卡片、不许加圆角、不许留白边、不许只当装饰小图用——它就是这张海报的主视觉。',
      '   也不要用 transform:scale / 负 margin 去二次裁切：那会把主体或人脸切掉，而画面构图是按整幅算好的。',
      `12. **文字只能落在安全区**：这张主视觉在生成时就为排版留好了空区 —— ${SAFE_ZONE_HINTS[photo.safeZone]}。`,
      '   所有信息文字（主标题/副标题/卖点/CTA/落款/AI 标识）都必须落在这片区域内，',
      '   **绝不许压在人物面部或主体上**（这一项机器量不出来，只能靠你自己守；打磨轮请专门自查一遍）。',
      '   需要提升可读性时只能加一层极轻的渐变蒙版（linear-gradient 到半透明黑/白），',
      '   不许铺满不透明色块把照片盖掉。',
    ] : []),
    '',
    '【输出格式】只输出 HTML 源码本身，从 <!DOCTYPE html> 到 </html>。',
    '不要 Markdown 围栏，不要任何解释、前言或后记。',
  ].join('\n');
}

/**
 * 影像主导路线的【怎么画】段。与 graphic 段是**互斥替换**，不是叠加 ——
 * graphic 那段在教模型「用图案与几何把整幅画满」，photo 这段要它**收手**：
 * 主视觉已经由生图模型画完了，排版层再堆图形只会和照片抢注意力（这是这类海报最典型的翻车形态）。
 */
function photoHowTo(style: PosterStyle): string[] {
  return [
    '【怎么画 · 影像主导】',
    '- 先读下面那篇视觉哲学宣言，把它当作这张海报的美学法律：气质、取舍、色彩关系、层级都由它决定。',
    `- **画布最底层已经有一张全幅主视觉**（风格：${style.name}），由顶级生图模型出的无文字照片/画作，`,
    '  按硬约束 11 铺满整张画布。你的工作不是再画一张图，而是给它做**克制的排版叠层**。',
    '- 允许的手法只有这些：一层极轻的渐变蒙版（只为文字可读性）、细线与细分隔、小色块、',
    '  金属质感/描边的大字标题、字重与字距的对比、极小的英文标注。',
    '  **不要**再铺满几何图案、不要画装饰插画、不要加边框把照片框起来——那是在跟主视觉抢画面。',
    `- 排版气质（这一档的语法，按它走）：${style.typographyHints}`,
    `- 色板优先用这一档的：${style.palette.join('  ')}；宣言色板作辅助与推导。`,
    '- 画面 ≈ 90% 视觉 + 10% 必要文字。信息活在设计里，不活在段落里。',
    '- 隐性主题：把这门生意的灵魂藏进色彩关系与文字节奏里——**不要直白复述卖点**，',
    '  也不得为了「艺术性」牺牲主标题可读性、CTA 显著性或二维码可扫性。',
  ];
}

// 上游 → 打磨提示词的移植对照（SKILL.upstream.md「FINAL STEP」段，整段是本机制的出处）：
//   "The user ALREADY said 'It isn't perfect enough. It must be
//    pristine, a masterpiece of craftsmanship, as if it were
//    about to be displayed in a museum.'"                      → 第一段（原样直译）
//   "avoid adding more graphics; instead refine what has been
//    created and make it extremely crisp"                      → 【打磨不是加东西】
//   "If the instinct is to call a new function or draw a new
//    shape, STOP and instead ask: How can I make what's
//    already here more of a piece of art?"                     → 【打磨不是加东西】最后一句
//   "Take a second pass."                                      → 最后一句
const POLISH_DIRECTIVE = [
  '',
  '【本轮任务：打磨（不是重做）】',
  '用户已经说了：「这还不够完美。它必须是无瑕的——一件工艺品级的杰作，像是马上要被摆进博物馆展出。」',
  '',
  '【打磨不是加东西】不要再加图形、不要换字体、不要套滤镜、不要重排整版。',
  '要做的是让**已经在画面上的东西**更凝练、更锋利、更贴合那套哲学与极简原则：',
  '对齐再收一次、边距统一、字距成组、基线对齐、色彩关系再校一遍、收口处理干净。',
  '当你想调用一个新函数、画一个新形状时，停下来，问自己：怎样让**已经在这里的东西**更像一件艺术品？',
  '',
  '再走一遍代码，把它打磨成一件有哲学支撑的杰作。保持同一套构图与信息层级，也保持全部硬约束。',
].join('\n');

function fixDirective(violations: PosterViolation[]): string {
  return [
    '',
    '【本轮任务：修正 + 打磨】',
    '上一版渲染后量测到以下**硬约束违规**（每条都带 DOM 路径与实测数值，逐条修掉）：',
    violationsCritique(violations),
    '',
    '修正原则：优先压缩排版、精简层级、加大留白或改变构图关系来解决空间问题，',
    '不要靠缩小字号、不要靠删掉必要文案（主标题/CTA/AI 标识都不许删）。',
    '修完顺手把整版再打磨一遍：对齐、边距、字距、色彩关系、收口——保持同一套美学立场。',
  ].join('\n');
}

/** 用户侧上下文（宣言 + 文案 + 可用素材）。两个 prompt 共用，保证前后轮看到的事实一致。 */
function canvasUserPrompt(o: {
  brief: NormalizedPosterBrief;
  manifesto: PosterManifesto;
  assets: CanvasAssetUrls;
  photo?: PosterStyle | null;
}): string {
  const { brief, manifesto } = o;
  const placeholders = availablePlaceholders(o.assets);
  const lines = [
    ...(o.photo ? [
      `【本张走影像主导路线 · ${o.photo.name}（${o.photo.key}）】`,
      `全幅主视觉占位符：${CANVAS_PLACEHOLDER.visual}（服务端渲染前替换成真实图片字节）`,
      `文字安全区：${SAFE_ZONE_HINTS[o.photo.safeZone]} —— 所有文字必须落在这里，不许压主体/人脸`,
      `风格色板：${o.photo.palette.join('  ')}`,
      `排版气质：${o.photo.typographyHints}`,
      '',
    ] : []),
    `【视觉哲学宣言 · ${manifesto.movement}】`,
    ...manifesto.paragraphs,
    `色板：${manifesto.palette.join('  ')}`,
    manifesto.reference ? `隐性主题（只用于创作，不要印在画面上）：${manifesto.reference}` : '',
    '',
    '【可用文案（原文，一字不改）】',
    `主标题：${brief.headline}`,
    brief.subheadline ? `副标题：${brief.subheadline}` : '（无副标题）',
    brief.proofPoints.length ? `卖点（最多 3 条，可只用其中几条）：${brief.proofPoints.join(' / ')}` : '（无卖点）',
    `行动号召：${brief.cta}`,
    '落款：军师参谋部',
    `AI 标识（原样）：${AI_MARK_TEXT}`,
    '',
    '【业务背景（决定气质，不要把这些字印上去）】',
    `商业目标：${brief.goal}`,
    `目标客群：${brief.audience}`,
    brief.visualDirection ? `视觉方向：${brief.visualDirection}` : '',
    brief.negativePrompt ? `排除项（画面里不要出现）：${brief.negativePrompt}` : '',
    '',
    '【可用素材占位符】',
    placeholders.length
      ? `${placeholders.join('  ')}（只有这些可用；服务端会在渲染前替换成真实图片字节）`
      : '无（用户没有上传任何素材：请完全用 CSS/SVG 图形与排印作画，不要留空的图位，也不要写任何占位符）',
    o.assets.qrUrl ? `二维码占位符 ${CANVAS_PLACEHOLDER.qr} 必须放在白底静区容器里，并带 data-role="qr"` : '',
  ];
  return lines.filter((l) => l !== '').join('\n');
}

/* ───────────────── 依赖注入（测试不打真 LLM / 不起浏览器） ───────────────── */

export type CompleteTextFn = (
  system: string,
  user: string,
  o: { maxChars?: number; maxTokens?: number; temperature?: number },
) => Promise<string | null>;

export interface CanvasRenderFn {
  (html: string, o: { headline: string; expectQr: boolean; timeoutMs?: number }): Promise<{
    buffer: Buffer; width: number; height: number; violations: PosterViolation[]; measured: boolean;
    /** 页面可见文字（交付前输出侧审核用）。测试桩可省略，按空串处理。 */
    bodyText?: string;
  }>;
}

export interface CanvasEngineDeps {
  complete?: CompleteTextFn;
  render?: CanvasRenderFn;
  now?: () => number;
  /**
   * 画面文字的输出侧审核（fail-closed）。brief 文案建单时已审过，但模型可能自创装饰性文字，
   * 那也是印在对外成品上的内容，必须过同一道闸。worker 会带任务上下文注入；缺省用无上下文的
   * moderate('output')——绝不允许「没注入就不审」。
   */
  moderateText?: (text: string) => Promise<boolean>;
}

const defaultRender: CanvasRenderFn = async (html, o) => {
  const { rendered, measured } = await renderCanvasPoster(html, o);
  return { buffer: rendered.buffer, width: rendered.width, height: rendered.height, violations: rendered.violations, measured, bodyText: rendered.bodyText };
};

/* ───────────────── 主流程 ───────────────── */

export interface CanvasPoster {
  buffer: Buffer;
  mimeType: 'image/png';
  width: number;
  height: number;
  /** 最终 HTML（落 CreativeAsset.metadataJson 供排障；不入 CreativeJob 行，太大）。 */
  html: string;
  /** HTML 相关的 LLM 调用轮数（1=只生成，2=生成+一轮打磨/修复，3=再修一轮）。恒 ≥2：打磨是无条件的。 */
  rounds: number;
  /** 首轮量出、最终被修掉的违规条数。 */
  violationsFixed: number;
  /** 最终残留违规（成功时必为空数组）。 */
  violations: PosterViolation[];
  /** 打磨轮反而量出违规 → 已退回上一张干净图。 */
  polishReverted: boolean;
  /** 服务端兜底注入了 AI 标识（模型自己没写）。 */
  aiMarkInjected: boolean;
}

export type CanvasEngineOutcome =
  | { ok: true; poster: CanvasPoster }
  | {
    ok: false; reason: string; rounds: number; violations: PosterViolation[];
    /**
     * 最后一轮渲染过的产物（截断到 MAX_DEBUG_HTML_CHARS）。可能缺：模型压根没产出、
     * 或最后一轮被静态审计拒在浏览器之前（此时手上只有更早那一轮）。
     * 用途单一：回落排障时看模型到底想画什么（量测器误伤的判定依据）。
     */
    lastHtml?: string;
  };

interface Attempt {
  html: string;
  buffer: Buffer;
  width: number;
  height: number;
  violations: PosterViolation[];
  aiMarkInjected: boolean;
  /** 页面可见文字（量测时收集），交付前过输出侧审核。 */
  bodyText: string;
}

/**
 * 跑一轮「审计 → 替换 → 渲染 → 量测」。
 * 静态审计不过时不进浏览器（省一次渲染），直接把原因包成 `html_rejected` 违规回喂。
 */
async function attemptOnce(
  raw: string,
  input: { brief: NormalizedPosterBrief; assets: CanvasAssetUrls; timeoutMs?: number },
  render: CanvasRenderFn,
): Promise<{ attempt: Attempt | null; violations: PosterViolation[]; fatal?: string }> {
  const clean = sanitizeCanvasHtml(raw);
  if (!clean.ok) {
    return {
      attempt: null,
      violations: clean.issues.map((detail) => ({ code: 'html_rejected' as const, selector: 'html', detail })),
    };
  }
  const { html: filled } = fillPlaceholders(clean.html, input.assets);
  const { html, injected } = ensureAiMark(filled);
  let out: Awaited<ReturnType<CanvasRenderFn>>;
  try {
    out = await render(html, {
      headline: input.brief.headline,
      expectQr: !!input.assets.qrUrl,
      ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
    });
  } catch (e) {
    // 渲染异常（浏览器不可用 / 超时 / 产物不是 PNG）不是模型能修的 → 直接终止 AI 路径去回落。
    return { attempt: null, violations: [], fatal: `渲染失败：${(e as Error).message}` };
  }
  if (!out.measured) {
    // 量测拿不到结果时**不当成干净**（保守）：这是「无法验证」，与「验证通过」不是一回事。
    return { attempt: null, violations: [], fatal: '量测未生效（无法验证版面合规）' };
  }
  return {
    attempt: {
      html, buffer: out.buffer, width: out.width, height: out.height,
      violations: out.violations, aiMarkInjected: injected,
      bodyText: out.bodyText ?? '',
    },
    violations: out.violations,
  };
}

/**
 * 生成一张海报。**不抛异常**：走不通就回 `ok:false`，由 worker 回落模板路径。
 *
 * @param opts.budgetMs 整段预算（默认 180s）。每次 LLM 调用与渲染前都查一次剩余时间——
 *        宁可少跑一轮打磨，也不要让一单在 running 里耗到被 sweep 判卡死（那会变成重跑 + 两张资产）。
 */
export async function generateCanvasPoster(
  input: {
    brief: NormalizedPosterBrief;
    manifesto: PosterManifesto;
    assets: CanvasAssetUrls;
    /**
     * 影像主导路线的风格档（photo route）。给了它就走 photo 变体提示词：
     * 全幅背景层规则 + 安全区排版 + 该档的排版气质与色板。
     * **它与 assets.visualUrl 必须同时给**：只给 style 不给图，模型会去引用一个不存在的占位符
     * （量测器报 placeholder_residue，白烧三轮）。worker 那侧保证两者同进同出。
     */
    photoStyle?: PosterStyle | null;
    /** 单次渲染超时（沿用后台配置的 timeoutMs）。 */
    timeoutMs?: number;
    budgetMs?: number;
  },
  deps: CanvasEngineDeps = {},
): Promise<CanvasEngineOutcome> {
  const complete: CompleteTextFn = deps.complete ?? completeText;
  const render = deps.render ?? defaultRender;
  const now = deps.now ?? (() => Date.now());
  const moderateText = deps.moderateText ?? ((t: string) => moderate('output', t));
  const deadline = now() + (input.budgetMs ?? AI_ENGINE_BUDGET_MS);
  const outOfTime = (): boolean => now() >= deadline;

  /** 失败出口的唯一收口：顺手把最后一轮产物截断后带上（有就带，没有就不带这个键）。 */
  const fail = (
    o: { reason: string; rounds: number; violations: PosterViolation[]; html?: string | null },
  ): CanvasEngineOutcome => ({
    ok: false,
    reason: o.reason,
    rounds: o.rounds,
    violations: o.violations,
    ...(o.html ? { lastHtml: o.html.slice(0, MAX_DEBUG_HTML_CHARS) } : {}),
  });

  /**
   * 交付闸门（三个成功出口的唯一收口）：模型自创的画面文字过输出侧审核，不过审即回落模板。
   * 放在最后而不是逐轮审：文字在打磨轮间基本不变（brief 原文 + 少量装饰字），逐轮审是三倍成本；
   * 而最终交付的这一张必须审——它是印出去的对外成品。审核异常按 fail-closed 处理（moderate 内部约定）。
   */
  const deliver = async (a: Attempt, rounds: number, fvc: number, reverted: boolean): Promise<CanvasEngineOutcome> => {
    let pass = false;
    try {
      pass = await moderateText(a.bodyText);
    } catch {
      pass = false; // 审核服务自身异常：宁可回落模板（那条路的文字全部来自已审过的 brief）
    }
    if (!pass) {
      console.warn('[creative] AI 画面文字未过输出侧审核，回落模板路径');
      return fail({ reason: '画面文字未过内容审核', rounds, violations: [], html: a.html });
    }
    return { ok: true, poster: toPoster(a, rounds, fvc, reverted) };
  };

  const photo = input.photoStyle ?? null;
  const system = canvasSystemPrompt(photo ?? undefined);
  const user = canvasUserPrompt({ ...input, photo });

  let calls = 0;
  let firstViolationCount = 0;
  let lastClean: Attempt | null = null;
  let current: Attempt | null = null;
  let pending: PosterViolation[] = [];   // 待回喂的违规（空 = 上一轮干净，本轮做无条件打磨）
  let polished = false;                   // 是否已经发生过一次 refine（打磨或修复都算 second pass）
  let reason = '未知原因';

  while (calls < MAX_HTML_CALLS) {
    if (outOfTime()) {
      reason = `AI 引擎超出 ${input.budgetMs ?? AI_ENGINE_BUDGET_MS}ms 预算`;
      break;
    }
    // 第一次是「创作」，之后是「修正 + 打磨」或「无条件打磨」。
    const sys = calls === 0
      ? system
      : `${system}\n${pending.length ? fixDirective(pending) : POLISH_DIRECTIVE}`;
    // 静态审计不过的那一轮没有可用产物（current 仍是上一轮的），此时不附「上一版 HTML」，
    // 让模型按 critique 重写一份完整文档，而不是去改一份它看不到的东西。
    const usr = calls === 0 || !current
      ? user
      : `${user}\n\n【上一版 HTML（在它的基础上改，不要从零重写）】\n${current.html}`;

    calls++;
    const raw = await complete(sys, usr, { maxChars: 60_000, maxTokens: HTML_MAX_TOKENS, temperature: 0.7 });
    if (!raw) {
      // 无 live provider（mock/测试）或调用失败。首轮就没有 → 整条 AI 路径走不通。
      reason = calls === 1 ? '模型不可用（未配置真实 provider 或调用失败）' : '打磨轮模型调用失败';
      break;
    }

    const r = await attemptOnce(raw, input, render);
    if (r.fatal) { reason = r.fatal; break; }   // 渲染/量测本身坏了：模型修不了，去回落
    if (calls === 1) firstViolationCount = r.violations.length;
    if (r.attempt) current = r.attempt;

    // ── 干净 ──
    if (r.attempt && !r.violations.length) {
      lastClean = r.attempt;
      // ★ 上游 skill 的核心机制：首轮干净也**无条件**再打磨一轮（"take a second pass"）。
      //   已经打磨过（polished）才收工，否则再走一轮。
      if (polished) return deliver(r.attempt, calls, firstViolationCount, false);
      pending = [];
      polished = true;
      continue;
    }

    // ── 不干净（或静态审计不过 → 无可用产物）──
    // 手上已有干净图 = 打磨轮把画面弄坏了：立刻退回那张，不再烧轮次（不变式②）。
    if (lastClean) {
      console.warn('[creative] 打磨轮引入违规，退回上一版干净产物：', r.violations.map((v) => v.code).join(',') || '产物不合格');
      return deliver(lastClean, calls, firstViolationCount, true);
    }
    pending = r.violations;
    polished = true;
    reason = `${calls} 轮后仍有 ${pending.length} 条违规：${[...new Set(pending.map((v) => v.code))].join(',')}`;
  }

  // 轮次/预算用尽。手上有干净图就交（例如超时发生在打磨轮之前）。
  if (lastClean) return deliver(lastClean, calls, firstViolationCount, !!current && current !== lastClean);
  return fail({ reason, rounds: calls, violations: pending, html: current?.html });
}

function toPoster(a: Attempt, rounds: number, firstViolationCount: number, polishReverted: boolean): CanvasPoster {
  return {
    buffer: a.buffer,
    mimeType: 'image/png',
    width: a.width,
    height: a.height,
    html: a.html,
    rounds,
    violationsFixed: Math.max(0, firstViolationCount - a.violations.length),
    violations: a.violations,
    polishReverted,
    aiMarkInjected: a.aiMarkInjected,
  };
}
