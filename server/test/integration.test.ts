// 军师后端集成测试（mock 模型，可复现）。
// 运行：先备好测试库并 `DATABASE_URL=...＿test npm run db:push`，再 `npm test`（详见 docs/TESTING.md）。
// 覆盖：鉴权/隔离基线、多智能体对话、记忆召回、项目+知识库+跨对话召回、版本化报告+diff、
//       ★跨用户隔离（防信息泄露）、模型配置不泄露明文 key。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import { api, login, seedAgents, cleanBusiness, closeApp, uniquePhone, deliverable } from './helpers.js';
// 直接断言的服务层（也是后端的一部分）
import { recallMemories } from '../src/services/memory.js';
import { buildGenContext } from '../src/services/context.js';
import { hybridSearch, resolveReferences } from '../src/services/retrieval.js';
import { diffContents, wordDiff } from '../src/services/reports.js';

const tenantOf = async (token: string) =>
  (await prisma.user.findUnique({ where: { id: token } }))!.tenantId;

before(async () => {
  await cleanBusiness();
  await seedAgents();
});
after(async () => {
  await closeApp();
});

// ───────────────────────── TC-A 鉴权与账号隔离基线 ─────────────────────────
describe('TC-A 鉴权与账号隔离基线', () => {
  test('A1 无 token 访问受保护接口 → 401', async () => {
    const r = await api('GET', '/api/me');
    assert.equal(r.status, 401);
  });

  test('A2 手机号登录自动建号；A、B 各自独立租户', async () => {
    const ta = await login(uniquePhone(), '甲公司');
    const tb = await login(uniquePhone(), '乙公司');
    assert.ok(ta && tb && ta !== tb, '两个账号 token 应不同');
    const meA = await api('GET', '/api/me', { token: ta });
    const meB = await api('GET', '/api/me', { token: tb });
    assert.equal(meA.status, 200);
    assert.notEqual(meA.body.tenant.id, meB.body.tenant.id, '两个账号应属于不同租户');
  });

  test('A3 非法/失效 token → 401', async () => {
    const r = await api('GET', '/api/me', { token: 'not-a-real-user-id' });
    assert.equal(r.status, 401);
  });
});

