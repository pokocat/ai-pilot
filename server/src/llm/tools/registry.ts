// 工具注册表：内置工具按名解析；自定义 HTTP 工具 Phase 2 再实现（此处留桩）。

import { searchKnowledge, recallMemory } from './builtin.js';
import type { Tool } from './types.js';

const BUILTIN: Record<string, Tool> = {
  [searchKnowledge.name]: searchKnowledge,
  [recallMemory.name]: recallMemory,
};

/** 全部内置工具名（后台校验勾选项用）。 */
export function builtinToolNames(): string[] {
  return Object.keys(BUILTIN);
}

/** 全部内置工具的元信息（后台勾选项展示用，name+描述）。新增工具注册进 BUILTIN 后自动带出。 */
export function builtinToolMeta(): { name: string; description: string }[] {
  return Object.values(BUILTIN).map((t) => ({ name: t.name, description: t.description }));
}

/** 把 agent 勾选的工具名解析成具体 Tool[]；未知名忽略。 */
export function resolveTools(toolNames?: string[] | null): Tool[] {
  if (!toolNames?.length) return [];
  const seen = new Set<string>();
  const out: Tool[] = [];
  for (const n of toolNames) {
    if (seen.has(n)) continue;
    seen.add(n);
    const t = BUILTIN[n];
    if (t) out.push(t);
  }
  return out;
}

/** 自定义 HTTP 工具（运营填 URL + schema 调外部 API）。SSRF/鉴权/超时硬化未做，Phase 2 defer。 */
export function makeHttpTool(_def: { name: string; description: string; httpUrl?: string; inputSchema: Record<string, unknown> }): Tool {
  throw new Error('自定义 HTTP 工具尚未实现');
}
