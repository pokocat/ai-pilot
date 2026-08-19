// 文档解析：把上传的 PDF / Word(docx) / Excel(xlsx) / PowerPoint(pptx) / CSV / Markdown / 纯文本提取成可入库的纯文本。
// 重型解析在受限 Worker 中按需加载，避免用户文件占满 API 主事件循环或主堆。
// 解析失败由调用方写入 KnowledgeItem.status=failed + error，不致命。

export type DocType = 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'csv' | 'md' | 'html' | 'txt';

// 扩展名 → 类型。旧二进制 .xls 不再接受，避免继续依赖无修复版本的 xlsx 解析链。
const EXT_MAP: Record<string, DocType> = {
  pdf: 'pdf',
  docx: 'docx',
  doc: 'docx',
  xlsx: 'xlsx',
  pptx: 'pptx',
  csv: 'csv',
  md: 'md',
  markdown: 'md',
  html: 'html',
  htm: 'html',
  txt: 'txt',
  text: 'txt',
};

export const SUPPORTED_EXT = [...new Set(Object.keys(EXT_MAP))];

const LEGACY_UNSUPPORTED_EXT = new Set(['xls']);

// 提取文本上限：约 12 万字符（≈ 数百个切片），防超大文件把嵌入次数打爆。
const MAX_TEXT = 120_000;
// NUL 字节：Postgres TEXT 不允许存 0x00，PDF 解析偶发——入库前必须剔除。运行时生成，避免源码里出现裸 NUL。
const NUL = String.fromCharCode(0);

/** 由文件名扩展名（优先）或 mime 推断文档类型；无法识别返回 null。 */
export function detectDocType(fileName: string, mime?: string): DocType | null {
  const ext = (fileName.split('.').pop() ?? '').toLowerCase();
  if (LEGACY_UNSUPPORTED_EXT.has(ext)) return null;
  if (EXT_MAP[ext]) return EXT_MAP[ext];
  const m = (mime ?? '').toLowerCase();
  if (m.includes('pdf')) return 'pdf';
  if (m.includes('wordprocessingml') || m.includes('msword')) return 'docx';
  if (m.includes('spreadsheetml') || m.includes('ms-excel')) return 'xlsx';
  if (m.includes('presentationml')) return 'pptx';
  if (m.includes('csv')) return 'csv';
  if (m.includes('markdown')) return 'md';
  if (m.includes('html')) return 'html';
  if (m.startsWith('text/')) return 'txt';
  return null;
}

function clip(s: string): string {
  // 剔除 NUL 字节 + 行尾空白 + 过多空行；保留普通空格（英文分词/关键词命中需要）。
  const t = s.split(NUL).join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return t.length > MAX_TEXT ? t.slice(0, MAX_TEXT) : t;
}

function decodeHtmlEntities(value: string): string {
  const codePoint = (raw: string, radix: number) => {
    const value = Number.parseInt(raw, radix);
    return Number.isInteger(value) && value >= 0 && value <= 0x10FFFF ? String.fromCodePoint(value) : '';
  };
  return value
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_all, hex) => codePoint(hex, 16))
    .replace(/&#(\d+);/g, (_all, decimal) => codePoint(decimal, 10));
}

function htmlToContent(value: string): string {
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(value);
  const title = titleMatch ? decodeHtmlEntities(titleMatch[1].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()) : '';
  const bodyMatch = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(value);
  const body = bodyMatch ? bodyMatch[1] : value;
  const content = decodeHtmlEntities(body
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(?:script|style|noscript|template|svg|canvas)\b[^>]*>[\s\S]*?<\/(?:script|style|noscript|template|svg|canvas)>/gi, ' ')
    .replace(/<(?:br|hr)\b[^>]*\/?\s*>/gi, '\n')
    .replace(/<\/(?:p|div|section|article|header|footer|main|h[1-6]|li|tr|blockquote)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ')
    .trim());
  return !title || !content || content.startsWith(title) ? (content || title) : `${title}\n\n${content}`;
}

