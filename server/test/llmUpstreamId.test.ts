// 上游响应 id 捕获的回归测试。
//
// 为什么值得单独立一个文件：这个字段**存在的唯一理由是账单对账**——供应商工作台能按
// `chatcmpl-*` / `msg_*` 查单次调用，没有它我们最细只能对到「某模型某天的 token 数 ↔ 某计费项的
// 整月金额」（2026-07 账期就是这么被卡住的，只能给出合计倍数、给不出逐档单价）。
// 它不影响任何产出，所以一旦漏抓**永远不会有人发现**，只会在下次对账时才暴露，且那时数据已经没了。
// 因此三条路径（非流式 / 流式 / 报错）各钉一条用例。
import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createEndpointCapture, runWithEndpointCapture, noteUpstreamId } from '../src/services/llmPool.js';
import { claudeChatStream, claudeRawMetered, __setClaudeFetchForTest } from '../src/llm/providers/claude.js';
import { openaiRawMetered } from '../src/llm/providers/openai.js';
import type { GenContext } from '../src/llm/schema.js';
import type { ResolvedAiConfig } from '../src/services/aiConfig.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  __setClaudeFetchForTest(null);
  globalThis.fetch = realFetch;
});

const claudeCfg = {
  provider: 'claude', label: 'qnaigc-test', baseUrl: 'https://gateway.test', model: 'dj-claude-4.6-opus',
  apiKey: 'sk-real-test', embeddingModel: '', temperature: 0.6, thinkingMode: 'disabled', thinkingBudget: 1024,
  timeoutMs: 30_000, embeddingEnabled: false, embeddingBaseUrl: '', embeddingApiKey: '',
} as unknown as ResolvedAiConfig;

const openaiCfg = {
  ...claudeCfg, provider: 'openai', baseUrl: 'https://gateway.test/v1', model: 'moonshotai/kimi-k3',
} as unknown as ResolvedAiConfig;

const CTX = {
  systemPrompt: '你是顾问。', userMessage: '讲讲毛利', agentKey: 'general',
  history: [], memories: [], knowledge: [], refs: [],
} as unknown as GenContext;

/** Anthropic SSE：message_start 带 id，后续事件不带——正是要验证从 message_start 抓得到。 */
function anthropicSse(id: string, chunks: string[]): string {
  const ev = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  let out = ev('message_start', {
    type: 'message_start',
    message: { id, type: 'message', role: 'assistant', model: 'dj-claude-4.6-opus', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 0 } },
  });
  out += ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  for (const c of chunks) out += ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: c } });
  out += ev('content_block_stop', { type: 'content_block_stop', index: 0 });
  out += ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 40 } });
  out += ev('message_stop', { type: 'message_stop' });
  return out;
}

function stubClaudeSse(body: string): void {
  __setClaudeFetchForTest((async () => {
    const enc = new TextEncoder();
    return new Response(new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(enc.encode(body)); c.close(); },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as unknown as typeof globalThis.fetch);
}

function stubClaudeJson(id: string): void {
  __setClaudeFetchForTest((async () => new Response(JSON.stringify({
    id, type: 'message', role: 'assistant', model: 'dj-claude-4.6-opus',
    content: [{ type: 'text', text: '毛利先看结构。' }],
    stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof globalThis.fetch);
}

/** openai.ts 用的是 globalThis.fetch（不是 SDK shim），所以打全局有效。 */
function stubOpenai(status: number, body: unknown): void {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  })) as unknown as typeof globalThis.fetch;
}

describe('上游响应 id 捕获（账单对账用）', () => {
  test('Anthropic 非流式：从响应体 id 抓到 msg_*', async () => {
    stubClaudeJson('msg_01ABCdef');
    const capture = createEndpointCapture();
    await runWithEndpointCapture(capture, () => claudeRawMetered(claudeCfg, '系统', '用户'));
    assert.deepEqual(capture.upstreamIds, ['msg_01ABCdef']);
  });

  test('Anthropic 流式：从 message_start 抓到，且不因多事件重复', async () => {
    stubClaudeSse(anthropicSse('msg_stream_9', ['先看', '毛利', '结构。']));
    const capture = createEndpointCapture();
    await runWithEndpointCapture(capture, async () => {
      // 流式是惰性 generator，必须真的抽干才会产生外呼。
      for await (const _ of claudeChatStream(CTX, claudeCfg)) { /* drain */ }
    });
    // message_start 与 finalMessage 都会过 usageOf → 同一个 id 出现两次，必须只留一个。
    assert.deepEqual(capture.upstreamIds, ['msg_stream_9']);
  });

  test('OpenAI 兼容非流式：抓到 chatcmpl-*', async () => {
    stubOpenai(200, {
      id: 'chatcmpl-7Xk2p',
      choices: [{ message: { content: '毛利结构如下。' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 120, completion_tokens: 18 },
    });
    const capture = createEndpointCapture();
    await runWithEndpointCapture(capture, () => openaiRawMetered(openaiCfg, '系统', '用户'));
    assert.deepEqual(capture.upstreamIds, ['chatcmpl-7Xk2p']);
  });

  // 这条是本文件最重要的一条：**上游回了响应体就说明它已受理、账单上就有这一笔**，
  // 即使随后被判失败。失败的调用恰恰是最需要拿 id 去工作台反查的。
  test('OpenAI 兼容报错（429）：响应体带 id 时仍要抓到', async () => {
    stubOpenai(429, {
      id: 'chatcmpl-rate-limited',
      error: { message: 'rate limit reached', type: 'rate_limit_error' },
    });
    const capture = createEndpointCapture();
    await runWithEndpointCapture(capture, async () => {
      await assert.rejects(() => openaiRawMetered(openaiCfg, '系统', '用户'));
    });
    assert.deepEqual(capture.upstreamIds, ['chatcmpl-rate-limited']);
  });

  test('多次外呼（工具循环/续写/端点转移）按顺序累积，去重，且有上限', () => {
    const capture = createEndpointCapture();
    runWithEndpointCapture(capture, async () => {
      noteUpstreamId('chatcmpl-a');
      noteUpstreamId('chatcmpl-b');
      noteUpstreamId('chatcmpl-a'); // 重复
      for (let i = 0; i < 30; i++) noteUpstreamId(`chatcmpl-x${i}`);
      noteUpstreamId(null);
      noteUpstreamId(undefined);
      noteUpstreamId('');
    });
    assert.equal(capture.upstreamIds[0], 'chatcmpl-a');
    assert.equal(capture.upstreamIds[1], 'chatcmpl-b');
    assert.equal(new Set(capture.upstreamIds).size, capture.upstreamIds.length, '不许有重复');
    assert.equal(capture.upstreamIds.length, 12, 'UPSTREAM_ID_MAX 应封顶 12');
  });

  test('不在 capture 上下文里调用不抛异常（provider 也被非 gateway 路径直接调用）', () => {
    assert.doesNotThrow(() => noteUpstreamId('chatcmpl-orphan'));
  });
});
