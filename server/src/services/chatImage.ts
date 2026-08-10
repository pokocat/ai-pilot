// 聊天图片：上传原件存 OSS（私有）→ 建 sourceType='image' 的 KnowledgeItem（不解析/不切片/不嵌入）→
// 发问时按 image ref 读回原件转 base64，交给多模态 provider「阅图」。
//
// 与文档管线的关键差异：图片不进检索（无 chunk）、不进资料库列表/@引用候选（sourceType 过滤）、
// 直接 status='ready'。租户隔离严格：一切读取都带 tenantId。
//
// 存储抽象：生产走 OSS 私有对象；测试/未配 OSS 时落进程内内存暂存（够单测读回 base64，绝不触达真实 OSS）。

import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { env } from '../env.js';
import { prisma } from '../db.js';
import { ossConfigured, ossPutBuffer, ossGetBuffer } from './ossUpload.js';
import type { MessageRef } from '../llm/schema.js';

// 允许的图片 MIME → 扩展名（与 Anthropic/OpenAI 视觉支持口径一致）。
export const IMAGE_MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

// 扩展名 → 供 provider 用的标准 media type（Anthropic image source.media_type / OpenAI data URL 前缀）。
const EXT_MEDIA_TYPE: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
};

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 单张 ≤10MB
export const MAX_ATTACHMENTS_PER_MESSAGE = 9;    // 图片与其它引用共用 9 份总上限
export const MAX_IMAGES_PER_MESSAGE = 9;         // 单条消息至多 9 张；运行时权威值由 /me 下发
export const MAX_IMAGES_PER_BATCH = 4;           // 任一上游视觉请求至多 4 张
export const MAX_IMAGE_BATCH_BYTES = 12 * 1024 * 1024;
export const MAX_IMAGE_MESSAGE_BYTES = 24 * 1024 * 1024;
export const MAX_INFERENCE_IMAGE_EDGE = 2048;

export const ATTACHMENT_CAPABILITIES = {
  maxAttachmentsPerMessage: MAX_ATTACHMENTS_PER_MESSAGE,
  maxImagesPerMessage: MAX_IMAGES_PER_MESSAGE,
  maxImagesPerBatch: MAX_IMAGES_PER_BATCH,
  maxImageBytes: MAX_IMAGE_BYTES,
  maxImageBatchBytes: MAX_IMAGE_BATCH_BYTES,
  maxImageMessageBytes: MAX_IMAGE_MESSAGE_BYTES,
} as const;

export interface ResolvedChatImage {
  index: number; // 本轮图片序号，1-based，供最终回答引用「图 3」
  refId: string;
  mediaType: string;
  base64: string;
  bytes: number;
}

export interface ResolvedImageRefs {
  requestedCount: number;
  images: ResolvedChatImage[];
  skipped: { index: number; refId: string; reason: string }[];
  totalBytes: number;
}

/**
 * 建单前用上传元数据做廉价总量闸门，避免明知超限仍落用户消息、预留额度再让 Worker 失败。
 * Worker 读取原件后还会按真实字节复核；缺失项留给阅图阶段生成明确 notices。
 */
export async function validateImageReferenceBudget(tenantId: string, refs: MessageRef[] | undefined): Promise<void> {
  const imageRefs = (refs ?? []).filter((ref) => ref.kind === 'image');
  if (!imageRefs.length) return;
  const rows = await prisma.knowledgeItem.findMany({
    where: { tenantId, sourceType: 'image', id: { in: imageRefs.map((ref) => ref.id) } },
    select: { id: true, fileSize: true, inferenceFileSize: true },
  });
  const sizes = new Map(rows.map((row) => [row.id, Math.max(0, Number(row.inferenceFileSize ?? row.fileSize) || 0)]));
  const totalBytes = imageRefs.reduce((sum, ref) => sum + (sizes.get(ref.id) ?? 0), 0);
  if (totalBytes > MAX_IMAGE_MESSAGE_BYTES) {
    throw Object.assign(new Error(`这组图片合计超过 ${Math.floor(MAX_IMAGE_MESSAGE_BYTES / 1024 / 1024)}MB，请压缩或分两次发送`), {
      statusCode: 413, code: 'IMAGE_MESSAGE_TOO_LARGE', limitBytes: MAX_IMAGE_MESSAGE_BYTES,
    });
  }
}

/** MIME → 扩展名；不在白名单返回 null。 */
export function imageExtFromMime(mime: string | undefined): string | null {
  return (mime && IMAGE_MIME_EXT[mime.toLowerCase()]) || null;
}

