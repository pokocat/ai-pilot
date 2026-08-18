import { checkUpload } from '../services/uploadGuard';

export const CHAT_UPLOAD_EXT = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'pptx', 'md', 'markdown', 'txt'] as const;
export const CHAT_UPLOAD_MAX_COUNT = 9;
export const CHAT_UPLOAD_MAX_BATCH_BYTES = 60 * 1024 * 1024;

type UploadCandidate = { name?: string; size?: number };

export function chatUploadIssue(files: UploadCandidate[], currentCount: number): string {
  if (!files.length) return '';
  if (currentCount + files.length > CHAT_UPLOAD_MAX_COUNT) {
    return `一轮最多附 ${CHAT_UPLOAD_MAX_COUNT} 份资料，请先移除一些再上传。`;
  }
  for (const file of files) {
    const name = String(file.name || '未命名资料');
    const ext = (name.split('.').pop() || '').toLowerCase();
    if (!(CHAT_UPLOAD_EXT as readonly string[]).includes(ext)) {
      return `「${name}」格式暂不支持。可上传 PDF、Word、Excel、PPTX、CSV、MD 或 TXT。`;
    }
    const checked = checkUpload(file);
    if (!checked.ok) return checked.desc || checked.title || `「${name}」无法上传。`;
  }
  const totalBytes = files.reduce((sum, file) => sum + (file.size || 0), 0);
  if (totalBytes > CHAT_UPLOAD_MAX_BATCH_BYTES) {
    return `这一批共 ${formatUploadBytes(totalBytes)}，一次最多 ${formatUploadBytes(CHAT_UPLOAD_MAX_BATCH_BYTES)}，请分批上传。`;
  }
  return '';
}

export function formatUploadBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
