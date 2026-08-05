// Claude 原生流式的回归测试：**逐字 delta 必须真的下发**。
//
// 为什么单独立一个文件：2026-08-04 往 streamChatRound 里加 sink 时，`if (opts.sink) ...` 被插进了
// `else if` 链中间，把 `content_block_delta` 分支变成了「opts.sink 为假才走」——而首轮恰恰传 sink。
// 结果是 claude 流式一个 delta 都不发，正文靠 finalMessage 兜底所以**不报错、测试全绿、线上跑了几小时**
// 才被人工 review 发现。这条用例就是钉死它：断言必须在「传了 sink 的真实调用路径」上看到 delta。
//
// 打桩方式：**不能**打 globalThis.fetch —— SDK 用的是自带的 fetch shim（node-fetch），
// 打全局对它无效（第一版就这么写，结果真去连了 gateway.test 拿到 ECONNRESET）。
// 走 __setClaudeFetchForTest 注入，喂一段真实形态的 Anthropic SSE。
import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeChatStream, __setClaudeFetchForTest } from '../src/llm/providers/claude.js';
import type { GenContext } from '../src/llm/schema.js';
import type { ResolvedAiConfig } from '../src/services/aiConfig.js';
import { renderMetrics, __resetMetrics } from '../src/services/metrics.js';

// SDK 用自带 fetch shim，打桩全局 fetch 对它无效 —— 必须走 __setClaudeFetchForTest 注入。
afterEach(() => { __setClaudeFetchForTest(null); });

const CFG: ResolvedAiConfig = {
  provider: 'claude', label: 'test', baseUrl: 'https://gateway.test', model: 'claude-test', apiKey: 'sk-real-test',
  embeddingModel: '', temperature: 0.6, thinkingMode: 'disabled', thinkingBudget: 1024,
  timeoutMs: 30_000, embeddingEnabled: false, embeddingBaseUrl: '', embeddingApiKey: '',
} as unknown as ResolvedAiConfig;

const CTX = {
  systemPrompt: '你是顾问。', userMessage: '讲讲毛利', agentKey: 'general',
  history: [], memories: [], knowledge: [], refs: [],
} as unknown as GenContext;

/** 拼一段真实形态的 Anthropic SSE：message_start → 若干 text_delta → message_delta(stop_reason) → message_stop。 */
function anthropicSse(chunks: string[], stopReason = 'end_turn'): string {
  const ev = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  let out = ev('message_start', {
    type: 'message_start',
    message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-test', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 0 } },
  });
  out += ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  for (const c of chunks) {
    out += ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: c } });
  }
  out += ev('content_block_stop', { type: 'content_block_stop', index: 0 });
  out += ev('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 40 } });
  out += ev('message_stop', { type: 'message_stop' });
  return out;
}

function stubSse(body: string): void {
  __setClaudeFetchForTest((async () => {
    const enc = new TextEncoder();
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(enc.encode(body)); controller.close(); },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as unknown as typeof globalThis.fetch);
}

describe('Claude 流式', () => {
  test('逐字 delta 必须真的下发（首轮传了 sink 也不能被 else-if 链吃掉）', async () => {
    stubSse(anthropicSse(['先看毛利', '结构，', '再看现金流。']));
    const deltas: string[] = [];
    let done: { text: string; truncated?: boolean } | null = null;
    for await (const ev of claudeChatStream(CTX, CFG)) {
      if (ev.type === 'delta') deltas.push(ev.text);
      else done = ev.result;
    }
    assert.deepEqual(deltas, ['先看毛利', '结构，', '再看现金流。'], '一个 delta 都不能少——少了就是逐字流静默失效');
    assert.equal(done?.text, '先看毛利结构，再看现金流。');
    assert.equal(done?.truncated, undefined);
  });

  test('正文来自 delta 而不是 finalMessage 兜底（兜底会掩盖逐字流失效）', async () => {
    stubSse(anthropicSse(['甲', '乙', '丙']));
    let deltaChars = 0;
    let finalLen = 0;
    for await (const ev of claudeChatStream(CTX, CFG)) {
      if (ev.type === 'delta') deltaChars += ev.text.length;
      else finalLen = ev.result.text.length;
    }
    assert.equal(deltaChars, finalLen, '流出的字数必须等于最终正文字数；不等说明正文走了兜底路径');
  });

  test('首字延迟有打点（看板与 P95 告警的数据源）', async () => {
    __resetMetrics();
    stubSse(anthropicSse(['一', '二']));
    for await (const _ of claudeChatStream(CTX, CFG)) { /* drain */ }
    assert.match(await renderMetrics(), /junshi_chat_first_token_seconds_count\{provider="claude"\} 1/);
  });

  test('撞上限（stop_reason=max_tokens）→ 触发续写，用户拿到拼接后的完整正文', async () => {
    let call = 0;
    __setClaudeFetchForTest((async () => {
      const first = call++ === 0;
      const enc = new TextEncoder();
      const body = first
        ? anthropicSse(['前半段写到这里'], 'max_tokens')
        : anthropicSse(['，后半段补齐了。'], 'end_turn');
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(enc.encode(body)); controller.close(); },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof globalThis.fetch);

    let done: { text: string; truncated?: boolean } | null = null;
    for await (const ev of claudeChatStream(CTX, CFG)) {
      if (ev.type === 'done') done = ev.result;
    }
    assert.equal(call, 2, '撞上限应自动续写一轮');
    assert.equal(done?.text, '前半段写到这里，后半段补齐了。');
    assert.equal(done?.truncated, undefined, '续写成功后不该再标未写完');
  });
});
