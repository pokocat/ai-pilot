// V7-06 智库三段式资料整理管道测试（直连 service，绕过尚未注册的路由；风格参照 wechatPay.test.ts）。
// 关键断言：staging 对检索不可见（无 chunk）→ organize 归类+去重 → confirm 才嵌入且可召回；额度门禁；SKU 门禁；跨租户隔离。
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, login, uniquePhone } from './helpers.js';
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

// 5b) 深度整理是一次性服务：用过一次后，同一笔购买不能无限复用（回归：此前从不核销）。
test('deep-organize 用过一次后核销，同一批凭据不能重复使用', async () => {
  const batchId1 = 'batch-deep-2a';
  const batchId2 = 'batch-deep-2b';
  await ingestStagedFile({ tenantId: tenantA, userId: userA, fileName: '资料一.txt', mime: 'text/plain', buf: buf('第一批 素材'), batchId: batchId1 });
  await ingestStagedFile({ tenantId: tenantA, userId: userA, fileName: '资料二.txt', mime: 'text/plain', buf: buf('第二批 素材'), batchId: batchId2 });
  await prisma.userModule.create({ data: { tenantId: tenantA, userId: userA, moduleKey: 'sku:deep-organize', source: 'purchase' } });

  const first = await deepOrganize({ tenantId: tenantA, userId: userA, batchId: batchId1 });
  assert.equal(first.deep, true);

  // 第二批复用同一笔已核销的凭据应被拒绝（402），而不是免费无限执行。
  await assert.rejects(
    () => deepOrganize({ tenantId: tenantA, userId: userA, batchId: batchId2 }),
    (e: any) => e.statusCode === 402 && e.code === 'SKU_REQUIRED',
  );

  // 再次购买后凭据恢复可用。
  await prisma.userModule.upsert({
    where: { userId_moduleKey: { userId: userA, moduleKey: 'sku:deep-organize' } },
    update: { enabled: true },
    create: { tenantId: tenantA, userId: userA, moduleKey: 'sku:deep-organize', source: 'purchase' },
  });
  const second = await deepOrganize({ tenantId: tenantA, userId: userA, batchId: batchId2 });
  assert.equal(second.deep, true);
});

// 5c) 执行失败不应白白核销凭据：批次不存在时应报错且凭据仍可用。
test('deep-organize 执行失败时不核销凭据，允许重试', async () => {
  await prisma.userModule.create({ data: { tenantId: tenantA, userId: userA, moduleKey: 'sku:deep-organize', source: 'purchase' } });

  await assert.rejects(
    () => deepOrganize({ tenantId: tenantA, userId: userA, batchId: 'batch-does-not-exist' }),
    (e: any) => e.code === 'BATCH_NOT_FOUND',
  );

  const batchId = 'batch-deep-retry';
  await ingestStagedFile({ tenantId: tenantA, userId: userA, fileName: '重试资料.txt', mime: 'text/plain', buf: buf('重试 素材'), batchId });
  const res = await deepOrganize({ tenantId: tenantA, userId: userA, batchId });
  assert.equal(res.deep, true, '凭据应仍然可用（失败的那次不应核销）');
});

// 7) 批次逐份清单：buildPipeline 的 batches[].files 带出每份 id/文件名/状态/字节（此前缺字段，前端看不到清单）。
test('pipeline 批次带出逐份文件清单（files）', async () => {
  const batchId = 'batch-files-1';
  const a1 = await ingestStagedFile({ tenantId: tenantA, userId: userA, fileName: '增长漏斗.txt', mime: 'text/plain', buf: buf('增长 漏斗 转化'), batchId });
  const a2 = await ingestStagedFile({ tenantId: tenantA, userId: userA, fileName: '财务表.csv', mime: 'text/csv', buf: buf('营收,利润\n100,20'), batchId });

  const view = await buildPipeline({ tenantId: tenantA, userId: userA });
  const b = view.batches.find((x) => x.id === batchId)!;
  assert.equal(b.files.length, 2, '批次应带出 2 份文件清单');
  const ids = new Set(b.files.map((f) => f.id));
  assert.ok(ids.has(a1.id) && ids.has(a2.id));
  const f = b.files.find((x) => x.id === a2.id)!;
  assert.equal(f.fileName, '财务表.csv');
  assert.ok(typeof f.status === 'string');
  assert.equal(f.fileSize, buf('营收,利润\n100,20').length);
});

// 8) 整理结果逐份回传：organizeBatch 返回 items（分类 + 摘要 + 去重标记）。
test('organize 逐份回传 items（分类/摘要/去重标记）', async () => {
  const batchId = 'batch-items-1';
  const common = buf('成交案例 客户评价 结果截图 证明材料');
  await ingestStagedFile({ tenantId: tenantA, userId: userA, fileName: '案例证明.txt', mime: 'text/plain', buf: common, batchId });
  await ingestStagedFile({ tenantId: tenantA, userId: userA, fileName: '案例证明.txt', mime: 'text/plain', buf: common, batchId }); // dup
  await ingestStagedFile({ tenantId: tenantA, userId: userA, fileName: '财务报表.csv', mime: 'text/csv', buf: buf('营收,利润\n100,20'), batchId });

  const res = await organizeBatch({ tenantId: tenantA, userId: userA, batchId });
  assert.equal(res.items.length, 3, '应逐份回传');
  const csv = res.items.find((i) => i.fileName === '财务报表.csv')!;
  assert.equal(csv.category, 'finance');
  assert.ok(csv.summary, '应带摘要');
  assert.equal(csv.isDup, false);
  const dupCount = res.items.filter((i) => i.isDup).length;
  assert.equal(dupCount, 1, '一份应标记为重复');
});

