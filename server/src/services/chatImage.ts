// 聊天图片：上传原件存 OSS（私有）→ 建 sourceType='image' 的 KnowledgeItem（不解析/不切片/不嵌入）→
// 发问时按 image ref 读回原件转 base64，交给多模态 provider「阅图」。
//
// 与文档管线的关键差异：图片不进检索（无 chunk）、不进资料库列表/@引用候选（sourceType 过滤）、
// 直接 status='ready'。租户隔离严格：一切读取都带 tenantId。
//
// 存储抽象：生产走 OSS 私有对象；测试/未配 OSS 时落进程内内存暂存（够单测读回 base64，绝不触达真实 OSS）。

import { randomUUID } from 'node:crypto';
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
export const MAX_IMAGES_PER_MESSAGE = 4;         // 单条消息至多带 4 张（超出忽略并留日志）

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
  await putChatImage(key, opts.buf, opts.mime);
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
      tagsJson: [],
    },
  });
  return { id: item.id };
}

/**
 * 把本轮消息里的 image 引用解析成多模态入参 { mediaType, base64 }[]（严格租户隔离，只取 sourceType='image'）。
 * 单条消息至多 MAX_IMAGES_PER_MESSAGE 张，超出忽略并留日志；读不出的图跳过（不塞空块）。
 */
export async function resolveImageRefs(
  tenantId: string,
  refs: MessageRef[] | undefined,
): Promise<{ mediaType: string; base64: string }[]> {
  const imageRefs = (refs ?? []).filter((r) => r.kind === 'image');
  if (!imageRefs.length) return [];
  const taken = imageRefs.slice(0, MAX_IMAGES_PER_MESSAGE);
  if (imageRefs.length > MAX_IMAGES_PER_MESSAGE) {
    console.warn(`[chatImage] 单条消息图片数 ${imageRefs.length} 超过上限 ${MAX_IMAGES_PER_MESSAGE}，仅取前 ${MAX_IMAGES_PER_MESSAGE} 张`);
  }
  const out: { mediaType: string; base64: string }[] = [];
  for (const ref of taken) {
    try {
      const item = await prisma.knowledgeItem.findFirst({
        where: { id: ref.id, tenantId, sourceType: 'image' },
        select: { fileKey: true, fileType: true },
      });
      if (!item?.fileKey) continue;
      const buf = await getChatImage(item.fileKey);
      if (!buf?.length) continue;
      out.push({ mediaType: mediaTypeFromExt(item.fileType), base64: buf.toString('base64') });
    } catch (e) {
      console.error('[chatImage] resolveImageRefs 单张失败：', (e as Error).message);
    }
  }
  return out;
}
