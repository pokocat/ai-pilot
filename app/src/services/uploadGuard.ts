// V7-03 上传前置校验：拦截不支持的格式与超限文件，交给 ExceptionSheet('upload') 展示。
// 设计规格 §3.1：文件名匹配 /\.(exe|dmg|app|pkg)$/i 或 size > 30MB → 统一异常屏。

// 单批单文件体积上限（字节）。超过则拦截并提示「超过 30MB」。
export const MAX_UPLOAD_BYTES = 30 * 1024 * 1024; // 30MB

// 不支持的可执行/安装包扩展名（大小写不敏感）。
const BLOCKED_EXT = /\.(exe|dmg|app|pkg)$/i;

export interface UploadCheckResult {
  ok: boolean;
  kind?: 'upload';
  title?: string;
  desc?: string;
}

// 校验单个待上传文件；失败返回可直接喂给 ExceptionSheet 的 {kind,title,desc}。
export function checkUpload(file: { name?: string; size?: number }): UploadCheckResult {
  const name = file?.name || '';
  const size = file?.size || 0;
  if (BLOCKED_EXT.test(name) || size > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      kind: 'upload',
      title: '资料暂时无法上传',
      desc: `${name} 格式不支持或超过 30MB。`,
    };
  }
  return { ok: true };
}
