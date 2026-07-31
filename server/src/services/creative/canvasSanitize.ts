// AI 排版引擎的静态审计：**LLM 写的 HTML 是不可信输入**，和用户上传的文件一个级别。
//
// 三条设计红线：
//   ① **只拒不洗**。命中禁用形态一律整份打回（连同原因回喂给模型重写），绝不做「悄悄删掉 <script>
//      再渲染」这种清洗——清洗既改变了模型的构图意图（删掉一块布局可能整版塌掉），又给绕过留缝隙
//      （`<scr<script>ipt>` 这类嵌套骗过一次替换就活了）。拒绝是可回喂的，清洗是不可观测的。
//   ② **白名单思路**：允许什么写清楚（head 只放行 meta charset/viewport + title + style；
//      图片只放行占位符与 data:image），其余一律视为违规——而不是维护一张永远追不全的黑名单。
//   ③ 静态审计只是第一道闸。渲染那一层还有 `javaScriptEnabled:false` + 请求拦截白名单
//      （见 reportPdf.hardenPage）：静态检查可能被没想到的写法绕过，网络层与脚本开关不会。
//
// 与 templates.auditPosterHtml 的分工：那个函数审的是**我们自己**拼的模板（只需确认 AI 标识在位、
// 没混进外链），这里审的是**模型生成的整页文档**，强度完全不同，故不复用。
import { AI_MARK_TEXT, CANVAS, CANVAS_CLASS } from './templates.js';

/**
 * 资产占位符：模型只能这么引用用户素材（真实 URL/字节由服务端在渲染前替换进去）。
 *
 * `visual` 是影像主导路线（photo route）的全幅主视觉——由生图模型产出、服务端存成 kind='visual'
 * 资产后注入。它与 `portrait` 互斥：photo 路线的门禁就是「用户上传了本人照片 → 不走 photo」
 * （见 posterRoute.ts 的注释），所以这两个占位符在同一张海报上不会同时可用。
 */
export const CANVAS_PLACEHOLDER = {
  portrait: '{{PORTRAIT_URL}}',
  logo: '{{LOGO_URL}}',
  qr: '{{QR_URL}}',
  visual: '{{VISUAL_URL}}',
} as const;

/** 占位符通用形态（量测器据此判「残留」：模型引用了一个没提供的素材）。 */
export const PLACEHOLDER_RE = /\{\{[A-Z_]{3,32}\}\}/;

/**
 * HTML 体积上限。一页 540×720 的手写 HTML/CSS 正常在 6–20KB；这里给到 160KB 是为了容纳
 * 模型内联的 data URI（少见但合法）。超过即拒：巨大的产物既是模型跑飞的信号，也会拖垮渲染。
 */
const MAX_HTML_BYTES = 160_000;

/** 禁用标签（出现即整份打回）。`meta` 单独处理：charset/viewport 是合法且必要的。 */
const BANNED_TAGS = [
  'script', 'iframe', 'object', 'embed', 'link', 'base', 'form', 'input', 'textarea', 'select',
  'button', 'audio', 'video', 'source', 'track', 'applet', 'frame', 'frameset', 'portal', 'noscript',
] as const;

export type SanitizeResult =
  | { ok: true; html: string }
  | { ok: false; issues: string[] };

/**
 * 剥掉模型爱加的 Markdown 围栏与前后废话，只留 HTML 文档本体。
 * 兼容 ```html / ``` / 前置一句「好的，这是…」的形态；找不到 `<!DOCTYPE` 就原样返回（由校验去拒）。
 */
