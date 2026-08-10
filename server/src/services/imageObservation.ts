import { createHash } from 'node:crypto';
import type { GenerationJob } from '@prisma/client';
import type { ImageObservationView } from '../../../shared/contracts';
import type { GenContext, Usage } from '../llm/schema.js';
import { observeImageBatch, type ImageBatchObservation } from '../llm/gateway.js';
import {
  MAX_IMAGE_BATCH_BYTES,
  MAX_IMAGES_PER_BATCH,
  resolveImageRefsDetailed,
  type ResolvedChatImage,
} from './chatImage.js';
import {
  finishGenerationAttempt,
  saveImageObservationProgress,
  startGenerationAttempt,
} from './generationJobs.js';

type Observer = typeof observeImageBatch;
let observer: Observer = observeImageBatch;

/** 测试 seam：可验证分批、失败和恢复，禁止测试触达真实视觉模型。 */
export function __setImageObserverForTest(value: Observer | null): void {
  observer = value ?? observeImageBatch;
}

export interface ImageBatch {
  batchKey: string;
  batchNumber: number;
  images: ResolvedChatImage[];
  bytes: number;
}

export function groupImageBatches(images: ResolvedChatImage[]): ImageBatch[] {
  const batches: ImageBatch[] = [];
  let current: ResolvedChatImage[] = [];
  let bytes = 0;
  const flush = () => {
    if (!current.length) return;
    const batchNumber = batches.length + 1;
    const signature = current.map((image) => `${image.index}:${image.refId}:${image.bytes}`).join('|');
    batches.push({
      batchKey: `img-${createHash('sha1').update(signature).digest('hex').slice(0, 16)}`,
      batchNumber,
      images: current,
      bytes,
    });
    current = [];
    bytes = 0;
  };
  for (const image of images) {
    if (current.length >= MAX_IMAGES_PER_BATCH || (current.length && bytes + image.bytes > MAX_IMAGE_BATCH_BYTES)) flush();
    current.push(image);
    bytes += image.bytes;
  }
  flush();
  return batches;
}

function storedObservations(job: GenerationJob): ImageObservationView[] {
  return Array.isArray(job.imageObservationsJson)
    ? (job.imageObservationsJson as unknown[]).filter((item): item is ImageObservationView => {
      if (!item || typeof item !== 'object') return false;
      const value = item as Partial<ImageObservationView>;
      return typeof value.batchKey === 'string' && Number.isInteger(value.batchNumber)
        && Array.isArray(value.imageIndexes) && typeof value.observation === 'string';
    })
    : [];
}

function storedSkipped(job: GenerationJob): number[] {
  return Array.isArray(job.imageSkippedIndexesJson)
    ? job.imageSkippedIndexesJson.filter((value): value is number => Number.isInteger(value))
    : [];
}

function failedUsage(batch: ImageBatch): Usage {
  // 上游失败时拿不到 usage 也可能已经计费；按每图 1,000 输入 token 保守估算并进入同一 job 结算。
  return { inputTokens: batch.images.length * 1_000, outputTokens: 0, cachedInput: 0, billableTokens: batch.images.length * 1_000 };
}

function formatObservationLine(observations: ImageObservationView[], skipped: number[]): string | null {
  if (!observations.length && !skipped.length) return null;
  const body = observations
    .sort((a, b) => a.batchNumber - b.batchNumber)
    .map((item) => item.observation)
    .join('\n');
  const failures = skipped.length
    ? `\n未成功读取：${skipped.sort((a, b) => a - b).map((index) => `图${index}`).join('、')}。回答时必须明确说明，不能假装看过。`
    : '';
  return `【本轮图片观察（轻量视觉批次的结构化结果）】\n${body}${failures}\n最终回答要综合用户问题与全部成功观察，并用“图1、图2”标注证据；不要声称重新看到了原图。`;
}

export interface PreparedImageContext {
  observationLine: string | null;
  notices: string[];
  imageCount: number;
  batchCount: number;
  completedBatches: number;
  skippedImageIndexes: number[];
  totalBytes: number;
}

/**
 * 同一 GenerationJob 下逐批阅图：每批成功观察落 attempt.resultJson + job checkpoint；接管时复用，
 * 只调用还没有 batchKey 结果的批次。某批失败会标记对应图号并继续其余批次。
 */
