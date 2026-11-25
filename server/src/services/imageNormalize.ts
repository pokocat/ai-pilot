// 用户上传图片的统一归一化（2026-11-24 用户要求：格式、尺寸这类系统能处理的问题由系统处理，不拒绝用户）。
//
// 各上传入口（聊天图片、海报素材、头像、爱速拍照片/素材、声量AI 参考图）以前各自按 MIME 白名单 + 字节上限拒收，
// iPhone 的 HEIC、超过 10MB 的原图都会被 4xx 打回去让用户自己转。现在统一走这里：
//   · 入口允许的格式、且不超上限 → **原样返回，字节不变**（GIF 动图、PNG 透明等都不动）；
//   · 其它能解码的格式（HEIC/HEIF、AVIF、TIFF、SVG 除外）或超限 → 转成入口接受的格式：
//     有透明且入口收 PNG → PNG；否则白底 JPEG（q90，必要时逐级缩小长边），直到 ≤ 上限；
//     按 EXIF 方向转正，输出不带元数据（含 GPS）；GIF/多帧只取第一帧。
//   · 只有真正处理不了的才报错：不是图片/解不开（400 IMAGE_DECODE_FAILED）、原始文件超过读取上限（413 IMAGE_TOO_LARGE）。
//
// HEIC：sharp 预编译版只带 AVIF 的 libheif，没有 HEVC 解码，所以 HEIC 走 heic-decode（libheif-js wasm，
// 依赖许可 ISC + LGPL-3.0，仅服务端运行、不分发），解出 RGBA 后再交给 sharp。按需动态加载，平时不占启动时间。
import sharp, { type Sharp } from 'sharp';

export type ImageExt = 'jpg' | 'png' | 'gif' | 'webp';
export const IMAGE_EXT_MIME: Record<ImageExt, string> = { jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };

/** 原始文件读取上限：超过这个才是「处理不了」（防内存打爆）。手机原图、HEIC 都远低于它。 */
export const RAW_IMAGE_READ_MAX = 40 * 1024 * 1024;

export class ImageNormalizeError extends Error {
  constructor(message: string, readonly statusCode: number, readonly code: string) { super(message); }
}

export interface NormalizedImage {
  buf: Buffer;
  ext: ImageExt;
  mime: string;
  /** true = 系统做过转换或压缩（字节与上传的不同）。 */
  converted: boolean;
}

const SHARP_FORMAT_EXT: Record<string, ImageExt> = { jpeg: 'jpg', png: 'png', gif: 'gif', webp: 'webp' };

/** ISO BMFF 的 HEIC/HEIF 品牌（不含 avif，avif 由 sharp 自己解）。 */
export function isHeicLike(buf: Buffer): boolean {
  if (buf.length < 12 || buf.toString('latin1', 4, 8) !== 'ftyp') return false;
  const brand = buf.toString('latin1', 8, 12).replace(/\0/g, ' ').trim().toLowerCase();
  return ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1'].includes(brand);
}

async function decodeHeic(buf: Buffer): Promise<Sharp> {
  // heic-decode 是无类型声明的 CJS 包：经 createRequire 加载，按需（首次遇到 HEIC 才载入 wasm）。
  const { createRequire } = await import('node:module');
  const decode = createRequire(import.meta.url)('heic-decode') as (o: { buffer: Buffer }) => Promise<{ width: number; height: number; data: Uint8ClampedArray }>;
  const image = await decode({ buffer: buf });
  return sharp(Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength), {
    raw: { width: image.width, height: image.height, channels: 4 },
  });
}

