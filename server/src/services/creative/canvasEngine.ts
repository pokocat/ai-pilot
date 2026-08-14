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
//     → 仍不干净 → 返回 ok:false，由 worker 按 tier 决定模板回落或 premium 失败退款
//
// 三条不变式（改本文件前先读）：
//   ① **HTML 相关的 LLM 调用最多 3 次**（MAX_HTML_CALLS）。每轮都要跑一次真实渲染，成本与时延都在这里；
//      整段还压着一个 180s 预算，超了就用手上最好的结果或回落。
//   ② **打磨轮不许让画面变差**。若首轮干净、打磨轮反而量出违规，直接退回首轮那张干净图
//      （polishReverted），绝不为了"执行了打磨"而交一张更差的图。
//   ③ 失败一律**返回**而不是抛：调用方要靠返回值按 tier 决定回落或退款；抛异常会丢失可诊断原因。
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
import { critiqueDirective, requestVisualCritique, type VisualCritique } from './visualCritique.js';
import type { NormalizedPosterBrief } from './schema.js';
import type { PosterManifesto } from './manifesto.js';
import { directionFor } from './directions.js';

/**
 * HTML 相关的 LLM 调用上限（生成 1 + 打磨/修复 2）。
 *
 * 曾在 2026-08-12 提到 4，当天预发实测后改回 3：开思考 + 上万 token 产出 + 打磨轮带图，
 * 单轮挂钟就要 1–2.5 分钟，第 4 轮**在整段预算里根本排不下**。留着它就是一个不会兑现的承诺
 * （与当初删掉 `_MAX_CONCURRENCY` 同一条教训：旋钮写得出来、跑起来永远到不了）。
 */
export const MAX_HTML_CALLS = 3;
/**
 * 视觉评审（看图）调用上限。它是**顾问**不是闸门，所以单独计数、单独设顶：
 * 评审失灵最多退化成「没有评审」的老行为，不占 HTML 轮次，也不该把预算烧在看图上。
 * 2 次 = 首版看一次 + 打磨后再看一次（第二次拿到「达标」就提前收工，省掉最后一轮 HTML）。
 */
export const MAX_VISION_CALLS = 2;
/**
 * 整段预算（含全部 LLM 往返与渲染）。超时即用手上最好的结果，没有就回落模板。
 *
 * ★ 这个数受 `worker.STALE_RUNNING_MS` 约束，不是随手写的：`runAiEngine` 的 `budget()` 从**它自己开始**算，
 *   所以这一个数同时罩住宣言 + 主视觉生图 + 排版全程；加上上传与结算，一单的挂钟时间要稳稳落在
 *   sweep 判卡死的阈值内，否则同一单被跑两遍、出两张资产。
 *
 *   180s →（08-12 上午）360s →（08-12 下午）480s。两次上调都是被实测顶上来的：
 *   · 单轮 HTML 开了思考挂钟就要 1–4 分钟（预发实测，端点负载不同波动很大）；
 *   · 高级档还要先花 30–40s 让 Seedream 出主视觉。
 *   最坏情况：宣言 40s + 主视觉 40s + 排版 480s + 上传 20s ≈ 580s，落在 `STALE_RUNNING_MS`（15min）内。
 */
export const AI_ENGINE_BUDGET_MS = 480_000;
/**
 * 单次渲染的下限超时。渲染超时取「后台配的 timeoutMs」与「本引擎剩余预算」的较小值——
 * 否则运营把渲染超时配到 480s 时，一次渲染就能把整段预算连同 sweep 的 10 分钟一起吃穿。
 * 给 15s 下限是不让剩余预算见底时传一个 0/负数进去（那等于每次渲染必超时）。
 */
const MIN_RENDER_TIMEOUT_MS = 15_000;
/**
 * 单次 HTML 生成的挂钟上限，**覆盖全局 `OPENAI_TIMEOUT_MS`（60s）**。
 *
 * 2026-08-12 预发实测（`model=dj-claude-4.6-opus`、`thinkingMode=adaptive`）：创作轮勉强压线，
 * 打磨轮因为输入多了「上一版 HTML + 成品图」直接撞 60s → `completeText` 返回 null →
 * 引擎判「打磨轮模型调用失败」→ 整单回落模板。**画质最高的那条路径被一个与画质无关的全局旋钮掐死**，
 * 而且现象是「悄悄变成模板图」，不看 `aiEngineError` 根本发现不了。
 *
 * 150s → 240s（同日下午）：影像档的创作轮实测直接顶穿 150s。单轮耗时随端点负载波动很大，
 * 给窄了的代价是「一次抖动 = 一单失败」，而高级档失败是要退款的。
 */
