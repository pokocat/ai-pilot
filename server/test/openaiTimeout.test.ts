// OpenAI 兼容网关的超时语义：成果给更长预算；流式按首包/空闲超时，不按累计时长截断。
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { openaiChatStream, openaiDeliverable } from '../src/llm/providers/openai.js';
import type { GenContext } from '../src/llm/schema.js';
import type { ResolvedAiConfig } from '../src/services/aiConfig.js';
import { renderMetrics, __resetMetrics } from '../src/services/metrics.js';

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

test('流中途断掉但已有正文 → 保留已流出的内容并标 truncated，不抛错', async () => {
  // 慢网关打满流超时是线上真实形态：此时上万字已经流给用户了，把整轮判失败等于
  // 把用户读过的内容换成错误气泡——与撞上限同一类事故，必须同一处理。
  globalThis.fetch = (async () => {
    const enc = new TextEncoder();
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"这是已经流给用户的正文"}}]}\n\n'));
        // 必须等这块被读走再 error：同步 controller.error() 会把已入队的 chunk 一起丢掉，
        // 那就变成「一个字都没吐出来」的另一种场景了（见下一条用例）。
        setTimeout(() => controller.error(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })), 30);
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;

  const events: string[] = [];
  let done: { text: string; truncated?: boolean } | null = null;
  for await (const event of openaiChatStream(CTX, CFG(1_000))) {
    if (event.type === 'delta') events.push(event.text);
    else done = event.result;
  }
  assert.deepEqual(events, ['这是已经流给用户的正文']);
  assert.equal(done?.text, '这是已经流给用户的正文', '已流出的正文一个字都不能丢');
  assert.equal(done?.truncated, true, '要标未写完，端上才给「继续写完」');
});

test('一个字都没吐出来就断掉 → 仍如实抛错（没有可保留的内容）', async () => {
  globalThis.fetch = (async () => {
    const enc = new TextEncoder();
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode(': ping\n\n'));
        controller.error(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;

  await assert.rejects(async () => {
    for await (const _ of openaiChatStream(CTX, CFG(1_000))) { /* drain */ }
  });
});

test('流卡死（发完一段就静默）→ 看门狗开火、保留已下发正文、记 stall 打点', async () => {
  // 这是 claude 侧最要紧的那个缺口的可测替身：两个 provider 共用同一组阈值与同一套处理。
  process.env.STREAM_FIRST_EVENT_IDLE_MS = '400';
  process.env.STREAM_IDLE_MS = '120';
  __resetMetrics();
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const enc = new TextEncoder();
    const signal = init?.signal as AbortSignal | undefined;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"开头这段已经流给用户了"}}]}\n\n'));
        // 之后永不再发、也永不 close —— 正是「网关发完头就装死」的形状。
        // 桩必须响应 abort：真实 fetch 在 signal 触发时会让 body 流出错，
        // 桩不照做的话看门狗开了火也停不下来（本用例第一版就这么挂死过）。
        signal?.addEventListener('abort', () => {
          controller.error(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
        }, { once: true });
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as unknown as typeof fetch;

  try {
    const events: string[] = [];
    let done: { text: string; truncated?: boolean } | null = null;
    for await (const event of openaiChatStream(CTX, CFG(10_000))) {
      if (event.type === 'delta') events.push(event.text);
      else done = event.result;
    }
    assert.deepEqual(events, ['开头这段已经流给用户了']);
    assert.equal(done?.text, '开头这段已经流给用户了', '卡死前已下发的正文一个字都不能丢');
    assert.equal(done?.truncated, true, '要标未写完，端上才给「继续写完」');
    const body = await renderMetrics();
    assert.match(body, /junshi_chat_stream_stall_total\{provider="openai",phase="mid_stream"\} 1/);
    assert.match(body, /junshi_chat_partial_kept_total\{provider="openai",cause="stream_error"\} 1/);
    assert.match(body, /junshi_chat_first_token_seconds_count\{provider="openai"\} 1/, '首字延迟要记一次');
  } finally {
    delete process.env.STREAM_FIRST_EVENT_IDLE_MS;
    delete process.env.STREAM_IDLE_MS;
  }
});

test('响应头到了但一个事件都不来 → phase=first_event，且无正文时如实报错', async () => {
  process.env.STREAM_FIRST_EVENT_IDLE_MS = '200';
  __resetMetrics();
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const signal = init?.signal as AbortSignal | undefined;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        // 头已返回，正文永不到来；abort 时如实让流出错（同上）。
        signal?.addEventListener('abort', () => {
          controller.error(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
        }, { once: true });
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as unknown as typeof fetch;

  try {
    await assert.rejects(async () => {
      for await (const _ of openaiChatStream(CTX, CFG(10_000))) { /* drain */ }
    });
    assert.match(await renderMetrics(), /junshi_chat_stream_stall_total\{provider="openai",phase="first_event"\} 1/);
  } finally {
    delete process.env.STREAM_FIRST_EVENT_IDLE_MS;
  }
});
