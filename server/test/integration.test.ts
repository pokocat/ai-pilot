// 军师后端集成测试（mock 模型，可复现）。
// 运行：先备好测试库并 `DATABASE_URL=...＿test npm run db:push`，再 `npm test`（详见 docs/TESTING.md）。
// 覆盖：鉴权/隔离基线、多智能体对话、记忆召回、项目+知识库+跨对话召回、版本化报告+diff、
//       ★跨用户隔离（防信息泄露）、模型配置不泄露明文 key。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import { api, login, seedBaseline, cleanBusiness, closeApp, uniquePhone, deliverable } from './helpers.js';
// 直接断言的服务层（也是后端的一部分）
import { recallMemories, recordFeedback } from '../src/services/memory.js';
import { buildGenContext } from '../src/services/context.js';
import { hybridSearch, resolveReferences } from '../src/services/retrieval.js';
import type { MemoryConfig } from '../src/data/agents.js';

const tenantOf = async (token: string) =>
  (await prisma.user.findUnique({ where: { id: token } }))!.tenantId;

before(async () => {
  await cleanBusiness();
  await seedBaseline();
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

// ───────────────────────── TC-I 流式产出（SSE） ─────────────────────────
describe('TC-I 流式产出（SSE /generate）', () => {
  test('I1 顾问结构化成果按事件流式下发', async () => {
    const t = await login(uniquePhone());
    const r = await api('POST', '/api/generate', { token: t, body: { text: '帮我做一次战略体检', agentKey: 'strat' } });
    assert.equal(r.status, 200);
    const sse = String(r.body);
    for (const ev of ['event: begin', 'event: section', 'event: footer', 'event: done']) {
      assert.ok(sse.includes(ev), `SSE 应包含 ${ev}`);
    }
  });
});

// ───────────────────────── TC-J 内容审核拦截（合规） ─────────────────────────
describe('TC-J 内容审核拦截', () => {
  test('J1 命中违规词的输入 → 422 拦截', async () => {
    const t = await login(uniquePhone());
    const r = await api('POST', '/api/generate-sync', { token: t, body: { text: '帮我评估一个赌博平台的获客方案', agentKey: 'general' } });
    assert.equal(r.status, 422, '违规输入应被拦截');
    assert.equal(r.body.code, 'MODERATION_BLOCK');
  });
});

// ───────────────────────── TC-K 算力（套餐赠送 + 计量） ─────────────────────────
describe('TC-K 算力账户', () => {
  test('K1 注册即按套餐赠送算力，/me 可见余额', async () => {
    const t = await login(uniquePhone());
    const me = await api('GET', '/api/me', { token: t });
    assert.ok(me.body.creditBalance > 0, '新账号应有赠送算力');
    assert.ok(me.body.plan, '应绑定套餐');
  });
  // 按次扣减尚未实现（gateway.meter 为占位，未写 credit_ledger）——见 ROADMAP P2。
  test('K2 产出按次扣减算力', { skip: 'meter() 为占位，未落 credit_ledger（待实现）' }, () => {});
});

// ───────────────────────── TC-L 并发冒烟 ─────────────────────────
describe('TC-L 并发冒烟', () => {
  test('L1 同一用户并发多次产出：均成功且会话不串', async () => {
    const t = await login(uniquePhone());
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => api('POST', '/api/generate-sync', { token: t, body: { text: `并发问题 ${i}`, agentKey: 'general' } })),
    );
    assert.ok(results.every((r) => r.status === 200), '全部应成功');
    const ids = new Set(results.map((r) => r.body.sessionId));
    assert.equal(ids.size, 8, '8 次应产生 8 个独立会话，无串号');
  });
});

