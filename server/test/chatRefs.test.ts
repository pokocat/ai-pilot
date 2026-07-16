// 对话多文件引用：注入预算 / 截断标注 / 超额引用可见 / 拆读中状态 / 对话上传额度门禁。
//
// 这几条都是「不能静默」的边：预算不能让第一份吃光、截断不能让模型以为看的是全文、
// 超过 9 份不能悄悄丢、还在拆读的不能塞个空块冒充正文、对话上传不能绕开免费额度。
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, login, uniquePhone } from './helpers.js';
import {
  resolveReferences,
  allocateRefBudget,
  MAX_REF_CHARS_PER_DOC,
  MAX_REF_CHARS_TOTAL,
  MAX_REFS,
} from '../src/services/retrieval.js';
import { FREE_DOCS } from '../src/services/knowledgePipeline.js';
import type { MessageRef } from '../src/llm/schema.js';

let tenantA = '', userA = '';

before(async () => { await getApp(); });
after(async () => { await closeApp(); });

beforeEach(async () => {
  await cleanBusiness();
  await seedBaseline();
  const t = await prisma.tenant.create({ data: { name: 'A公司' } });
  tenantA = t.id;
  userA = (await prisma.user.create({ data: { tenantId: tenantA, phone: '13800000020', name: '甲', role: 'owner' } })).id;
});

/** 建一条 ready 的知识项，正文由 len 个字符组成。 */
async function mkKnowledge(title: string, len: number, status = 'ready'): Promise<MessageRef> {
  const item = await prisma.knowledgeItem.create({
    data: {
      tenantId: tenantA, userId: userA, kind: 'document', title,
      text: '甲'.repeat(len), sourceType: 'upload', status, stage: 'confirmed',
      fileName: `${title}.txt`, fileSize: len, tagsJson: [],
    },
  });
  return { kind: 'knowledge', id: item.id, label: title };
}

// ───────────────── 1) 预算分配：上限 + 公平（纯函数，不碰库） ─────────────────

test('allocateRefBudget：装得下就都给足，不做无谓裁剪', () => {
  const got = allocateRefBudget([100, 200, 300]);
  assert.deepEqual(got, [100, 200, 300]);
});

test('allocateRefBudget：单份不得超过每份上限', () => {
  const got = allocateRefBudget([MAX_REF_CHARS_PER_DOC * 3]);
  assert.equal(got[0], MAX_REF_CHARS_PER_DOC, '一份再长也只到每份上限');
});

test('allocateRefBudget：合计不得超过总预算', () => {
  // 9 份各 8000 = 72000，远超 30000 总预算。
  const got = allocateRefBudget(new Array(9).fill(MAX_REF_CHARS_PER_DOC));
  const sum = got.reduce((a, b) => a + b, 0);
  assert.ok(sum <= MAX_REF_CHARS_TOTAL, `合计 ${sum} 不应超过 ${MAX_REF_CHARS_TOTAL}`);
  assert.ok(sum >= MAX_REF_CHARS_TOTAL - 9, `合计 ${sum} 应基本用满预算（误差 < 份数）`);
});

test('allocateRefBudget：不是先到先得——长文件不得饿死后面的短文件', () => {
  // 一份 8000 长文 + 8 份 500 短文。若先到先得，长文吃光预算后短文颗粒无收。
  const got = allocateRefBudget([MAX_REF_CHARS_PER_DOC, ...new Array(8).fill(500)]);
  assert.ok(got.slice(1).every((n) => n === 500), '短文件应全额拿到（它们要得少）');
  assert.ok(got[0] > 0, '长文件也应分到预算');
  assert.ok(got.reduce((a, b) => a + b, 0) <= MAX_REF_CHARS_TOTAL);
});

test('allocateRefBudget：全是超长文件时按份均分（谁都不独吞）', () => {
  const got = allocateRefBudget(new Array(6).fill(50000));
  const share = Math.floor(MAX_REF_CHARS_TOTAL / 6);
  assert.ok(got.every((n) => Math.abs(n - share) <= 1), `应各得 ~${share}，实得 ${got.join('/')}`);
});

// ───────────────── 2) 截断必须自报家门 ─────────────────

