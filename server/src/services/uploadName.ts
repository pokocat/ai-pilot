// 上传展示名安全化：仅作用于「展示名」（title/fileName）。
// 原件对象存储 key 用 randomUUID（不含用户名），天然免注入/重名——本函数不参与 key 生成。
// 规则：去路径分隔符与控制字符、折叠空白、过长截断（尽量保留扩展名）。
export function sanitizeUploadName(name: string | null | undefined): string {
  if (!name) return '';
  const s = String(name)
    .replace(/[/\\]/g, ' ')                  // 去路径分隔符
    .replace(/[\u0000-\u001f\u007f]/g, '')   // 去控制字符
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length <= 120) return s;
  const dot = s.lastIndexOf('.');
  const ext = dot > 0 && s.length - dot <= 12 ? s.slice(dot) : '';
  return s.slice(0, 120 - ext.length).trim() + ext;
}

export function isTemporaryUploadName(name: string | null | undefined): boolean {
  const clean = sanitizeUploadName(name);
  return !clean || /^(tmp_|wxfile:|file:|blob:|undefined$|null$)/i.test(clean);
}

export function isPlaceholderUploadName(name: string | null | undefined): boolean {
  const clean = sanitizeUploadName(name);
  return isTemporaryUploadName(clean)
    || /^(上传资料(?:\s*\d+)?|未命名(?:文件|资料)?|待识别资料)$/i.test(clean)
    || /^(founder|company|finance|content|growth|customer|proof|unknown)资料$/i.test(clean);
}

export function bestUploadName(...names: Array<string | null | undefined>): string {
  return names.map((name) => sanitizeUploadName(name)).find((name) => !isPlaceholderUploadName(name)) || '';
}

export function inferUploadNameFromContent(text: string, fileType: string | null | undefined): string {
  const firstLine = String(text || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
  const heading = firstLine.match(/^#{1,3}\s+(.+)$/)?.[1]?.trim() || '';
  if (!heading || heading.length > 80) return '';
  const clean = heading.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const ext = String(fileType || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return ext && !clean.toLowerCase().endsWith(`.${ext}`) ? `${clean}.${ext}` : clean;
}

/** 旧版微信上传可能把临时路径名写进数据库；历史临时名只在展示层换成可读兜底。 */
export function displayUploadName(name: string | null | undefined, fallback = '待识别资料'): string {
  const clean = sanitizeUploadName(name);
  if (isPlaceholderUploadName(clean)) return fallback;
  return clean;
}
