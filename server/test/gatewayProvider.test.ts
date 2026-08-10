// Gateway × Provider 错误路径集成测试：端到端跑「路由 → gateway → openai provider → fetch」，
// 用 globalThis.fetch stub 模拟 OpenAI 兼容协议的 正常 / 429 / 500 / 超时(abort) 返回，
// 断言 gateway 的兜底决策与错误映射（这正是 PR #4 调整的 AI_FALLBACK_MOCK + aiUnavailable 逻辑）：
//   - 真实调用成功 → 原样返回模型文本（证明走的是真 provider 代码路径，不是 mock）
//   - 调用失败 + AI_FALLBACK_MOCK=false → 503 AI_UNAVAILABLE（abort→「超时」，其它→「不可用」）
//   - 调用失败 + AI_FALLBACK_MOCK=true  → 静默兜底 mock，200
// 不出网：fetch 被打桩；用 AI_ALLOW_REAL_PROVIDER=1 仅放行「provider 代码路径」（见 env.isAiTestMode）。
//   cd server && node --import tsx --test test/gatewayProvider.test.ts
import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, closeApp, seedBaseline, cleanBusiness, login, api, uniquePhone } from './helpers.js';
import { prisma } from '../src/db.js';
import { env } from '../src/env.js';
import { publishDraft } from '../src/services/agentVersions.js';

const CHAT_URL = '/chat/completions';
const realFetch = globalThis.fetch;
const origFallback = env.aiFallbackMock;

// 把 general 配成自定义 OpenAI 端点（providerMode=openai）。明文 key 透传（未配加密），isRealKey=true。
async function makeGeneralOpenai() {
  await prisma.agent.update({
    where: { key: 'general' },
    data: { providerMode: 'openai', apiBaseUrl: 'http://mock.test/v1', apiModel: 'mock-model', apiKey: 'sk-test-real-123' },
  });
  await publishDraft('general', { label: 'gateway provider test' });
}
async function resetGeneral() {
  await prisma.agent.update({
    where: { key: 'general' },
    data: { providerMode: 'inherit', apiBaseUrl: null, apiModel: null, apiKey: null },
  });
  await publishDraft('general', { label: 'gateway provider reset' });
}

// 只拦截 chat/completions；其余出站请求一律报错（不该有——嵌入/检索在测试里走本地确定性，不出网）。
function stubFetch(handler: (url?: any, init?: RequestInit) => { ok: boolean; status: number; body: unknown } | Promise<never>) {
  globalThis.fetch = (async (url: any, init?: RequestInit) => {
    if (!String(url).includes(CHAT_URL)) throw new Error(`unexpected fetch: ${url}`);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    const auxiliary = auxiliaryResponse(body);
    if (auxiliary) return auxiliary;
    const r = await handler(url, init);
    return { ok: r.ok, status: r.status, json: async () => r.body } as unknown as Response;
  }) as unknown as typeof fetch;
}