const MAX_LLM_TIMEOUT_MS = 240_000;
/**
 * 起新一轮的最低剩余预算。低于它就不再开新一轮——**不是为了省钱，是为了不越过 deadline**：
 * 单次 LLM 调用的超时被 `min(MAX_LLM_TIMEOUT_MS, 剩余预算)` 夹住，只要开轮时剩余 ≥ 这个数，
 * 这一轮就一定在 deadline 之前收尾，整单也就不会漂到 sweep 的 10 分钟以外。
 */
const MIN_LLM_TIMEOUT_MS = 60_000;
/** 看图评审的挂钟上限：它只写一行判定 + 几条意见，产出很短，不需要按创作轮那样给。 */
const CRITIQUE_TIMEOUT_MS = 60_000;
/**
 * 单次 HTML 生成的 **净正文** 预算（思考预算由 gateway 的 chatMaxTokens 另行叠加 +7000）。
 *
 * 6000 → 12000 → 6000。调大的动机是「一页有密度的 HTML 写不下」，但实测产物只有 11–13k **字符**
 * （≈3.5–4k token），6000 从来没有截断过它 —— 动机本身站不住，所以收回来。
 *
 * ⚠️ 别把这一格与「单轮变慢」联系起来：2026-08-12 预发那次单轮 >240s **不是**这个预算造成的。
 * 实测证据是「同一份提示词只改 affinityKey 就从 224s 超时变成 41.5s 成功」——慢在 LLM 端点池的
 * 车道排队上（`rawText` 的 affinityKey = sha1(system+user)，稳定的提示词会被永久粘在同一个端点上，
 * 那条车道饱和时这类请求就一直排队到放弃）。调这里的数解决不了那个问题。
 */
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
    // 这一段是**负向清单**，位置在硬约束之前、创作手法之后：它管的不是「合不合规」而是「像不像自动生成的」。
    // 列的每一条都是机器量不出来、却一眼就露怯的廉价特征——量测器管不到的地方，只能靠提示词与看图打磨。
    '【别让它看起来像自动生成的（逐条自查）】',
    '- 不要把每块信息都塞进圆角卡片或描边容器里：卡里套卡是"自动生成感"最强的特征。',
    '  层级靠字号、位置与留白建立，不靠容器和分割线。',
    '- 不要均匀铺满：画面要有明确的疏密对比，敢让整片区域什么都不放。留白是构图，不是没画完。',
    '- 不要处处居中：除非居中本身就是这张的构图立场，否则立一条明确的对齐轴，让元素成组咬住它。',
    '- 同一个元素不要叠三种强调手法（又加粗又换色又加底又描边）。要强调，只挑一种，做到底。',
    '- 慎用阴影：要么不用，要么极轻。靠 box-shadow 把一堆卡片"浮起来"是廉价感的头号来源。',
    '- 纯平色块容易显廉价：需要时给表面一点材质（极细噪点、微渐变、纸纹、网点），但克制到几乎看不见。',
    '- 数字与英文用同一套字体里合适的字重，不要让它们比中文更抢眼；小字标注宁可再小一点、再淡一点。',
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
    // 2026-08-12 三方出图对比里抓到的真缺陷：没给二维码素材时，两版引擎都自己用 SVG/方块
    // 画了一个"像二维码"的图案。它扫出来什么都没有——一张印着假码的对外物料是信任事故，
    // 而量测器的 qr_quiet_zone 只认 <img data-role="qr">，手画的方块阵它一条都拦不住。
    '   **没有给你二维码素材时，绝对不许自己画一个像二维码的东西**（方块阵、定位角、点阵码都不行）：',
    '   那种图案扫出来是空的，印在对外物料上就是欺骗。此时行动号召只用文字表达。',
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
      // 2026-08-12 预发实测：模型守住了"铺底"这一条，却在版面中间又插了一张同源的白边小图
      //   （占位符被引用了第二次），看上去像一张贴歪的拍立得。约束只说了"必须铺底"，没说"只能用一次"。
      `   **整份文档里 ${CANVAS_PLACEHOLDER.visual} 只能出现一次**，就是上面那个铺底层。`,
      '   不许在版面里再放一张同源的小图（缩略图、相框、卡片、圆角小方块都不行）——',
      '   同一张图出现两次会让画面看起来像贴错了素材，而不是一个设计决定。',
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