export async function prepareImageObservations(args: {
  job: GenerationJob;
  workerId: string;
  leaseVersion: number;
  refs: Parameters<typeof resolveImageRefsDetailed>[1];
  userQuestion: string;
  signal?: AbortSignal;
}): Promise<PreparedImageContext> {
  const requested = (args.refs ?? []).filter((ref) => ref.kind === 'image').length;
  if (!requested) return { observationLine: null, notices: [], imageCount: 0, batchCount: 0, completedBatches: 0, skippedImageIndexes: [], totalBytes: 0 };
  const resolved = await resolveImageRefsDetailed(args.job.tenantId, args.refs);
  const batches = groupImageBatches(resolved.images);
  const observations = storedObservations(args.job);
  const skipped = new Set<number>([...storedSkipped(args.job), ...resolved.skipped.map((item) => item.index)]);

  await saveImageObservationProgress({
    jobId: args.job.id,
    workerId: args.workerId,
    leaseVersion: args.leaseVersion,
    observations,
    skippedImageIndexes: [...skipped],
    imageBatchCount: batches.length,
    imageTotalBytes: resolved.totalBytes,
  });

  for (const batch of batches) {
    if (observations.some((item) => item.batchKey === batch.batchKey)) continue;
    const attemptNo = await startGenerationAttempt(args.job.id, args.workerId, args.leaseVersion, `image_observation:${batch.batchNumber}`);
    let outcome: ImageBatchObservation | null = null;
    try {
      outcome = await observer({
        images: batch.images.map(({ index, mediaType, base64 }) => ({ index, mediaType, base64 })),
        userQuestion: args.userQuestion,
        signal: args.signal,
        usageMeta: {
          tenantId: args.job.tenantId,
          userId: args.job.userId,
          sessionId: args.job.sessionId,
          agentKey: args.job.agentKey,
        },
      });
      if (!outcome.result.trim()) throw Object.assign(new Error('图片观察结果为空'), { code: 'IMAGE_OBSERVATION_EMPTY' });
      const item: ImageObservationView = {
        batchKey: batch.batchKey,
        batchNumber: batch.batchNumber,
        imageIndexes: batch.images.map((image) => image.index),
        observation: outcome.result.trim().slice(0, 4_000),
      };
      observations.push(item);
      await finishGenerationAttempt({
        jobId: args.job.id, attemptNo, leaseVersion: args.leaseVersion, status: 'completed',
        usage: outcome.usage, usageSource: outcome.providerInvoked ? 'provider' : 'provider',
        provider: outcome.provider, model: outcome.model, result: item,
      });
    } catch (error) {
      batch.images.forEach((image) => skipped.add(image.index));
      const item: ImageObservationView = {
        batchKey: batch.batchKey,
        batchNumber: batch.batchNumber,
        imageIndexes: batch.images.map((image) => image.index),
        observation: batch.images.map((image) => `[图${image.index}] 读取失败，本轮不据此下判断。`).join('\n'),
      };
      observations.push(item);
      await finishGenerationAttempt({
        jobId: args.job.id, attemptNo, leaseVersion: args.leaseVersion, status: 'failed',
        usage: outcome?.usage ?? failedUsage(batch), usageSource: outcome ? 'provider' : 'estimated',
        terminationReason: (error as Error & { code?: string }).code ?? 'image_observation_failed',
        provider: outcome?.provider ?? null, model: outcome?.model ?? null, result: item,
      });
    }
    await saveImageObservationProgress({
      jobId: args.job.id,
      workerId: args.workerId,
      leaseVersion: args.leaseVersion,
      observations,
      skippedImageIndexes: [...skipped],
      imageBatchCount: batches.length,
      imageTotalBytes: resolved.totalBytes,
    });
  }
  const skippedIndexes = [...skipped].sort((a, b) => a - b);
  return {
    observationLine: formatObservationLine(observations, skippedIndexes),
    notices: skippedIndexes.length ? [`${skippedIndexes.map((index) => `图 ${index}`).join('、')}未成功读取，其余图片已继续分析。`] : [],
    imageCount: requested,
    batchCount: batches.length,
    completedBatches: observations.length,
    skippedImageIndexes: skippedIndexes,
    totalBytes: resolved.totalBytes,
  };
}

export function applyPreparedImages(ctx: GenContext, prepared: PreparedImageContext): GenContext {
  return {
    ...ctx,
    images: undefined,
    imageObservationLine: prepared.observationLine,
    contextTrace: {
      ...(ctx.contextTrace ?? { recallIntent: false, history: { recentMessages: 0, carryoverMessages: 0, totalChars: 0 }, memories: [] }),
      images: {
        imageCount: prepared.imageCount,
        batchCount: prepared.batchCount,
        completedBatches: prepared.completedBatches,
        skippedImageIndexes: prepared.skippedImageIndexes,
        totalBytes: prepared.totalBytes,
      },
    },
  };
}