test('resolveReferences：超长单份被截到每份上限，且标注为节选（写明全文字数与截取字数）', async () => {
  const ref = await mkKnowledge('长报告', MAX_REF_CHARS_PER_DOC + 5000);
  const { lines } = await resolveReferences(tenantA, userA, [ref]);
  assert.equal(lines.length, 1);
  const line = lines[0];
  assert.ok(line.includes('节选'), '必须明说是节选');
  assert.ok(line.includes(`全文 ${MAX_REF_CHARS_PER_DOC + 5000} 字`), '必须写明全文多少字');
  assert.ok(line.includes(`截取前 ${MAX_REF_CHARS_PER_DOC} 字`), '必须写明截了多少字');
  // 正文部分确实被裁到上限（标注头之外的正文长度）。
  const body = line.slice(line.indexOf('】') + 1);
  assert.equal(body.length, MAX_REF_CHARS_PER_DOC, '正文应恰好裁到每份上限');
});

test('resolveReferences：正文没超预算时不加节选标注（不谎报截断）', async () => {
  const ref = await mkKnowledge('短备忘', 200);
  const { lines } = await resolveReferences(tenantA, userA, [ref]);
  assert.ok(!lines[0].includes('节选'), '没截断就不该标节选');
  assert.ok(lines[0].includes('甲'.repeat(200)), '短文应原样全带');
});

test('resolveReferences：多份合计不得超过总预算，且每份都分到字数', async () => {
  const refs: MessageRef[] = [];
  for (let i = 0; i < 6; i++) refs.push(await mkKnowledge(`卷${i}`, 20000)); // 6 × 20000 = 120000 远超预算
  const { lines } = await resolveReferences(tenantA, userA, refs);
  assert.equal(lines.length, 6, '6 份都应在场（只是各自节选）');
  const bodies = lines.map((l) => l.slice(l.indexOf('】') + 1));
  assert.ok(bodies.every((b) => b.length > 0), '不得有任何一份一个字都进不去');
  const total = bodies.reduce((n, b) => n + b.length, 0);
  assert.ok(total <= MAX_REF_CHARS_TOTAL, `注入合计 ${total} 不应超过 ${MAX_REF_CHARS_TOTAL}`);
  assert.ok(lines.every((l) => l.includes('节选')), '每份都被裁了，就每份都要标注');
});

// ───────────────── 3) 超过上限的引用：丢可以，瞒不行 ─────────────────

test('resolveReferences：超过 9 份时余下的被丢下，但点名回传 notices（不静默）', async () => {
  const refs: MessageRef[] = [];
  for (let i = 0; i < MAX_REFS + 3; i++) refs.push(await mkKnowledge(`资料${i}`, 100));
  const { lines, labels, notices } = await resolveReferences(tenantA, userA, refs);
  assert.equal(lines.length, MAX_REFS, `至多带 ${MAX_REFS} 份`);
  assert.equal(labels.length, MAX_REFS);
  assert.equal(notices.length, 1, '被丢下的必须有一条提示');
  assert.ok(notices[0].includes('3 份'), '要说清丢了几份');
  assert.ok(notices[0].includes(`${MAX_REFS} 份`), '要说清上限是几份');
  // 被丢下的三份要点名（label 回传），客户才知道是哪几份没带上。
  for (const name of ['资料9', '资料10', '资料11']) {
    assert.ok(notices[0].includes(name), `应点名被丢下的「${name}」，实得：${notices[0]}`);
  }
});

test('resolveReferences：正好 9 份时全带上，不产生任何提示', async () => {
  const refs: MessageRef[] = [];
  for (let i = 0; i < MAX_REFS; i++) refs.push(await mkKnowledge(`资料${i}`, 100));
  const { lines, notices } = await resolveReferences(tenantA, userA, refs);
  assert.equal(lines.length, MAX_REFS);
  assert.equal(notices.length, 0, '没丢东西就别吓唬人');
});

// ───────────────── 4) 解析竞态：拆读中的不能冒充正文 ─────────────────

