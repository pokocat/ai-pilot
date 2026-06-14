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
import { recordTokenUsage, tokenUsageSummary } from '../src/services/usage.js';
import { setQuota, getQuotaState, chargeQuota, ensureQuota } from '../src/services/tokenQuota.js';
import { percentEncode, canonicalQuery, aliyunSignature } from '../src/services/sms.js';
import { _resetTokenCache } from '../src/services/wechat.js';

const tenantOf = async (token: string) =>
  (await prisma.user.findUnique({ where: { id: token } }))!.tenantId;

before(async () => {
  process.env.ADMIN_TOKEN = 'test-admin-token';
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

  test('A4 微信登录用 openid 建号，复登命中同一账号', async () => {
    const oldFetch = globalThis.fetch;
    process.env.WECHAT_MINI_APPID = 'wx-test-appid';
    process.env.WECHAT_MINI_SECRET = 'wx-test-secret';
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      assert.equal(url.searchParams.get('appid'), 'wx-test-appid');
      assert.equal(url.searchParams.get('secret'), 'wx-test-secret');
      assert.equal(url.searchParams.get('grant_type'), 'authorization_code');
      return new Response(JSON.stringify({
        openid: 'openid-test-a',
        unionid: 'unionid-test-a',
        session_key: 'should-not-return-to-client',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    try {
      const first = await api('POST', '/api/auth/wechat-login', { body: { code: 'wx-code-a' } });
      assert.equal(first.status, 200);
      assert.equal(first.body.isNew, true);
      assert.equal(first.body.user.wechatLinked, true);
      assert.equal(first.body.user.phone, '');
      assert.equal(first.body.session_key, undefined, '不应把微信 session_key 下发给前端');

      const second = await api('POST', '/api/auth/wechat-login', { body: { code: 'wx-code-b' } });
      assert.equal(second.status, 200);
      assert.equal(second.body.isNew, false);
      assert.equal(second.body.token, first.body.token, '同一 openid 应复用同一账号');

      const user = await prisma.user.findUnique({ where: { id: first.body.token } });
      assert.equal(user?.wechatOpenId, 'openid-test-a');
      assert.equal(user?.wechatUnionId, 'unionid-test-a');
    } finally {
      globalThis.fetch = oldFetch;
      delete process.env.WECHAT_MINI_APPID;
      delete process.env.WECHAT_MINI_SECRET;
    }
  });

  test('A5 admin 接口必须有管理员凭证，普通用户不能访问', async () => {
    const anon = await api('GET', '/api/admin/overview', { adminToken: false });
    assert.equal(anon.status, 401);
    const t = await login(uniquePhone());
    const owner = await api('GET', '/api/admin/overview', { token: t, adminToken: false });
    assert.equal(owner.status, 403);
  });
});

// ───────────────────────── TC-F 短信验证码登录 / 一键登录 ─────────────────────────
describe('TC-F 短信验证码登录 / 一键登录', () => {
  test('F1 发送验证码 → 演示口径回传 devCode + 冷却/有效期', async () => {
    const phone = uniquePhone();
    const r = await api('POST', '/api/auth/sms/send', { body: { phone } });
    assert.equal(r.status, 200);
    assert.match(String(r.body.devCode), /^\d{6}$/);
    assert.ok(r.body.cooldownSec > 0 && r.body.expiresInSec > 0);
  });

  test('F2 正确验证码 → 登录建号；返回真实手机号', async () => {
    const phone = uniquePhone();
    const sent = await api('POST', '/api/auth/sms/send', { body: { phone } });
    const r = await api('POST', '/api/auth/login', { body: { phone, code: sent.body.devCode, name: '丙公司' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.isNew, true);
    assert.equal(r.body.user.phone, phone);
    const me = await api('GET', '/api/me', { token: r.body.token });
    assert.equal(me.status, 200);
  });

  test('F3 错误验证码 → 400 SMS_CODE_INVALID', async () => {
    const phone = uniquePhone();
    await api('POST', '/api/auth/sms/send', { body: { phone } });
    const r = await api('POST', '/api/auth/login', { body: { phone, code: '000000' } });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'SMS_CODE_INVALID');
  });

  test('F4 验证码一次性：消费后再用即失效', async () => {
    const phone = uniquePhone();
    const sent = await api('POST', '/api/auth/sms/send', { body: { phone } });
    const code = sent.body.devCode as string;
    assert.equal((await api('POST', '/api/auth/login', { body: { phone, code } })).status, 200);
    assert.equal((await api('POST', '/api/auth/login', { body: { phone, code } })).status, 400);
  });

  test('F5 冷却内重复发送 → 429 SMS_TOO_FREQUENT', async () => {
    const phone = uniquePhone();
    assert.equal((await api('POST', '/api/auth/sms/send', { body: { phone } })).status, 200);
    const b = await api('POST', '/api/auth/sms/send', { body: { phone } });
    assert.equal(b.status, 429);
    assert.equal(b.body.code, 'SMS_TOO_FREQUENT');
  });

  test('F6 免码登录仍可用（未传 code，向后兼容演示/测试）', async () => {
    const r = await api('POST', '/api/auth/login', { body: { phone: uniquePhone() } });
    assert.equal(r.status, 200);
  });

  test('F7 本机号一键登录：phoneCode 换号 → 登录建号，复登命中同号（mock 微信取号）', async () => {
    const oldFetch = globalThis.fetch;
    process.env.WECHAT_MINI_APPID = 'wx-test-appid';
    process.env.WECHAT_MINI_SECRET = 'wx-test-secret';
    _resetTokenCache();
    const phone = uniquePhone();
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.includes('stable_token')) {
        return new Response(JSON.stringify({ access_token: 'tok-test', expires_in: 7200 }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('getuserphonenumber')) {
        return new Response(JSON.stringify({ errcode: 0, phone_info: { purePhoneNumber: phone, countryCode: '86' } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error('unexpected fetch ' + url);
    }) as typeof fetch;
    try {
      const r = await api('POST', '/api/auth/wechat-phone', { body: { phoneCode: 'pc-123' } });
      assert.equal(r.status, 200);
      assert.equal(r.body.isNew, true);
      assert.equal(r.body.user.phone, phone);
      const again = await api('POST', '/api/auth/wechat-phone', { body: { phoneCode: 'pc-456' } });
      assert.equal(again.body.token, r.body.token, '同号应复用同一账号');
    } finally {
      globalThis.fetch = oldFetch;
      delete process.env.WECHAT_MINI_APPID;
      delete process.env.WECHAT_MINI_SECRET;
      _resetTokenCache();
    }
  });

  test('F8 运营商一键登录入口预留 → 501 NOT_IMPLEMENTED', async () => {
    const r = await api('POST', '/api/auth/carrier-onetap', { body: { token: 't' } });
    assert.equal(r.status, 501);
    assert.equal(r.body.code, 'CARRIER_ONETAP_NOT_IMPLEMENTED');
  });

  test('F9 阿里云签名工具：百分号编码与排序确定、可复现', () => {
    assert.equal(percentEncode('a b+c*d~e'), 'a%20b%2Bc%2Ad~e');
    assert.equal(canonicalQuery({ b: '2', a: '1', Ab: '3' }), 'Ab=3&a=1&b=2');
    const p = { Action: 'SendSms', PhoneNumbers: '13800138000', SignName: '军师' };
    assert.equal(aliyunSignature('GET', p, 'sk'), aliyunSignature('GET', p, 'sk'));
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

// ───────────────────────── TC-K 算力（套餐赠送 + 按次计量 + 不足拦截） ─────────────────────────
describe('TC-K 算力账户', () => {
  test('K1 注册即按套餐赠送算力，/me 可见余额', async () => {
    const t = await login(uniquePhone());
    const me = await api('GET', '/api/me', { token: t });
    assert.ok(me.body.creditBalance > 0, '新账号应有赠送算力');
    assert.ok(me.body.plan, '应绑定套餐');
  });

  test('K2 报告类产出按次扣减、自由对话免费，/me 同步', async () => {
    const t = await login(uniquePhone());
    const before = (await api('GET', '/api/me', { token: t })).body.creditBalance as number;
    const r1 = await api('POST', '/api/generate-sync', { token: t, body: { text: '战略体检', agentKey: 'strat' } });
    assert.equal(r1.body.creditBalance, before, '文本报告走 token 额度，不扣钻石');
    assert.ok(r1.body.tokenQuota, '产出应回填本月额度状态');
    assert.equal((await api('GET', '/api/me', { token: t })).body.creditBalance, before, '/me 钻石余额不变');
    const r2 = await api('POST', '/api/generate-sync', { token: t, body: { text: '随便聊聊', agentKey: 'general' } });
    assert.equal(r2.body.creditBalance, before, '对话同样走 token 额度，不扣钻石');
  });

  test('K3 额度不足 → 产出被 402 INSUFFICIENT_QUOTA 拦截、不留会话', async () => {
    const t = await login(uniquePhone());
    const tenantId = await tenantOf(t);
    await setQuota(tenantId, t, 0); // 置零本月 token 额度
    const r = await api('POST', '/api/generate-sync', { token: t, body: { text: '战略体检', agentKey: 'strat' } });
    assert.equal(r.status, 402);
    assert.equal(r.body.code, 'INSUFFICIENT_QUOTA');
    assert.equal((await api('GET', '/api/sessions', { token: t })).body.length, 0, '被拦截不应留下会话');
    const chat = await api('POST', '/api/generate-sync', { token: t, body: { text: '聊聊', agentKey: 'general' } });
    assert.equal(chat.status, 402, '额度耗尽：对话也走 token 额度，同样拦截');
  });

  test('K4 购买套餐 → 切换套餐、入账算力、后台用量同步', async () => {
    const t = await login(uniquePhone());
    const before = (await api('GET', '/api/me', { token: t })).body.creditBalance as number;
    const plans = await api('GET', '/api/plans');
    assert.equal(plans.status, 200);
    const decision = plans.body.find((p: any) => p.name === '决策版');
    assert.ok(decision, '应返回决策版套餐');

    const buy = await api('POST', `/api/plans/${decision.id}/purchase`, { token: t, body: {} });
    assert.equal(buy.status, 200);
    assert.equal(buy.body.plan.name, '决策版');
    assert.equal(buy.body.grantedCredits, decision.creditsPerMonth);
    assert.equal(buy.body.creditBalance, before + decision.creditsPerMonth);

    const me = await api('GET', '/api/me', { token: t });
    assert.equal(me.body.plan.name, '决策版');
    assert.equal(me.body.creditBalance, before + decision.creditsPerMonth);

    const usage = await api('GET', '/api/admin/usage');
    const row = usage.body.users.find((u: any) => u.id === t);
    assert.equal(row.planName, '决策版');
    assert.equal(row.creditBalance, before + decision.creditsPerMonth);
    assert.equal(row.totalGranted, before + decision.creditsPerMonth);
  });

  test('K5 购买企业版不限量后，报告产出不再扣减', async () => {
    const t = await login(uniquePhone());
    const plans = await api('GET', '/api/plans');
    const enterprise = plans.body.find((p: any) => p.creditsPerMonth < 0);
    assert.ok(enterprise, '应有不限量企业版套餐');

    const buy = await api('POST', `/api/plans/${enterprise.id}/purchase`, { token: t, body: {} });
    assert.equal(buy.status, 200);
    assert.equal(buy.body.creditBalance, -1);
    assert.equal(buy.body.grantedCredits, 0);

    const gen = await api('POST', '/api/generate-sync', { token: t, body: { text: '战略体检', agentKey: 'strat' } });
    assert.equal(gen.status, 200);
    assert.equal(gen.body.creditBalance, -1, '不限量套餐报告产出后仍为不限量');
    assert.equal((await api('GET', '/api/me', { token: t })).body.creditBalance, -1);
  });
});

// ───────────────────────── TC-V 智能体权益（赠送 / 解锁 / 按次 / 后台开通） ─────────────────────────
describe('TC-V 智能体权益', () => {
  test('V1 GET /agents 返回 billing/price/owned；免费可用、付费默认未解锁', async () => {
    const t = await login(uniquePhone());
    const list = (await api('GET', '/api/agents', { token: t })).body as any[];
    const strat = list.find((a) => a.key === 'strat');
    const copy = list.find((a) => a.key === 'copy');
    const ip = list.find((a) => a.key === 'ip');
    assert.equal(strat.billing, 'free');
    assert.equal(strat.owned, true, '免费智能体恒为已拥有');
    assert.equal(copy.billing, 'unlock');
    assert.equal(copy.owned, false, '付费解锁类默认未拥有');
    assert.ok(copy.price > 0, 'unlock 应有价格');
    assert.equal(ip.billing, 'metered');
    assert.equal(ip.owned, true, '按次计费无需解锁，owned=true');
  });

  test('V2 未解锁 unlock 智能体产出 → 403 AGENT_LOCKED，不留会话', async () => {
    const t = await login(uniquePhone());
    const r = await api('POST', '/api/generate-sync', { token: t, body: { text: '写个文案', agentKey: 'copy' } });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'AGENT_LOCKED');
    assert.equal((await api('GET', '/api/sessions', { token: t })).body.length, 0, '被拦截不应留下会话');
  });

  test('V3 用算力解锁 unlock 智能体 → 扣算力、owned=true、随后可产出', async () => {
    const t = await login(uniquePhone());
    const before = (await api('GET', '/api/me', { token: t })).body.creditBalance as number;
    const copy = (await api('GET', '/api/agents', { token: t })).body.find((a: any) => a.key === 'copy');
    assert.ok(before >= copy.price, '体验版赠送算力应足够解锁 copy');

    const buy = await api('POST', '/api/agents/copy/purchase', { token: t, body: {} });
    assert.equal(buy.status, 200);
    assert.equal(buy.body.alreadyOwned, false);
    assert.equal(buy.body.pricePaid, copy.price);
    assert.equal(buy.body.creditBalance, before - copy.price, '解锁应扣减算力');
    assert.equal((await api('GET', '/api/me', { token: t })).body.creditBalance, before - copy.price, '/me 同步');

    const owned = (await api('GET', '/api/agents', { token: t })).body.find((a: any) => a.key === 'copy');
    assert.equal(owned.owned, true);

    const gen = await api('POST', '/api/generate-sync', { token: t, body: { text: '写个文案', agentKey: 'copy' } });
    assert.equal(gen.status, 200);
    assert.equal(gen.body.kind, 'report');
  });

  test('V4 解锁幂等：重复购买不再扣费、alreadyOwned=true', async () => {
    const t = await login(uniquePhone());
    const first = await api('POST', '/api/agents/copy/purchase', { token: t, body: {} });
    const balAfter = first.body.creditBalance as number;
    const again = await api('POST', '/api/agents/copy/purchase', { token: t, body: {} });
    assert.equal(again.status, 200);
    assert.equal(again.body.alreadyOwned, true);
    assert.equal(again.body.pricePaid, 0);
    assert.equal(again.body.creditBalance, balAfter, '重复购买余额不变');
  });

  test('V5 算力不足解锁 → 402 INSUFFICIENT_CREDITS，不开通', async () => {
    const t = await login(uniquePhone());
    const tenantId = await tenantOf(t);
    await prisma.creditLedger.create({ data: { tenantId, userId: t, delta: -999, reason: '测试置零', balance: 0 } });
    const buy = await api('POST', '/api/agents/intel/purchase', { token: t, body: {} });
    assert.equal(buy.status, 402);
    assert.equal(buy.body.code, 'INSUFFICIENT_CREDITS');
    const intel = (await api('GET', '/api/agents', { token: t })).body.find((a: any) => a.key === 'intel');
    assert.equal(intel.owned, false, '未成功扣费则不开通');
  });

  test('V6 free 类无需购买 → 返回 400 AGENT_NOT_PURCHASABLE', async () => {
    const t = await login(uniquePhone());
    const buy = await api('POST', '/api/agents/strat/purchase', { token: t, body: {} });
    assert.equal(buy.status, 400);
    assert.equal(buy.body.code, 'AGENT_NOT_PURCHASABLE');
  });

  test('V7 metered 智能体免解锁可用，按 price 计费', async () => {
    const t = await login(uniquePhone());
    const before = (await api('GET', '/api/me', { token: t })).body.creditBalance as number;
    const ip = (await api('GET', '/api/agents', { token: t })).body.find((a: any) => a.key === 'ip');
    const gen = await api('POST', '/api/generate-sync', { token: t, body: { text: '帮我打造企业 IP', agentKey: 'ip' } });
    assert.equal(gen.status, 200, 'metered 无需解锁即可使用');
    assert.equal(gen.body.kind, 'report');
    assert.equal(gen.body.creditBalance, before - ip.price, '按次计费应扣 price 算力');
  });

  test('V8 后台为用户开通/取消 unlock 智能体', async () => {
    const t = await login(uniquePhone());
    // 开通前：未拥有 + 产出被拦截
    assert.equal((await api('POST', '/api/generate-sync', { token: t, body: { text: '竞品分析', agentKey: 'intel' } })).status, 403);

    const grant = await api('POST', `/api/admin/users/${t}/agents`, { body: { agentKey: 'intel' } });
    assert.equal(grant.status, 200);
    const detail = await api('GET', `/api/admin/users/${t}`);
    const row = detail.body.agents.find((a: any) => a.key === 'intel');
    assert.equal(row.owned, true);
    assert.equal(row.source, 'admin_grant');
    // 开通后可产出
    assert.equal((await api('POST', '/api/generate-sync', { token: t, body: { text: '竞品分析', agentKey: 'intel' } })).status, 200);

    // 取消开通后重新被拦截
    const revoke = await api('DELETE', `/api/admin/users/${t}/agents/intel`);
    assert.equal(revoke.status, 200);
    assert.equal((await api('GET', `/api/agents`, { token: t })).body.find((a: any) => a.key === 'intel').owned, false);
  });

  test('V9 后台新增智能体 → 后台列表可见且默认下架', async () => {
    const create = await api('POST', '/api/admin/agents', { body: { key: 'legaltest', name: '法务顾问', role: '合同 · 合规', billing: 'unlock', price: 9 } });
    assert.equal(create.status, 200);
    const list = (await api('GET', '/api/admin/agents')).body as any[];
    const created = list.find((a) => a.key === 'legaltest');
    assert.ok(created, '后台列表应含新增智能体');
    assert.equal(created.billing, 'unlock');
    assert.equal(created.price, 9);
    assert.equal(created.enabled, false);
    // 清理，避免污染后续按 agent 计数的断言
    await prisma.agent.delete({ where: { key: 'legaltest' } });
  });
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

// ───────────────────────── TC-U 用户主要操作路径回归 ─────────────────────────
describe('TC-U 用户主要操作路径回归', () => {
  test('U1 登录→建档→项目知识→顾问产出→存库→纪要全链路可用', async () => {
    const t = await login(uniquePhone(), '主路径公司');
    const me0 = await api('GET', '/api/me', { token: t });
    const before = me0.body.creditBalance as number;
    assert.ok((await api('GET', '/api/agents')).body.length > 0, '应可拉取智能体');
    assert.ok((await api('GET', '/api/survey')).body.length > 0, '应可拉取建档问卷');

    await api('PUT', '/api/profile', { token: t, body: { industry: '企业服务', stage: 'A 轮前后', pain: '增长乏力' } });
    const project = await api('POST', '/api/projects', { token: t, body: { name: '主路径增长项目', summary: '验证完整用户路径' } });
    await api('POST', '/api/knowledge', {
      token: t,
      body: { projectId: project.body.id, title: '目标客群', text: '目标客户是 50-500 人规模的企业服务公司，重点关注续费率。' },
    });

    const gen = await api('POST', '/api/generate-sync', {
      token: t,
      body: { text: '围绕目标客群做一次战略体检', agentKey: 'strat', projectId: project.body.id },
    });
    assert.equal(gen.status, 200);
    assert.equal(gen.body.kind, 'report');
    assert.equal(gen.body.creditBalance, before, '文本报告走 token 额度，不扣钻石');

    const lib = await api('POST', '/api/library', {
      token: t,
      body: {
        title: '主路径战略体检',
        type: '战略体检',
        agentKey: 'strat',
        sessionId: gen.body.sessionId,
        projectId: project.body.id,
        content: gen.body.deliverable,
      },
    });
    assert.equal(lib.status, 200);
    assert.ok(lib.body.reportId && lib.body.version >= 1, '存库应桥接版本化报告');

    const summary = await api('POST', `/api/sessions/${gen.body.sessionId}/summarize`, { token: t });
    assert.equal(summary.status, 200);
    assert.ok(summary.body.reportId && summary.body.knowledgeAdded >= 1, '纪要应生成报告并沉淀知识');

    const detail = await api('GET', `/api/projects/${project.body.id}`, { token: t });
    assert.ok(detail.body.counts.sessions >= 1, '项目应聚合会话');
    assert.ok(detail.body.counts.reports >= 2, '项目应聚合存库报告和纪要报告');
    assert.ok(detail.body.counts.knowledge >= 2, '项目应聚合手动知识和纪要知识');
    assert.equal((await api('GET', '/api/me', { token: t })).body.creditBalance, before, '/me 钻石余额不变（文本走额度）');
  });
});

// ───────────────────────── TC-W 运营后台鉴权（防越权调用 /admin/*） ─────────────────────────
describe('TC-W 运营后台鉴权', () => {
  test('W1 无任何凭证访问后台接口 → 401', async () => {
    const r = await api('GET', '/api/admin/overview', { adminToken: false });
    assert.equal(r.status, 401);
    assert.equal(r.body.code, 'ADMIN_UNAUTHORIZED');
  });

  test('W2 普通小程序用户（非管理员）访问后台接口 → 403', async () => {
    const t = await login(uniquePhone());
    const r = await api('GET', '/api/admin/overview', { token: t, adminToken: false });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'ADMIN_FORBIDDEN');
  });

  test('W3 错误的 admin 密钥 → 401', async () => {
    const r = await api('GET', '/api/admin/overview', { adminToken: 'wrong-secret' });
    assert.equal(r.status, 401);
  });

  test('W4 正确的 admin 密钥 → 200', async () => {
    const r = await api('GET', '/api/admin/overview'); // helper 自动带正确 ADMIN_TOKEN
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.stats), '应返回看板数据');
  });

  test('W5 role=admin 账号（仅 x-user-id、无密钥）→ 200', async () => {
    const t = await login(uniquePhone());
    await prisma.user.update({ where: { id: t }, data: { role: 'admin' } });
    const r = await api('GET', '/api/admin/overview', { token: t, adminToken: false });
    assert.equal(r.status, 200);
  });

  test('W6 ★ 普通用户无法越权自助开通付费智能体（403 且确实未开通）', async () => {
    const t = await login(uniquePhone());
    // 尝试用自己的登录态调用后台开通接口给自己开通 unlock 智能体
    const grant = await api('POST', `/api/admin/users/${t}/agents`, { token: t, adminToken: false, body: { agentKey: 'intel' } });
    assert.ok(grant.status === 403 || grant.status === 401, '越权开通应被拒');
    // 校验确实未开通：产出仍被 AGENT_LOCKED 拦截
    const gen = await api('POST', '/api/generate-sync', { token: t, body: { text: '竞品分析', agentKey: 'intel' } });
    assert.equal(gen.status, 403);
    assert.equal(gen.body.code, 'AGENT_LOCKED');
  });
});

// ───────────────────────── TC-X 身份与账号注销 ─────────────────────────
describe('TC-X 身份与账号注销', () => {
  test('X1 注册不生成随机名；PUT /me 设置称呼+公司后 /me 同步', async () => {
    const t = await login(uniquePhone());
    const before = await api('GET', '/api/me', { token: t });
    assert.equal(before.body.user.name, '', '新账号不应有编造的随机名');
    assert.equal(before.body.understanding.title, '军师档案', '/me 应返回用户可读的经营理解');

    const tenantId = await tenantOf(t);
    await prisma.user.update({ where: { id: t }, data: { name: '用户1018' } });
    await prisma.tenant.update({ where: { id: tenantId }, data: { name: '企业1018' } });
    const placeholder = await api('GET', '/api/me', { token: t });
    const identity = placeholder.body.understanding.sections.find((s: any) => s.key === 'identity');
    assert.deepEqual(identity.items, [], '历史占位名不应展示为真实经营身份');
    assert.ok(placeholder.body.understanding.nextQuestions.includes('以后军师怎么称呼你？'), '占位称呼应继续触发追问');
    assert.ok(placeholder.body.understanding.nextQuestions.includes('你的公司、门店或品牌叫什么？'), '占位公司应继续触发追问');

    const alias = await api('GET', '/api/auth/suggest-name');
    assert.equal(alias.status, 200);
    assert.ok(alias.body.name && alias.body.source, '应返回一个可填入注册框的花名');
    const aliasToken = await login(uniquePhone(), alias.body.name);
    const aliasMe = await api('GET', '/api/me', { token: aliasToken });
    assert.equal(aliasMe.body.user.name, alias.body.name, '花名只作为用户称呼');
    assert.equal(aliasMe.body.tenant.name, '', '花名不应被写成公司名');

    const upd = await api('PUT', '/api/me', { token: t, body: { name: '王越', company: '云栖科技' } });
    assert.equal(upd.status, 200);
    const me = await api('GET', '/api/me', { token: t });
    assert.equal(me.body.user.name, '王越');
    assert.equal(me.body.tenant.name, '云栖科技', '公司应写入租户名');
  });

  test('X2 报告抬头带入真实公司而非硬编码', async () => {
    const t = await login(uniquePhone());
    await api('PUT', '/api/me', { token: t, body: { name: '李雷', company: '星澜科技' } });
    const r = await api('POST', '/api/generate-sync', { token: t, body: { text: '战略体检', agentKey: 'strat' } });
    assert.equal(r.body.kind, 'report');
    assert.ok(r.body.deliverable.meta.includes('星澜科技'), '成果抬头应带入真实公司名');
    assert.ok(!r.body.deliverable.meta.includes('云栖科技'), '不应出现硬编码的占位公司');
  });

  test('X3 军师档案访谈模式不自动召回旧项目/知识', async () => {
    const t = await login(uniquePhone());
    const tenantId = await tenantOf(t);
    const p = await api('POST', '/api/projects', { token: t, body: { name: '2026 融资冲刺', summary: '旧项目摘要：A 轮估值逻辑' } });
    const k = await api('POST', '/api/knowledge', {
      token: t,
      body: { text: '旧融资报告：高价值客群在制造/医疗，NRR 100-110%', projectId: p.body.id, kind: 'insight', title: '旧融资报告' },
    });
    await prisma.memory.create({
      data: {
        tenantId, userId: t, agentKey: 'general', kind: 'insight',
        text: '旧记忆：融资冲刺里提过三层定价',
        source: 'conversation', weight: 1,
      },
    });

    const { ctx, knowledgeUsed } = await buildGenContext({
      userId: t,
      tenantId,
      agentKey: 'general',
      projectId: p.body.id,
      refs: [{ kind: 'knowledge', id: k.body.id, label: '旧融资报告' }],
      userMessage: '请进入军师档案访谈模式，先问我几个简单问题',
    });
    assert.deepEqual(ctx.memories, [], '访谈模式不应召回长期记忆');
    assert.deepEqual(ctx.references, [], '访谈模式不应注入显式旧引用');
    assert.deepEqual(ctx.knowledge, [], '访谈模式不应自动召回知识库');
    assert.equal(ctx.projectSummary, null, '访谈模式不应带旧项目摘要展开分析');
    assert.deepEqual(knowledgeUsed, [], '访谈模式不应声明使用旧资料');
  });

  test('X4 注销账号 → 删除数据，原 token 失效', async () => {
    const t = await login(uniquePhone());
    await api('POST', '/api/generate-sync', { token: t, body: { text: '战略体检', agentKey: 'strat' } });
    const del = await api('DELETE', '/api/me', { token: t });
    assert.equal(del.status, 200);
    const after = await api('GET', '/api/me', { token: t });
    assert.equal(after.status, 401, '注销后原登录态应失效');
    assert.equal(await prisma.user.count({ where: { id: t } }), 0, '用户记录应被删除');
  });
});

// ───────────────────────── TC-Y Token 用量计量（计费 P1·旁路统计） ─────────────────────────
describe('TC-Y Token 用量计量', () => {
  test('Y1 recordTokenUsage 落库并估算成本；零 token（mock）跳过', async () => {
    const t = await login(uniquePhone(), 'Token甲');
    const tenantId = await tenantOf(t);
    await recordTokenUsage({ tenantId, userId: t, sessionId: null, agentKey: 'strat', kind: 'deliverable', provider: 'openai', model: 'gpt-4o', usage: { inputTokens: 1000, outputTokens: 500, cachedInput: 0 } });
    await recordTokenUsage({ tenantId, userId: t, kind: 'chat', provider: 'mock', model: 'template', usage: { inputTokens: 0, outputTokens: 0, cachedInput: 0 } });
    const rows = await prisma.tokenUsage.findMany({ where: { userId: t } });
    assert.equal(rows.length, 1, '零 token 的 mock 调用不应落库');
    assert.equal(rows[0].totalTokens, 1500);
    assert.equal(rows[0].costMicros, 54000); // gpt-4o 元价(美元价×7.2)：1000*18 + 500*72（微元）
  });

  test('Y2 tokenUsageSummary 与 /admin/token-usage 同口径', async () => {
    const t = await login(uniquePhone(), 'Token乙');
    const tenantId = await tenantOf(t);
    await recordTokenUsage({ tenantId, userId: t, kind: 'deliverable', provider: 'openai', model: 'gpt-4o', usage: { inputTokens: 2000, outputTokens: 1000, cachedInput: 0 } });
    const sum = await tokenUsageSummary(30);
    assert.ok(sum.totals.totalTokens >= 3000, '总 token 应累计');
    assert.ok(sum.byModel.find((m) => m.model === 'gpt-4o')?.calibrated, 'gpt-4o 单价应在价表内');
    const view = await api('GET', '/api/admin/token-usage'); // helper 自动带 ADMIN_TOKEN
    assert.equal(view.status, 200);
    assert.equal(view.body.totals.totalTokens, sum.totals.totalTokens);
  });

  test('Y3 注销账号连带清除其 token 用量（外键安全）', async () => {
    const t = await login(uniquePhone(), 'Token丙');
    const tenantId = await tenantOf(t);
    await recordTokenUsage({ tenantId, userId: t, kind: 'chat', provider: 'openai', model: 'gpt-4o', usage: { inputTokens: 100, outputTokens: 50, cachedInput: 0 } });
    assert.equal(await prisma.tokenUsage.count({ where: { userId: t } }), 1);
    const del = await api('DELETE', '/api/me', { token: t });
    assert.equal(del.status, 200);
    assert.equal(await prisma.tokenUsage.count({ where: { tenantId } }), 0, '注销后该租户 token 流水应清空');
  });
});

// ───────────────────────── TC-Z 月度 Token 额度（双轴计费 P2） ─────────────────────────
describe('TC-Z 月度 Token 额度', () => {
  test('Z1 setQuota/charge/ensure：ceil(token×ratio) 扣减、透支后拦截', async () => {
    const t = await login(uniquePhone(), '额度甲');
    const tenantId = await tenantOf(t);
    await setQuota(tenantId, t, 1000);
    let st = await getQuotaState(t);
    assert.equal(st.quota, 1000);
    assert.equal(st.used, 0);
    assert.equal(st.unlimited, false);
    st = await chargeQuota(t, 300, 1.5); // ceil(300×1.5)=450
    assert.equal(st.used, 450);
    assert.equal(st.balance, 550);
    await ensureQuota(t); // 余额>0 放行（不抛）
    await chargeQuota(t, 1000, 1); // 透支到负
    await assert.rejects(() => ensureQuota(t), (e: unknown) => (e as { code?: string }).code === 'INSUFFICIENT_QUOTA');
  });

  test('Z2 不限量(quota=-1) 放行且不扣', async () => {
    const t = await login(uniquePhone(), '额度乙');
    const tenantId = await tenantOf(t);
    await setQuota(tenantId, t, -1);
    await ensureQuota(t);
    const st = await chargeQuota(t, 99999, 5);
    assert.equal(st.unlimited, true);
  });

  test('Z3 /me 含 tokenQuota；/me/credits 返回钻石流水', async () => {
    const t = await login(uniquePhone(), '额度丙');
    const tenantId = await tenantOf(t);
    await setQuota(tenantId, t, 500);
    const me = await api('GET', '/api/me', { token: t });
    assert.equal(me.status, 200);
    assert.equal(me.body.tokenQuota.limit, 500);
    assert.ok('creditBalance' in me.body, '应保留钻石轴');
    const cr = await api('GET', '/api/me/credits', { token: t });
    assert.equal(cr.status, 200);
    assert.ok(Array.isArray(cr.body.items));
  });

  test('Z4 注销连带清除 token_wallet（外键安全）', async () => {
    const t = await login(uniquePhone(), '额度丁');
    const tenantId = await tenantOf(t);
    await setQuota(tenantId, t, 1000);
    assert.equal(await prisma.tokenWallet.count({ where: { userId: t } }), 1);
    const del = await api('DELETE', '/api/me', { token: t });
    assert.equal(del.status, 200);
    assert.equal(await prisma.tokenWallet.count({ where: { tenantId } }), 0, '注销后租户额度账户应清空');
  });
});
