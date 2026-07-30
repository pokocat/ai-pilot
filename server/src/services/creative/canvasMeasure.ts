// AI 排版引擎的**量测器**：渲染完成后在页面上下文扫一遍真实布局，产出结构化违规清单。
//
// 为什么必须量而不是「相信模型」：上游 canvas-design 把「nothing overlaps, nothing falls off the page」
// 写成不可协商的底线，但那是给人看的要求。自动化管线里唯一能让这条要求生效的办法是**渲染后量像素**——
// 模型自称排好了不算，量出来在画布内才算。
//
// 每条违规都带 `selector`（DOM 路径）+ `detail`（具体数值），因为它要被逐条回喂给模型。
// 「有问题请改进」这种模糊 critique 喂回去等于没喂：模型不知道改哪一块、改到什么程度算够。
import { AI_MARK_TEXT } from './templates.js';
import { CANVAS_SPEC } from './canvasSanitize.js';

/**
 * 违规码表（回喂 critique 与 resultJson 都用这套码）：
 * · `html_rejected`        静态审计不过（不是量测出来的，但同属「这一轮不合格」的原因，统一进清单）
 * · `overflow`             画布容器 scrollWidth/Height 超出 540×720（内容被 overflow:hidden 无声裁掉）
 * · `out_of_bounds`        可见元素的包围盒越出画布（容差 1px）
 * · `margin`               可见文字元素距画布边 < 12px（贴边即廉价感；豁免见 EXEMPT_ATTR）
 * · `min_font`             可见文字字号 < 10px（印出来不可读）
 * · `text_overlap`         两个文字块包围盒重叠且交叠面积 ≥ 较小者 25%（互相压字；豁免见 DECOR_ATTR）
 * · `headline_missing`     brief 主标题不在画面文字里（模型自己改写/漏排了标题）
 * · `aimark_missing`       AI 生成标识不在画面文字里（注入后仍缺失 = 被 CSS 隐藏了）
 * · `qr_quiet_zone`        二维码可扫性：缺 data-role="qr" / 本体 < 64px / 静区 < 4px / 底色非白
 * · `placeholder_residue`  残留 {{XXX_URL}}：模型引用了一个用户没提供的素材
 */
export const VIOLATION_CODES = [
  'html_rejected', 'overflow', 'out_of_bounds', 'margin', 'min_font', 'text_overlap',
  'headline_missing', 'aimark_missing', 'qr_quiet_zone', 'placeholder_residue',
] as const;
export type ViolationCode = (typeof VIOLATION_CODES)[number];

export interface PosterViolation {
  code: ViolationCode;
  /** DOM 路径（如 `div.poster > section.head > h1`）；非 DOM 类违规用 `document` / `html`。 */
  selector: string;
  /** 具体数值/原文，直接进 critique。 */
  detail: string;
}

/** 量测阈值。改这里必须同步改提示词里的硬约束条目（两处口径必须一致）。 */
export const MEASURE_LIMITS = {
  minFontPx: 10,
  minMarginPx: 12,
  minGapPx: 8,
  qrMinPx: 64,
  qrQuietPx: 4,
  /** 越界容差：亚像素取整会让「刚好贴边」量出 540.4 这种值。 */
  boundsTolerancePx: 1,
  /** 重叠判定：交叠面积占较小块的比例阈值。 */
  overlapRatio: 0.25,
  /** 参与两两重叠比较的文字块上限（O(n²)，给个界防止病态 DOM 把渲染拖住）。 */
  maxTextNodes: 80,
} as const;

/** 带此属性的元素跳过 margin 检查（服务端注入的 AI 标识角标本来就贴边，那是设计不是缺陷）。 */
export const EXEMPT_ATTR = 'data-poster-exempt';

/**
 * 装饰性文字叠层声明（**只豁免 text_overlap**）。
 *
 * 与 EXEMPT_ATTR 的语义必须分清，两者不可互换：
 *   · `EXEMPT_ATTR`（exempt）= **服务端注入物**的边距豁免。我们自己贴上去的 AI 标识角标本来就贴边，
 *     那是设计，不是缺陷。它豁免的是 `margin`。
 *   · `DECOR_ATTR`（decor）= **模型声明**「这一层文字是图形元素，不是信息」。大字当背景纹理、层叠标注、
 *     错落压印都是正当的排印手法，量测器不该把它们判成"互相压字"。它豁免的只有 `text_overlap`。
 *
 * decor **不豁免** `out_of_bounds` / `overflow` / `margin` / `min_font`：装饰字也不许出画、不许贴边、
 * 不许小到印不出来。生产实锤（2026-07-30）是引擎三轮全卡在 text_overlap 上回落模板 —— 误伤的是叠层手法，
 * 不是越界，所以这里刻意只开一个口子。
 *
 * 判定按「自身或任一祖先带该属性」：叠层通常是一个装饰容器裹着若干文字叶子块，
 * 只认叶子上的属性会逼模型给每个字都贴一遍。
 */