function markdownToContent(value: string): string {
  return value
    // front matter is presentation/configuration rather than document content.
    .replace(/^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<https?:\/\/[^>]+>/g, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^[ \t]*(?:[-+*]|\d+[.)])[ \t]+/gm, '')
    .replace(/^\s*(```|~~~)[^\n]*$/gm, '')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/^\s*[-*_]{3,}\s*$/gm, '')
    .trim();
}

/**
 * 资料库、确认预览和检索共用的内容归一化：删除原文件的表现层，只留下可读文本。
 * PDF/Word/表格解析器本身已产出文本；HTML 与 Markdown 在此去除标记、样式和脚本。
 */
export function normalizeDocumentText(value: string, type?: string | null): string {
  const source = String(value || '').trim();
  if (!source) return '';
  const isHtml = type === 'html' || /<(?:!doctype|html|head|body|title|meta|style|script)\b/i.test(source);
  return clip(isHtml ? htmlToContent(source) : (type === 'md' ? markdownToContent(source) : source));
}

async function parsePdf(buf: Buffer): Promise<string> {
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(buf), verbosity: 0 });
  try {
    const res = await parser.getText();
    return res.text ?? '';
  } finally {
    await parser.destroy().catch(() => {});
  }
}

async function parseDocx(buf: Buffer): Promise<string> {
  // mammoth 是 CJS（export =），动态 import 后取 default 或命名空间本身。
  const mod = (await import('mammoth')) as unknown as { default?: unknown };
  const mammoth = (mod.default ?? mod) as { extractRawText(o: { buffer: Buffer }): Promise<{ value: string }> };
  const { value } = await mammoth.extractRawText({ buffer: buf });
  return value ?? '';
}

async function parseXlsx(buf: Buffer): Promise<string> {
  const mod = await import('read-excel-file/node');
  const sheets = await mod.default(buf);
  if (sheets.length > 50) throw new Error('表格工作表过多（上限 50 张）');
  const parts: string[] = [];
  let cellsRead = 0;
  for (const sheet of sheets) {
    if (sheet.data.length > 20_000) throw new Error(`工作表「${sheet.sheet}」超过 20000 行`);
    const rows: string[] = [];
    for (const row of sheet.data) {
      const values = row.map((cell) => {
        cellsRead += 1;
        if (cellsRead > 200_000) throw new Error('表格单元格过多（上限 200000 个）');
        if (cell == null) return '';
        const value = cell instanceof Date ? cell.toISOString() : String(cell);
        return value.replace(/[\t\r\n]+/g, ' ').trim();
      });
      const line = values.join('\t').trim();
      if (line) rows.push(line);
    }
    if (rows.length) parts.push(`工作表：${sheet.sheet}\n${rows.join('\n')}`);
  }
  return parts.join('\n\n');
}

async function parsePptx(buf: Buffer): Promise<string> {
  // pptx 是 OOXML ZIP。先按目录数、宣告解压体积限流，再只读 slide*.xml。
  const mod = (await import('jszip')) as unknown as { default?: unknown };
  const JSZip = (mod.default ?? mod) as typeof import('jszip');
  const archive = await JSZip.loadAsync(buf, { createFolders: false });
  const entries = Object.values(archive.files);
  if (entries.length > 2_000) throw new Error('PPTX 压缩包条目过多（上限 2000 个）');
  let declaredBytes = 0;
  for (const entry of entries) {
    const size = Number((entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0);
    if (!Number.isFinite(size) || size < 0) throw new Error('PPTX 压缩包大小信息异常');
    declaredBytes += size;
    if (declaredBytes > 100 * 1024 * 1024) throw new Error('PPTX 解压后体积过大（上限 100MB）');
  }
  const slides = entries
    .filter((entry) => !entry.dir && /^ppt\/slides\/slide\d+\.xml$/i.test(entry.name))
    .sort((a, b) => Number(a.name.match(/slide(\d+)/i)?.[1] || 0) - Number(b.name.match(/slide(\d+)/i)?.[1] || 0));
  const parts: string[] = [];
  for (const [slideIndex, slide] of slides.entries()) {
    const declaredSize = Number((slide as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0);
    if (declaredSize > 2 * 1024 * 1024) throw new Error(`PPTX 第 ${slideIndex + 1} 页 XML 过大`);
    const xml = await slide.async('string');
    const lines = [...xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/gi)]
      .map((match) => decodeHtmlEntities(match[1].replace(/<[^>]+>/g, '')).trim())
      .filter(Boolean);
    if (lines.length) parts.push(`第 ${slideIndex + 1} 页\n${lines.join('\n')}`);
  }
  return parts.join('\n\n');
}

/**
 * 解析文档为纯文本。返回 { type, text }；不支持的类型或提取不到文本时抛出（调用方落 failed）。
 */
export async function parseDocumentInProcess(buf: Buffer, fileName: string, mime?: string): Promise<{ type: DocType; text: string }> {
  const type = detectDocType(fileName, mime);
  if (!type) throw new Error(`不支持的文件类型：${fileName}（支持 ${SUPPORTED_EXT.join(' / ')}）`);
  let text = '';
  switch (type) {
    case 'pdf':
      text = await parsePdf(buf);
      break;
    case 'docx':
      text = await parseDocx(buf);
      break;
    case 'xlsx':
      text = await parseXlsx(buf);
      break;
    case 'pptx':
      text = await parsePptx(buf);
      break;
    case 'csv':
    case 'md':
    case 'html':
    case 'txt':
      text = buf.toString('utf8');
      break;
  }
  text = normalizeDocumentText(text, type);
  if (!text) throw new Error('未能从文件中提取到文本（可能是扫描件/纯图片 PDF，或空文件）');
  return { type, text };
}

/**
 * 公开解析入口：每份用户文件放入独立受限 Worker。
 * 192MB 老生代 + 20s 超时是安全边界；超限只会终止该文件，不影响 API 进程。
 */
export async function parseDocument(buf: Buffer, fileName: string, mime?: string): Promise<{ type: DocType; text: string }> {
  const { Worker } = await import('node:worker_threads');
  const bytes = Uint8Array.from(buf);
  const worker = new Worker(new URL('./docParseWorker.js', import.meta.url), {
    resourceLimits: {
      maxOldGenerationSizeMb: 192,
      maxYoungGenerationSizeMb: 32,
      stackSizeMb: 4,
    },
  });
  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error('文档解析超时（上限 20 秒）'))), 20_000);
    timer.unref?.();
    worker.once('message', (message: { ok: true; value: { type: DocType; text: string } } | { ok: false; error: string }) => {
      if (message.ok) finish(() => resolve(message.value));
      else finish(() => reject(new Error(message.error)));
    });
    worker.once('error', (error) => finish(() => reject(new Error(`文档解析工作线程失败：${error.message}`))));
    worker.once('exit', (code) => {
      if (code !== 0) finish(() => reject(new Error(`文档解析工作线程异常退出（${code}）`)));
    });
    worker.postMessage({ buffer: bytes.buffer, fileName, mime }, [bytes.buffer]);
  });
}
