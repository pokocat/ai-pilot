// 报告 PDF 生成：把服务端渲染的报告 HTML（reportHtml.ts）用无头 Chromium 打成「单页长 PDF」（与网页等长、不分页，类似长截图转 PDF），供「带走/下载」。
// 设计红线：
//   ① NODE_ENV=test 绝不拉起真浏览器——返回最小合法 PDF 桩（参考 ossConfigured/isSmsTestMode 的短路模式）。
//   ② 浏览器懒启动单例（首个真实请求才 launch），进程退出关闭；崩溃/断连自动重启（下次请求重新 launch）。
//   ③ 单并发队列（promise 链）+ 单次生成超时，避免并发把内存打爆或卡死进程。
//   ④ launch 失败（缺 Chromium/依赖库）不许 crash 进程：抛 PdfUnavailableError，路由转成明确错误码，前端提示「暂不可用」。
import { env } from '../env.js';

const PDF_TIMEOUT_MS = Number(process.env.REPORT_PDF_TIMEOUT_MS ?? 30_000);

// 渲染视口宽：按手机浏览器宽渲染（2026-07-22 改，原 800px 桌面宽）——PDF 在手机上会整页缩放，
// 桌面宽转出来字太小；手机宽转出的 PDF 与手机直接看报告 H5 观感一致。420 ≈ 主流手机逻辑宽。
const RENDER_VIEWPORT_WIDTH = 420;
// 渲染视口高：量高与 vh 覆盖都以它为基准（≈手机视口高）。100vh 在此视口=900px。
const RENDER_VIEWPORT_HEIGHT = 900;
// PDF 专用覆盖样式：reportHtml 的封面用了 min-height:100vh——出 PDF 时 page 高被设成内容全高，
// PDF 排版会把 vh 按「页高」重解析，封面膨胀到整页把正文挤出去（再被 pageRanges:'1' 裁掉）。
// 故把所有依赖 vh 的元素钉成按渲染视口高换算的固定 px。⚠️ 模板（reportHtml.ts）新增/改动 vh 用法时，
// 必须 `grep -nE 'vh' reportHtml.ts` 并同步此处（当前仅 .cover 一处 min-height:100vh）。
const PDF_VH_OVERRIDE_CSS = `.cover{min-height:${RENDER_VIEWPORT_HEIGHT}px !important}`;
// 单页 PDF 高度上限：Chrome/PDF 单页最大 ~14400pt(200in)。page.pdf 以 96dpi 把 px 换算成 in，
// 故 CSS px 上限 = 200×96 = 19200；留一点余量取 19000，避免踩边界导致生成失败。超长报告 clamp 到此值并记 log。
const MAX_PDF_HEIGHT_PX = 19_000;

/** 最小合法 PDF（单空白页）——test 环境/需要占位时返回，浏览器可正常打开。 */
const STUB_PDF = Buffer.from(
  '%PDF-1.4\n' +
  '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
  '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\n' +
  'trailer<</Root 1 0 R>>\n' +
  '%%EOF\n',
  'latin1',
);

/** test 环境（或显式关闭）一律走桩：绝不 launch 真浏览器、绝不触外部。 */
export function isPdfTestMode(): boolean {
  return process.env.NODE_ENV === 'test' || process.env.REPORT_PDF_DISABLED === 'true';
}

/** PDF 能力不可用（Chromium 未安装 / launch 失败）——路由据此回 503「暂不可用」，不 crash。 */
export class PdfUnavailableError extends Error {
  readonly code = 'PDF_UNAVAILABLE';
  constructor(message: string) {
    super(message);
    this.name = 'PdfUnavailableError';
  }
}

// puppeteer 的最小结构类型（避免在无 Chromium 环境对完整类型的硬依赖，且便于 test 短路）。
interface PdfPage {
  setViewport(opts: { width: number; height: number }): Promise<void>;
  setContent(html: string, opts: { waitUntil: string; timeout: number }): Promise<void>;
  emulateMediaType(type: string): Promise<void>;
  addStyleTag(opts: { content: string }): Promise<unknown>;
  evaluate<T>(fn: () => T): Promise<T>;
  pdf(opts: Record<string, unknown>): Promise<Uint8Array | Buffer>;
  close(): Promise<void>;
}
interface PdfBrowser {
  newPage(): Promise<PdfPage>;
  close(): Promise<void>;
  on(event: string, cb: () => void): void;
}

let browserPromise: Promise<PdfBrowser> | null = null;
let queue: Promise<unknown> = Promise.resolve();

