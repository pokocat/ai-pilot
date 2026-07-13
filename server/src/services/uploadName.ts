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
