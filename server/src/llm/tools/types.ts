// Skill（工具调用）核心契约。provider 无关：循环 loop.ts 用这些类型驱动多轮工具调用，
// provider 各自把 LoopMessage 翻译成自家消息格式（OpenAI tool_calls / Anthropic tool_use）。

import type { Usage } from '../schema.js';

/** 一个可被模型调用的工具（技能）。run 返回喂回模型的纯文本结果。 */
export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema，结构同 DELIVERABLE_TOOL.input_schema
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

/** 工具运行所需的最小上下文（由 GenContext + UsageMeta 在循环入口组装）。 */
export interface ToolContext {
  tenantId: string | null;
  userId: string | null;
  agentKey: string;
  projectId: string | null;
  query: string; // 本轮用户原文，作为工具入参缺省兜底
}

/** 模型请求调用某工具。 */
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** 工具执行结果（回灌给模型）。 */
export interface ToolResult {
  id: string;
  name: string;
  content: string;
  isError: boolean;
}

/** 循环维护的 provider 无关会话项；每个 provider 的 step 自行翻译成自家格式。 */
export type LoopMessage =
  | { role: 'system'; text: string }
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string } // 历史里的助手纯文本
  | { role: 'assistant_tools'; calls: ToolCall[] } // 助手本轮请求的工具调用
  | { role: 'tool_results'; results: ToolResult[] }; // 我们产出的工具结果

/** 终结工具（deliverable 路径用 emit_deliverable 作为「最终答案」的载体）。 */
export interface FinalTool {
  name: string;
  description: string;
  schema: Record<string, unknown>;
}

/** 一次 provider step 的产出：要么请求继续调工具，要么给出最终答案。 */
export type TurnOutput =
  | { kind: 'tool_calls'; calls: ToolCall[]; usage: Usage }
  | { kind: 'final'; text?: string; toolInput?: Record<string, unknown>; usage: Usage };

/** provider 的「一步」原语：发当前消息栈 + 工具定义，返回 tool_calls 或 final。 */
export type StepFn = (
  messages: LoopMessage[],
  tools: Tool[],
  opts: { forceFinal: boolean; finalTool?: FinalTool },
) => Promise<TurnOutput>;
