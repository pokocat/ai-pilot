// V7-14 跨域搜索接口集成测试：四域命中（军师/会话/报告/知识）、staging 资料隔离、跨用户不可见。
//
// 关键隔离断言：同一关键词下，confirmed 知识条目可被搜到，staging 条目**绝不出现**——
// 即便 staging 条目带有 chunk（本测试特意给它切片嵌入），也必须被 stage 过滤挡在结果外。
//
// 注意：本工单只交付 routes/search.ts；父工单把 searchRoutes 注册进 app.ts 之前，
// /api/search 返回 404，本文件的断言会失败——属预期（"write anyway"）。路由挂载后即转绿。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, login, uniquePhone } from './helpers.ts';
import { prisma } from '../src/db.ts';
import { ingestKnowledge } from '../src/services/knowledge.ts';
import type { SearchResult } from '../../shared/contracts';

// 独特关键词：四域数据都埋这个词，一次查询能命中会话/报告/知识（confirmed + staging）。
const KW = '增长飞轮';

let token = '';
let other = '';
let sessionId = '';
let reportId = '';
let confirmedId = '';
let stagingId = '';

before(async () => {
  await getApp();
  await cleanBusiness();
  await seedBaseline();
  token = await login(uniquePhone(), '搜索用户'); // token === userId
  other = await login(uniquePhone(), '隔壁用户');

  const me = await prisma.user.findUniqueOrThrow({ where: { id: token }, select: { tenantId: true } });
  const tenantId = me.tenantId;

  // 会话：标题含关键词（general 由 seedBaseline 灌入，FK 成立）。
  const session = await prisma.session.create({
    data: { tenantId, userId: token, agentKey: 'general', title: `${KW}复盘会话` },
  });
  sessionId = session.id;

  // 报告：标题含关键词。
  const report = await prisma.reportDoc.create({
    data: { tenantId, userId: token, title: `${KW}增长方案`, slug: `search-${KW}`, type: '增长方案', currentVersion: 1 },
  });
  reportId = report.id;

  // confirmed 知识：ingestKnowledge 默认 stage='confirmed' 且切片嵌入 → 可被 hybridSearch 召回。
  const confirmed = await ingestKnowledge({
    tenantId, userId: token, kind: 'insight',
    title: `${KW}·已入库`,
    text: `这是已确认入库的知识：围绕获客-转化-复购构建${KW}，形成正向增长循环。`,
    sourceType: 'manual',
  });
  confirmedId = confirmed.id;

  // staging 知识：同样切片嵌入（特意让它「可被检索」），随后置 stage='staging'。
  // 若 search 路由漏了 stage 过滤，它就会混进结果——本测试正是要挡住它。
  const staging = await ingestKnowledge({
    tenantId, userId: token, kind: 'insight',
    title: `${KW}·待整理`,
    text: `这是尚未确认的草稿资料：关于${KW}的零散笔记，还在待整理区。`,
    sourceType: 'upload',
  });
  await prisma.knowledgeItem.update({ where: { id: staging.id }, data: { stage: 'staging' } });
  stagingId = staging.id;
});

after(async () => { await closeApp(); });

test('聚合四域命中；staging 资料被隔离（关键断言）', async () => {
  const r = await api<SearchResult>('GET', `/api/search?q=${encodeURIComponent(KW)}`, { token });
  assert.equal(r.status, 200);
  assert.equal(r.body.q, KW);

  const of = (kind: string) => r.body.hits.filter((h) => h.kind === kind);

  // 会话命中 + 路由。
  const sh = of('session').find((h) => h.id === sessionId);
  assert.ok(sh, '应命中标题含关键词的会话');
  assert.equal(sh.route, `/pages/chat/index?sessionId=${sessionId}`);

  // 报告命中 + snippet=type + 路由。
  const rh = of('report').find((h) => h.id === reportId);
  assert.ok(rh, '应命中标题含关键词的报告');
  assert.equal(rh.snippet, '增长方案');
  assert.equal(rh.route, `/packages/work/report/index?id=${reportId}`);

  // confirmed 知识命中 + 路由。
  const kh = of('knowledge').find((h) => h.id === confirmedId);
  assert.ok(kh, '应命中 confirmed 知识条目');
  assert.equal(kh.route, '/pages/thinktank/index');

  // 关键隔离：staging 条目绝不出现在任何 kind 的结果中。
  assert.ok(!r.body.hits.some((h) => h.id === stagingId), 'staging 资料不得出现在搜索结果');
});

test('军师按 role 关键词命中（大小写不敏感）', async () => {
  // 战略诊断官 role = '定位 · 卡点 · SWOT'；用小写 swot 查，验证大小写不敏感匹配。
  const r = await api<SearchResult>('GET', '/api/search?q=swot', { token });
  assert.equal(r.status, 200);
  const agentHits = r.body.hits.filter((h) => h.kind === 'agent');
  const strat = agentHits.find((h) => h.id === 'strat');
  assert.ok(strat, '应按 role 关键词命中战略诊断官');
  assert.equal(strat.snippet, '定位 · 卡点 · SWOT'); // snippet = role
  assert.equal(strat.route, '/pages/chat/index?agentKey=strat&fresh=1');
});

test('军师按 name 关键词命中', async () => {
  const r = await api<SearchResult>('GET', `/api/search?q=${encodeURIComponent('操盘手')}`, { token });
  assert.equal(r.status, 200);
  assert.ok(r.body.hits.some((h) => h.kind === 'agent' && h.id === 'growth'), '应按 name 命中增长操盘手');
});

test('TC-G 跨用户不可见：B 搜同关键词查不到 A 的会话/报告/知识', async () => {
  const r = await api<SearchResult>('GET', `/api/search?q=${encodeURIComponent(KW)}`, { token: other });
  assert.equal(r.status, 200);
  assert.ok(!r.body.hits.some((h) => h.kind === 'session'), '看不到 A 的会话');
  assert.ok(!r.body.hits.some((h) => h.kind === 'report'), '看不到 A 的报告');
  assert.ok(!r.body.hits.some((h) => h.kind === 'knowledge'), '看不到 A 的知识（含 confirmed）');
});

test('空 q → { q:"", hits:[] }', async () => {
  const empty = await api<SearchResult>('GET', '/api/search?q=', { token });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body, { q: '', hits: [] });

  // 纯空白 q 同样归一化为空结果。
  const blank = await api<SearchResult>('GET', '/api/search?q=%20%20', { token });
  assert.equal(blank.status, 200);
  assert.deepEqual(blank.body, { q: '', hits: [] });
});

test('未登录 → 401', async () => {
  const r = await api('GET', `/api/search?q=${encodeURIComponent(KW)}`);
  assert.equal(r.status, 401);
});
