// OpenAI 兼容网关的超时语义：成果给更长预算；流式按首包/空闲超时，不按累计时长截断。
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { openaiChatStream, openaiDeliverable } from '../src/llm/providers/openai.js';
import type { GenContext } from '../src/llm/schema.js';
import type { ResolvedAiConfig } from '../src/services/aiConfig.js';

const realFetch = globalThis.fetch;

const CFG = (timeoutMs: number): ResolvedAiConfig => ({
  provider: 'openai', label: 'test', baseUrl: 'https://gateway.test/v1', model: 'slow-model', apiKey: 'sk-real-test',
  embeddingModel: '', temperature: 0.7, timeoutMs,
  embeddingEnabled: false, embeddingBaseUrl: '', embeddingApiKey: '',
  rerankEnabled: false, rerankModel: '', rerankBaseUrl: '', rerankApiKey: '',
});

const CTX: GenContext = {
  agentKey: 'general', agentName: '总军师', systemPrompt: 'test', deliverableKey: null,
  profile: null, memories: [], benmingColor: '#123456', benchmark: '', userMessage: '请给建议',
};

function waitFor(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const aborted = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
    };
    const done = () => {
      signal?.removeEventListener('abort', aborted);
      resolve();
    };
    timer = setTimeout(done, ms);
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

afterEach(() => { globalThis.fetch = realFetch; });

test('结构化成果使用独立长等待预算，不受普通 40ms 对话超时截断', async () => {
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    await waitFor(70, init?.signal ?? undefined);
    return new Response(JSON.stringify({
      choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify({ title: '诊断', sections: [{ h: '判断', b: '先稳住现金流。' }] }) } }] } }],
      usage: { prompt_tokens: 10, completion_tokens: 8 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  const out = await openaiDeliverable(CTX, CFG(40));
  assert.equal(out.result.title, '诊断');
  assert.equal(out.result.sections[0]?.h, '判断');
});

test('流式收到字节会续期，累计超出初始上限仍可正常完成', async () => {
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const enc = new TextEncoder();
    const signal = init?.signal;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        const first = setTimeout(() => controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"第一段"}}]}\n\n')), 100);
        const second = setTimeout(() => {
          controller.enqueue(enc.encode('data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\ndata: [DONE]\n\n'));
          controller.close();
        }, 1_050);
        signal?.addEventListener('abort', () => {
          clearTimeout(first); clearTimeout(second);
          controller.error(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
        }, { once: true });
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;

  const events: string[] = [];
  for await (const event of openaiChatStream(CTX, CFG(1_000))) {
    if (event.type === 'delta') events.push(event.text);
  }
  assert.deepEqual(events, ['第一段']);
});

test('流式达到输出上限 → 自动续写补齐，用户拿到一条完整回复', async () => {
  let calls = 0;
  const maxTokensPerCall: number[] = [];
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { max_tokens?: number; messages: { role: string; content: string }[] };
    maxTokensPerCall.push(Number(body.max_tokens ?? 0));
    const first = calls++ === 0;
    if (!first) {
      // 续写形态：残文进 assistant 历史、指令进 user 轮（末轮 assistant prefill 在 Claude 4.6+ 会 400）。
      assert.equal(body.messages[body.messages.length - 1].role, 'user');
      assert.match(body.messages[body.messages.length - 2].content, /尚未写完的正文/);
    }
    const enc = new TextEncoder();
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode(`data: {"choices":[{"delta":{"content":"${first ? '尚未写完的正文' : '，这下写完了。'}"}}]}\n\n`));
        controller.enqueue(enc.encode(`data: {"choices":[{"delta":{},"finish_reason":"${first ? 'length' : 'stop'}"}]}\n\n`));
        controller.enqueue(enc.encode(`data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":${first ? 8000 : 20}}}\n\ndata: [DONE]\n\n`));
        controller.close();
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;

  const events: string[] = [];
  let done: { text: string; truncated?: boolean } | null = null;
  for await (const event of openaiChatStream(CTX, CFG(1_000))) {
    if (event.type === 'delta') events.push(event.text);
    else done = event.result;
  }
  assert.equal(calls, 2, '撞上限应自动续写一轮');
  assert.deepEqual(maxTokensPerCall, [8000, 8000], '每轮正文预算恒为 8000（关闭思考时不叠加）');
  assert.deepEqual(events, ['尚未写完的正文', '，这下写完了。'], '续写内容要接着流给用户');
  assert.equal(done?.text, '尚未写完的正文，这下写完了。');
  assert.equal(done?.truncated, undefined, '续写成功后不该再标未写完');
});

test('续写轮数用尽仍未写完 → 保留已写内容并标 truncated，不抛错丢内容', async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    const enc = new TextEncoder();
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        // 每轮都续上一小段且都撞上限：首轮 + 2 轮续写后交回用户。
        controller.enqueue(enc.encode(`data: {"choices":[{"delta":{"content":"第${calls}段还没完"}}]}\n\n`));
        controller.enqueue(enc.encode('data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n'));
        controller.enqueue(enc.encode('data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":8000}}\n\ndata: [DONE]\n\n'));
        controller.close();
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;

  let done: { text: string; truncated?: boolean } | null = null;
  for await (const event of openaiChatStream(CTX, CFG(1_000))) {
    if (event.type === 'done') done = event.result;
  }
  assert.equal(calls, 3, '首轮 + 2 轮续写，不能无限续');
  assert.equal(done?.truncated, true);
  assert.equal(done?.text, '第1段还没完第2段还没完第3段还没完', '三轮内容全部保留，一个字都不能丢');
});

test('一个字正文都没写就撞上限 → 无锚点可续写，如实抛 AI_OUTPUT_TRUNCATED', async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    const enc = new TextEncoder();
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode('data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n'));
        controller.enqueue(enc.encode('data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":8000}}\n\ndata: [DONE]\n\n'));
        controller.close();
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;

  await assert.rejects(
    async () => { for await (const _ of openaiChatStream(CTX, CFG(1_000))) { /* drain */ } },
    (err: Error & { code?: string }) => {
      assert.equal(err.code, 'AI_OUTPUT_TRUNCATED');
      assert.match(err.message, /思考预算/, '这种形态几乎总是思考预算占满了输出预算');
      return true;
    },
  );
  assert.equal(calls, 1, '没有正文时不该空转续写');
});
