// openaiStep（工具调用循环的 OpenAI provider step）单元测试：stub fetch，
// 断言 LoopMessage→OpenAI 消息翻译、tools/tool_choice 构造、响应解析成 TurnOutput。
//   cd server && node --import tsx --test test/openaiStep.test.ts
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { openaiStep } from '../src/llm/providers/openai.js';
import type { LoopMessage, Tool } from '../src/llm/tools/types.js';
import type { ResolvedAiConfig } from '../src/services/aiConfig.js';

const CFG: ResolvedAiConfig = {
  provider: 'openai', label: 'x', baseUrl: 'http://test/v1', model: 'm', apiKey: 'sk-x',
  embeddingModel: '', temperature: 0.5, timeoutMs: 5000,
};
const TOOL: Tool = { name: 'search_knowledge', description: 'd', inputSchema: { type: 'object', properties: {} }, async run() { return ''; } };
const MSGS: LoopMessage[] = [{ role: 'system', text: 'sys' }, { role: 'user', text: 'hi' }];

let lastBody: any = null;
const realFetch = globalThis.fetch;
function stub(message: Record<string, unknown>) {
  globalThis.fetch = (async (_url: any, init: any = {}) => {
    lastBody = init?.body ? JSON.parse(init.body) : null;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message }], usage: { prompt_tokens: 3, completion_tokens: 2 } }) } as unknown as Response;
  }) as unknown as typeof fetch;
}
beforeEach(() => { lastBody = null; });
afterEach(() => { globalThis.fetch = realFetch; });

describe('openaiStep', () => {
  test('常规工具调用 → kind:tool_calls，args 解析', async () => {
    stub({ content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search_knowledge', arguments: '{"query":"增长"}' } }] });
    const out = await openaiStep(CFG)(MSGS, [TOOL], { forceFinal: false });
    assert.equal(out.kind, 'tool_calls');
    if (out.kind === 'tool_calls') {
      assert.equal(out.calls[0].name, 'search_knowledge');
      assert.deepEqual(out.calls[0].args, { query: '增长' });
    }
    assert.deepEqual(out.usage, { inputTokens: 3, outputTokens: 2, cachedInput: 0 });
    assert.equal(lastBody.tool_choice, 'auto'); // 非强制收口 → auto
  });

  test('命中终结工具 emit_deliverable → kind:final 带 toolInput', async () => {
    stub({ content: null, tool_calls: [{ id: 'c2', type: 'function', function: { name: 'emit_deliverable', arguments: '{"title":"T","sections":[]}' } }] });
    const out = await openaiStep(CFG)(MSGS, [TOOL], { forceFinal: false, finalTool: { name: 'emit_deliverable', description: 'd', schema: { type: 'object' } } });
    assert.equal(out.kind, 'final');
    if (out.kind === 'final') assert.deepEqual(out.toolInput, { title: 'T', sections: [] });
  });

  test('纯文本无工具调用 → kind:final 带 text', async () => {
    stub({ content: '  这是回答  ' });
    const out = await openaiStep(CFG)(MSGS, [TOOL], { forceFinal: false });
    assert.equal(out.kind, 'final');
    if (out.kind === 'final') assert.equal(out.text, '这是回答');
  });

  test('forceFinal + 无 finalTool（chat 收口）→ 请求不带 tools', async () => {
    stub({ content: '最终答案' });
    const out = await openaiStep(CFG)(MSGS, [TOOL], { forceFinal: true });
    assert.equal(out.kind, 'final');
    assert.equal(lastBody.tools, undefined); // 去掉工具，强制出文本
  });

  test('forceFinal + finalTool（deliverable 收口）→ 强制 tool_choice=emit_deliverable', async () => {
    stub({ content: null, tool_calls: [{ id: 'c3', type: 'function', function: { name: 'emit_deliverable', arguments: '{"sections":[]}' } }] });
    await openaiStep(CFG)(MSGS, [TOOL], { forceFinal: true, finalTool: { name: 'emit_deliverable', description: 'd', schema: { type: 'object' } } });
    assert.deepEqual(lastBody.tool_choice, { type: 'function', function: { name: 'emit_deliverable' } });
  });

  test('tool_results 翻译成 role:tool 消息', async () => {
    stub({ content: 'ok' });
    const msgs: LoopMessage[] = [
      { role: 'system', text: 's' },
      { role: 'user', text: 'q' },
      { role: 'assistant_tools', calls: [{ id: 'c1', name: 'search_knowledge', args: {} }] },
      { role: 'tool_results', results: [{ id: 'c1', name: 'search_knowledge', content: '命中内容', isError: false }] },
    ];
    await openaiStep(CFG)(msgs, [TOOL], { forceFinal: false });
    const toolMsg = lastBody.messages.find((m: any) => m.role === 'tool');
    assert.ok(toolMsg);
    assert.equal(toolMsg.tool_call_id, 'c1');
    assert.equal(toolMsg.content, '命中内容');
    const asst = lastBody.messages.find((m: any) => m.role === 'assistant' && m.tool_calls);
    assert.equal(asst.tool_calls[0].function.name, 'search_knowledge');
  });
});
