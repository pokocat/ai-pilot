// 报告 PDF 生成：把服务端渲染的报告 HTML（reportHtml.ts）用无头 Chromium 打成 A4 PDF，供「带走/下载」。
// 设计红线：
//   ① NODE_ENV=test 绝不拉起真浏览器——返回最小合法 PDF 桩（参考 ossConfigured/isSmsTestMode 的短路模式）。
//   ② 浏览器懒启动单例（首个真实请求才 launch），进程退出关闭；崩溃/断连自动重启（下次请求重新 launch）。
//   ③ 单并发队列（promise 链）+ 单次生成超时，避免并发把内存打爆或卡死进程。
//   ④ launch 失败（缺 Chromium/依赖库）不许 crash 进程：抛 PdfUnavailableError，路由转成明确错误码，前端提示「暂不可用」。
import { env } from '../env.js';

const PDF_TIMEOUT_MS = Number(process.env.REPORT_PDF_TIMEOUT_MS ?? 30_000);

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
  setContent(html: string, opts: { waitUntil: string; timeout: number }): Promise<void>;
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
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: PDF_TIMEOUT_MS });
    const out = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '16mm', right: '14mm', bottom: '16mm', left: '14mm' },
      timeout: PDF_TIMEOUT_MS,
    });
    return Buffer.isBuffer(out) ? out : Buffer.from(out);
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

/**
 * HTML → A4 PDF Buffer。单并发（队列串行化，避免多页并发打爆内存）+ 单次超时。
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

/** PDF 缓存对象 key（确定性，不动 DB schema）：`{prefix/}pdf/{id}.pdf`。 */
export function reportPdfKey(id: string): string {
  return `${env.ossKeyPrefix ? env.ossKeyPrefix + '/' : ''}pdf/${id}.pdf`;
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