// 9) 已优化持久化：organize 后 buildPipeline 从库内重建 optimizedItems + optimized 阶段 folders（刷新不丢）。
test('pipeline 从库内重建已优化区（optimizedItems + optimized folders）', async () => {
  const batchId = 'batch-optpersist-1';
  await ingestStagedFile({ tenantId: tenantA, userId: userA, fileName: '增长资料.txt', mime: 'text/plain', buf: buf('增长 漏斗 转化 私域 投放'), batchId });
  await organizeBatch({ tenantId: tenantA, userId: userA, batchId });

  const view = await buildPipeline({ tenantId: tenantA, userId: userA });
  assert.ok(view.optimizedItems.length >= 1, '已优化区应有持久数据');
  const it = view.optimizedItems[0];
  assert.ok(it.category && it.summary, '重建项应含分类与摘要');
  assert.ok(view.folders.some((f) => f.stage === 'optimized'), 'folders 应含 optimized 阶段');
});

// 10) 深度整理差异化产出：产《资料整理报告》+ 版本去重 + 计费口径字段 + docs stage 透出。
test('deep-organize 产资料整理报告 + 版本去重 + 保守结算字段', async () => {
  const batchId = 'batch-deepreport-1';
  await ingestStagedFile({ tenantId: tenantA, userId: userA, fileName: '财务报表.csv', mime: 'text/csv', buf: buf('营收,利润\n100,20'), batchId });
  await ingestStagedFile({ tenantId: tenantA, userId: userA, fileName: '内容脚本.txt', mime: 'text/plain', buf: buf('内容 脚本 选题 IP'), batchId });
  await prisma.userModule.create({ data: { tenantId: tenantA, userId: userA, moduleKey: 'sku:deep-organize', source: 'purchase' } });

  const r1 = await deepOrganize({ tenantId: tenantA, userId: userA, batchId });
  assert.equal(r1.deep, true);
  assert.ok(r1.reportId, '应产出报告 id');
  assert.equal(r1.reportVersion, 1);
  assert.equal(r1.meterAttempts, 0, 'mock 无 live provider → attempts=0');
  assert.equal(r1.meterOk, false);
  assert.ok(r1.items.length >= 2, '深度整理回传逐份 items');

  // 报告落库：type=资料整理报告，5 段齐全。
  const doc = await prisma.reportDoc.findUnique({ where: { id: r1.reportId } });
  assert.equal(doc!.type, '资料整理报告');
  const ver = await prisma.reportVersion.findFirst({ where: { reportId: r1.reportId, version: 1 } });
  const content = ver!.contentJson as { sections: { h: string }[] };
  assert.deepEqual(
    content.sections.map((s) => s.h),
    ['本批收到什么', '怎么归档的', '去重了什么', '重点资料精炼摘要', '军师建议补充的资料'],
  );

  // 重试场景：再次深度整理同批（重新购买凭据）→ 内容不变 → 报告版本去重（不涨版），摘要已精炼不重复调用。
  await prisma.userModule.upsert({
    where: { userId_moduleKey: { userId: userA, moduleKey: 'sku:deep-organize' } },
    update: { enabled: true }, create: { tenantId: tenantA, userId: userA, moduleKey: 'sku:deep-organize', source: 'purchase' },
  });
  const r2 = await deepOrganize({ tenantId: tenantA, userId: userA, batchId });
  assert.equal(r2.reportVersion, 1, '内容不变 → 版本去重');
  assert.equal(r2.meterAttempts, 0, '已精炼过的份不重复调用 LLM');
  const verCount = await prisma.reportVersion.count({ where: { reportId: r1.reportId } });
  assert.equal(verCount, 1);
});

// 11) 路由计费接线 + docs stage：deep-organize 走 reserveQuota/settle（mock attempts=0 不实扣）；docs 透出 stage。
test('deep-organize 路由 200 出报告，docs 透出 stage（mock 不实扣额度）', async () => {
  const token = await login(uniquePhone(), '深整客');
  const u = await prisma.user.findUnique({ where: { id: token }, select: { tenantId: true } });
  const tid = u!.tenantId;
  const batchId = 'route-deep-1';
  await ingestStagedFile({ tenantId: tid, userId: token, fileName: '财务报表.csv', mime: 'text/csv', buf: buf('营收,利润\n100,20'), batchId });
  await prisma.userModule.create({ data: { tenantId: tid, userId: token, moduleKey: 'sku:deep-organize', source: 'purchase' } });

  const before = await prisma.tokenWallet.findUnique({ where: { userId: token }, select: { balance: true } });
  const r = await api('POST', '/api/knowledge/deep-organize', { token, body: { batchId } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.reportId);
  assert.equal(r.body.reportVersion, 1);

  // mock 无 live provider → 保守结算 0 → 额度不实扣（settle 已把预留全额退回）。
  const after = await prisma.tokenWallet.findUnique({ where: { userId: token }, select: { balance: true } });
  if (before && after) assert.equal(after.balance, before.balance, 'mock 下额度应无净变化');

  // docs 视图透出 stage（不过滤，前端标注）。
  const docs = await api('GET', '/api/knowledge/docs', { token });
  assert.equal(docs.status, 200);
  assert.ok(docs.body.every((d: { stage?: string }) => typeof d.stage === 'string'), '每行应带 stage');
  assert.ok(docs.body.some((d: { stage: string }) => d.stage === 'optimized'), '深度整理后应有 optimized 项');
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
