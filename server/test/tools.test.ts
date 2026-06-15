// 工具调用循环 + 注册表单元测试（纯单元，不连库、不联网）。
// 用 fake step 驱动 runToolLoop，断言：工具被执行、结果回灌、最终收口、usage 累加、maxIterations 截断。
//   cd server && node --import tsx --test test/tools.test.ts
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runToolLoop } from '../src/llm/tools/loop.js';
import { builtinToolNames, resolveTools } from '../src/llm/tools/registry.js';
import type { LoopMessage, StepFn, Tool, ToolContext } from '../src/llm/tools/types.js';

const CTX: ToolContext = { tenantId: 't1', userId: 'u1', agentKey: 'ak', projectId: null, query: '增长怎么做' };
const U = { inputTokens: 10, outputTokens: 5, cachedInput: 0 };

function fakeTool(name: string, ret: string): Tool & { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  return { name, description: name, inputSchema: { type: 'object', properties: {} }, calls, async run(args) { calls.push(args); return ret; } };
}

describe('runToolLoop', () => {
  test('调一次工具→回灌→最终文本；usage 累加；toolCalls/iterations 正确', async () => {
    const tool = fakeTool('search_knowledge', '命中：增长靠复购');
    let seenResultsOnSecondCall: LoopMessage | undefined;
    let n = 0;
    const step: StepFn = async (messages) => {
      n++;
      if (n === 1) return { kind: 'tool_calls', calls: [{ id: 'c1', name: 'search_knowledge', args: { query: 'x' } }], usage: U };
      seenResultsOnSecondCall = messages.find((m) => m.role === 'tool_results');
      return { kind: 'final', text: '基于检索给出判断', usage: U };
    };
    const r = await runToolLoop({ step, system: 'sys', userMessage: 'hi', tools: [tool], toolCtx: CTX });
    assert.equal(r.text, '基于检索给出判断');
    assert.equal(r.toolCalls, 1);
    assert.equal(r.iterations, 2);
    assert.deepEqual(r.usage, { inputTokens: 20, outputTokens: 10, cachedInput: 0 }); // 两轮累加
    assert.equal(tool.calls.length, 1); // 工具被执行一次
    assert.ok(seenResultsOnSecondCall && seenResultsOnSecondCall.role === 'tool_results');
    if (seenResultsOnSecondCall?.role === 'tool_results') {
      assert.equal(seenResultsOnSecondCall.results[0].content, '命中：增长靠复购'); // 结果回灌
    }
  });

  test('立即 final → iterations=1, toolCalls=0', async () => {
    const step: StepFn = async () => ({ kind: 'final', text: '直接回答', usage: U });
    const r = await runToolLoop({ step, system: 's', userMessage: 'q', tools: [], toolCtx: CTX });
    assert.equal(r.iterations, 1);
    assert.equal(r.toolCalls, 0);
    assert.equal(r.text, '直接回答');
  });

  test('maxIterations 截断：最后一轮 forceFinal 收口', async () => {
    const tool = fakeTool('search_knowledge', 'x');
    const step: StepFn = async (_m, _t, opts) =>
      opts.forceFinal
        ? { kind: 'final', text: '强制收口', usage: U }
        : { kind: 'tool_calls', calls: [{ id: 'c', name: 'search_knowledge', args: {} }], usage: U };
    const r = await runToolLoop({ step, system: 's', userMessage: 'q', tools: [tool], toolCtx: CTX, maxIterations: 2 });
    assert.equal(r.iterations, 2);
    assert.equal(r.text, '强制收口');
  });

  test('未知工具 → 结果标记 isError 并继续', async () => {
    let secondMessages: LoopMessage[] = [];
    let n = 0;
    const step: StepFn = async (messages) => {
      n++;
      if (n === 1) return { kind: 'tool_calls', calls: [{ id: 'c', name: '不存在', args: {} }], usage: U };
      secondMessages = messages;
      return { kind: 'final', text: 'ok', usage: U };
    };
    const r = await runToolLoop({ step, system: 's', userMessage: 'q', tools: [], toolCtx: CTX });
    assert.equal(r.text, 'ok');
    const res = secondMessages.find((m) => m.role === 'tool_results');
    if (res?.role === 'tool_results') {
      assert.equal(res.results[0].isError, true);
      assert.match(res.results[0].content, /未知工具/);
    }
  });

  test('deliverable 路径：final 带 toolInput', async () => {
    const step: StepFn = async () => ({ kind: 'final', toolInput: { title: 'T', sections: [] }, usage: U });
    const r = await runToolLoop({ step, system: 's', userMessage: 'q', tools: [], toolCtx: CTX, finalTool: { name: 'emit_deliverable', description: 'd', schema: {} } });
    assert.deepEqual(r.toolInput, { title: 'T', sections: [] });
  });
});

describe('registry', () => {
  test('内置工具名包含 search_knowledge / recall_memory', () => {
    const names = builtinToolNames();
    assert.ok(names.includes('search_knowledge'));
    assert.ok(names.includes('recall_memory'));
  });
  test('resolveTools 解析勾选项；去重；忽略未知名', () => {
    const tools = resolveTools(['search_knowledge', 'search_knowledge', 'bogus', 'recall_memory']);
    assert.deepEqual(tools.map((t) => t.name), ['search_knowledge', 'recall_memory']);
  });
  test('resolveTools 空/undefined → []', () => {
    assert.deepEqual(resolveTools(undefined), []);
    assert.deepEqual(resolveTools([]), []);
  });
});
