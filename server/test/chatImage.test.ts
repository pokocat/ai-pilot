// 聊天图片全链路：上传端点（MIME/大小/成功）+ 图片排除资料库列表 + image ref → 多模态入参注入 +
// provider content block 组装（单测组装函数，不触真实模型）。
//
// 铁律：测试绝不触达真实 OSS/真实 LLM。图片在测试环境落进程内内存暂存（chatImage 内），buildGenContext
// 走确定性 mock provider，故这里只单测「组装逻辑」与「注入结果」，不发真实多模态请求。
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import { getApp, closeApp, seedBaseline, cleanBusiness, login, uniquePhone } from './helpers.js';
import { ingestChatImage, resolveImageRefs, MAX_IMAGES_PER_MESSAGE } from '../src/services/chatImage.js';
import { buildGenContext } from '../src/services/context.js';
import { claudeUserContent } from '../src/llm/providers/claude.js';
import { openaiUserContent } from '../src/llm/providers/openai.js';
import { listKnowledge, listKnowledgeDocs } from '../src/services/knowledge.js';
import type { MessageRef } from '../src/llm/schema.js';

before(async () => { await getApp(); });
after(async () => { await closeApp(); });
beforeEach(async () => { await cleanBusiness(); await seedBaseline(); });

/** 拼一个带二进制体的 multipart 请求体（inject 不带 form-data 封装）。 */
function imageMultipart(fileName: string, contentType: string, body: Buffer): { payload: Buffer; headers: Record<string, string> } {
  const boundary = '----junshiImgBoundary1234567890';
  const pre = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
    `Content-Type: ${contentType}\r\n\r\n`,
    'utf8',
  );
  const post = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return { payload: Buffer.concat([pre, body, post]), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

// ───────────────── 1) 上传端点：MIME / 大小 / 成功 ─────────────────

test('POST /chat/image-upload 拒绝非白名单 MIME → 400 IMAGE_BAD_TYPE', async () => {
  const token = await login(uniquePhone(), '图客甲');
  const app = await getApp();
  const { payload, headers } = imageMultipart('a.pdf', 'application/pdf', Buffer.from('%PDF-1.4 not an image'));
  const res = await app.inject({ method: 'POST', url: '/api/chat/image-upload', headers: { ...headers, 'x-user-id': token }, payload });
  assert.equal(res.statusCode, 400, `实得 ${res.statusCode} ${res.body}`);
  assert.equal(res.json().code, 'IMAGE_BAD_TYPE');
});

test('POST /chat/image-upload 超 10MB → 413', async () => {
  const token = await login(uniquePhone(), '图客乙');
  const app = await getApp();
  const big = Buffer.alloc(11 * 1024 * 1024, 1); // 11MB > 10MB 上限（< 20MB multipart 上限，故走我们自己的 413）
  const { payload, headers } = imageMultipart('big.png', 'image/png', big);
  const res = await app.inject({ method: 'POST', url: '/api/chat/image-upload', headers: { ...headers, 'x-user-id': token }, payload });
  assert.equal(res.statusCode, 413, `实得 ${res.statusCode} ${res.body}`);
});

test('POST /chat/image-upload 成功 → 200 + 建 sourceType=image、status=ready 条目', async () => {
  const token = await login(uniquePhone(), '图客丙');
  const app = await getApp();
  const { payload, headers } = imageMultipart('shot.png', 'image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]));
  const res = await app.inject({ method: 'POST', url: '/api/chat/image-upload', headers: { ...headers, 'x-user-id': token }, payload });
  assert.equal(res.statusCode, 200, `实得 ${res.statusCode} ${res.body}`);
  const { id } = res.json();
  assert.ok(id);
  const item = await prisma.knowledgeItem.findUnique({ where: { id } });
  assert.equal(item?.sourceType, 'image');
  assert.equal(item?.status, 'ready');
  assert.equal(item?.fileType, 'png');
  assert.ok(item?.fileKey, '应落 OSS/内存暂存 key');
});

// ───────────────── 2) 图片排除资料库列表（@引用候选 + 文档视图） ─────────────────

test('图片不进 @引用候选（listKnowledge）与我的资料库（listKnowledgeDocs）', async () => {
  const token = await login(uniquePhone(), '图客丁');
  const u = await prisma.user.findUnique({ where: { id: token }, select: { tenantId: true } });
  const tid = u!.tenantId;
  // 一份普通文档 + 一张图。
  await prisma.knowledgeItem.create({ data: { tenantId: tid, userId: token, kind: 'document', title: '经营表', text: '营收数据', sourceType: 'upload', status: 'ready', stage: 'confirmed', tagsJson: [] } });
  await ingestChatImage({ tenantId: tid, userId: token, mime: 'image/png', buf: Buffer.from([1, 2, 3]), fileName: 'x.png' });

  const cand = await listKnowledge(tid);
  assert.equal(cand.length, 1, '候选只应含文档');
  assert.ok(cand.every((k) => k.title !== 'x.png'));
  const docs = await listKnowledgeDocs(tid, token);
  assert.equal(docs.length, 1, '资料库文档视图只应含文档');
});

// ───────────────── 3) image ref → 多模态入参（resolveImageRefs + buildGenContext.images） ─────────────────

test('resolveImageRefs：读回原件转 base64（严格租户隔离），最多 4 张', async () => {
  const token = await login(uniquePhone(), '图客戊');
  const u = await prisma.user.findUnique({ where: { id: token }, select: { tenantId: true } });
  const tid = u!.tenantId;
  const bytes = Buffer.from([10, 20, 30, 40, 50]);
  const { id } = await ingestChatImage({ tenantId: tid, userId: token, mime: 'image/jpeg', buf: bytes, fileName: 'p.jpg' });

  const got = await resolveImageRefs(tid, [{ kind: 'image', id, label: '图片' }]);
  assert.equal(got.length, 1);
  assert.equal(got[0].mediaType, 'image/jpeg');
  assert.equal(got[0].base64, bytes.toString('base64'), 'base64 应与原件一致');

  // 跨租户读不到。
  const other = await resolveImageRefs('tenant-other', [{ kind: 'image', id, label: '图片' }]);
  assert.equal(other.length, 0);

  // 超 4 张只取前 4。
  const many: MessageRef[] = [];
  for (let i = 0; i < MAX_IMAGES_PER_MESSAGE + 2; i++) {
    const r = await ingestChatImage({ tenantId: tid, userId: token, mime: 'image/png', buf: Buffer.from([i]), fileName: `m${i}.png` });
    many.push({ kind: 'image', id: r.id, label: '图片' });
  }
  const capped = await resolveImageRefs(tid, many);
  assert.equal(capped.length, MAX_IMAGES_PER_MESSAGE);
});

test('buildGenContext：本轮 image 引用注入 ctx.images', async () => {
  const token = await login(uniquePhone(), '图客己');
  const u = await prisma.user.findUnique({ where: { id: token }, select: { tenantId: true } });
  const tid = u!.tenantId;
  const { id } = await ingestChatImage({ tenantId: tid, userId: token, mime: 'image/webp', buf: Buffer.from([7, 7, 7]), fileName: 'g.webp' });

  const { ctx } = await buildGenContext({
    userId: token, tenantId: tid, agentKey: 'general', userMessage: '看看这张图',
    refs: [{ kind: 'image', id, label: '图片' }],
  });
  assert.ok(ctx.images && ctx.images.length === 1);
  assert.equal(ctx.images![0].mediaType, 'image/webp');
});

// ───────────────── 4) provider content block 组装（纯函数单测） ─────────────────

test('claudeUserContent：无图 → 纯字符串（不动既有形态）', () => {
  assert.equal(claudeUserContent('你好'), '你好');
  assert.equal(claudeUserContent('你好', []), '你好');
});

test('claudeUserContent：有图 → [image..., text] 块数组', () => {
  const out = claudeUserContent('这是什么', [{ mediaType: 'image/png', base64: 'AAAA' }]);
  assert.ok(Array.isArray(out));
  const blocks = out as any[];
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].type, 'image');
  assert.equal(blocks[0].source.type, 'base64');
  assert.equal(blocks[0].source.media_type, 'image/png');
  assert.equal(blocks[0].source.data, 'AAAA');
  assert.equal(blocks[1].type, 'text');
  assert.equal(blocks[1].text, '这是什么');
});

test('openaiUserContent：无图 → 纯字符串；有图 → image_url(data URL) + text', () => {
  assert.equal(openaiUserContent('你好'), '你好');
  const out = openaiUserContent('看图', [{ mediaType: 'image/jpeg', base64: 'BBBB' }]);
  assert.ok(Array.isArray(out));
  const parts = out as any[];
  assert.equal(parts.length, 2);
  assert.equal(parts[0].type, 'image_url');
  assert.equal(parts[0].image_url.url, 'data:image/jpeg;base64,BBBB');
  assert.equal(parts[1].type, 'text');
  assert.equal(parts[1].text, '看图');
});