/** 扩展名 → media type（provider 用）；未知回退 image/jpeg。 */
export function mediaTypeFromExt(ext: string | null | undefined): string {
  return (ext && EXT_MEDIA_TYPE[ext.toLowerCase()]) || 'image/jpeg';
}

// 测试/未配 OSS 环境的进程内暂存（键 = OSS 对象 key）。生产一律走 OSS，不进此表。
const memStore = new Map<string, Buffer>();

/** 存一张图（OSS 私有 or 内存暂存）。返回对象 key。 */
async function putChatImage(key: string, buf: Buffer, contentType: string): Promise<void> {
  if (ossConfigured()) {
    await ossPutBuffer(key, buf, contentType);
    return;
  }
  memStore.set(key, buf);
}

/** 读一张图的原始字节（OSS or 内存暂存）；不存在返回 null。 */
async function getChatImage(key: string): Promise<Buffer | null> {
  if (ossConfigured()) return ossGetBuffer(key);
  return memStore.get(key) ?? null;
}

interface InferenceImageCopy {
  buf: Buffer;
  mediaType: string;
  ext: string;
  resized: boolean;
}

/**
 * 生成视觉模型专用副本。小图不重复编码；超出 2048px 时按原格式压缩，GIF 固定转 WebP 首帧。
 * 原图始终保留，模型只读取这里返回的受控副本。
 */
export async function createInferenceImageCopy(buf: Buffer, mediaType: string): Promise<InferenceImageCopy> {
  try {
    const source = sharp(buf, { animated: false, failOn: 'error' });
    const metadata = await source.metadata();
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    if (!width || !height) throw new Error('无法识别图片尺寸');
    if (Math.max(width, height) <= MAX_INFERENCE_IMAGE_EDGE) {
      const ext = imageExtFromMime(mediaType) ?? 'jpg';
      return { buf, mediaType: mediaTypeFromExt(ext), ext, resized: false };
    }

    let pipeline = sharp(buf, { animated: false, failOn: 'error' })
      .rotate()
      .resize({
        width: MAX_INFERENCE_IMAGE_EDGE,
        height: MAX_INFERENCE_IMAGE_EDGE,
        fit: 'inside',
        withoutEnlargement: true,
      });
    const normalized = mediaType.toLowerCase();
    if (normalized === 'image/png') {
      pipeline = pipeline.png({ compressionLevel: 9, adaptiveFiltering: true });
      return { buf: await pipeline.toBuffer(), mediaType: 'image/png', ext: 'png', resized: true };
    }
    if (normalized === 'image/webp' || normalized === 'image/gif') {
      pipeline = pipeline.webp({ quality: 88 });
      return { buf: await pipeline.toBuffer(), mediaType: 'image/webp', ext: 'webp', resized: true };
    }
    pipeline = pipeline.jpeg({ quality: 88, mozjpeg: true });
    return { buf: await pipeline.toBuffer(), mediaType: 'image/jpeg', ext: 'jpg', resized: true };
  } catch (cause) {
    throw Object.assign(new Error('图片内容无法识别，请重新选择或先另存为 JPG/PNG'), {
      statusCode: 400,
      code: 'IMAGE_DECODE_FAILED',
      cause,
    });
  }
}

/** OSS 是否已就绪（供路由判断生产未配 → 503）。 */
export function chatImageStorageReady(): boolean {
  return ossConfigured();
}

/**
 * 摄取一张聊天图片：存原件（私有）+ 建 sourceType='image' 的 KnowledgeItem（不解析/不切片/不嵌入）。
 * 返回 { id }。stage 默认 'confirmed'（字节计入配额），但 sourceType='image' 使其不计入文档份数、不进检索/列表。
 */
export async function ingestChatImage(opts: {
  tenantId: string;
  userId: string;
  projectId?: string | null;
  mime: string;
  buf: Buffer;
  fileName?: string | null;
}): Promise<{ id: string }> {
  const ext = imageExtFromMime(opts.mime) ?? 'jpg';
  const key = `${env.ossKeyPrefix ? env.ossKeyPrefix + '/' : ''}chatimg/${opts.tenantId}/${randomUUID()}.${ext}`;
  const inference = await createInferenceImageCopy(opts.buf, opts.mime);
  const inferenceKey = inference.resized ? `${key}.inference.${inference.ext}` : key;
  await putChatImage(key, opts.buf, opts.mime);
  if (inference.resized) await putChatImage(inferenceKey, inference.buf, inference.mediaType);
  const item = await prisma.knowledgeItem.create({
    data: {
      tenantId: opts.tenantId,
      userId: opts.userId,
      projectId: opts.projectId ?? null,
      kind: 'document',
      title: opts.fileName || '图片',
      text: '',
      sourceType: 'image',
      status: 'ready',
      fileName: opts.fileName || `图片.${ext}`,
      fileType: ext,
      fileSize: opts.buf.length,
      fileKey: key,
      inferenceFileKey: inferenceKey,
      inferenceFileType: inference.ext,
      inferenceFileSize: inference.buf.length,
      tagsJson: [],
    },
  });
  return { id: item.id };
}