// ───────────────────────── TC-B 与不同智能体对话（mock） ─────────────────────────
describe('TC-B 与不同智能体对话（mock，无真实 LLM）', () => {
  test('B1 通用军师 general → 自由对话回复', async () => {
    const t = await login(uniquePhone());
    const r = await api('POST', '/api/generate-sync', { token: t, body: { text: '你好，最近该关注什么', agentKey: 'general' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.kind, 'chat');
    assert.ok(r.body.reply?.text, '应有回复文本');
  });

  test('B2 战略诊断官 strat → 结构化成果（report）', async () => {
    const t = await login(uniquePhone());
    const r = await api('POST', '/api/generate-sync', { token: t, body: { text: '帮我做一次战略体检', agentKey: 'strat' } });
    assert.equal(r.body.kind, 'report');
    assert.ok((r.body.deliverable?.sections?.length ?? 0) > 0, '成果应有分段内容');
  });

  test('B3 会话持久化与可回溯', async () => {
    const t = await login(uniquePhone());
    const gen = await api('POST', '/api/generate-sync', { token: t, body: { text: '增长方案怎么做', agentKey: 'growth' } });
    const sid = gen.body.sessionId;
    const list = await api('GET', '/api/sessions', { token: t });
    assert.ok(list.body.some((s: any) => s.id === sid), '会话列表应含该会话');
    const detail = await api('GET', `/api/sessions/${sid}`, { token: t });
    assert.equal(detail.status, 200);
    assert.ok(detail.body.messages.length >= 2, '应还原 用户消息 + 产出');
  });
});

// ───────────────────────── TC-C 长期记忆召回 ─────────────────────────
describe('TC-C 长期记忆召回', () => {
  test('C1 与顾问对话后写入长期记忆，下次可召回', async () => {
    const t = await login(uniquePhone());
    await api('POST', '/api/generate-sync', { token: t, body: { text: '我们最头疼的是获客成本太高', agentKey: 'strat' } });
    const mems = await recallMemories(t, 'strat', 5, '获客成本');
    assert.ok(mems.some((m) => m.includes('获客成本')), '应召回到含「获客成本」的记忆');
  });

  test('C2 语义召回：与问题相关的记忆排在前', async () => {
    const t = await login(uniquePhone());
    await api('POST', '/api/generate-sync', { token: t, body: { text: '我们最关注获客成本与转化率', agentKey: 'strat' } });
    await api('POST', '/api/generate-sync', { token: t, body: { text: '我们在筹备 A 轮融资与期权池设计', agentKey: 'strat' } });
    const top = await recallMemories(t, 'strat', 1, '融资 期权');
    assert.ok(top[0]?.includes('融资'), `应优先召回融资相关记忆，实际：${top[0]}`);
  });
});

// ───────────────────────── TC-D 项目 + 知识库 + 跨对话召回 ─────────────────────────
describe('TC-D 项目 + 知识库 + 跨对话召回', () => {
  test('D1 创建项目，会话归属项目', async () => {
    const t = await login(uniquePhone());
    const p = await api('POST', '/api/projects', { token: t, body: { name: '2026 融资冲刺' } });
    const pid = p.body.id;
    const gen = await api('POST', '/api/generate-sync', { token: t, body: { text: '融资准备清单', agentKey: 'fund', projectId: pid } });
    const detail = await api('GET', `/api/sessions/${gen.body.sessionId}`, { token: t });
    assert.equal(detail.body.projectId, pid, '会话应归属该项目');
  });

  test('D2 知识入库 → 检索命中 → 下次对话上下文召回', async () => {
    const t = await login(uniquePhone());
    const tenantId = await tenantOf(t);
    const p = await api('POST', '/api/projects', { token: t, body: { name: '客群研究' } });
    const pid = p.body.id;
    await api('POST', '/api/knowledge', { token: t, body: { text: '高价值客群集中在制造与医疗 SaaS，续费率高、客单价高', projectId: pid, kind: 'insight', title: '高价值客群' } });

    const search = await api('GET', `/api/knowledge/search?q=${encodeURIComponent('制造 医疗 客群')}&projectId=${pid}`, { token: t });
    assert.ok(search.body.length > 0, '混合检索应命中知识');

    // 下次对话：buildGenContext 应把项目知识召回进上下文
    const { ctx } = await buildGenContext({ userId: t, tenantId, agentKey: 'strat', userMessage: '我们的高价值客群在哪些行业', projectId: pid });
    assert.ok(ctx.knowledge && ctx.knowledge.length > 0, '上下文应注入项目知识');
    assert.ok(ctx.knowledge.join('').includes('制造'), '召回内容应相关');
  });

  test('D3 对话汇总 → 版本化报告 + 沉淀知识库', async () => {
    const t = await login(uniquePhone());
    const gen = await api('POST', '/api/generate-sync', { token: t, body: { text: '帮我做一次战略体检', agentKey: 'strat' } });
    const sum = await api('POST', `/api/sessions/${gen.body.sessionId}/summarize`, { token: t });
    assert.equal(sum.status, 200);
    assert.ok(sum.body.reportId && sum.body.version >= 1, '应生成版本化纪要报告');
    assert.ok(sum.body.knowledgeAdded >= 1, '纪要要点应沉淀进知识库');
    const kb = await api('GET', '/api/knowledge', { token: t });
    assert.ok(kb.body.some((k: any) => k.sourceType === 'conversation'), '知识库应有对话来源的条目');
  });
});

// ───────────────────────── TC-E 版本化报告 + diff ─────────────────────────
describe('TC-E 版本化报告 + diff', () => {
  test('E1~E3 同名续版本、同内容去重', async () => {
    const t = await login(uniquePhone());
    const save = (secs: any) => api('POST', '/api/library', { token: t, body: { title: '战略诊断报告', type: '战略体检', agentKey: 'strat', content: deliverable('战略诊断报告', secs) } });
    const v1 = await save([{ h: '现状', b: '获客成本偏高' }]);
    assert.equal(v1.body.version, 1);
    const v2 = await save([{ h: '现状', b: '获客成本偏高，需控制' }]);
    assert.equal(v2.body.version, 2, '改内容应升版本');
    const v2dup = await save([{ h: '现状', b: '获客成本偏高，需控制' }]);
    assert.equal(v2dup.body.version, 2, '同内容应去重，不新增版本');

    const doc = await api('GET', `/api/reports/${v1.body.reportId}`, { token: t });
    assert.equal(doc.body.versions.length, 2, '应恰好 2 个版本');
  });

  test('E4 两版差异：section 级 + 词级高亮', async () => {
    const t = await login(uniquePhone());
    const save = (secs: any) => api('POST', '/api/library', { token: t, body: { title: '增长方案', type: '增长方案', agentKey: 'growth', content: deliverable('增长方案', secs) } });
    const v1 = await save([{ h: '路径', b: '先做私域复购' }]);
    await save([{ h: '路径', b: '先做私域复购，再拓新渠道' }, { h: '风险', b: '渠道成本' }]);
    const diff = await api('GET', `/api/reports/${v1.body.reportId}/diff?from=1&to=2`, { token: t });
    assert.equal(diff.status, 200);
    const changed = diff.body.sections.find((s: any) => s.h === '路径');
    const added = diff.body.sections.find((s: any) => s.h === '风险');
    assert.equal(changed.change, 'changed');
    assert.equal(added.change, 'added');
    assert.ok(changed.words?.some((w: any) => w.t === 'add'), '应含词级新增片段');
    assert.ok(changed.words?.some((w: any) => w.t === 'eq'), '应含词级未变片段');
  });
});

// ───────────────────────── TC-G ★ 跨用户隔离（防信息泄露） ─────────────────────────
describe('TC-G ★ 跨用户知识库/数据隔离（防泄露）', () => {
  test('A 的项目/报告/知识/记忆，B 一律不可见、不可召回、不可引用', async () => {
    const A = await login(uniquePhone(), '甲');
    const B = await login(uniquePhone(), '乙');
    const tenantA = await tenantOf(A);
    const tenantB = await tenantOf(B);

    // A 沉淀机密内容
    const pa = await api('POST', '/api/projects', { token: A, body: { name: 'A机密项目' } });
    const ka = await api('POST', '/api/knowledge', { token: A, body: { text: 'A的机密客户名单：晨曦集团、北辰科技', projectId: pa.body.id, title: '机密客户' } });
    const ra = await api('POST', '/api/library', { token: A, body: { title: 'A机密战略', type: '战略体检', agentKey: 'strat', content: deliverable('A机密战略', [{ h: '核心', b: 'A的独家打法' }]) } });
    await api('POST', '/api/generate-sync', { token: A, body: { text: 'A的机密：我们要收购晨曦集团', agentKey: 'strat' } });

    // —— 列表接口：B 全空 ——
    assert.equal((await api('GET', '/api/projects', { token: B })).body.length, 0, 'B 不应看到 A 的项目');
    assert.equal((await api('GET', '/api/reports', { token: B })).body.length, 0, 'B 不应看到 A 的报告');
    assert.equal((await api('GET', '/api/library', { token: B })).body.length, 0, 'B 不应看到 A 的方案库');
    assert.equal((await api('GET', '/api/knowledge', { token: B })).body.length, 0, 'B 不应看到 A 的知识');

    // —— 检索接口：B 搜不到 A 的机密（关键防泄露点）——
    const leak = await api('GET', `/api/knowledge/search?q=${encodeURIComponent('机密客户名单 晨曦集团')}`, { token: B });
    assert.equal(leak.body.length, 0, 'B 的检索绝不能命中 A 的机密知识');

    // —— 直取 A 资源：B 得 404（不可见）——
    assert.equal((await api('GET', `/api/projects/${pa.body.id}`, { token: B })).status, 404);
    assert.equal((await api('GET', `/api/reports/${ra.body.reportId}`, { token: B })).status, 404);

    // —— 服务层：跨租户检索 / 引用解析 / 记忆召回 一律隔离 ——
    assert.ok((await hybridSearch({ tenantId: tenantA, query: '机密客户名单' })).length > 0, 'A 自己应能检索到');
    assert.equal((await hybridSearch({ tenantId: tenantB, query: '机密客户名单' })).length, 0, 'B 租户检索应为空');

    // B 即便拿到 A 的 id 显式 @引用，也解析不出内容
    const refs = await resolveReferences(tenantB, B, [
      { kind: 'report', id: ra.body.reportId, label: 'x' },
      { kind: 'knowledge', id: ka.body.id, label: 'x' },
    ]);
    assert.equal(refs.lines.length, 0, 'B 引用 A 的资源不应解析出任何内容');

    // A 的记忆只进 A 的上下文，不进 B 的
    const memA = await recallMemories(A, 'strat', 5, '晨曦集团 收购');
    const memB = await recallMemories(B, 'strat', 5, '晨曦集团 收购');
    assert.ok(memA.some((m) => m.includes('晨曦')), 'A 应召回自己的记忆');
    assert.equal(memB.length, 0, 'B 不应召回任何 A 的记忆');

    // B 的对话上下文不含 A 的知识
    const { ctx: ctxB } = await buildGenContext({ userId: B, tenantId: tenantB, agentKey: 'strat', userMessage: '机密客户名单', projectId: null });
    assert.equal((ctxB.knowledge ?? []).length, 0, 'B 的上下文不应注入任何 A 的知识');
  });
});

// ───────────────────────── TC-H 模型配置（不泄露明文 key） ─────────────────────────
describe('TC-H 模型配置（默认 Agnes，可切换，不泄露明文 key）', () => {
  test('H1 读配置：含 hasKey 布尔，绝不回传明文 apiKey；预设可用', async () => {
    const r = await api('GET', '/api/admin/ai-config');
    assert.equal(r.status, 200);
    assert.equal(typeof r.body.config.hasKey, 'boolean');
    assert.ok(!('apiKey' in r.body.config), '对外配置不得包含明文 apiKey 字段');
    assert.ok(r.body.presets.some((p: any) => p.id === 'agnes'), '应含 Agnes 预设');
  });

  test('H2 改配置：切到 Agnes；未配 key 时实际降级 mock', async () => {
    const r = await api('PUT', '/api/admin/ai-config', { body: { provider: 'openai', label: 'Agnes 2.0 Flash', baseUrl: 'https://apihub.agnes-ai.com/v1', model: 'agnes-2.0-flash' } });
    assert.equal(r.body.config.model, 'agnes-2.0-flash');
    assert.equal(r.body.config.hasKey, false, '未传 key → 无 key');
    assert.equal(r.body.config.ready, false, '无真实 key → 未就绪');
    assert.equal(r.body.config.effectiveProvider, 'mock', '未就绪应实际降级 mock');
    assert.ok(!('apiKey' in r.body.config));
  });
});