function rebuildDirective(reason: string): string {
  return [
    '',
    '【本轮任务：机会式重构（只此一次）】',
    '上一版已经通过全部机器量测，但艺术总监判断它缺少清晰的视觉主角，局部打磨不足以解决。',
    `具体原因：${reason}`,
    '允许重组构图、尺度关系与视觉母题，但文案原字、素材、创作方向、AI 标识及全部硬约束不变。',
    '只建立一个视觉主角，不要用增加卡片、图标和装饰数量来冒充“更丰富”。',
    '若本轮引入任何机器违规，系统会直接退回上一版干净产物，不再给额外轮次补救。',
  ].join('\n');
}

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
    `创作方向：${directionFor(brief.directionKey).name}`,
    `【正向 Art Direction】${directionFor(brief.directionKey).artDirection}`,
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
  o: {
    maxChars?: number; maxTokens?: number; temperature?: number;
    /** 打磨轮把上一版渲染出的成品 PNG 一起发给模型（让它先看图再改代码）。 */
    images?: { mediaType: string; base64: string }[];
    /** 是否开思考。海报这条链**恒传 false**，理由见调用处那段实测记录。 */
    allowThinking?: boolean;
    /** 单次调用挂钟上限，覆盖全局 OPENAI_TIMEOUT_MS（整页 HTML 跑不进那 60s）。 */
    timeoutMs?: number;
  },
) => Promise<string | null>;

export interface CanvasRenderFn {
  (html: string, o: { headline: string; expectQr: boolean; timeoutMs?: number }): Promise<{
    buffer: Buffer; width: number; height: number; violations: PosterViolation[]; measured: boolean;
    /** 页面可见文字（交付前输出侧审核用）。测试桩可省略，按空串处理。 */
    bodyText?: string;
  }>;
}

export type CritiqueFn = (
  input: { png: Buffer; brief: NormalizedPosterBrief; manifesto: PosterManifesto; photo?: PosterStyle | null },
) => Promise<VisualCritique | null>;

export interface CanvasEngineDeps {
  complete?: CompleteTextFn;
  render?: CanvasRenderFn;
  now?: () => number;
  /**
   * 视觉评审（看图提意见）。**顾问不是闸门**：返回 null 一律按「本轮没有评审」继续走，
   * 绝不因为评审不可用而让一单失败。缺省用 requestVisualCritique（走同一个 complete 带图发出去）。
   * 单测默认不注入 → 走缺省实现 → complete 桩收到带 images 的调用，测试可据此区分两类调用。
   */
  critique?: CritiqueFn;
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
  /** HTML 相关的 LLM 调用轮数（1=只生成，2=生成+一轮打磨/修复，以此类推）。恒 ≥2：打磨是无条件的。 */
  rounds: number;
  /** 发生过的视觉评审次数（看图轮）。0 = 评审不可用，本单退化成纯量测闭环。 */
  visualCritiques: number;
  /** 最后一次评审判定为「达标」→ 提前收工，而不是被轮次或预算用尽逼停。 */
  critiquePassed: boolean;
  /** 首轮量出、最终被修掉的违规条数。 */
  violationsFixed: number;
  /** 最终残留违规（成功时必为空数组）。 */
  violations: PosterViolation[];
  /** 打磨轮反而量出违规 → 已退回上一张干净图。 */
  polishReverted: boolean;
  /** 艺术总监曾在既有三轮预算内触发一次构图重构。 */
  rebuildTriggered: boolean;
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
  /** 渲染用的最终 HTML（占位符已换成真实素材字节）。落资产 metadata 的是这一份。 */
  html: string;
  /**
   * **回喂给模型看的那一份**：模型自己写的源码，占位符还是 `{{VISUAL_URL}}` 的形态。
   *
   * 为什么必须分开：影像档的主视觉是一段约 200KB 的 base64 data URI，`fillPlaceholders` 之后
   * `html` 会膨胀到 20 万字符以上，而打磨轮的 user prompt 有 60k 上限 —— 回喂 `html` 的实际效果是
   * 「模型收到一份从 base64 中间被切断的残片」，既读不懂又把额度全烧在一串它自己写不出的字节上。
   * 2026-08-12 预发实测到的就是这一格（usr=209720）。回喂源码则既短又正是它下一轮要改的东西。
   */
  sourceHtml: string;
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
      html, sourceHtml: clean.html, buffer: out.buffer, width: out.width, height: out.height,
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
  const remaining = (): number => deadline - now();
  const outOfTime = (): boolean => remaining() <= 0;
  /** 单次 LLM 调用的挂钟上限：被剩余预算夹住，保证任何一轮都不会跨过 deadline。 */
  const llmTimeout = (): number => Math.min(MAX_LLM_TIMEOUT_MS, Math.max(0, remaining()));
  /**
   * 本次渲染允许用多久 = min(后台配的渲染超时, 本引擎剩余预算)，下限 MIN_RENDER_TIMEOUT_MS。
   * 没有这一层的话，运营把渲染超时配到上限 480s 时，单次渲染就能越过本引擎的整段预算，
   * 进而把一单的挂钟时间顶到 worker 判卡死的 10 分钟以外 → 重新入队、跑两遍、出两张资产。
   */
  const renderTimeout = (): number => {
    const left = deadline - now();
    const configured = input.timeoutMs ?? left;
    return Math.max(MIN_RENDER_TIMEOUT_MS, Math.min(configured, left));
  };