export function stripHtmlFence(raw: string): string {
  let s = String(raw ?? '').trim();
  // ```html … ``` → 取围栏内内容
  const fence = s.match(/```(?:html)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) s = fence[1].trim();
  const at = s.search(/<!DOCTYPE\s+html/i);
  if (at > 0) s = s.slice(at);
  const end = s.toLowerCase().lastIndexOf('</html>');
  if (end >= 0) s = s.slice(0, end + '</html>'.length);
  return s.trim();
}

/**
 * 收集一段 HTML 里所有「资源地址」出现的位置：src / href / srcset / xlink:href / CSS url(...)。
 *
 * 注意属性名后面钉着 `\s*=`：`data-poster-exempt="1"` / `data-poster-decor="1"` 这类量测器约定的
 * data-* 属性因此**不会**被误当成 `data=` / `poster=` 资源地址（'data' 后面是 '-'，匹配不上）。
 * 量测器约定的属性是白名单外的自由文本，本审计刻意不管它们——它管的是能发起网络请求的形态。
 */
function resourceUrls(html: string): { where: string; value: string }[] {
  const out: { where: string; value: string }[] = [];
  const attr = /\b(src|href|srcset|xlink:href|poster|data|formaction)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (let m = attr.exec(html); m; m = attr.exec(html)) {
    out.push({ where: m[1].toLowerCase(), value: (m[3] ?? m[4] ?? m[5] ?? '').trim() });
  }
  const cssUrl = /url\(\s*("([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi;
  for (let m = cssUrl.exec(html); m; m = cssUrl.exec(html)) {
    out.push({ where: 'css-url', value: (m[2] ?? m[3] ?? m[4] ?? '').trim() });
  }
  return out;
}

/** 地址是否允许：占位符 / data:image / 页内锚点（svg 引用）。其余（含 http、协议相对、相对路径）全拒。 */
function allowedUrl(value: string): boolean {
  const v = value.trim();
  if (!v) return true;                              // src="" 只是难看，不是安全问题（量测器会抓到空图）
  if (PLACEHOLDER_RE.test(v)) return true;
  if (/^data:image\/(png|jpe?g|gif|webp|svg\+xml);/i.test(v)) return true;
  if (v.startsWith('#')) return true;
  return false;
}

/**
 * 静态审计。通过则回**已剥围栏**的 HTML；不通过回一串可直接回喂给模型的中文原因。
 * 注意每条原因都要具体到「哪个形态」——模糊的「有问题请改进」喂回去等于没喂。
 */
export function sanitizeCanvasHtml(raw: string): SanitizeResult {
  const html = stripHtmlFence(raw);
  const issues: string[] = [];

  if (!html) return { ok: false, issues: ['产出为空'] };
  if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) {
    issues.push(`HTML 体积 ${Math.round(Buffer.byteLength(html, 'utf8') / 1024)}KB 超过上限 ${MAX_HTML_BYTES / 1024}KB`);
  }
  if (!/^<!DOCTYPE\s+html/i.test(html)) issues.push('必须以 <!DOCTYPE html> 开头（只输出 HTML 源码，不要解释文字或 Markdown 围栏）');
  if (!/<\/html>\s*$/i.test(html)) issues.push('文档不完整：缺少结尾 </html>（可能被截断，请压缩 CSS 后重写完整一页）');
  if (!new RegExp(`class\\s*=\\s*["'][^"']*\\b${CANVAS_CLASS}\\b`, 'i').test(html)) {
    issues.push(`缺少画布根元素 <div class="${CANVAS_CLASS}">（量测器与截图都以它为准）`);
  }

  for (const tag of BANNED_TAGS) {
    if (new RegExp(`<\\s*${tag}\\b`, 'i').test(html)) issues.push(`禁止使用 <${tag}>`);
  }
  // meta 白名单：charset 与 viewport 放行，其它（尤其 http-equiv refresh / CSP）一律拒。
  const metas = html.match(/<\s*meta\b[^>]*>/gi) ?? [];
  for (const m of metas) {
    if (/\bcharset\s*=/i.test(m)) continue;
    if (/name\s*=\s*["']?viewport/i.test(m)) continue;
    issues.push(`<meta> 只允许 charset 与 viewport：${m.slice(0, 60)}`);
  }
  if (/\son[a-z]{2,20}\s*=/i.test(html)) issues.push('禁止任何 on* 事件属性（onload/onerror/onclick…）');
  if (/(javascript|vbscript)\s*:/i.test(html)) issues.push('禁止 javascript:/vbscript: 伪协议');
  if (/data\s*:\s*text\/html/i.test(html)) issues.push('禁止 data:text/html');
  if (/@import\b/i.test(html)) issues.push('禁止 CSS @import（字体只用给定字体栈，不下载）');
  if (/(behavior\s*:|-moz-binding)/i.test(html)) issues.push('禁止 behavior/-moz-binding');
  if (/<\s*svg\b[^>]*>/i.test(html) && /<\s*(foreignObject|use\s+[^>]*href\s*=\s*["']?https?:)/i.test(html)) {
    issues.push('SVG 内禁止 foreignObject 与外链 use');
  }

  for (const u of resourceUrls(html)) {
    if (allowedUrl(u.value)) continue;
    issues.push(`禁止外链/相对资源（${u.where}="${u.value.slice(0, 60)}"）：图片只能用给定占位符或 data:image`);
  }

  // 同一类问题只回喂一条，避免 critique 被 20 条重复占满（模型会去修最靠前的那几条）。
  const uniq = [...new Set(issues)];
  return uniq.length ? { ok: false, issues: uniq.slice(0, 10) } : { ok: true, html };
}

/* ───────────────── 占位符替换 ───────────────── */

export interface CanvasAssetUrls {
  portraitUrl?: string | null;
  logoUrl?: string | null;
  qrUrl?: string | null;
  /** 影像主导路线的全幅主视觉（生图模型产出，无文字）。graphic 路线恒空。 */
  visualUrl?: string | null;
}

/** 素材清单（喂给提示词：告诉模型**只有这些**占位符可用）。 */
export function availablePlaceholders(assets: CanvasAssetUrls): string[] {
  const out: string[] = [];
  // 主视觉排最前：photo 路线里它是画布底层，模型该先看到它。
  if (assets.visualUrl) out.push(CANVAS_PLACEHOLDER.visual);
  if (assets.portraitUrl) out.push(CANVAS_PLACEHOLDER.portrait);
  if (assets.logoUrl) out.push(CANVAS_PLACEHOLDER.logo);
  if (assets.qrUrl) out.push(CANVAS_PLACEHOLDER.qr);
  return out;
}

/**
 * 把占位符换成真实地址（data URI 或 OSS 签名 URL）。
 *
 * **没提供的素材刻意不清理**：占位符原样留在 DOM 里，由量测器报 `placeholder_residue` 违规并回喂
 * 「你引用了一个不存在的素材」。反过来（悄悄删掉那个 <img>）会留下一个空洞的构图，
 * 而模型永远不知道自己引用错了 —— 错误必须可见才可能被修。
 */
export function fillPlaceholders(html: string, assets: CanvasAssetUrls): { html: string; filled: string[]; residue: boolean } {
  const filled: string[] = [];
  let out = html;
  const put = (token: string, url?: string | null): void => {
    if (!url || !out.includes(token)) return;
    // data URI / 签名 URL 都不含引号，直接整串替换即可（含引号的地址会被上面的静态审计拒掉）。
    out = out.split(token).join(url);
    filled.push(token);
  };
  put(CANVAS_PLACEHOLDER.visual, assets.visualUrl);
  put(CANVAS_PLACEHOLDER.portrait, assets.portraitUrl);
  put(CANVAS_PLACEHOLDER.logo, assets.logoUrl);
  put(CANVAS_PLACEHOLDER.qr, assets.qrUrl);
  return { html: out, filled, residue: PLACEHOLDER_RE.test(out) };
}

/* ───────────────── AI 生成标识兜底注入 ───────────────── */

/**
 * AI 标识缺失时注入一条固定 overlay（《人工智能生成合成内容标识办法》2025-09-01 施行，不可关闭）。
 *
 * 为什么是「注入」而不是「回喂违规」：合规标识是**服务端的义务**，不能取决于模型这一轮听不听话。
 * 回喂只会多烧一轮 token，且仍有不听话的可能。注入是确定性的。
 * `data-poster-exempt` 让量测器跳过它的边距检查（角标本来就贴边，是设计而非缺陷）。
 */
export function ensureAiMark(html: string): { html: string; injected: boolean } {
  if (html.includes(AI_MARK_TEXT)) return { html, injected: false };
  const overlay =
    `<div data-poster-exempt="1" style="position:absolute;left:0;right:0;bottom:0;height:22px;`
    + `display:flex;align-items:center;justify-content:center;font-size:10px;letter-spacing:.14em;`
    + `color:rgba(255,255,255,.86);background:rgba(0,0,0,.42);`
    + `font-family:'Noto Sans SC','Noto Sans CJK SC','PingFang SC',sans-serif">${AI_MARK_TEXT}</div>`;
  // 插在画布根元素的结束标签前：那是唯一能保证「在画布内、且不被 overflow 裁掉」的位置。
  // 找不到根元素闭合点时退到 </body>（此时静态审计已经报过缺根元素，这里只求标识别丢）。
  const at = html.lastIndexOf('</div>');
  if (at > 0) return { html: `${html.slice(0, at)}${overlay}${html.slice(at)}`, injected: true };
  const body = html.toLowerCase().lastIndexOf('</body>');
  if (body > 0) return { html: `${html.slice(0, body)}${overlay}${html.slice(body)}`, injected: true };
  return { html: html + overlay, injected: true };
}

/** 画布尺寸（提示词与量测器共用一份，避免两处漂移）。 */
export const CANVAS_SPEC = { width: CANVAS.width, height: CANVAS.height, scale: CANVAS.scale } as const;
