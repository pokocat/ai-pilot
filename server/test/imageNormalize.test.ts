// 用户上传图片的统一归一化（services/imageNormalize.ts）：能由系统处理的格式与大小不交给用户（2026-11-24）。
//   cd server && npm test -- test/imageNormalize.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { ImageNormalizeError, isHeicLike, normalizeUploadedImage, RAW_IMAGE_READ_MAX, renameForExt } from '../src/services/imageNormalize.js';
import { api, cleanBusiness, closeApp, getApp, login, seedBaseline, uniquePhone } from './helpers.js';
import { prisma } from '../src/db.js';

const heic = readFileSync(new URL('./fixtures/sample.heic', import.meta.url));
const ALL = ['jpg', 'png', 'gif', 'webp'] as const;

test('入口接受的格式且不超限：字节原样返回（GIF 动图、透明 PNG 都不动）', async () => {
  const png = await sharp({ create: { width: 20, height: 20, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0.3 } } }).png().toBuffer();
  const out = await normalizeUploadedImage(png, { accept: ALL, maxBytes: 10 * 1024 * 1024 });
  assert.equal(out.converted, false);
  assert.equal(out.buf, png);
  assert.equal(out.mime, 'image/png');
  const gif = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#f00' } }).gif().toBuffer();
  assert.equal((await normalizeUploadedImage(gif, { accept: ALL, maxBytes: 10 * 1024 * 1024 })).buf, gif);
});

test('HEIC（iPhone 原图）→ JPEG', async () => {
  assert.equal(isHeicLike(heic), true);
  const out = await normalizeUploadedImage(heic, { accept: ALL, maxBytes: 10 * 1024 * 1024 });
  assert.equal(out.converted, true);
  assert.equal(out.ext, 'jpg');
  const meta = await sharp(out.buf).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.equal(meta.width, 96);
  assert.equal(meta.height, 64);
});

test('入口不收的格式：透明 WebP → PNG、不透明 WebP → JPEG、AVIF → JPEG、TIFF → JPEG', async () => {
  const alpha = await sharp({ create: { width: 24, height: 24, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 0.5 } } }).webp().toBuffer();
  const a = await normalizeUploadedImage(alpha, { accept: ['jpg', 'png'], maxBytes: 10 * 1024 * 1024 });
  assert.equal(a.ext, 'png');
  assert.equal((await sharp(a.buf).metadata()).hasAlpha, true);
  const opaque = await sharp({ create: { width: 24, height: 24, channels: 3, background: '#123456' } }).webp().toBuffer();
  assert.equal((await normalizeUploadedImage(opaque, { accept: ['jpg', 'png'], maxBytes: 10 * 1024 * 1024 })).ext, 'jpg');
  const avif = await sharp({ create: { width: 24, height: 24, channels: 3, background: '#654321' } }).avif().toBuffer();
  assert.equal((await normalizeUploadedImage(avif, { accept: ALL, maxBytes: 10 * 1024 * 1024 })).ext, 'jpg');
  const tiff = await sharp({ create: { width: 24, height: 24, channels: 3, background: '#abcdef' } }).tiff().toBuffer();
  assert.equal((await normalizeUploadedImage(tiff, { accept: ALL, maxBytes: 10 * 1024 * 1024 })).ext, 'jpg');
});

test('超过上限：自动压缩到上限以内，而不是 413', async () => {
  // 随机噪点 PNG 压不小，正好用来逼出压缩分支。
  const noise = await sharp(Buffer.from(Array.from({ length: 1200 * 1200 * 3 }, () => Math.floor(Math.random() * 256))), {
    raw: { width: 1200, height: 1200, channels: 3 },
  }).png().toBuffer();
  const limit = 400 * 1024;
  assert.ok(noise.length > limit);
  const out = await normalizeUploadedImage(noise, { accept: ALL, maxBytes: limit });
  assert.equal(out.converted, true);
  assert.ok(out.buf.length <= limit, `${out.buf.length} > ${limit}`);
  assert.equal(out.ext, 'jpg');
});

test('真正处理不了的才报错：不是图片 400、SVG 400、空文件 400、超读取上限 413', async () => {
  for (const [buf, status] of [
    [Buffer.from('definitely not an image'), 400],
    [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'), 400],
    [Buffer.alloc(0), 400],
  ] as const) {
    await assert.rejects(normalizeUploadedImage(buf, { accept: ALL, maxBytes: 1024 }), (e: unknown) => e instanceof ImageNormalizeError && e.statusCode === status);
  }
  const huge = Buffer.alloc(RAW_IMAGE_READ_MAX + 1);
  await assert.rejects(normalizeUploadedImage(huge, { accept: ALL, maxBytes: 1024 }), (e: unknown) => e instanceof ImageNormalizeError && e.statusCode === 413);
});

test('文件名跟着实际格式改扩展名', () => {
  assert.equal(renameForExt('IMG_0001.HEIC', 'jpg'), 'IMG_0001.jpg');
  assert.equal(renameForExt('门头', 'png'), '门头.png');
  assert.equal(renameForExt('', 'jpg'), '图片.jpg');
});

test('聊天图片上传：HEIC 存成 JPEG，超 10MB 的不再 413', async () => {
  await getApp();
  await cleanBusiness();
  await seedBaseline();
  try {
    const token = await login(uniquePhone(), '传图');
    const boundary = '----imageNormalizeBoundary';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="IMG_0002.HEIC"\r\nContent-Type: image/heic\r\n\r\n`),
      heic,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const app = await getApp();
    const res = await app.inject({ method: 'POST', url: '/api/chat/image-upload', headers: { 'x-user-id': token, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: body });
    assert.equal(res.statusCode, 200, res.body);
    const item = await prisma.knowledgeItem.findUniqueOrThrow({ where: { id: res.json().id } });
    assert.equal(item.fileType, 'jpg');
    assert.equal(item.fileName, 'IMG_0002.jpg');
    const garbage = await app.inject({
      method: 'POST', url: '/api/chat/image-upload', headers: { 'x-user-id': token, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`), Buffer.from('nope'), Buffer.from(`\r\n--${boundary}--\r\n`)]),
    });
    assert.equal(garbage.statusCode, 400);
    assert.equal(garbage.json().code, 'IMAGE_DECODE_FAILED');
    void api;
  } finally {
    await closeApp();
  }
});
