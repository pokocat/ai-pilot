// 海报渲染：HTML → PNG。**不另起浏览器实例**——直接调 reportPdf.renderHtmlToPng，
// 复用那边的 puppeteer 懒启动单例 + 单并发队列 + withTimeout + isPdfTestMode 短路（见 reportPdf.ts 文件头红线）。
// 本模块只负责：拼画布参数、跑模板自检、校验输出 PNG 的真实尺寸。
// PdfUnavailableError 由 worker 直接从 reportPdf 引入（本模块曾原样转出一次，无人引用 → 已删）。
import { renderHtmlToPng, isPdfTestMode } from '../reportPdf.js';
import { env } from '../../env.js';
import { CANVAS, CANVAS_CLASS, renderPosterHtml, auditPosterHtml, type TemplateInput } from './templates.js';
import { posterScanFn, posterScanArg, parseScan, scanBodyText, type PosterViolation } from './canvasMeasure.js';

export class PosterRenderError extends Error {
  readonly code = 'POSTER_RENDER_FAILED';
  constructor(message: string) {
    super(message);
    this.name = 'PosterRenderError';
  }
}

/** 从 PNG 头部读 width/height（IHDR 固定在 8 字节签名 + 4 长度 + 4 类型之后）。非 PNG 返回 null。 */
export function readPngSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24) return null;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < sig.length; i++) if (buf[i] !== sig[i]) return null;
  if (buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** 渲染产物。刻意**不回传 html**：那份字符串没有任何读取方，却是整条链路里最大的一块内存。 */
export interface PosterRenderResult {
  buffer: Buffer;
  mimeType: 'image/png';
  width: number;
  height: number;
}

/**
 * 渲染一张海报。
 * @param timeoutMs 单次渲染超时（任务级超时由 worker 另行把关）。
 * @throws PosterRenderError 模板自检不过 / 输出尺寸不符；PdfUnavailableError 浏览器不可用（worker 据此退款）。
 */
export async function renderPoster(input: TemplateInput, opts: { timeoutMs?: number } = {}): Promise<PosterRenderResult> {
  // 拼 HTML 的异常也要收成 PosterRenderError（例：老任务带着已下线的 templateKey）。
  // 否则它会以裸 TypeError 冒到 worker，落成 errorCode='INTERNAL' —— 用户看到的文案一样，
  // 但运营在任务台上分不清「模板问题」和「代码 bug」，排障要靠翻日志。
  let html: string;
  try {
    html = renderPosterHtml(input);
  } catch (e) {
    throw new PosterRenderError(`版式渲染失败：${(e as Error).message}`);
  }
  const audit = auditPosterHtml(html);
  if (!audit.ok) throw new PosterRenderError(`模板自检未通过：${audit.issues.join('；')}`);

  const expected = { width: CANVAS.width * CANVAS.scale, height: CANVAS.height * CANVAS.scale };
  const { buffer, scrollWidth, scrollHeight } = await renderHtmlToPng(html, {
    width: CANVAS.width,
    height: CANVAS.height,
    deviceScaleFactor: CANVAS.scale,
    // 量画布容器本身（.poster 带 overflow:hidden，量 document 量不到内部溢出）。
    measureSelector: `.${CANVAS_CLASS}`,
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
  });
  if (!buffer?.length) throw new PosterRenderError('渲染返回空内容');

  // 溢出闸（「文字不越界」的自动化保证，不靠目视）：固定画布只截视口，文档一旦更高，
  // 超出部分就被无声裁掉——最常见的形态正是最后一条卖点被切掉半个笔画。宁可整单失败退款，
  // 也不把裁字的图发给用户。留 1px 容差吸收亚像素取整。
  if (scrollHeight > CANVAS.height + 1 || scrollWidth > CANVAS.width + 1) {
    throw new PosterRenderError(
      `内容超出画布（文档 ${scrollWidth}×${scrollHeight}，画布 ${CANVAS.width}×${CANVAS.height}）——文案过长或模板布局需收紧`,
    );
  }

  // test 模式拿到的是 1×1 桩 PNG，尺寸校验只在真实渲染路径生效（否则整个测试链路都得跑 Chromium）。
  if (isPdfTestMode()) {
    return { buffer, mimeType: 'image/png', width: expected.width, height: expected.height };
  }
  const size = readPngSize(buffer);
  if (!size) throw new PosterRenderError('渲染产物不是合法 PNG');
  if (size.width !== expected.width || size.height !== expected.height) {
    throw new PosterRenderError(`渲染尺寸不符：期望 ${expected.width}×${expected.height}，实际 ${size.width}×${size.height}`);
  }
  return { buffer, mimeType: 'image/png', width: size.width, height: size.height };
}

/* ───────────────── AI 排版引擎的渲染 + 量测 ───────────────── */

/**
 * 请求拦截白名单：`data:` 恒放行（素材一律内联字节），另外放行 OSS 域，
 * 因为 `creativeAssetUrl()` 在配了 OSS 的生产环境返回的是签名 URL。
 * 未配 OSS（测试/本地）时列表只剩空串被过滤掉 → 等于只放行 data:，正是我们要的最小面。
 */
function allowedAssetPrefixes(): string[] {
  const host = env.ossBucket && env.ossEndpoint ? `https://${env.ossBucket}.${env.ossEndpoint}` : '';
  return [host].filter(Boolean);
}

export interface CanvasRenderResult extends PosterRenderResult {
  violations: PosterViolation[];
  /** 页面可见文字（量测时顺带收集）：AI 引擎交付前要对模型自创的画面文字做输出侧审核。 */
  bodyText: string;
}

/**
 * 渲染**模型生成的**整页 HTML，并在同一帧上量测。与 renderPoster 的区别只在于「输入不可信」：
 *   · `javaScriptEnabled:false`：页面内联脚本不执行（静态审计已拒 `<script>`，这里是第二道）；
 *   · `allowUrlPrefixes`：只放行 data: 与 OSS 签名域，其余外链在网络层 abort；
 *   · `domScan`：拿回结构化违规清单（越界/边距/字号/重叠/文案在场/二维码/占位符残留）。
 *
 * 量测结果拿不到（形状不对 / test 桩路径）时**不当成干净**：返回 `violations: null` 的语义交给
 * 调用方——canvasEngine 会把它当作「无法验证」并按配置决定是否回落。这里用空数组 + `measured` 标志区分。
 */
export async function renderCanvasPoster(
  html: string,
  o: { headline: string; expectQr: boolean; timeoutMs?: number; allowInTestMode?: boolean },
): Promise<{ rendered: CanvasRenderResult; measured: boolean }> {
  const expected = { width: CANVAS.width * CANVAS.scale, height: CANVAS.height * CANVAS.scale };
  const res = await renderHtmlToPng(html, {
    width: CANVAS.width,
    height: CANVAS.height,
    deviceScaleFactor: CANVAS.scale,
    measureSelector: `.${CANVAS_CLASS}`,
    javaScriptEnabled: false,
    allowUrlPrefixes: allowedAssetPrefixes(),
    domScan: { fn: posterScanFn as unknown as (arg: never) => unknown, arg: posterScanArg({ headline: o.headline, expectQr: o.expectQr, canvasClass: CANVAS_CLASS }) },
    ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
    ...(o.allowInTestMode ? { allowInTestMode: true } : {}),
  });
  if (!res.buffer?.length) throw new PosterRenderError('渲染返回空内容');
  const violations = parseScan(res.scan);

  // 尺寸校验：test 桩是 1×1，只有真实渲染路径才校验（与 renderPoster 同口径）。
  const stubbed = isPdfTestMode() && !o.allowInTestMode;
  let width = expected.width;
  let height = expected.height;
  if (!stubbed) {
    const size = readPngSize(res.buffer);
    if (!size) throw new PosterRenderError('渲染产物不是合法 PNG');
    if (size.width !== expected.width || size.height !== expected.height) {
      throw new PosterRenderError(`渲染尺寸不符：期望 ${expected.width}×${expected.height}，实际 ${size.width}×${size.height}`);
    }
    width = size.width;
    height = size.height;
  }
  return {
    rendered: { buffer: res.buffer, mimeType: 'image/png', width, height, violations: violations ?? [], bodyText: scanBodyText(res.scan) },
    measured: violations !== null,
  };
}
