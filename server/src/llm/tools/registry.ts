// 可插拔技能注册表：native 技能(代码内置)在此登记，按 kind 解析。
// 新增一个 native 技能 = 写好它的模块(builtin.ts 或独立文件)→ 加进下面的清单。
// 运营自建 HTTP 工具不在此处，走 DB(services/skillTools)；两类在 selectableMeta 里汇合成统一技能库。

import { searchKnowledge, recallMemory, renderReport } from './builtin.js';
import type { Tool, OutputSkill, SkillMeta } from './types.js';

// —— native 技能清单(可插拔挂载点) ——
const TOOL_SKILLS: Tool[] = [searchKnowledge, recallMemory];   // kind='tool'：模型主动调用
const OUTPUT_SKILLS: OutputSkill[] = [renderReport];           // kind='output'：产出后处理

const TOOLS = new Map(TOOL_SKILLS.map((t) => [t.name, t]));
const OUTPUTS = new Map(OUTPUT_SKILLS.map((s) => [s.key, s]));

/** 全部内置「工具技能」名(后台校验勾选项 / 区分内置 vs 自建用)。 */
export function builtinToolNames(): string[] {
  return [...TOOLS.keys()];
}

/** 全部内置工具技能的元信息(name+描述)；保留旧签名供既有调用方用。 */
export function builtinToolMeta(): { name: string; description: string }[] {
  return TOOL_SKILLS.map((t) => ({ name: t.name, description: t.description }));
}

/** 全部 native 技能的统一元信息(tool + output，带 kind)，供技能库展示。 */
export function nativeSkillMeta(): SkillMeta[] {
  return [
    ...TOOL_SKILLS.map((t) => ({ key: t.name, name: t.name, description: t.description, kind: 'tool' as const, builtin: true })),
    ...OUTPUT_SKILLS.map((s) => ({ key: s.key, name: s.name, description: s.description, kind: 'output' as const, builtin: true })),
  ];
}

/** 内置 output 技能的 key(用于把它们从「喂给模型的工具」里排除)。 */
export function builtinOutputKeys(): string[] {
  return [...OUTPUTS.keys()];
}

/** 把勾选的工具名解析成具体工具技能 Tool[]；未知名忽略，去重。 */
export function resolveTools(toolNames?: string[] | null): Tool[] {
  if (!toolNames?.length) return [];
  const seen = new Set<string>();
  const out: Tool[] = [];
  for (const n of toolNames) {
    if (seen.has(n)) continue;
    seen.add(n);
    const t = TOOLS.get(n);
    if (t) out.push(t);
  }
  return out;
}

/** 把勾选的名字解析成 output 技能；未知名忽略，去重、保序。 */
export function resolveOutputSkills(names?: string[] | null): OutputSkill[] {
  if (!names?.length) return [];
  const seen = new Set<string>();
  const out: OutputSkill[] = [];
  for (const n of names) {
    if (seen.has(n)) continue;
    seen.add(n);
    const s = OUTPUTS.get(n);
    if (s) out.push(s);
  }
  return out;
}

export function getOutputSkill(key: string): OutputSkill | undefined {
  return OUTPUTS.get(key);
}