/**
 * 把本轮 image 引用解析为带 1-based 序号的推理副本。失败项必须进入 skipped，禁止静默截断。
 */
export async function resolveImageRefsDetailed(
  tenantId: string,
  refs: MessageRef[] | undefined,
): Promise<ResolvedImageRefs> {
  const imageRefs = (refs ?? []).filter((r) => r.kind === 'image');
  if (!imageRefs.length) return { requestedCount: 0, images: [], skipped: [], totalBytes: 0 };
  if (imageRefs.length > MAX_IMAGES_PER_MESSAGE) {
    throw Object.assign(new Error(`一条消息最多带 ${MAX_IMAGES_PER_MESSAGE} 张图片，请分两次发送`), {
      statusCode: 400, code: 'TOO_MANY_IMAGES', limit: MAX_IMAGES_PER_MESSAGE,
    });
  }
  const images: ResolvedChatImage[] = [];
  const skipped: ResolvedImageRefs['skipped'] = [];
  let totalBytes = 0;
  for (let position = 0; position < imageRefs.length; position++) {
    const ref = imageRefs[position];
    const index = position + 1;
    try {
      const item = await prisma.knowledgeItem.findFirst({
        where: { id: ref.id, tenantId, sourceType: 'image' },
        select: {
          id: true,
          fileKey: true,
          fileType: true,
          fileSize: true,
          inferenceFileKey: true,
          inferenceFileType: true,
          inferenceFileSize: true,
        },
      });
      if (!item?.fileKey) {
        skipped.push({ index, refId: ref.id, reason: '图片不存在或无权读取' });
        continue;
      }
      const stored = await getChatImage(item.inferenceFileKey ?? item.fileKey);
      if (!stored?.length) {
        skipped.push({ index, refId: ref.id, reason: '图片原件读取失败' });
        continue;
      }
      let buf = stored;
      let mediaType = mediaTypeFromExt(item.inferenceFileType ?? item.fileType);
      if (!item.inferenceFileKey) {
        // 存量图片懒生成推理副本；后续轮次直接复用，不重复转码。
        const inference = await createInferenceImageCopy(stored, mediaTypeFromExt(item.fileType));
        const inferenceKey = inference.resized ? `${item.fileKey}.inference.${inference.ext}` : item.fileKey;
        if (inference.resized) await putChatImage(inferenceKey, inference.buf, inference.mediaType);
        await prisma.knowledgeItem.update({
          where: { id: item.id },
          data: {
            inferenceFileKey: inferenceKey,
            inferenceFileType: inference.ext,
            inferenceFileSize: inference.buf.length,
          },
        });
        buf = inference.buf;
        mediaType = inference.mediaType;
      }
      if (buf.length > MAX_IMAGE_BYTES) {
        skipped.push({ index, refId: ref.id, reason: `图片超过 ${Math.floor(MAX_IMAGE_BYTES / 1024 / 1024)}MB` });
        continue;
      }
      totalBytes += buf.length;
      images.push({ index, refId: ref.id, mediaType, base64: buf.toString('base64'), bytes: buf.length });
    } catch (e) {
      console.error(`[chatImage] 图 ${index} 读取失败：`, (e as Error).message);
      skipped.push({ index, refId: ref.id, reason: '图片原件读取失败' });
    }
  }
  if (totalBytes > MAX_IMAGE_MESSAGE_BYTES) {
    throw Object.assign(new Error(`这组图片合计超过 ${Math.floor(MAX_IMAGE_MESSAGE_BYTES / 1024 / 1024)}MB，请压缩或分两次发送`), {
      statusCode: 413, code: 'IMAGE_MESSAGE_TOO_LARGE', limitBytes: MAX_IMAGE_MESSAGE_BYTES,
    });
  }
  return { requestedCount: imageRefs.length, images, skipped, totalBytes };
}

/** 兼容旧调用：返回全部可读图片，不再静默限制为 4；上游调用方必须自行按批次约束。 */
export async function resolveImageRefs(
  tenantId: string,
  refs: MessageRef[] | undefined,
): Promise<{ mediaType: string; base64: string }[]> {
  const resolved = await resolveImageRefsDetailed(tenantId, refs);
  return resolved.images.map(({ mediaType, base64 }) => ({ mediaType, base64 }));
}
