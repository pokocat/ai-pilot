const MAX_DOCUMENT_UPLOAD_BYTES = 20 * 1024 * 1024;
const SUPPORTED_DOCUMENT_EXT = ['pdf', 'doc', 'docx', 'xlsx', 'csv', 'pptx', 'md', 'markdown', 'html', 'htm', 'txt'];

function fileExtension(name) {
  return String(name || '').split('.').pop().toLowerCase();
}

function formatFileSize(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))}KB`;
  return `${(value / 1024 / 1024).toFixed(1)}MB`;
}

function validateDocumentUpload(file) {
  const name = String((file && file.name) || '这份资料');
  const ext = fileExtension(name);
  if (ext === 'ppt') {
    return { ok: false, name, message: '暂不支持旧版 .ppt，请在 PowerPoint 中另存为 .pptx 后上传。' };
  }
  if (!SUPPORTED_DOCUMENT_EXT.includes(ext)) {
    return { ok: false, name, message: `不支持 .${ext || '未知'} 格式，请上传 PDF、Word、Excel、PPTX、Markdown 或 TXT。` };
  }
  const size = Math.max(0, Number(file && file.size) || 0);
  if (size > MAX_DOCUMENT_UPLOAD_BYTES) {
    return { ok: false, name, message: `文件为 ${formatFileSize(size)}，单个文件上限 20MB。请压缩或拆分后重试。` };
  }
  return { ok: true, name, ext };
}

module.exports = { MAX_DOCUMENT_UPLOAD_BYTES, SUPPORTED_DOCUMENT_EXT, fileExtension, formatFileSize, validateDocumentUpload };
