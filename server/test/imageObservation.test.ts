import { after, afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { prisma } from '../src/db.js';
import {
  MAX_IMAGE_BATCH_BYTES,
  MAX_IMAGES_PER_BATCH,
  ingestChatImage,
  resolveImageRefsDetailed,
  type ResolvedChatImage,
} from '../src/services/chatImage.js';
import {
  __setImageObserverForTest,
  groupImageBatches,
} from '../src/services/imageObservation.js';
import { generationView } from '../src/services/generationJobs.js';
import { enqueueDurableGeneration } from '../src/services/generationRequest.js';
import { tickGenerationWorker } from '../src/services/generationWorker.js';
import { cleanBusiness, closeApp, login, seedBaseline, uniquePhone } from './helpers.js';
import type { ImageObservationView, MessageRef } from '../../shared/contracts';

beforeEach(async () => {
  __setImageObserverForTest(null);
  await cleanBusiness();
  await seedBaseline();
});
afterEach(() => __setImageObserverForTest(null));
after(async () => closeApp());

async function fixture(imageCount = 9, inferenceBytesOverride?: number) {
  const id = await login(uniquePhone(), '阅图测试老板');
  const user = await prisma.user.findUniqueOrThrow({ where: { id }, select: { id: true, tenantId: true } });
  const refs: MessageRef[] = [];
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 20, g: 80, b: 140 } } }).png().toBuffer();
  for (let index = 1; index <= imageCount; index++) {
    const image = await ingestChatImage({
      tenantId: user.tenantId,
      userId: user.id,
      mime: 'image/png',
      buf: png,
      fileName: `图${index}.png`,
    });
    if (inferenceBytesOverride) {
      await prisma.knowledgeItem.update({
        where: { id: image.id },
        data: { inferenceFileSize: inferenceBytesOverride },
      });
    }
    refs.push({ kind: 'image', id: image.id, label: `图${index}` });
  }
  return { user, refs };
}

const zeroUsage = { inputTokens: 0, outputTokens: 0, cachedInput: 0, billableTokens: 0 };