test('resolveReferences：仍在拆读的资料 → 明说未就绪 + 回传提示，绝不塞空知识块', async () => {
  // 上传即挂引用、解析异步：此刻 text='' 且 status='parsing'。
  const item = await prisma.knowledgeItem.create({
    data: {
      tenantId: tenantA, userId: userA, kind: 'document', title: '刚传的年报',
      text: '', sourceType: 'upload', status: 'parsing', stage: 'confirmed',
      fileName: '年报.pdf', fileSize: 1024, tagsJson: [],
    },
  });
  const { lines, labels, notices } = await resolveReferences(tenantA, userA, [
    { kind: 'knowledge', id: item.id, label: '刚传的年报' },
  ]);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes('尚在拆读'), '注入文本要明说此件未就绪');
  assert.ok(lines[0].includes('不可臆测'), '要禁止模型对着空文件编内容');
  assert.notEqual(lines[0], '【知识：刚传的年报】', '绝不能是个空知识块');
  assert.ok(labels[0].includes('拆读中'), '展示标签也要带状态');
  assert.equal(notices.length, 1);
  assert.ok(notices[0].includes('刚传的年报') && notices[0].includes('拆读'), `提示要点名，实得：${notices[0]}`);
});

test('resolveReferences：解析失败/正文为空的资料 → 明说读不出，不冒充有内容', async () => {
  const item = await prisma.knowledgeItem.create({
    data: {
      tenantId: tenantA, userId: userA, kind: 'document', title: '坏扫描件',
      text: '', sourceType: 'upload', status: 'failed', stage: 'confirmed',
      fileName: '扫描.pdf', fileSize: 2048, tagsJson: [],
    },
  });
  const { lines, notices } = await resolveReferences(tenantA, userA, [
    { kind: 'knowledge', id: item.id, label: '坏扫描件' },
  ]);
  assert.ok(lines[0].includes('未能读出正文'));
  assert.ok(notices.some((n) => n.includes('坏扫描件') && n.includes('读不出')));
});

test('resolveReferences：已就绪的资料不产生任何状态提示', async () => {
  const ref = await mkKnowledge('已拆好的表', 300);
  const { lines, notices } = await resolveReferences(tenantA, userA, [ref]);
  assert.ok(lines[0].includes('甲'.repeat(300)));
  assert.equal(notices.length, 0);
});

// ───────────────── 5) 对话上传（非 staged）也要走额度门禁 ─────────────────

/** 拼一个 multipart 请求体（inject 不带 form-data 封装）。 */
function multipart(fileName: string, content: string): { payload: string; headers: Record<string, string> } {
  const boundary = '----junshiTestBoundary1234567890';
  const payload =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
    'Content-Type: text/plain\r\n\r\n' +
    `${content}\r\n` +
    `--${boundary}--\r\n`;
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

test('对话上传（非 staged）额度用尽 → 402 KNOWLEDGE_QUOTA，不再无声入库', async () => {
  const token = await login(uniquePhone(), '对话上传客');
  const u = await prisma.user.findUnique({ where: { id: token }, select: { tenantId: true } });
  const tid = u!.tenantId;
  // 灌满本月免费份数。
  await prisma.knowledgeItem.createMany({
    data: Array.from({ length: FREE_DOCS }, (_, i) => ({
      tenantId: tid, userId: token, kind: 'document', title: `f${i}`, text: 't',
      sourceType: 'upload', stage: 'confirmed', status: 'ready', fileSize: 10,
    })),
  });

  const app = await getApp();
  const { payload, headers } = multipart('新资料.txt', '这是对话里传上来的一份资料');
  const res = await app.inject({
    method: 'POST', url: '/api/knowledge/upload',
    headers: { ...headers, 'x-user-id': token },
    payload,
  });
  assert.equal(res.statusCode, 402, `超额应被拦，实得 ${res.statusCode} ${res.body}`);
  assert.equal(res.json().code, 'KNOWLEDGE_QUOTA');

  // 关键：被拦的上传绝不能留下条目（否则额度只会越查越满）。
  const n = await prisma.knowledgeItem.count({ where: { tenantId: tid, userId: token } });
  assert.equal(n, FREE_DOCS, '被拦的上传不应入库');
});

test('对话上传（非 staged）额度未满 → 正常入库，走 parsing 异步解析', async () => {
  const token = await login(uniquePhone(), '正常上传客');
  const app = await getApp();
  const { payload, headers } = multipart('周报.txt', '本周成交 12 单，线索 340 条。');
  const res = await app.inject({
    method: 'POST', url: '/api/knowledge/upload',
    headers: { ...headers, 'x-user-id': token },
    payload,
  });
  assert.equal(res.statusCode, 200, `额度充足应放行，实得 ${res.statusCode} ${res.body}`);
  const body = res.json();
  assert.ok(body.id);
  assert.ok(['parsing', 'ready', 'embedding'].includes(body.status), `实得 status=${body.status}`);
});
