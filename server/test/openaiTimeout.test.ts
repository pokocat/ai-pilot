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

test('结构化成果至少允许 120 秒预算，不受普通 40ms 对话超时截断', async () => {
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