describe('9 图分批编排', () => {
  test('分批同时受每批 4 张与 12MB 两道闸门约束', () => {
    const images: ResolvedChatImage[] = [
      { index: 1, refId: '1', mediaType: 'image/png', base64: '', bytes: 7 * 1024 * 1024 },
      { index: 2, refId: '2', mediaType: 'image/png', base64: '', bytes: 6 * 1024 * 1024 },
      ...Array.from({ length: 7 }, (_, offset) => ({
        index: offset + 3, refId: String(offset + 3), mediaType: 'image/png', base64: '', bytes: 1,
      })),
    ];
    const batches = groupImageBatches(images);
    assert.ok(batches.every((batch) => batch.images.length <= MAX_IMAGES_PER_BATCH));
    assert.ok(batches.every((batch) => batch.bytes <= MAX_IMAGE_BATCH_BYTES));
    assert.deepEqual(batches.flatMap((batch) => batch.images.map((image) => image.index)), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  test('9 张图严格按 4/4/1 调用，观察 attempt 与进度检查点全部落库', async () => {
    const { user, refs } = await fixture();
    const calls: number[][] = [];
    __setImageObserverForTest(async ({ images }) => {
      calls.push(images.map((image) => image.index));
      return {
        result: images.map((image) => `[图${image.index}] 已观察`).join('\n'),
        usage: zeroUsage,
        provider: 'mock', model: 'image-test', providerInvoked: false,
      };
    });
    const created = await enqueueDurableGeneration(user, {
      text: '综合比较这九张经营截图', agentKey: 'general', refs, clientRequestId: 'image-nine-batches',
    });
    assert.equal(await tickGenerationWorker(), true);
    assert.deepEqual(calls, [[1, 2, 3, 4], [5, 6, 7, 8], [9]]);
    const done = await prisma.generationJob.findUniqueOrThrow({ where: { id: created.job.id } });
    assert.equal(done.imageCount, 9);
    assert.equal(done.imageBatchCount, 3);
    assert.equal(done.imageCompletedBatches, 3);
    assert.equal((done.imageObservationsJson as unknown[]).length, 3);
    const attempts = await prisma.generationAttempt.findMany({ where: { jobId: done.id, kind: { startsWith: 'image_observation:' } }, orderBy: { attemptNo: 'asc' } });
    assert.equal(attempts.length, 3);
    assert.ok(attempts.every((attempt) => attempt.status === 'completed' && attempt.resultJson));
    assert.equal(generationView(done).imageProgress?.phase, 'done');
  });

  test('中间一批失败仍继续最后一批，终态明确返回未读取图号', async () => {
    const { user, refs } = await fixture();
    let call = 0;
    __setImageObserverForTest(async ({ images }) => {
      call += 1;
      if (call === 2) throw Object.assign(new Error('vision timeout'), { code: 'VISION_TIMEOUT' });
      return {
        result: images.map((image) => `[图${image.index}] 已观察`).join('\n'),
        usage: zeroUsage,
        provider: 'mock', model: 'image-test', providerInvoked: false,
      };
    });
    const created = await enqueueDurableGeneration(user, {
      text: '看完九张图后给我结论', agentKey: 'general', refs, clientRequestId: 'image-one-batch-fails',
    });
    await tickGenerationWorker();
    assert.equal(call, 3, '第二批失败后必须继续第三批');
    const done = await prisma.generationJob.findUniqueOrThrow({ where: { id: created.job.id } });
    assert.ok(['completed', 'truncated'].includes(done.status));
    assert.deepEqual(done.imageSkippedIndexesJson, [5, 6, 7, 8]);
    const failed = await prisma.generationAttempt.findFirstOrThrow({ where: { jobId: done.id, kind: 'image_observation:2' } });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.terminationReason, 'VISION_TIMEOUT');
    assert.match(generationView(done).refNotices?.join('') ?? '', /图 5.*图 8.*未成功读取/);
  });

  test('worker 接管后只读取检查点里尚未完成的批次', async () => {
    const { user, refs } = await fixture();
    const created = await enqueueDurableGeneration(user, {
      text: '继续完成九张图的分析', agentKey: 'general', refs, clientRequestId: 'image-resume-incomplete',
    });
    const resolved = await resolveImageRefsDetailed(user.tenantId, refs);
    const batches = groupImageBatches(resolved.images);
    const existing: ImageObservationView[] = batches.slice(0, 2).map((batch) => ({
      batchKey: batch.batchKey,
      batchNumber: batch.batchNumber,
      imageIndexes: batch.images.map((image) => image.index),
      observation: batch.images.map((image) => `[图${image.index}] 上次已完成`).join('\n'),
    }));
    await prisma.generationJob.update({
      where: { id: created.job.id },
      data: {
        imageBatchCount: batches.length,
        imageCompletedBatches: existing.length,
        imageObservationsJson: existing,
        imageSkippedIndexesJson: [],
        imageTotalBytes: resolved.totalBytes,
      },
    });
    await prisma.generationAttempt.createMany({
      data: existing.map((item, index) => ({
        jobId: created.job.id,
        attemptNo: index + 1,
        kind: `image_observation:${index + 1}`,
        status: 'completed',
        usageJson: zeroUsage,
        usageSource: 'provider',
        resultJson: item,
        leaseVersion: 0,
        startedAt: new Date(),
        completedAt: new Date(),
      })),
    });
    const calls: number[][] = [];
    __setImageObserverForTest(async ({ images }) => {
      calls.push(images.map((image) => image.index));
      return {
        result: images.map((image) => `[图${image.index}] 本次补完`).join('\n'),
        usage: zeroUsage,
        provider: 'mock', model: 'image-test', providerInvoked: false,
      };
    });
    await tickGenerationWorker();
    assert.deepEqual(calls, [[9]]);
    const done = await prisma.generationJob.findUniqueOrThrow({ where: { id: created.job.id } });
    assert.equal(done.imageCompletedBatches, 3);
    assert.equal(await prisma.generationAttempt.count({ where: { jobId: done.id, kind: { startsWith: 'image_observation:' } } }), 3);
  });

  test('超过 24MB 的本轮图片在调用视觉模型前被拒绝', async () => {
    const { user, refs } = await fixture(3, 9 * 1024 * 1024);
    await assert.rejects(
      enqueueDurableGeneration(user, {
        text: '看看这三张大图', agentKey: 'general', refs, clientRequestId: 'image-message-too-large',
      }),
      (error: Error & { code?: string }) => error.code === 'IMAGE_MESSAGE_TOO_LARGE',
    );
    assert.equal(await prisma.generationJob.count({ where: { userId: user.id } }), 0, '超限必须在落消息和预留额度前拒绝');
  });
});