function streamResponse(chunks: string[]): Response {
  const enc = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/**
 * 主回答落库后还会异步触发标题、记忆与摘要提炼。它们共用同一自定义端点，但不属于本文件要
 * 统计的 provider 主链调用；若让它们落进下一条用例的 fetch stub，调用次数会随调度时序漂移。
 */
function auxiliaryResponse(body: Record<string, unknown>): Response | null {
  const messages = Array.isArray(body.messages) ? body.messages as { role?: string; content?: unknown }[] : [];
  const system = messages.find((item) => item.role === 'system')?.content;
  const prompt = typeof system === 'string' ? system : '';
  let content: string | null = null;
  if (/记忆抽取官/.test(prompt)) content = '{"facts":[]}';
  else if (/会话取名助手/.test(prompt)) content = '{"title":"测试会话"}';
  else if (/会话索引器/.test(prompt)) content = '{"items":[]}';
  if (content === null) return null;
  return Response.json({
    choices: [{ finish_reason: 'stop', message: { content } }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  });
}

/** 按调用序返回不同的流：第 n 次请求用 sequences[n]（用尽后沿用最后一条）。供续写路径测试。 */
function stubStreamSeq(sequences: string[][], inspect?: (body: Record<string, unknown>, call: number) => void) {
  let call = 0;
  globalThis.fetch = (async (url: any, init?: RequestInit) => {
    if (!String(url).includes(CHAT_URL)) throw new Error(`unexpected fetch: ${url}`);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    const auxiliary = auxiliaryResponse(body);
    if (auxiliary) return auxiliary;
    const i = call++;
    inspect?.(body, i);
    return streamResponse(sequences[Math.min(i, sequences.length - 1)]);
  }) as unknown as typeof fetch;
  return () => call;
}

function stubStream(chunks: string[], inspect?: (body: Record<string, unknown>) => void) {
  globalThis.fetch = (async (url: any, init?: RequestInit) => {
    if (!String(url).includes(CHAT_URL)) throw new Error(`unexpected fetch: ${url}`);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    const auxiliary = auxiliaryResponse(body);
    if (auxiliary) return auxiliary;
    inspect?.(body);
    return streamResponse(chunks);
  }) as unknown as typeof fetch;
}
// 模拟 AbortController 超时：fetch reject 一个含 abort 字样的错误（aiUnavailable 据此判「超时」）。
function stubAbort() {
  globalThis.fetch = (async (url: any) => {
    if (!String(url).includes(CHAT_URL)) throw new Error(`unexpected fetch: ${url}`);
    const e = new Error('The operation was aborted'); (e as Error & { name: string }).name = 'AbortError';
    throw e;
  }) as unknown as typeof fetch;
}

async function gen(token: string, text: string) {
  return api('POST', '/api/generate-sync', { token, body: { text, agentKey: 'general' } });
}

// Gateway 用例只测 provider，不测首次入局。2026-07-21 入局门上线后，新注册账号必须先有 Profile，
// 否则请求会被补档案流程提前接管；过去这组测试只因运行日期尚早于上线日而偶然通过。
async function loginReady(): Promise<string> {
  const token = await login(uniquePhone());
  const user = await prisma.user.findUniqueOrThrow({ where: { id: token }, select: { tenantId: true } });
  await prisma.profile.create({ data: { tenantId: user.tenantId, industry: '企业服务' } });
  return token;
}

describe('Gateway × Provider 错误路径', () => {
  before(async () => {
    process.env.AI_ALLOW_REAL_PROVIDER = '1'; // 放行真实 provider 代码路径（fetch 仍被打桩）
    await getApp();
    await cleanBusiness();
    await seedBaseline();
    await makeGeneralOpenai();
  });
  after(async () => {
    await resetGeneral();
    delete process.env.AI_ALLOW_REAL_PROVIDER;
    globalThis.fetch = realFetch;
    env.aiFallbackMock = origFallback;
    await closeApp();
  });
  beforeEach(() => { env.aiFallbackMock = origFallback; });
  afterEach(() => { globalThis.fetch = realFetch; });

  test('真实调用成功 → 原样返回模型文本（证明走真 provider，非 mock）', async () => {
    stubFetch(() => ({
      ok: true, status: 200,
      body: { choices: [{ message: { content: '机构级判断：先稳现金流，再谈增长。' } }], usage: { prompt_tokens: 12, completion_tokens: 8 } },
    }));
    const t = await loginReady();
    const r = await gen(t, '我该先做什么');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.kind, 'chat');
    assert.equal(r.body.reply.text, '机构级判断：先稳现金流，再谈增长。');
    const trace = await prisma.llmTrace.findFirstOrThrow({
      where: { userId: t, status: 'ok', kind: 'chat' },
      orderBy: { createdAt: 'desc' },
    });
    assert.equal(trace.model, 'mock-model', 'trace 应记录实际请求 model');
    assert.equal(trace.endpointId, null, 'per-agent 自定义接入没有全局 AiModel.id');
    assert.equal(trace.endpointLabel, 'general 自定义端点', 'trace 应标明实际自定义端点，不能误记全局 activeModel');
  });

  test('/generate 普通聊天 → OpenAI 原生 stream 分段下发，输出不再走阻塞审核', async () => {
    let called = 0;
    stubStream([
      'data: {"choices":[{"delta":{"content":"第一段，"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"赌博风险应直接规避。"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":8}}\n\n',
      'data: [DONE]\n\n',
    ], (body) => {
      called++;
      assert.equal(body.stream, true, '普通聊天必须请求 provider 原生 stream');
      assert.deepEqual(body.stream_options, { include_usage: true });
    });
    const t = await loginReady();
    const r = await api('POST', '/api/generate', { token: t, body: { text: '聊聊合规风险', agentKey: 'general' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(called, 1, '原生流式成功时不应再补打一遍非流式请求');
    const sse = String(r.body);
    assert.match(sse, /event: token\ndata: \{"text":"第一段，"\}/, '第一段 token 应单独下发');
    assert.match(sse, /event: token\ndata: \{"text":"赌博风险应直接规避。"\}/, '第二段 token 应单独下发');
    assert.match(sse, /event: chat/);
    assert.match(sse, /第一段，赌博风险应直接规避。/);
    assert.match(sse, /event: done/);
    const outputLogs = await prisma.moderationLog.count({ where: { userId: t, refType: 'output' } });
    assert.equal(outputLogs, 0, '输出不再进入阻塞式 moderation_log');
  });

  test('/generate 流式撞输出上限 → 自动续写接上，用户看到一条完整回复', async () => {
    // 第 1 轮 finish_reason=length（没写完），第 2 轮正常收尾。用户视角是一条连续的回复。
    const calls = stubStreamSeq([
      [
        'data: {"choices":[{"delta":{"content":"这是一段还没写完的长回复"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":8000}}\n\n',
        'data: [DONE]\n\n',
      ],
      [
        'data: {"choices":[{"delta":{"content":"，后半段补齐了。"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":300,"completion_tokens":40}}\n\n',
        'data: [DONE]\n\n',
      ],
    ], (body, call) => {
      const msgs = body.messages as { role: string; content: string }[];
      if (call === 0) return;
      // 续写请求的形态是「残文进 assistant 历史 + 指令进 user 轮」——**不能**是末轮 assistant
      // prefill：Claude Opus 4.6 及以后已移除末轮 prefill，会直接 400。
      assert.equal(msgs[msgs.length - 1].role, 'user', '续写指令必须在 user 轮，不能用末轮 assistant prefill');
      assert.equal(msgs[msgs.length - 2].role, 'assistant');
      assert.match(msgs[msgs.length - 2].content, /这是一段还没写完的长回复/, '残文要作为上下文带回去');
      assert.match(msgs[msgs.length - 1].content, /接着写完/);
    });
    const t = await loginReady();
    // 不使用“给我出方案/报告”等明确成果动作词：统一输出意图路由会正确切到报告链，
    // 这里要锁的是普通聊天正文撞上限后的流式续写。
    const r = await api('POST', '/api/generate', { token: t, body: { text: '把这个问题完整讲透，细节多一些', agentKey: 'general' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(calls(), 2, '撞上限应自动续写一轮');
    const sse = String(r.body);
    assert.match(sse, /event: token\ndata: \{"text":"这是一段还没写完的长回复"\}/);
    assert.match(sse, /后半段补齐了。/, '续写内容要接着流给用户');
    assert.match(sse, /event: chat/);
    assert.doesNotMatch(sse, /event: error/, '能续写完就不是错误');
    assert.doesNotMatch(sse, /truncated/, '续写成功后不该再标未写完');
    assert.match(sse, /event: done/);
    const msg = await prisma.message.findFirstOrThrow({
      where: { role: 'assistant', session: { userId: t } },
      orderBy: { createdAt: 'desc' },
    });
    const content = msg.contentJson as { text?: string; truncated?: boolean };
    assert.equal(content.text, '这是一段还没写完的长回复，后半段补齐了。', '落库的是拼接后的完整正文');
    assert.equal(content.truncated, undefined);
  });

  test('/generate 续写轮数用尽仍未写完 → 内容照常落库并标 truncated，不报错', async () => {
    // 每一轮都 length：首轮 + 2 轮续写用尽后，交回用户决定是否继续。
    const calls = stubStreamSeq([[
      'data: {"choices":[{"delta":{"content":"永远写不完的长回复"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":8000}}\n\n',
      'data: [DONE]\n\n',
    ]]);
    const t = await loginReady();
    const r = await api('POST', '/api/generate', { token: t, body: { text: '这个问题请讲透一点，越细越好', agentKey: 'general' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(calls(), 3, '首轮 + 2 轮续写，不能无限续');
    const sse = String(r.body);
    assert.doesNotMatch(sse, /event: error/, '有可读内容就不能变成错误气泡');
    assert.match(sse, /event: chat/);
    assert.match(sse, /"truncated":true/, '要把「还没写完」透给端上做「继续」入口');
    assert.match(sse, /event: done/);
    const msg = await prisma.message.findFirstOrThrow({
      where: { role: 'assistant', session: { userId: t } },
      orderBy: { createdAt: 'desc' },
    });
    const content = msg.contentJson as { text?: string; truncated?: boolean };
    assert.equal(content.truncated, true, '未写完的标记要跟着消息落库，重进会话仍能点继续');
    assert.ok((content.text ?? '').includes('永远写不完的长回复'), '已写出的内容不得丢弃');
  });

  test('429 + AI_FALLBACK_MOCK=false → 503 AI_UNAVAILABLE', async () => {
    env.aiFallbackMock = false;
    stubFetch(() => ({ ok: false, status: 429, body: { error: { message: 'rate limited' } } }));
    const t = await loginReady();
    const r = await gen(t, '帮我看下增长');
    assert.equal(r.status, 503);
    assert.equal(r.body.code, 'AI_UNAVAILABLE');
  });

  test('500 + AI_FALLBACK_MOCK=false → 503 AI_UNAVAILABLE', async () => {
    env.aiFallbackMock = false;
    stubFetch(() => ({ ok: false, status: 500, body: { error: { message: 'boom' } } }));
    const t = await loginReady();
    const r = await gen(t, '诊断一下');
    assert.equal(r.status, 503);
    assert.equal(r.body.code, 'AI_UNAVAILABLE');
  });

  test('OpenAI 兼容返回 length 且正文为空 → 503 截断（无锚点可续写），不落固定追问兜底', async () => {
    // 这个形态几乎总是思考预算把 max_tokens 占满了：没有任何正文可作续写锚点，只能如实报错。
    env.aiFallbackMock = false;
    let calls = 0;
    stubFetch(() => {
      calls++;
      return {
        ok: true, status: 200,
        body: {
          choices: [{ finish_reason: 'length', message: { content: '' } }],
          usage: { prompt_tokens: 120, completion_tokens: 1500 },
        },
      };
    });
    const t = await loginReady();
    const r = await gen(t, '我已经给了背景，继续判断');
    assert.equal(r.status, 503);
    assert.equal(r.body.code, 'AI_OUTPUT_TRUNCATED');
    assert.equal(calls, 1, '没有正文时不该空转续写');
    assert.doesNotMatch(String(r.body.error), /我需要更多信息/);
  });

  test('OpenAI 兼容非流式撞上限但有正文 → 自动续写后返回完整回复', async () => {
    env.aiFallbackMock = false;
    let calls = 0;
    stubFetch((_url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { messages: { role: string; content: string }[] };
      const first = calls++ === 0;
      if (!first) {
        const msgs = body.messages;
        assert.equal(msgs[msgs.length - 1].role, 'user', '续写指令必须在 user 轮');
        assert.match(msgs[msgs.length - 2].content, /前半段判断/);
      }
      return {
        ok: true, status: 200,
        body: {
          choices: [{
            finish_reason: first ? 'length' : 'stop',
            message: { content: first ? '前半段判断' : '，以及后半段结论。' },
          }],
          usage: { prompt_tokens: 120, completion_tokens: first ? 8000 : 30 },
        },
      };
    });
    const t = await loginReady();
    const r = await gen(t, '给我完整判断');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(calls, 2);
    assert.equal((r.body as { reply?: { text?: string; truncated?: boolean } }).reply?.text, '前半段判断，以及后半段结论。');
    assert.equal((r.body as { reply?: { truncated?: boolean } }).reply?.truncated, undefined);
  });

  test('on-demand 明确“出报告” → 强制结构化成果，sections 非数组也不报 AI_UNAVAILABLE', async () => {
    env.aiFallbackMock = false;
    stubFetch((_url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { tool_choice?: { function?: { name?: string } } };
      assert.equal(body.tool_choice?.function?.name, 'emit_deliverable', '明确报告请求必须强制调用结构化成果工具');
      return {
        ok: true,
        status: 200,
        body: {
          choices: [{
            message: {
              tool_calls: [{
                function: {
                  name: 'emit_deliverable',
                  arguments: JSON.stringify({
                    title: '测试报告',
                    sections: { h: '判断', b: '先收口到一个主战场。', list: ['保现金流', '聚焦案例'] },
                  }),
                },
              }],
            },
          }],
          usage: { prompt_tokens: 120, completion_tokens: 80 },
        },
      };
    });
    const t = await loginReady();
    const r = await gen(t, '出报告');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.kind, 'report');
    assert.equal(r.body.deliverable?.title, '测试报告');
    assert.equal(r.body.deliverable?.sections?.[0]?.h, '判断');
  });

  test('报告误带代码工作区语境 → gateway 替换为业务兜底成果', async () => {
    env.aiFallbackMock = false;
    stubFetch(() => ({
      ok: true,
      status: 200,
      body: {
        choices: [{
          message: {
            tool_calls: [{
              function: {
                name: 'emit_deliverable',
                arguments: JSON.stringify({
                  title: '战略诊断报告',
                  sections: [
                    {
                      h: '现状诊断',
                      b: '当前工作区为一个 Git 仓库，但缺少足够的项目文档、业务数据或战略输入材料。',
                    },
                    { h: '下一步', list: ['请上传业务文档到工作区'] },
                  ],
                }),
              },
            }],
          },
        }],
        usage: { prompt_tokens: 120, completion_tokens: 80 },
      },
    }));
    const t = await loginReady();
    const r = await gen(t, '出报告');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.kind, 'report');
    assert.equal(r.body.deliverable?.degraded, true, '跑偏报告应标记 degraded，前台不扣额度');
    const text = JSON.stringify(r.body.deliverable);
    assert.doesNotMatch(text, /Git|当前工作区|代码仓库|上传业务文档到工作区/);
  });

  test('超时(abort) + AI_FALLBACK_MOCK=false → 503 且提示「超时」', async () => {
    env.aiFallbackMock = false;
    stubAbort();
    const t = await loginReady();
    const r = await gen(t, '慢慢想');
    assert.equal(r.status, 503);
    assert.equal(r.body.code, 'AI_UNAVAILABLE');
    assert.match(r.body.error, /超时/);
  });

  test('429 + AI_FALLBACK_MOCK=true → 静默兜底 mock，200', async () => {
    env.aiFallbackMock = true;
    stubFetch(() => ({ ok: false, status: 429, body: { error: { message: 'rate limited' } } }));
    const t = await loginReady();
    const r = await gen(t, '兜底应答');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.kind, 'chat');
    assert.ok(r.body.reply.text && r.body.reply.text.length > 0, 'mock 应返回非空文本');
  });
});
