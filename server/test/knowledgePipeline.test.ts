// V7-06 智库三段式资料整理管道测试（直连 service，绕过尚未注册的路由；风格参照 wechatPay.test.ts）。
// 关键断言：staging 对检索不可见（无 chunk）→ organize 归类+去重 → confirm 才嵌入且可召回；额度门禁；SKU 门禁；跨租户隔离。
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import { getApp, closeApp, seedBaseline, cleanBusiness } from './helpers.js';
import {
  ingestStagedFile,
  buildPipeline,
  organizeBatch,
  confirmItems,
  deepOrganize,
  checkQuota,
  getQuota,
  FREE_DOCS,
} from '../src/services/knowledgePipeline.js';
import { hybridSearch } from '../src/services/retrieval.js';

let tenantA = '', userA = '', tenantB = '', userB = '';

before(async () => { await getApp(); });
after(async () => { await closeApp(); });

beforeEach(async () => {
  await cleanBusiness();
  await seedBaseline();
  const tA = await prisma.tenant.create({ data: { name: 'A公司' } });
  tenantA = tA.id;
  userA = (await prisma.user.create({ data: { tenantId: tenantA, phone: '13800000010', name: '甲', role: 'owner' } })).id;
  const tB = await prisma.tenant.create({ data: { name: 'B公司' } });
  tenantB = tB.id;
  userB = (await prisma.user.create({ data: { tenantId: tenantB, phone: '13800000011', name: '乙', role: 'owner' } })).id;
});

const buf = (s: string): Buffer => Buffer.from(s, 'utf8');

// 1) staged 上传：无切片，检索天然不可见（isolation 关键断言）。
test('staged 上传创建 staging 条目且无 chunk，不出现在 hybridSearch', async () => {
  const batchId = 'batch-iso-1';
  const r = await ingestStagedFile({
    tenantId: tenantA, userId: userA, fileName: '增长漏斗数据.txt', mime: 'text/plain',
    buf: buf('这是一份独特的成交漏斗表 zebrakeyword 线索到咨询转化数据'), batchId,
  });
  assert.equal(r.stage, 'staging');

  const chunks = await prisma.knowledgeChunk.count({ where: { itemId: r.id } });
  assert.equal(chunks, 0, 'staging 条目不应有切片');

  const hits = await hybridSearch({ tenantId: tenantA, userId: userA, query: 'zebrakeyword 成交漏斗' });
  assert.equal(hits.length, 0, 'staging 条目不应出现在检索结果（无 chunk）');
});

// 2) organize：写 bizCategory + 置 optimized + 同名同大小去重标记 dupOfId。
test('organize 归类落 bizCategory + optimized，且同名同大小去重', async () => {
  const batchId = 'batch-org-1';
  const common = buf('成交案例 客户评价 结果截图 证明材料');
  const a1 = await ingestStagedFile({ tenantId: tenantA, userId: userA, fileName: '案例证明.txt', mime: 'text/plain', buf: common, batchId });
  const a2 = await ingestStagedFile({ tenantId: tenantA, userId: userA, fileName: '案例证明.txt', mime: 'text/plain', buf: common, batchId }); // dup
  const a3 = await ingestStagedFile({ tenantId: tenantA, userId: userA, fileName: '财务报表.csv', mime: 'text/csv', buf: buf('营收,利润\n100,20'), batchId });

  const res = await organizeBatch({ tenantId: tenantA, userId: userA, batchId });
  assert.equal(res.status, 'organized');
  assert.equal(res.dedup, 1, '一份重复应被标记');

  const items = await prisma.knowledgeItem.findMany({ where: { batchId } });
  for (const it of items) {
    assert.equal(it.stage, 'optimized', '批次内条目应置 optimized');
    assert.ok(it.bizCategory, '应写入 bizCategory');
  }
  const first = items.find((i) => i.id === a1.id)!;
  const dup = items.find((i) => i.id === a2.id)!;
  const csv = items.find((i) => i.id === a3.id)!;
  assert.equal(dup.dupOfId, first.id, '重复项 dupOfId 指向第一份');
  assert.equal(first.bizCategory, 'proof', '案例证明 → proof');
  assert.equal(csv.bizCategory, 'finance', '财务报表 → finance');
});