  let visionCalls = 0;
  let critiquePassed = false;
  let rebuildTriggered = false;

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
    return {
      ok: true,
      poster: toPoster(a, {
        rounds, firstViolationCount: fvc, polishReverted: reverted,
        visualCritiques: visionCalls, critiquePassed, rebuildTriggered,
      }),
    };
  };

  const photo = input.photoStyle ?? null;
  const system = canvasSystemPrompt(photo ?? undefined);
  const user = canvasUserPrompt({ ...input, photo });
  /** 缺省实现走同一个 complete（带图发出去），测试可注入桩绕开真实模型。 */
  const critique: CritiqueFn = deps.critique
    ?? ((i) => requestVisualCritique(i, (s, u, o) => complete(s, u, {
      ...o,
      timeoutMs: Math.min(CRITIQUE_TIMEOUT_MS, Math.max(0, remaining())),
    })));

  let calls = 0;
  let firstViolationCount = 0;
  let firstProductClean = false;         // 首轮产物就机器量测干净（机会式重构的准入条件之一，见下面 wantsRebuild）
  let lastClean: Attempt | null = null;
  let current: Attempt | null = null;
  let pending: PosterViolation[] = [];   // 待回喂的违规（机器闸门：空 = 上一轮量测干净）
  let notes: string[] = [];              // 待落实的视觉评审意见（人眼顾问：空 = 没有意见可落实）
  let rebuildReason = '';                // 非空 = 下一轮允许重组构图（最多一次，仍占既有 HTML 轮次）
  let polished = false;                   // 是否已经发生过一次 refine（打磨或修复都算 second pass）
  let reason = '未知原因';

  while (calls < MAX_HTML_CALLS) {
    // 剩余预算不足以完整跑完一轮就别开这一轮：开了也只会在半路被自己的超时掐断，
    // 白烧一次调用还什么都拿不到（手上若已有干净图，循环外会照常把它交出去）。
    if (remaining() < MIN_LLM_TIMEOUT_MS) {
      reason = `AI 引擎剩余预算不足一轮（总预算 ${input.budgetMs ?? AI_ENGINE_BUDGET_MS}ms）`;
      break;
    }
    // 第一次是「创作」，之后按手上有什么决定打磨的依据，优先级：
    //   机器违规 > 艺术总监意见 > 无条件打磨（上游那句 "take a second pass" 的兜底形态）。
    // 违规优先是因为它是**交付闸门**：带着违规的版面再美也交不出去，先把它修干净再谈审美。
    const sys = calls === 0
      ? system
      : `${system}\n${pending.length
        ? fixDirective(pending)
        : rebuildReason
          ? rebuildDirective(rebuildReason)
          : notes.length
            ? critiqueDirective(notes)
            : POLISH_DIRECTIVE}`;
    // 本轮一旦消费即清空；即使模型失败，也不允许在后续重复触发第二次重构。
    rebuildReason = '';
    // 静态审计不过的那一轮没有可用产物（current 仍是上一轮的），此时不附「上一版 HTML」，
    // 让模型按 critique 重写一份完整文档，而不是去改一份它看不到的东西。
    // 回喂的是**模型自己写的源码**（占位符形态），不是渲染用的那份 —— 后者内联了约 200KB 的
    // 主视觉 base64，会把 60k 的 user 额度撑爆并被拦腰截断（见 Attempt.sourceHtml 的注释）。
    const usr = calls === 0 || !current
      ? user
      : `${user}\n\n【上一版 HTML（在它的基础上改，不要从零重写）】\n${current.sourceHtml}`;
    // ★ 打磨轮把**上一版渲染出来的成品图**一起发过去：这是本引擎与上游 canvas-design 对齐的关键一步——
    //   让作者看见自己写的代码画成了什么样，而不是对着一份自己写的 HTML 凭空想象。
    //   静态审计不过的那轮没有产物可看（current 为空或是更早那版），此时只发文本。
    const images = calls > 0 && current
      ? [{ mediaType: 'image/png', base64: current.buffer.toString('base64') }]
      : null;

    calls++;
    const raw = await complete(sys, usr, {
      maxChars: 60_000,
      maxTokens: HTML_MAX_TOKENS,
      temperature: 0.7,
      // ★ 这一轮**不开思考**（2026-08-12 预发实测后定的，别再打开）：
      //   · 开着时线上是 adaptive 档，思考量由模型自己决定，而 `max_tokens` 管的是「思考 + 正文」总量。
      //     实测出现过「接口成功返回、正文是空串」——224s 之后拿回一个空字符串，引擎判「模型不可用」
      //     整单回落模板，全程无异常无日志。gateway 已按 chatMaxTokens 给正文留了 +7000 的净额，
      //     但 adaptive 的思考照样能越过这个预留，**失败模式消不掉，只能压低概率**。
      //   · 而它并没有换来质量：同一段提示词实测 思考关 42.6s→9416 字符 / 思考开 37.6s→7724 字符，
      //     时间相当、产出反而更少。这一轮的设计决策本来就已经由宣言那一轮承载了。
      //   要再试思考，正确做法是把 thinkingMode 显式覆盖成 enabled + 固定 budget（让预留真的生效），
      //   而不是把 adaptive 直接放进来。
      allowThinking: false,
      // 覆盖全局 60s：整页 HTML 跑不进那个数（见 MAX_LLM_TIMEOUT_MS 的实测记录）。
      timeoutMs: llmTimeout(),
      ...(images ? { images } : {}),
    });
    if (!raw) {
      // 无 live provider（mock/测试）或调用失败。首轮就没有 → 整条 AI 路径走不通。
      reason = calls === 1 ? '模型不可用（未配置真实 provider 或调用失败）' : '打磨轮模型调用失败';
      break;
    }

    const r = await attemptOnce(raw, { ...input, timeoutMs: renderTimeout() }, render);
    if (r.fatal) { reason = r.fatal; break; }   // 渲染/量测本身坏了：模型修不了，去回落
    if (calls === 1) firstViolationCount = r.violations.length;
    if (r.attempt) current = r.attempt;

    // ── 干净 ──
    if (r.attempt && !r.violations.length) {
      lastClean = r.attempt;
      if (calls === 1) firstProductClean = true;
      // 量测干净只说明「没排坏」，不说明「好看」。这里请艺术总监看一眼真图再决定收不收工。
      let verdict: VisualCritique | null = null;
      // 剩余预算连一次评审都放不下时就别看了：评审的价值全在「看完还能再改一轮」，
      // 改不动了才去看，纯属白花一次调用。
      if (visionCalls < MAX_VISION_CALLS && remaining() > CRITIQUE_TIMEOUT_MS) {
        visionCalls++;
        try {
          verdict = await critique({ png: r.attempt.buffer, brief: input.brief, manifesto: input.manifesto, photo });
        } catch (e) {
          // 顾问失灵不许弄挂一单。缺省实现自己已经吞了异常，这层是给注入实现兜底的——
          // 「评审是顾问不是闸门」这条不变式必须与具体实现无关地成立。
          console.warn('[creative] 视觉评审异常，按未评审继续：', (e as Error).message);
          verdict = null;
        }
      }
      // 机会式重构的准入条件（四条缺一不可，每条都是花钱买过的教训）：
      // ① 艺术总监明确判断「缺少视觉主角」，且本单还没重构过（重构最多一次）；
      // ② **第一版产物就机器干净**：走过修复轮才干净，说明这版是「刚被扳回合规」的，
      //    再整页推翻等于把刚修好的东西丢掉重赌一次，而且模型这一单的手感已经证明不稳；
      // ③ 重构后**至少还剩一轮补救**：重构一旦引入违规就直接回退（rebuildDirective 里也是这么写的），
      //    落在最后一轮就是白烧一整轮且无处补救；
      // ④ 时间还够。
      // 重构占用既有 HTML 轮次；若引入违规，下面 lastClean 分支会退回本张干净图。
      const wantsRebuild = !!verdict?.needsRebuild && !rebuildTriggered
        && firstProductClean && calls + 1 < MAX_HTML_CALLS && !outOfTime();
      if (wantsRebuild) {
        rebuildTriggered = true;
        rebuildReason = verdict!.rebuildReason;
        pending = [];
        // notes 在这里**故意丢弃**：这一轮要整页重组构图与尺度关系，而 notes 是针对**即将被推翻的那一版**
        // 写的局部意见（「副标题字号压到主标题 1/3」「右下角留白塌了」）——那些位置马上就不存在了。
        // 更要命的是两套指令方向相反：critiqueDirective 明写「不要推翻构图重排」，
        // 与 rebuildDirective 的「允许重组构图」直接打架，拼在一起等于让模型自己挑一条听。
        // 重构轮只带 rebuildReason 这一条主线；重构后的新版本会被重新评审，届时的 notes 才是针对新画面的。
        notes = [];
        polished = true;
        continue;
      }
      // 艺术总监还拿得出**具体局部意见** = 这一版还没到头。
      const stillWants = !!verdict && !verdict.pass && verdict.notes.length > 0;
      // ★ 无条件的第二遍仍然是底线（上游 "take a second pass"）：**评审判定不能让打磨轮被跳过**。
      //   首轮就判达标也照打一轮——真让它在首轮收工，等于用一个宽松的评委把现有行为往回退。
      //   收工条件因此是「已经打磨过 且（达标 或 评审不可用）」：
      //   · 达标      → 见好就收，把剩下的轮次省下来（多打磨一轮的期望收益是负的，同不变式②的教训）；
      //   · 评审不可用 → 退回**老行为**（打磨一轮即交），保证「评审挂了 = 回到 2026-07-29 的表现」。
      if (polished && !stillWants) {
        critiquePassed = !!verdict?.pass;
        return deliver(r.attempt, calls, firstViolationCount, false);
      }
      // 轮次或预算已经不够再改一轮了：手上这张是干净的，直接交，别把它耗没了。
      if (calls >= MAX_HTML_CALLS || outOfTime()) return deliver(r.attempt, calls, firstViolationCount, false);
      pending = [];
      notes = verdict?.notes ?? [];
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
    notes = [];   // 违规优先：先把版面修合规，审美意见等下一轮干净了再谈（也免得两套指令打架）
    polished = true;
    reason = `${calls} 轮后仍有 ${pending.length} 条违规：${[...new Set(pending.map((v) => v.code))].join(',')}`;
  }

  // 轮次/预算用尽。手上有干净图就交（例如超时发生在打磨轮之前）。
  if (lastClean) return deliver(lastClean, calls, firstViolationCount, !!current && current !== lastClean);
  return fail({ reason, rounds: calls, violations: pending, html: current?.html });
}

function toPoster(a: Attempt, o: {
  rounds: number;
  firstViolationCount: number;
  polishReverted: boolean;
  visualCritiques: number;
  critiquePassed: boolean;
  rebuildTriggered: boolean;
}): CanvasPoster {
  return {
    buffer: a.buffer,
    mimeType: 'image/png',
    width: a.width,
    height: a.height,
    html: a.html,
    rounds: o.rounds,
    visualCritiques: o.visualCritiques,
    critiquePassed: o.critiquePassed,
    violationsFixed: Math.max(0, o.firstViolationCount - a.violations.length),
    violations: a.violations,
    polishReverted: o.polishReverted,
    rebuildTriggered: o.rebuildTriggered,
    aiMarkInjected: a.aiMarkInjected,
  };
}