// ───────────────────────── TC-M 首登建档 → 个性化产出 ─────────────────────────
describe('TC-M 首登建档 → 个性化产出', () => {
  test('M1 建档后 onboarded=true，产出按企业档案个性化', async () => {
    const t = await login(uniquePhone());
    await api('PUT', '/api/profile', { token: t, body: { industry: '精密制造', stage: '规模化', pain: '现金流' } });
    const me = await api('GET', '/api/me', { token: t });
    assert.equal(me.body.onboarded, true, '建档后应标记 onboarded');
    const r = await api('POST', '/api/generate-sync', { token: t, body: { text: '帮我做一次战略体检', agentKey: 'strat' } });
    assert.ok(r.body.deliverable.meta.includes('精密制造'), '成果元信息应带入企业档案行业');
  });
});

// ───────────────────────── TC-N 老用户回流（持久化） ─────────────────────────
describe('TC-N 老用户回流持久化', () => {
  test('N1 同手机号复登 token 不变，历史数据仍在', async () => {
    const phone = uniquePhone();
    const t1 = await login(phone, '回流公司');
    await api('POST', '/api/projects', { token: t1, body: { name: '长期项目' } });
    const t2 = await login(phone);
    assert.equal(t2, t1, '同手机号复登应是同一账号');
    const projects = await api('GET', '/api/projects', { token: t2 });
    assert.ok(projects.body.some((p: any) => p.name === '长期项目'), '历史项目应仍在');
  });
});

// ───────────────────────── TC-O 跨智能体协同 + 引用闭环 ─────────────────────────
describe('TC-O 一个项目内跨智能体协同 + 引用闭环', () => {
  test('O1 战略报告 → 融资参谋引用它继续产出，沉淀在同一项目', async () => {
    const t = await login(uniquePhone());
    const p = await api('POST', '/api/projects', { token: t, body: { name: 'A 轮冲刺' } });
    const pid = p.body.id;
    // 战略诊断官产出并存为报告
    const gen1 = await api('POST', '/api/generate-sync', { token: t, body: { text: '战略体检', agentKey: 'strat', projectId: pid } });
    const lib = await api('POST', '/api/library', { token: t, body: { title: '战略诊断报告', type: '战略体检', agentKey: 'strat', sessionId: gen1.body.sessionId, projectId: pid, content: deliverable('战略诊断报告', [{ h: '核心判断', b: '聚焦高价值客群' }]) } });
    // 融资参谋引用该报告继续产出
    const gen2 = await api('POST', '/api/generate-sync', { token: t, body: { text: '据此做融资准备', agentKey: 'fund', projectId: pid, refs: [{ kind: 'report', id: lib.body.reportId, version: 1, label: '战略诊断报告 v1' }] } });
    assert.ok((gen2.body.knowledgeUsed ?? []).length > 0, '引用应被采纳并体现在产出依据中');
    // 项目聚合：≥2 会话、≥1 报告
    const detail = await api('GET', `/api/projects/${pid}`, { token: t });
    assert.ok(detail.body.counts.sessions >= 2 && detail.body.counts.reports >= 1, '项目应聚合多智能体协同的产物');
  });
});

// ───────────────────────── TC-P 成果采纳 → 反馈记忆 ─────────────────────────
describe('TC-P 成果反馈回流', () => {
  test('P1 默认配置不写反馈记忆（sources 未含 deliverable_feedback）', async () => {
    const t = await login(uniquePhone());
    await api('POST', '/api/library', { token: t, body: { title: '默认成果', type: '战略体检', agentKey: 'strat', content: deliverable('默认成果', [{ h: 'A', b: 'x' }]) } });
    const mems = await recallMemories(t, 'strat', 10, '采纳');
    assert.ok(!mems.some((m) => m.includes('采纳了')), '默认配置不应写入反馈记忆');
  });
  test('P2 开启 deliverable_feedback 后，采纳信号沉淀为可召回记忆', async () => {
    const t = await login(uniquePhone());
    const tenantId = await tenantOf(t);
    const cfg: MemoryConfig = { longTerm: true, autoLearn: true, intensity: 'balanced', retentionDays: 180, sources: ['deliverable_feedback'] };
    await recordFeedback({ tenantId, userId: t, agentKey: 'strat', cfg, signal: 'adopt', title: '增长方案' });
    const mems = await recallMemories(t, 'strat', 5, '采纳 增长方案');
    assert.ok(mems.some((m) => m.includes('采纳了《增长方案》')), '采纳信号应可召回');
  });
});

