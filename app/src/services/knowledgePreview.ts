/**
 * 确认入库前只展示内容文本，不解释原文件的 Markdown/HTML 样式。
 * 线上历史资料可能绕过了服务端归一化，因此客户端仍做一次兼容防线。
 */
const HTML_LIKE = /<(?:!doctype|html|head|body|title|meta|style|script)\b/i;

function decodeEntity(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_all, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_all, decimal) => String.fromCodePoint(parseInt(decimal, 10)));
}

function cleanHtml(value: string): string {
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(value);
  const title = titleMatch ? decodeEntity(titleMatch[1].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()) : '';
  const bodyMatch = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(value);
  const body = bodyMatch ? bodyMatch[1] : value;
  const content = decodeEntity(body
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(?:script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/(?:script|style|noscript|template|svg)>/gi, ' ')
    .replace(/<(?:br|hr)\b[^>]*\/?\s*>/gi, '\n')
    .replace(/<\/(?:p|div|section|article|header|footer|main|h[1-6]|li|tr|blockquote)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim());
  if (!title || !content || content.startsWith(title)) return content || title;
  return `${title}\n\n${content}`;
}

function cleanMarkdown(value: string): string {
  return value
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

export function displayKnowledgePreview(value: string | null | undefined, fileType?: string | null, maxChars = 1200): string {
  const source = String(value || '').trim();
  if (!source) return '';
  const readable = (fileType === 'html' || HTML_LIKE.test(source)) ? cleanHtml(source) : (fileType === 'md' ? cleanMarkdown(source) : source);
  return readable.slice(0, Math.max(0, maxChars)).trim();
}
