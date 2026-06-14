// Dify 提供方单元测试（纯单元、不连库、不联网）。
// 思路：stub globalThis.fetch 拦截出站请求，断言「请求构造」与「响应解析」两侧契约；
//       与集成测试（需 PostgreSQL）解耦，可单独跑：
//   cd server && node --import tsx --test test/dify.test.ts
// 覆盖：chat-messages 请求构造（URL/鉴权头/body 字段/inputs 占位符映射）、
//       响应解析（answer/conversation_id/空值兜底/非 2xx 抛错/user 回退链）、
//       difyDeliverable 成果包装、difyPing 连通性测试各分支、fillPlaceholders 占位符替换。
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { difyChat, difyDeliverable, difyPing } from '../src/llm/providers/dify.js';
import { fillPlaceholders } from '../src/llm/schema.js';
import type { GenContext, AgentRuntime } from '../src/llm/schema.js';

// ── fetch stub：记录最近一次调用，按需返回伪 Response 或抛错 ──
interface FetchCall { url: string; init: RequestInit; body: any; }
let lastCall: FetchCall | null = null;
const realFetch = globalThis.fetch;

function stubFetch(impl: (call: FetchCall) => { ok: boolean; status: number; body: unknown } | Promise<never>): void {
  globalThis.fetch = (async (url: any, init: any = {}) => {
    const parsed = init?.body ? JSON.parse(init.body) : undefined;
    const call: FetchCall = { url: String(url), init, body: parsed };
    lastCall = call;
    const out = impl(call); // 可能 throw（模拟网络错误）
    const { ok, status, body } = await out;
    return { ok, status, json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;
}

function okResponse(body: Record<string, unknown>) {
  return () => ({ ok: true, status: 200, body });
}

beforeEach(() => { lastCall = null; });
afterEach(() => { globalThis.fetch = realFetch; });

// ── 构造 GenContext：base 给 Dify runtime，rt 覆盖 runtime，over 覆盖顶层字段 ──
const BASE_RT: AgentRuntime = {
  mode: 'dify',
  difyBaseUrl: 'http://ai.aibuzz.cn/v1',
  difyApiKey: 'app-secret',
  difyInputs: {},
  user: 'user-123',
  sessionId: 'sess-1',
  conversationId: null,
};

function makeCtx(over: Partial<GenContext> = {}, rt: Partial<AgentRuntime> = {}): GenContext {
  return {
    agentKey: 'dify_agent',
    agentName: 'Dify 智能体',
    systemPrompt: '',
    deliverableKey: null,
    companyName: null,
    profile: null,
    memories: [],
    benmingColor: 'gold',
    benchmark: '行业基准文本',
    userMessage: '帮我看下增长',
    runtime: { ...BASE_RT, ...rt },
    ...over,
  } as GenContext;
}

// ───────────────────────── fillPlaceholders（占位符填充，Dify inputs 与 system prompt 共用） ─────────────────────────
describe('fillPlaceholders', () => {
  test('企业档案：有 profile 时拼出 行业/阶段/最关注', () => {
    const ctx = makeCtx({ profile: { industry: '餐饮', stage: 'A轮', pain: '现金流' } });
    const out = fillPlaceholders('档案：{企业档案}', ctx);
    assert.match(out, /行业=餐饮/);
    assert.match(out, /阶段=A轮/);
    assert.match(out, /最关注=现金流/);
  });

  test('企业档案：无 profile → 「暂无企业档案」', () => {
    assert.equal(fillPlaceholders('{企业档案}', makeCtx({ profile: null })), '暂无企业档案');
  });

  test('长期记忆：多条用「；」连接；为空 → 「暂无长期记忆」', () => {
    assert.equal(fillPlaceholders('{长期记忆}', makeCtx({ memories: ['偏好稳健', '看重毛利'] })), '偏好稳健；看重毛利');
    assert.equal(fillPlaceholders('{长期记忆}', makeCtx({ memories: [] })), '暂无长期记忆');
  });

  test('客户名 / 用户消息 占位符', () => {
    const ctx = makeCtx({ companyName: '甲公司', userMessage: '问句' });
    assert.equal(fillPlaceholders('{客户名}|{用户消息}', ctx), '甲公司|问句');
  });

  test('replaceAll：同一占位符多次出现都被替换', () => {
    const ctx = makeCtx({ memories: ['M'] });
    assert.equal(fillPlaceholders('{长期记忆}-{长期记忆}', ctx), 'M-M');
  });

  test('未知占位符保持原样', () => {
    assert.equal(fillPlaceholders('{不存在}', makeCtx()), '{不存在}');
  });
});

// ───────────────────────── difyChat：请求构造 ─────────────────────────
describe('difyChat 请求构造', () => {
  test('POST {base}/chat-messages，base 末尾斜杠被裁掉', async () => {
    stubFetch(okResponse({ answer: 'ok', conversation_id: 'c1' }));
    await difyChat(makeCtx({}, { difyBaseUrl: 'http://ai.aibuzz.cn/v1///' }));
    assert.equal(lastCall!.url, 'http://ai.aibuzz.cn/v1/chat-messages');
    assert.equal(lastCall!.init.method, 'POST');
  });

  test('鉴权与内容类型头', async () => {
    stubFetch(okResponse({ answer: 'ok' }));
    await difyChat(makeCtx({}, { difyApiKey: 'app-secret' }));
    const h = lastCall!.init.headers as Record<string, string>;
    assert.equal(h.Authorization, 'Bearer app-secret');
    assert.equal(h['Content-Type'], 'application/json');
  });

  test('body：query=userMessage，blocking 模式，conversation_id 与 user 来自 runtime', async () => {
    stubFetch(okResponse({ answer: 'ok' }));
    await difyChat(makeCtx({ userMessage: '增长怎么做' }, { conversationId: 'conv-9', user: 'u-9' }));
    assert.equal(lastCall!.body.query, '增长怎么做');
    assert.equal(lastCall!.body.response_mode, 'blocking');
    assert.equal(lastCall!.body.conversation_id, 'conv-9');
    assert.equal(lastCall!.body.user, 'u-9');
  });

  test('conversation_id 缺省 → 空串', async () => {
    stubFetch(okResponse({ answer: 'ok' }));
    await difyChat(makeCtx({}, { conversationId: undefined }));
    assert.equal(lastCall!.body.conversation_id, '');
  });

  test('user 回退链：user → sessionId → agentKey', async () => {
    stubFetch(okResponse({ answer: 'ok' }));
    await difyChat(makeCtx({}, { user: undefined, sessionId: 'sess-X' }));
    assert.equal(lastCall!.body.user, 'sess-X');
    stubFetch(okResponse({ answer: 'ok' }));
    await difyChat(makeCtx({ agentKey: 'ak' }, { user: undefined, sessionId: undefined }));
    assert.equal(lastCall!.body.user, 'ak');
  });

  test('inputs：按占位符映射填充真实上下文', async () => {
    stubFetch(okResponse({ answer: 'ok' }));
    await difyChat(
      makeCtx({ companyName: '甲公司', memories: ['看重毛利'] }, { difyInputs: { client: '{客户名}', mem: '{长期记忆}', lit: '常量' } }),
    );
    assert.deepEqual(lastCall!.body.inputs, { client: '甲公司', mem: '看重毛利', lit: '常量' });
  });

  test('inputs：空映射 → {}；空 key 被跳过', async () => {
    stubFetch(okResponse({ answer: 'ok' }));
    await difyChat(makeCtx({}, { difyInputs: {} }));
    assert.deepEqual(lastCall!.body.inputs, {});
    stubFetch(okResponse({ answer: 'ok' }));
    await difyChat(makeCtx({ companyName: '乙' }, { difyInputs: { '': '{客户名}', ok: '{客户名}' } }));
    assert.deepEqual(lastCall!.body.inputs, { ok: '乙' });
  });
});

// ───────────────────────── difyChat：响应解析 ─────────────────────────
describe('difyChat 响应解析', () => {
  test('answer 去空白；conversation_id 透传', async () => {
    stubFetch(okResponse({ answer: '  你好  ', conversation_id: 'c-7' }));
    const r = await difyChat(makeCtx());
    assert.equal(r.reply.text, '你好');
    assert.equal(r.conversationId, 'c-7');
  });

  test('answer 为空 → 兜底文案；conversation_id 缺省 → null', async () => {
    stubFetch(okResponse({ answer: '' }));
    const r = await difyChat(makeCtx());
    assert.match(r.reply.text, /未返回内容/);
    assert.equal(r.conversationId, null);
  });

  test('非 2xx → 抛错（含状态码与 message）', async () => {
    stubFetch(() => ({ ok: false, status: 401, body: { message: '无效 key' } }));
    await assert.rejects(() => difyChat(makeCtx()), /Dify 401: 无效 key/);
  });

  test('非 2xx 且无 message/code → 「请求失败」', async () => {
    stubFetch(() => ({ ok: false, status: 500, body: {} }));
    await assert.rejects(() => difyChat(makeCtx()), /Dify 500: 请求失败/);
  });

  test('缺 baseUrl / 缺 apiKey → 抛配置错误（不发请求）', async () => {
    let called = false;
    stubFetch(() => { called = true; return { ok: true, status: 200, body: {} }; });
    await assert.rejects(() => difyChat(makeCtx({}, { difyBaseUrl: '' })), /baseUrl 未配置/);
    await assert.rejects(() => difyChat(makeCtx({}, { difyApiKey: '' })), /api_key 未配置/);
    assert.equal(called, false);
  });
});

// ───────────────────────── difyDeliverable：成果包装 ─────────────────────────
describe('difyDeliverable', () => {
  test('有模板（战略体检）→ 用模板标题/图标，answer 落入单 section', async () => {
    stubFetch(okResponse({ answer: '# 诊断\n正文', conversation_id: 'c-d' }));
    const { deliverable, conversationId } = await difyDeliverable(makeCtx({ deliverableKey: '战略体检' }));
    assert.equal(deliverable.title, '战略诊断报告');
    assert.equal(deliverable.icon, 'target');
    assert.equal(deliverable.sections.length, 1);
    assert.equal(deliverable.sections[0].h, '战略诊断报告');
    assert.equal(deliverable.sections[0].b, '# 诊断\n正文');
    assert.deepEqual(deliverable.actions, ['save_to_library', 'export_pdf']);
    assert.equal(conversationId, 'c-d');
  });

  test('无模板 → 用 agentName 作标题、spark 图标、section 标题「产出」', async () => {
    stubFetch(okResponse({ answer: '纯文本' }));
    const { deliverable } = await difyDeliverable(makeCtx({ deliverableKey: null, agentName: '我的Dify' }));
    assert.equal(deliverable.title, '我的Dify');
    assert.equal(deliverable.icon, 'spark');
    assert.equal(deliverable.sections[0].h, '产出');
  });

  test('userMessage 为空 → query 用「请为我产出一份{模板标题}。」兜底', async () => {
    stubFetch(okResponse({ answer: 'x' }));
    await difyDeliverable(makeCtx({ deliverableKey: '战略体检', userMessage: '' }));
    assert.equal(lastCall!.body.query, '请为我产出一份战略诊断报告。');
  });

  test('meta：companyName/行业/阶段 拼接；都为空 → 「经营快照」', async () => {
    stubFetch(okResponse({ answer: 'x' }));
    const r1 = await difyDeliverable(makeCtx({ companyName: '甲', profile: { industry: '餐饮', stage: 'A轮', pain: null } }));
    assert.equal(r1.deliverable.meta, '甲 · 餐饮 · A轮');
    stubFetch(okResponse({ answer: 'x' }));
    const r2 = await difyDeliverable(makeCtx({ companyName: null, profile: null }));
    assert.equal(r2.deliverable.meta, '经营快照');
  });

  test('answer 为空 → section 兜底文案', async () => {
    stubFetch(okResponse({ answer: '' }));
    const { deliverable } = await difyDeliverable(makeCtx({ deliverableKey: '战略体检' }));
    assert.match(deliverable.sections[0].b!, /未返回内容/);
  });
});

// ───────────────────────── difyPing：连通性测试 ─────────────────────────
describe('difyPing', () => {
  test('缺 baseUrl → ok:false 且不发请求', async () => {
    let called = false;
    stubFetch(() => { called = true; return { ok: true, status: 200, body: {} }; });
    const r = await difyPing({ difyApiKey: 'app-x' });
    assert.equal(r.ok, false);
    assert.match(r.error!, /baseUrl/);
    assert.equal(called, false);
  });

  test('缺 apiKey → ok:false 且不发请求', async () => {
    let called = false;
    stubFetch(() => { called = true; return { ok: true, status: 200, body: {} }; });
    const r = await difyPing({ difyBaseUrl: 'http://ai.aibuzz.cn/v1' });
    assert.equal(r.ok, false);
    assert.match(r.error!, /api_key/);
    assert.equal(called, false);
  });

  test('连通成功 → ok:true，latencyMs 为数字，sample 截取 answer；请求体为最小 ping', async () => {
    stubFetch(okResponse({ answer: '可用' }));
    const r = await difyPing({ difyBaseUrl: 'http://ai.aibuzz.cn/v1/', difyApiKey: 'app-x' });
    assert.equal(r.ok, true);
    assert.equal(typeof r.latencyMs, 'number');
    assert.equal(r.sample, '可用');
    assert.equal(lastCall!.url, 'http://ai.aibuzz.cn/v1/chat-messages');
    assert.equal(lastCall!.body.query, 'ping');
    assert.equal(lastCall!.body.user, 'admin-test');
  });

  test('非 2xx → ok:false 且 error 含状态码', async () => {
    stubFetch(() => ({ ok: false, status: 500, body: { code: 'internal' } }));
    const r = await difyPing({ difyBaseUrl: 'http://ai.aibuzz.cn/v1', difyApiKey: 'app-x' });
    assert.equal(r.ok, false);
    assert.match(r.error!, /Dify 500: internal/);
  });

  test('网络异常（fetch 抛错）→ ok:false 且回带 error', async () => {
    globalThis.fetch = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    const r = await difyPing({ difyBaseUrl: 'http://ai.aibuzz.cn/v1', difyApiKey: 'app-x' });
    assert.equal(r.ok, false);
    assert.match(r.error!, /ECONNREFUSED/);
  });
});
