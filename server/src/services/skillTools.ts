// 运营自助技能库（自定义 HTTP 工具）：CRUD + 运行时解析。
// agent 的 skillsConfig.tools 里既可能是内置工具名，也可能是自定义工具 key；本服务统一解析。
import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { builtinToolNames, nativeSkillMeta, resolveTools, resolveOutputSkills } from '../llm/tools/registry.js';
import { makeHttpTool } from '../llm/tools/httpTool.js';
import type { Tool, OutputSkill } from '../llm/tools/types.js';
import type { SkillToolDef, SkillToolMeta, SkillToolUpsert } from '../../../shared/contracts';

const KEY_RE = /^[a-z][a-z0-9_]*$/;
const HTTP_METHODS = new Set(['GET', 'POST']);

type Row = {
  id: string; key: string; name: string; description: string; inputSchema: unknown;
  httpMethod: string; httpUrl: string; headersJson: unknown; argsLocation: string; enabled: boolean; createdAt: Date;
};

function headersOf(raw: unknown): Record<string, string> {
  const h = (raw as Record<string, unknown> | null) ?? {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) if (k && typeof v === 'string') out[k] = v;
  return out;
}

function toDef(r: Row): SkillToolDef {
  const headers = headersOf(r.headersJson);
  const keys = Object.keys(headers);
  return {
    id: r.id, key: r.key, name: r.name, description: r.description,
    inputSchema: (r.inputSchema as Record<string, unknown>) ?? {},
    httpMethod: r.httpMethod === 'GET' ? 'GET' : 'POST',
    httpUrl: r.httpUrl,
    argsLocation: r.argsLocation === 'query' ? 'query' : 'body',
    enabled: r.enabled,
    headerKeys: keys,        // 名可见
    hasHeaders: keys.length > 0,
    createdAt: r.createdAt.toISOString(),
  };
}

// 入参规整 + 校验（创建/更新共用）。create=true 时强校验 key。
function validate(input: SkillToolUpsert, create: boolean): void {
  if (create) {
    if (!KEY_RE.test(input.key ?? '')) throw new Error('工具标识(key) 需小写字母开头，仅含小写字母/数字/下划线');
    if (builtinToolNames().includes(input.key)) throw new Error('该标识与内置工具冲突，请换一个');
  }
  if (!input.name?.trim()) throw new Error('请填写展示名');
  if (!input.description?.trim()) throw new Error('请填写描述（模型据此判断何时调用）');
  if (!input.httpUrl?.trim() || !/^https?:\/\//i.test(input.httpUrl)) throw new Error('请填写合法的 http/https 接口地址');
  if (input.inputSchema === null || typeof input.inputSchema !== 'object' || Array.isArray(input.inputSchema)) throw new Error('参数 Schema 需为 JSON 对象');
}

export async function listDefs(): Promise<SkillToolDef[]> {
  const rows = await prisma.skillTool.findMany({ orderBy: { createdAt: 'desc' } });
  return rows.map(toDef);
}

export async function createTool(input: SkillToolUpsert): Promise<SkillToolDef> {
  validate(input, true);
  const row = await prisma.skillTool.create({
    data: {
      key: input.key,
      name: input.name.trim(),
      description: input.description.trim(),
      inputSchema: (input.inputSchema ?? {}) as Prisma.InputJsonValue,
      httpMethod: HTTP_METHODS.has(input.httpMethod ?? '') ? input.httpMethod! : 'POST',
      httpUrl: input.httpUrl.trim(),
      headersJson: (input.headers ?? {}) as Prisma.InputJsonValue,
      argsLocation: input.argsLocation === 'query' ? 'query' : 'body',
      enabled: input.enabled ?? true,
    },
  });
  return toDef(row);
}

export async function updateTool(id: string, input: SkillToolUpsert): Promise<SkillToolDef | null> {
  validate(input, false);
  const d: Prisma.SkillToolUpdateInput = {
    name: input.name.trim(),
    description: input.description.trim(),
    inputSchema: (input.inputSchema ?? {}) as Prisma.InputJsonValue,
    httpMethod: HTTP_METHODS.has(input.httpMethod ?? '') ? input.httpMethod! : 'POST',
    httpUrl: input.httpUrl.trim(),
    argsLocation: input.argsLocation === 'query' ? 'query' : 'body',
    enabled: input.enabled ?? true,
  };
  // headers 仅在显式传入时整体替换（仿 apiKey：留空=保留现有密文）。
  if (input.headers !== undefined) d.headersJson = (input.headers ?? {}) as Prisma.InputJsonValue;
  const row = await prisma.skillTool.update({ where: { id }, data: d }).catch(() => null);
  return row ? toDef(row) : null;
}

export async function deleteTool(id: string): Promise<boolean> {
  const r = await prisma.skillTool.delete({ where: { id } }).catch(() => null);
  return !!r;
}

/** agent 勾选列表（统一技能库）：native 技能(tool + output，带 kind) + 启用的运营自建 HTTP 工具(kind=tool)。 */
export async function selectableMeta(): Promise<SkillToolMeta[]> {
  const native = nativeSkillMeta().map((m) => ({ name: m.key, description: m.description, builtin: true, kind: m.kind }));
  const custom = await prisma.skillTool.findMany({ where: { enabled: true }, orderBy: { createdAt: 'desc' } });
  return [...native, ...custom.map((c) => ({ name: c.key, description: c.description, builtin: false, kind: 'tool' as const }))];
}

/** agent 勾选的「产出处理」技能(kind=output)。当前仅 native；未来可扩展 HTTP output。 */
export async function loadOutputSkillsByNames(names?: string[] | null): Promise<OutputSkill[]> {
  return resolveOutputSkills(names);
}

/** 把 agent 勾选的名字解析成 Tool[]：内置走 registry，其余按 key 查启用的自定义工具。 */
export async function loadToolsByNames(names?: string[] | null): Promise<Tool[]> {
  if (!names?.length) return [];
  const builtinSet = new Set(builtinToolNames());
  const builtinNames = names.filter((n) => builtinSet.has(n));
  const customKeys = names.filter((n) => !builtinSet.has(n));
  const tools: Tool[] = resolveTools(builtinNames);
  if (customKeys.length) {
    const rows = await prisma.skillTool.findMany({ where: { key: { in: customKeys }, enabled: true } });
    for (const r of rows) {
      tools.push(makeHttpTool({
        key: r.key, name: r.name, description: r.description,
        inputSchema: (r.inputSchema as Record<string, unknown>) ?? {},
        httpMethod: r.httpMethod, httpUrl: r.httpUrl,
        headers: headersOf(r.headersJson), argsLocation: r.argsLocation,
      }));
    }
  }
  return tools;
}