/** 读出第一帧的 sharp 实例与元信息；解不开抛 ImageNormalizeError。 */
async function open(buf: Buffer): Promise<{ make: () => Promise<Sharp>; format: string | undefined; hasAlpha: boolean; width: number; height: number }> {
  try {
    const meta = await sharp(buf, { pages: 1, failOn: 'none' }).metadata();
    // sharp 能读出 HEIC 的文件头（宽高），但预编译版解不了 HEVC 像素：heif 且不是 AV1（AVIF）的交给下面的 heic-decode。
    const sharpCannotDecode = meta.format === 'heif' && meta.compression !== 'av1';
    // SVG 能被 sharp 渲染，但它是可执行矢量文档，不当作用户照片接收。
    if (meta.format && meta.format !== 'svg' && !sharpCannotDecode && meta.width && meta.height) {
      return {
        make: async () => sharp(buf, { pages: 1, failOn: 'none' }).rotate(),
        format: meta.format, hasAlpha: !!meta.hasAlpha, width: meta.width, height: meta.height,
      };
    }
  } catch { /* 交给 HEIC 兜底 */ }
  if (isHeicLike(buf)) {
    try {
      const probe = await decodeHeic(buf);
      const meta = await probe.metadata();
      // libheif 已按 irot/imir 转正，raw 像素不带 EXIF，不再 rotate()。
      return { make: () => decodeHeic(buf), format: 'heif', hasAlpha: false, width: meta.width ?? 0, height: meta.height ?? 0 };
    } catch { /* 落到下面统一报错 */ }
  }
  // 沿用既有对外错误码（客户端已按 IMAGE_DECODE_FAILED 处理）；不再提示「另存为 JPG/PNG」这类让用户自己处理的话。
  throw new ImageNormalizeError('这个文件不是能识别的图片，请换一张', 400, 'IMAGE_DECODE_FAILED');
}

/**
 * 把一张用户上传的图片变成入口能收的样子。`accept` 是入口下游能处理的格式（至少含 jpg）。
 * 不需要动的原样返回；需要动的转换/压缩到 `maxBytes` 以内。
 */
export async function normalizeUploadedImage(
  input: Buffer,
  opts: { accept: readonly ImageExt[]; maxBytes: number },
): Promise<NormalizedImage> {
  if (!input?.length) throw new ImageNormalizeError('空文件', 400, 'IMAGE_EMPTY');
  if (input.length > RAW_IMAGE_READ_MAX) {
    throw new ImageNormalizeError(`图片超过 ${Math.round(RAW_IMAGE_READ_MAX / 1024 / 1024)}MB，无法处理`, 413, 'IMAGE_TOO_LARGE');
  }
  const accept = new Set<ImageExt>(opts.accept.includes('jpg') ? opts.accept : [...opts.accept, 'jpg']);
  const source = await open(input);
  const sourceExt = source.format ? SHARP_FORMAT_EXT[source.format] : undefined;
  if (sourceExt && accept.has(sourceExt) && input.length <= opts.maxBytes) {
    return { buf: input, ext: sourceExt, mime: IMAGE_EXT_MIME[sourceExt], converted: false };
  }
  if (source.hasAlpha && accept.has('png')) {
    const png = await (await source.make()).png({ compressionLevel: 9 }).toBuffer();
    if (png.length <= opts.maxBytes) return { buf: png, ext: 'png', mime: 'image/png', converted: true };
  }
  const longest = Math.max(source.width, source.height) || 4096;
  // 档位从原尺寸 q90 逐级降到 512px q70；真实照片在前两三档就能落进上限，后面几档只为兜住极端噪点图。
  const steps: [number, number][] = [[longest, 90], [6000, 85], [4096, 85], [3072, 85], [2048, 82], [1536, 80], [1024, 78], [768, 74], [512, 70]];
  for (const [side, quality] of steps) {
    if (side > longest && side !== longest) continue;
    const jpg = await (await source.make())
      .resize({ width: side, height: side, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();
    if (jpg.length <= opts.maxBytes) return { buf: jpg, ext: 'jpg', mime: 'image/jpeg', converted: true };
  }
  throw new ImageNormalizeError('图片无法压缩到可用大小', 413, 'IMAGE_TOO_LARGE');
}

/** 文件名换成实际格式的扩展名（`门头.heic` → `门头.jpg`）；没有文件名时用 fallback。 */
export function renameForExt(fileName: string | null | undefined, ext: ImageExt, fallback = '图片'): string {
  const base = String(fileName || '').trim().replace(/\.[A-Za-z0-9]{1,5}$/, '') || fallback;
  return `${base}.${ext}`;
}
