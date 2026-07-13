// 微信临时路径和历史通用占位名不是用户看到的源文件名，不能作为资料标题或引用标签。
export function sourceUploadName(name: string | null | undefined): string | undefined {
  const clean = String(name || '').trim();
  if (!clean || /^(tmp_|wxfile:|file:|blob:|undefined$|null$)/i.test(clean)) return undefined;
  if (/^(上传资料(?:\s*\d+)?|未命名(?:文件|资料)?|待识别资料)$/i.test(clean)) return undefined;
  if (/^(founder|company|finance|content|growth|customer|proof|unknown)资料$/i.test(clean)) return undefined;
  return clean;
}

export function displaySourceName(
  ...names: Array<string | null | undefined>
): string {
  return names.map(sourceUploadName).find(Boolean) || '待识别资料';
}