export const DECOR_ATTR = 'data-poster-decor';

export interface PosterScanArg {
  width: number;
  height: number;
  headline: string;
  aiMark: string;
  /** 本轮 HTML 是否引用了二维码占位符（引用了就必须能扫）。 */
  expectQr: boolean;
  limits: typeof MEASURE_LIMITS;
  canvasClass: string;
  exemptAttr: string;
  /** 装饰性叠层属性名（豁免 text_overlap）。与 exemptAttr 一样必须经 arg 传入：扫描函数不能引用模块常量。 */
  decorAttr: string;
}

/**
 * 在**浏览器上下文**执行的扫描函数。
 *
 * ⚠️ 硬约束：**必须自包含**。它会被 puppeteer 序列化（Function.prototype.toString）后在页面里 eval，
 * 引用任何模块作用域的标识符（常量、工具函数、import）都会在浏览器里变成 ReferenceError，
 * 而那个错误只会表现为「量测失败 → 整单回落模板」，非常难查。所有输入一律经 `arg` 传进来。
 * 服务端 tsconfig 不含 dom lib，故 document/window 经 globalThis 取并就地断言类型。
 */
export const posterScanFn = (arg: PosterScanArg): { violations: PosterViolation[]; bodyText: string } => {
  type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number };
  type El = {
    tagName: string; className: unknown; children: { length: number };
    parentElement: El | null; textContent: string | null;
    getAttribute(n: string): string | null;
    getBoundingClientRect(): Rect;
    querySelectorAll(s: string): { length: number; [i: number]: El };
    querySelector(s: string): El | null;
    scrollWidth: number; scrollHeight: number;
    contains(o: El): boolean;
  };
  const g = globalThis as unknown as {
    document: {
      body: El & { innerText: string; innerHTML: string };
      querySelector(s: string): El | null;
      querySelectorAll(s: string): { length: number; [i: number]: El };
    };
    getComputedStyle(el: El): {
      fontSize: string; display: string; visibility: string; opacity: string;
      backgroundColor: string; paddingTop: string; paddingRight: string; paddingBottom: string; paddingLeft: string;
      objectFit: string;
    };
  };
  const doc = g.document;
  const out: PosterViolation[] = [];
  const push = (code: string, selector: string, detail: string): void => {
    out.push({ code: code as PosterViolation['code'], selector, detail });
  };
  const round = (n: number): number => Math.round(n * 10) / 10;

  // DOM 路径：tag + 首个 class，最多回溯 4 层（够定位，又不至于长到刷屏）。
  const pathOf = (el: El): string => {
    const parts: string[] = [];
    let cur: El | null = el;
    for (let i = 0; cur && i < 4; i++) {
      const cls = typeof cur.className === 'string' && cur.className.trim()
        ? '.' + cur.className.trim().split(/\s+/)[0]
        : '';
      parts.unshift(cur.tagName.toLowerCase() + cls);
      cur = cur.parentElement;
      if (cur && cur.tagName.toLowerCase() === 'body') break;
    }
    return parts.join(' > ');
  };

  const visible = (el: El): boolean => {
    const st = g.getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden') return false;
    if (Number(st.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0.5 && r.height > 0.5;
  };

  // 装饰性叠层：自身或任一祖先带 decorAttr 即算（叠层通常是一个装饰容器裹着若干文字叶子块）。
  // 它**只**用于跳过 text_overlap；越界/边距/最小字号照旧逐条量（装饰字也不许出画、不许小到印不出来）。
  const decorated = (el: El): boolean => {
    let cur: El | null = el;
    for (let i = 0; cur && i < 12; i++) {
      if (cur.getAttribute(arg.decorAttr) !== null) return true;
      if (cur.tagName.toLowerCase() === 'body') return false;
      cur = cur.parentElement;
    }
    return false;
  };

  const norm = (s: string): string => (s || '').replace(/\s+/g, '');

  // ① 溢出：量画布容器自身（带 overflow:hidden，量 document 量不到内部溢出）。
  // 页面可见文字一并带回：AI 引擎要对「模型自己写上画面的字」做输出侧审核（brief 文案在
  // 建单时已审过，但模型可能自创装饰性文字——那也是印在对外成品上的内容，必须过同一道闸）。
  const bodyText = (doc.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 4000);
  const canvas = doc.querySelector('.' + arg.canvasClass);
  if (!canvas) {
    push('html_rejected', 'document', '画面里找不到画布根元素 .' + arg.canvasClass);
    return { violations: out, bodyText };
  }
  const tol = arg.limits.boundsTolerancePx;
  if (canvas.scrollWidth > arg.width + tol || canvas.scrollHeight > arg.height + tol) {
    push('overflow', pathOf(canvas),
      '画布内容 ' + canvas.scrollWidth + '×' + canvas.scrollHeight + ' 超出 ' + arg.width + '×' + arg.height
      + '，超出部分已被裁掉，请压缩排版而不是缩小字号');
  }

  // ② 逐元素：越界 / 边距 / 最小字号，并顺手收集「有自己文字的叶子块」用于重叠判定。
  const all = canvas.querySelectorAll('*');
  const textBoxes: { el: El; r: Rect; text: string; decor: boolean }[] = [];
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    const tag = el.tagName.toLowerCase();
    if (r.left < -tol || r.top < -tol || r.right > arg.width + tol || r.bottom > arg.height + tol) {
      push('out_of_bounds', pathOf(el),
        '包围盒 left=' + round(r.left) + ' top=' + round(r.top) + ' right=' + round(r.right) + ' bottom=' + round(r.bottom)
        + '，越出画布 0,0,' + arg.width + ',' + arg.height);
    }
    const own = el.children.length === 0 ? (el.textContent || '').trim() : '';
    if (!own) continue;
    const st = g.getComputedStyle(el);
    const fs = parseFloat(st.fontSize) || 0;
    if (fs < arg.limits.minFontPx) {
      push('min_font', pathOf(el), '字号 ' + round(fs) + 'px 小于下限 ' + arg.limits.minFontPx + 'px：「' + own.slice(0, 16) + '」');
    }
    const exempt = el.getAttribute(arg.exemptAttr) !== null
      || norm(own).indexOf(norm(arg.aiMark)) >= 0
      || (el.parentElement ? el.parentElement.getAttribute(arg.exemptAttr) !== null : false);
    if (!exempt) {
      const gap = Math.min(r.left, r.top, arg.width - r.right, arg.height - r.bottom);
      if (gap < arg.limits.minMarginPx) {
        push('margin', pathOf(el),
          '文字距画布边仅 ' + round(gap) + 'px（下限 ' + arg.limits.minMarginPx + 'px）：「' + own.slice(0, 16) + '」');
      }
    }
    if (tag !== 'br' && textBoxes.length < arg.limits.maxTextNodes) {
      textBoxes.push({ el, r, text: own, decor: decorated(el) });
    }
  }

  // ③ 文字块两两重叠（只比叶子文字块，且跳过祖先/后代关系——嵌套本来就"重叠"）。
  // 相交双方任一被声明为装饰层（decorAttr）即跳过：那是排印手法，不是压字。
  // 两个都是普通文字块 → 照旧违规（信息层之间禁止真重叠，模型不许拿 decor 逃逸）。
  for (let i = 0; i < textBoxes.length; i++) {
    for (let j = i + 1; j < textBoxes.length; j++) {
      const a = textBoxes[i];
      const b = textBoxes[j];
      if (a.decor || b.decor) continue;
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
      const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      if (w <= 0 || h <= 0) continue;
      const inter = w * h;
      const minArea = Math.min(a.r.width * a.r.height, b.r.width * b.r.height);
      if (minArea <= 0 || inter / minArea < arg.limits.overlapRatio) continue;
      push('text_overlap', pathOf(a.el),
        '与 ' + pathOf(b.el) + ' 重叠 ' + round(inter) + 'px²（占较小块 ' + Math.round((inter / minArea) * 100) + '%）：'
        + '「' + a.text.slice(0, 10) + '」压「' + b.text.slice(0, 10) + '」');
      j = textBoxes.length; // 同一个块只报一次，避免一个错位元素刷出十条
    }
  }

  // ④ 必要文案在场（去掉所有空白再比：艺术排版会把标题拆成逐字 span，innerText 里满是换行）。
  const flat = norm(doc.body.innerText || '');
  if (arg.headline && flat.indexOf(norm(arg.headline)) < 0) {
    push('headline_missing', 'body', '主标题「' + arg.headline + '」没有原样出现在画面上（不得改写或省略）');
  }
  if (arg.aiMark && flat.indexOf(norm(arg.aiMark)) < 0) {
    push('aimark_missing', 'body', 'AI 生成标识「' + arg.aiMark + '」不在画面上（不得隐藏或改写，合规要求）');
  }

  // ⑤ 占位符残留：引用了一个不存在的素材（服务端刻意不清理，见 fillPlaceholders 注释）。
  const residue = (doc.body.innerHTML || '').match(/\{\{[A-Z_]{3,32}\}\}/);
  if (residue) {
    push('placeholder_residue', 'body', '残留未替换的占位符 ' + residue[0] + '：该素材用户没有提供，不要引用它');
  }

  // ⑥ 二维码可扫性（有二维码素材时才查）。
  if (arg.expectQr) {
    const qr = doc.querySelector('img[data-role="qr"]');
    if (!qr) {
      push('qr_quiet_zone', 'body', '二维码 <img> 必须带 data-role="qr"（否则无法验证可扫性）');
    } else {
      const r = qr.getBoundingClientRect();
      if (r.width < arg.limits.qrMinPx || r.height < arg.limits.qrMinPx) {
        push('qr_quiet_zone', pathOf(qr),
          '二维码 ' + round(r.width) + '×' + round(r.height) + 'px 小于 ' + arg.limits.qrMinPx + 'px，扫不出来');
      }
      const box = qr.parentElement;
      if (!box) {
        push('qr_quiet_zone', pathOf(qr), '二维码需要一个白底容器提供静区');
      } else {
        const st = g.getComputedStyle(box);
        const pads = [st.paddingTop, st.paddingRight, st.paddingBottom, st.paddingLeft].map((v) => parseFloat(v) || 0);
        const minPad = Math.min(pads[0], pads[1], pads[2], pads[3]);
        if (minPad < arg.limits.qrQuietPx) {
          push('qr_quiet_zone', pathOf(box),
            '二维码静区不足：容器 padding 最小 ' + round(minPad) + 'px（需 ≥' + arg.limits.qrQuietPx + 'px 且为白底）');
        }
        const m = st.backgroundColor.match(/rgba?\(([^)]+)\)/);
        const ch = m ? m[1].split(',').map((v) => parseFloat(v)) : [];
        const opaque = ch.length < 4 || ch[3] > 0.9;
        const white = ch.length >= 3 && ch[0] >= 230 && ch[1] >= 230 && ch[2] >= 230;
        if (!(opaque && white)) {
          push('qr_quiet_zone', pathOf(box), '二维码静区底色必须是白系不透明（当前 ' + st.backgroundColor + '）');
        }
      }
    }
  }

  return { violations: out, bodyText };
};

