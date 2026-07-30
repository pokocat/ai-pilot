// 海报渲染：HTML → PNG。**不另起浏览器实例**——直接调 reportPdf.renderHtmlToPng，
// 复用那边的 puppeteer 懒启动单例 + 单并发队列 + withTimeout + isPdfTestMode 短路（见 reportPdf.ts 文件头红线）。
// 本模块只负责：拼画布参数、跑模板自检、校验输出 PNG 的真实尺寸。
// PdfUnavailableError 由 worker 直接从 reportPdf 引入（本模块曾原样转出一次，无人引用 → 已删）。
import { renderHtmlToPng, isPdfTestMode } from '../reportPdf.js';
import { CANVAS, CANVAS_CLASS, renderPosterHtml, auditPosterHtml, type TemplateInput } from './templates.js';

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