// ───────────────────────── TC-Q 记忆留存 TTL ─────────────────────────
describe('TC-Q 记忆留存（TTL 过期不召回）', () => {
  test('Q1 过期记忆被排除，未过期记忆正常召回', async () => {
    const t = await login(uniquePhone());
    const tenantId = await tenantOf(t);
    const past = new Date(Date.now() - 86400000);
    const future = new Date(Date.now() + 86400000);
    await prisma.memory.create({ data: { tenantId, userId: t, agentKey: 'strat', kind: 'preference', text: 'EXPIRED-不该出现', source: 'conversation', weight: 1, expiresAt: past } });
    await prisma.memory.create({ data: { tenantId, userId: t, agentKey: 'strat', kind: 'preference', text: 'VALID-应保留', source: 'conversation', weight: 1, expiresAt: future } });
    const mems = await recallMemories(t, 'strat', 10);
    assert.ok(mems.some((m) => m.includes('VALID')), '未过期记忆应召回');
    assert.ok(!mems.some((m) => m.includes('EXPIRED')), '过期记忆不应召回');
  });
});

// ───────────────────────── TC-R 跨项目知识不串 ─────────────────────────
describe('TC-R 跨项目知识隔离（同一用户）', () => {
  test('R1 在项目 A 对话不会召回项目 B 的知识', async () => {
    const t = await login(uniquePhone());
    const tenantId = await tenantOf(t);
    const pa = (await api('POST', '/api/projects', { token: t, body: { name: '供应链项目' } })).body.id;
    const pb = (await api('POST', '/api/projects', { token: t, body: { name: '出海项目' } })).body.id;
    await api('POST', '/api/knowledge', { token: t, body: { text: '供应链优化：与晨曦集团锁定年度框采', projectId: pa, title: '供应链' } });
    await api('POST', '/api/knowledge', { token: t, body: { text: '海外渠道：东南亚先做新加坡样板', projectId: pb, title: '出海' } });

    const { ctx: ctxA } = await buildGenContext({ userId: t, tenantId, agentKey: 'strat', userMessage: '供应链怎么优化', projectId: pa });
    const joinedA = (ctxA.knowledge ?? []).join('');
    assert.ok(joinedA.includes('供应链'), '项目 A 应召回 A 的知识');
    assert.ok(!joinedA.includes('海外渠道'), '项目 A 不应串入项目 B 的知识');
  });
});

// ───────────────────────── TC-S 每日献策 ─────────────────────────
describe('TC-S 每日献策', () => {
  test('S1 返回当日一条献策', async () => {
    const r = await api('GET', '/api/sayings/today');
    assert.equal(r.status, 200);
    assert.ok(r.body.text && r.body.date, '应返回 文案 + 日期');
  });
});

// ───────────────────────── TC-T 边界 / 健壮性 ─────────────────────────
describe('TC-T 边界与健壮性', () => {
  test('T1 空输入 → 400', async () => {
    const t = await login(uniquePhone());
    const r = await api('POST', '/api/generate-sync', { token: t, body: { text: '   ', agentKey: 'general' } });
    assert.equal(r.status, 400);
  });
  test('T2 空检索词 → 返回空数组（不报错）', async () => {
    const t = await login(uniquePhone());
    const r = await api('GET', '/api/knowledge/search?q=', { token: t });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, []);
  });
  test('T3 删除会话后不可再访问，且从列表消失', async () => {
    const t = await login(uniquePhone());
    const gen = await api('POST', '/api/generate-sync', { token: t, body: { text: '随便聊聊', agentKey: 'general' } });
    const sid = gen.body.sessionId;
    assert.equal((await api('DELETE', `/api/sessions/${sid}`, { token: t })).status, 200);
    assert.equal((await api('GET', `/api/sessions/${sid}`, { token: t })).status, 404);
    const list = await api('GET', '/api/sessions', { token: t });
    assert.ok(!list.body.some((s: any) => s.id === sid), '已删会话应从列表消失');
  });
});