/**
 * 从扫描结果里取页面可见文字（跨进程边界，形状不对回空串——审核空串必过，
 * 但那种情况 parseScan 也会回 null、整轮按「量测失败」保守处理，不会漏审）。
 */
export function scanBodyText(scan: unknown): string {
  const raw = (scan as { bodyText?: unknown } | null)?.bodyText;
  return typeof raw === 'string' ? raw.slice(0, 4000) : '';
}

/* ───────────────── 服务端侧：入参组装与结果校验 ───────────────── */

export function posterScanArg(o: { headline: string; expectQr: boolean; canvasClass: string }): PosterScanArg {
  return {
    width: CANVAS_SPEC.width,
    height: CANVAS_SPEC.height,
    headline: o.headline,
    aiMark: AI_MARK_TEXT,
    expectQr: o.expectQr,
    limits: MEASURE_LIMITS,
    canvasClass: o.canvasClass,
    exemptAttr: EXEMPT_ATTR,
    decorAttr: DECOR_ATTR,
  };
}

/**
 * 校验从浏览器带回来的扫描结果（跨进程边界的东西一律不信）。
 * 形状不对时返回 null，让调用方按「量测失败」处理（保守回落，绝不当成"干净"）。
 */
export function parseScan(scan: unknown): PosterViolation[] | null {
  const raw = (scan as { violations?: unknown } | null)?.violations;
  if (!Array.isArray(raw)) return null;
  const codes = VIOLATION_CODES as readonly string[];
  const out: PosterViolation[] = [];
  for (const v of raw) {
    const o = v as { code?: unknown; selector?: unknown; detail?: unknown };
    if (typeof o?.code !== 'string' || !codes.includes(o.code)) continue;
    out.push({
      code: o.code as ViolationCode,
      selector: typeof o.selector === 'string' ? o.selector.slice(0, 160) : '',
      detail: typeof o.detail === 'string' ? o.detail.slice(0, 300) : '',
    });
  }
  return out;
}

/** 违规清单 → 回喂给模型的 critique（逐条列出，含 selector 与数值）。 */
export function violationsCritique(violations: PosterViolation[]): string {
  return violations
    .slice(0, 12)
    .map((v, i) => `${i + 1}. [${v.code}] ${v.selector || '-'} —— ${v.detail}`)
    .join('\n');
}

/** 违规码计数（落 resultJson 供运营排障；不落 selector/detail，那些是给模型看的）。 */
export function violationCodeCounts(violations: PosterViolation[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of violations) out[v.code] = (out[v.code] ?? 0) + 1;
  return out;
}