async function getBrowser(): Promise<PdfBrowser> {
  if (!browserPromise) {
    browserPromise = (async () => {
      // 动态 import：未安装 puppeteer/Chromium 的环境不会在模块加载期崩，只在真正生成时失败。
      const mod = (await import('puppeteer')) as unknown as { default: { launch(opts: unknown): Promise<PdfBrowser> } };
      const browser = await mod.default.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      });
      // 断连（崩溃/被 kill）时清空单例，下次请求重新 launch。
      browser.on('disconnected', () => { browserPromise = null; });
      return browser;
    })().catch((err) => {
      browserPromise = null; // launch 失败：不缓存坏 promise，允许后续重试。
      throw new PdfUnavailableError((err as Error).message);
    });
  }
  return browserPromise;
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时(${ms}ms)`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

async function renderOnce(html: string): Promise<Buffer> {
  const browser = await getBrowser();
  let page: PdfPage | null = null;
  try {
    page = await browser.newPage();
    await page.setViewport({ width: RENDER_VIEWPORT_WIDTH, height: RENDER_VIEWPORT_HEIGHT });
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: PDF_TIMEOUT_MS });
    // 关键：按屏幕媒体渲染（绕开 HTML 里 @media print 的 page-break 分页规则），让 PDF 与网页版观感一致。
    await page.emulateMediaType('screen');
    // 钉死 vh：必须在量高之前注入，否则封面按页高膨胀、正文被挤出第一页（见 PDF_VH_OVERRIDE_CSS 注释）。
    await page.addStyleTag({ content: PDF_VH_OVERRIDE_CSS });
    // 量内容全高（documentElement 与 body 的 scrollHeight 取大者），据此出一张与页面等长的单页 PDF。
    // 注：回调在浏览器上下文执行；服务端 tsconfig 未含 dom lib，故经 globalThis 取 document（避免编译期报错）。
    const contentHeight = await page.evaluate(() => {
      const doc = (globalThis as unknown as { document: { documentElement: { scrollHeight: number }; body: { scrollHeight: number } } }).document;
      return Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight);
    });
    // 少量余量防止末行/印章因四舍五入被裁；再 clamp 到单页高度上限（超长报告不失败，只截断并记 log）。
    let pdfHeight = Math.ceil(contentHeight) + 8;
    if (pdfHeight > MAX_PDF_HEIGHT_PX) {
      console.warn(`[reportPdf] 内容高度 ${contentHeight}px 超单页上限，clamp 到 ${MAX_PDF_HEIGHT_PX}px（尾部可能被截断）`);
      pdfHeight = MAX_PDF_HEIGHT_PX;
    }
    const out = await page.pdf({
      width: `${RENDER_VIEWPORT_WIDTH}px`,
      height: `${pdfHeight}px`,
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
      pageRanges: '1', // 万一有余量溢出，也只保留第一页，确保单页交付。
      preferCSSPageSize: false,
      timeout: PDF_TIMEOUT_MS,
    });
    return Buffer.isBuffer(out) ? out : Buffer.from(out);
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

/**
 * HTML → 单页长 PDF Buffer。单并发（队列串行化，避免多页并发打爆内存）+ 单次超时。
 * test 环境返回桩；launch 失败抛 PdfUnavailableError（调用方转 503）。
 */
export async function htmlToPdf(html: string): Promise<Buffer> {
  if (isPdfTestMode()) return STUB_PDF;
  // 挂到队列尾部串行执行；无论成败都让队列继续（.catch 吞掉，仅用于排队，不影响本次结果）。
  const run = queue.then(() => withTimeout(renderOnce(html), PDF_TIMEOUT_MS, '报告 PDF 生成'));
  queue = run.catch(() => {});
  return run;
}

/** 进程退出/服务关闭时关闭浏览器，释放 Chromium 进程。best-effort。 */
export async function closePdfBrowser(): Promise<void> {
  if (!browserPromise) return;
  const p = browserPromise;
  browserPromise = null;
  try {
    const browser = await p;
    await browser.close();
  } catch {
    // 忽略：launch 本就失败或已断连。
  }
}

/**
 * PDF 缓存对象 key（确定性，不动 DB schema）：`{prefix/}pdf/{id}-long-m.pdf`。
 * `-long-m` 后缀是版本位：手机宽单页长 PDF，与旧分页版 `pdf/{id}.pdf`、桌面宽长版 `-long.pdf` 缓存天然分离——
 * 旧对象不会被新逻辑命中（也不必清理），换算法只需改此后缀。
 */
export function reportPdfKey(id: string): string {
  return `${env.ossKeyPrefix ? env.ossKeyPrefix + '/' : ''}pdf/${id}-long-m.pdf`;
}

/**
 * 生成下载用 Content-Disposition 头值：UTF-8 文件名（filename*）+ ASCII 兜底（filename）。
 * 兜底纯 ASCII，避免中文标题在部分客户端 header 解析异常。
 */
export function pdfContentDisposition(title: string): string {
  const full = `${title}·军师参谋部.pdf`;
  const ascii = full.replace(/[^\x20-\x7E]/g, '').replace(/["\\]/g, '').trim() || 'report.pdf';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(full)}`;
}
