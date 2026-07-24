// V7-03 上传前置校验：拦截不支持的格式与超限文件，交给 ExceptionSheet('upload') 展示。
// 设计规格 §3.1：文件名匹配 /\.(exe|dmg|app|pkg)$/i 或 size > 上限 → 统一异常屏。

// 单批单文件体积上限（字节）。必须与 server/src/app.ts 的 multipart fileSize 上限（20MB）保持一致，
// 否则客户端放行的文件仍会被服务端 413 拒绝（此前误写成 30MB，与服务端 20MB 不符）。
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20MB

// 不支持的可执行/安装包扩展名（大小写不敏感）。
const BLOCKED_EXT = /\.(exe|dmg|app|pkg)$/i;

export interface UploadCheckResult {
  ok: boolean;
  kind?: 'upload';
  title?: string;
  desc?: string;
}

// 聊天图片单张体积上限（字节）。必须与 server chatImage.MAX_IMAGE_BYTES（10MB）保持一致。
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB

// 校验单张待上传图片；失败返回可直接提示的 {ok,title,desc}。
export function checkImageUpload(file: { size?: number }): UploadCheckResult {
  if ((file?.size || 0) > MAX_IMAGE_BYTES) {
    return { ok: false, title: '图片太大了', desc: '单张图片不超过 10MB，压缩后再呈上。' };
  }
  return { ok: true };
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
      desc: `${name} 格式不支持或超过 20MB。`,
    };
  }
  return { ok: true };
}