// 3) confirm：置 confirmed + 切片嵌入（唯一嵌入点）+ 可被检索命中。
test('confirm 后条目 confirmed、有 chunk 且可检索', async () => {
  const batchId = 'batch-confirm-1';
  const r = await ingestStagedFile({
    tenantId: tenantA, userId: userA, fileName: '增长资料.txt', mime: 'text/plain',
    buf: buf('quokkakeyword 增长漏斗 转化线索 私域运营 独特内容'), batchId,
  });
  await organizeBatch({ tenantId: tenantA, userId: userA, batchId });

  const conf = await confirmItems({ tenantId: tenantA, userId: userA, batchId });
  assert.equal(conf.count, 1);
  assert.equal(conf.ingested, 1, '非重复项应被嵌入');

  const item = await prisma.knowledgeItem.findUnique({ where: { id: r.id } });
  assert.equal(item!.stage, 'confirmed');
  const chunks = await prisma.knowledgeChunk.count({ where: { itemId: r.id } });
  assert.ok(chunks > 0, 'confirmed 条目应有切片');

  const hits = await hybridSearch({ tenantId: tenantA, userId: userA, query: 'quokkakeyword 增长漏斗' });
  assert.ok(hits.some((h) => h.item.id === r.id), 'confirmed 条目应可被检索命中');
});

// 4) 额度门禁：本月满 30 份 → 402 KNOWLEDGE_QUOTA。
test('额度超限 → 402 KNOWLEDGE_QUOTA', async () => {
  await prisma.knowledgeItem.createMany({
    data: Array.from({ length: FREE_DOCS }, (_, i) => ({
      tenantId: tenantA, userId: userA, kind: 'document', title: `f${i}`, text: 't',
      sourceType: 'upload', stage: 'confirmed', status: 'ready', fileSize: 10,
    })),
  });
  const q = await getQuota({ tenantId: tenantA, userId: userA });
  assert.equal(q.usedDocs, FREE_DOCS);
  assert.equal(q.freeDocs, 30);

  await assert.rejects(
    () => checkQuota({ tenantId: tenantA, userId: userA, addBytes: 10 }),
    (e: any) => e.statusCode === 402 && e.code === 'KNOWLEDGE_QUOTA',
  );
  // staged 上传路径同样受门禁。
  await assert.rejects(
    () => ingestStagedFile({ tenantId: tenantA, userId: userA, fileName: 'x.txt', mime: 'text/plain', buf: buf('over'), batchId: 'b-over' }),
    (e: any) => e.code === 'KNOWLEDGE_QUOTA',
  );
});

// 5) 深度整理门禁：未购 → 402 SKU_REQUIRED；已购 → 执行并打标。
test('deep-organize 未购 → 402 SKU_REQUIRED；已购 → 执行', async () => {
  const batchId = 'batch-deep-1';
  await ingestStagedFile({ tenantId: tenantA, userId: userA, fileName: '内容脚本选题.txt', mime: 'text/plain', buf: buf('内容 脚本 选题 IP 素材'), batchId });

  await assert.rejects(
    () => deepOrganize({ tenantId: tenantA, userId: userA, batchId }),
    (e: any) => e.statusCode === 402 && e.code === 'SKU_REQUIRED' && e.skuKey === 'deep-organize',
  );

  await prisma.userModule.create({ data: { tenantId: tenantA, userId: userA, moduleKey: 'sku:deep-organize', source: 'purchase' } });
  const res = await deepOrganize({ tenantId: tenantA, userId: userA, batchId });
  assert.equal(res.deep, true);
  assert.equal(res.status, 'organized');
  const items = await prisma.knowledgeItem.findMany({ where: { batchId } });
  assert.ok(items.every((i) => i.stage === 'optimized'));
  assert.ok(items.some((i) => Array.isArray(i.tagsJson) && (i.tagsJson as string[]).includes('深度整理')), '深度整理应打标');
});

// 6) TC-G 跨租户隔离：B 看不到 A 的 pipeline/staging，也不能整理/确认 A 的批次。
test('跨租户隔离：B 看不到也动不了 A 的待整理', async () => {
  const batchId = 'batch-tcg-1';
  await ingestStagedFile({ tenantId: tenantA, userId: userA, fileName: 'A资料.txt', mime: 'text/plain', buf: buf('甲的独有资料 增长'), batchId });

  const viewB = await buildPipeline({ tenantId: tenantB, userId: userB });
  assert.equal(viewB.counts.staging, 0, 'B 看不到 A 的 staging');
  assert.equal(viewB.batches.length, 0, 'B 看不到 A 的批次');

  const viewA = await buildPipeline({ tenantId: tenantA, userId: userA });
  assert.equal(viewA.counts.staging, 1);
  assert.equal(viewA.batches.length, 1);
  assert.equal(viewA.batches[0].count, 1);

  await assert.rejects(
    () => organizeBatch({ tenantId: tenantB, userId: userB, batchId }),
    (e: any) => e.code === 'BATCH_NOT_FOUND',
  );

  const cB = await confirmItems({ tenantId: tenantB, userId: userB, batchId });
  assert.equal(cB.count, 0, 'B 确认 A 的批次应 0 命中');
  const aItem = await prisma.knowledgeItem.findFirst({ where: { batchId, tenantId: tenantA } });
  assert.equal(aItem!.stage, 'staging', 'A 的条目未被 B 改动');
});
