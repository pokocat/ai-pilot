// Provider 无关的多轮工具调用循环。
// 算法：seed system + history + user → 反复调用 provider 的 step：
//   · step 返回 tool_calls → 执行工具、把「助手工具调用块 + 工具结果块」追加进消息栈，继续；
//   · step 返回 final → 结束（chat 取 text；deliverable 取 emit_deliverable 的 toolInput）。
// 最后一轮强制 final（chat：去掉 tools；deliverable：强制 tool_choice=emit_deliverable），
// 保证一定收口。各轮 Usage 累加，由 gateway 合并成一条计费记录。

import { ZERO_USAGE, type Usage } from '../schema.js';
import type { FinalTool, LoopMessage, StepFn, Tool, ToolContext, ToolResult } from './types.js';

function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedInput: a.cachedInput + b.cachedInput,
  };
}

export interface LoopOpts {
  step: StepFn;
  system: string;
  history?: { role: string; text: string }[];
  userMessage: string;
  tools: Tool[];
  toolCtx: ToolContext;
  maxIterations?: number; // 默认 4
  finalTool?: FinalTool; // 设置=deliverable 路径；不设=chat 路径
}

export interface LoopResult {
  text?: string;
  toolInput?: Record<string, unknown>;
  usage: Usage;
  toolCalls: number;
  iterations: number;
}

export async function runToolLoop(opts: LoopOpts): Promise<LoopResult> {
  const maxIterations = Math.max(1, opts.maxIterations ?? 4);
  const messages: LoopMessage[] = [
    { role: 'system', text: opts.system },
    ...(opts.history ?? []).map((m): LoopMessage => ({ role: m.role === 'user' ? 'user' : 'assistant', text: m.text })),
    { role: 'user', text: opts.userMessage },
  ];

  let usage = ZERO_USAGE;
  let toolCalls = 0;

  for (let i = 0; i < maxIterations; i++) {
    const forceFinal = i === maxIterations - 1;
    const out = await opts.step(messages, opts.tools, { forceFinal, finalTool: opts.finalTool });
    usage = addUsage(usage, out.usage);

    if (out.kind === 'final') {
      return { text: out.text, toolInput: out.toolInput, usage, toolCalls, iterations: i + 1 };
    }

    // tool_calls：执行并回灌
    messages.push({ role: 'assistant_tools', calls: out.calls });
    const results: ToolResult[] = [];
    for (const call of out.calls) {
      toolCalls++;
      const tool = opts.tools.find((t) => t.name === call.name);
      if (!tool) {
        results.push({ id: call.id, name: call.name, content: `（未知工具：${call.name}）`, isError: true });
        continue;
      }
      try {
        const content = await tool.run(call.args ?? {}, opts.toolCtx);
        results.push({ id: call.id, name: call.name, content, isError: false });
      } catch (err) {
        results.push({ id: call.id, name: call.name, content: `（工具执行出错：${(err as Error).message}）`, isError: true });
      }
    }
    messages.push({ role: 'tool_results', results });
  }

  // forceFinal 保证最后一轮返回 final；理论不可达，作兜底。
  return { text: '', usage, toolCalls, iterations: maxIterations };
}
