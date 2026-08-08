// AI 配置里所有 Json 列的解析闸门（2026-08-07 · 重设计二期）。
//
// 为什么必须有：本次重设计主张的就是「声明式、可校验」。若 `capsJson` / `probeJson` / `modelScope`
// 这几列裸奔——读出来直接 `as` 成目标类型——声明式在自己家里就先瓦解了：一次手写脏数据、一次
// 结构演进忘了迁移，运行时读到的就是形状不对的对象，而 TypeScript 在 Json 列这里帮不上任何忙。
//
// 口径：**解析失败一律按「未配置」处理，绝不抛**。配置读取在热路径上（每次外呼都要判能力），
// 让一列脏 Json 把整站 AI 打挂是最坏的失败模式；退化成 unknown 只是回到「没探测过」的状态，
// 由校验器出 warn、由探活重新填。调用方拿 `issues` 决定要不要给运营报警。

import { z } from 'zod';

/** 能力三态。unknown=没探测过（不拦截）；no=已被探测/运营证伪（校验器据此拦截）。 */
export const CapSchema = z.enum(['unknown', 'yes', 'no']);
export type Cap = z.infer<typeof CapSchema>;

/**
 * 端点能力。来源优先级：运营显式覆盖 > 探测回填 > 厂商预设声明。
 * 全部可选：缺省即 unknown，等价于旧行为（靠模型名猜），不会凭空拦截既有配置。
 */
export const EndpointCapsSchema = z.object({
  thinking: CapSchema.optional(),
  tools: CapSchema.optional(),
  streaming: CapSchema.optional(),
  vision: CapSchema.optional(),
  /** 该端点实测能吐出的最大输出 token（含思考）。0/缺省=未知，不参与预算校验。 */
  maxOutputTokens: z.number().int().positive().optional(),
  /** 哪些字段是运营手动锁定的——探活回填时不得覆盖运营的判断。 */
  locked: z.array(z.string()).optional(),
  /**
   * 该端点的 Key 在上游被允许的模型清单（七牛 model groups），由 model_scope 探活回填。
   * 放在端点能力里而不是只放凭证上：旧结构下没有凭证表，而校验规则两种模式都要能用。
   */
  modelScope: z.object({ models: z.array(z.string()), at: z.string() }).optional(),
}).strict();
export type EndpointCaps = z.infer<typeof EndpointCapsSchema>;

/** 单项探活结果。 */
export const ProbeResultSchema = z.object({
  kind: z.string(),
  ok: z.boolean(),
  at: z.string(),                       // ISO 时间；脚本里不许 Date.now()，由调用方注入
  latencyMs: z.number().nonnegative().optional(),
  error: z.string().optional(),
  detail: z.record(z.unknown()).optional(),
}).strict();
export type ProbeResult = z.infer<typeof ProbeResultSchema>;

export const ProbeReportSchema = z.object({
  results: z.array(ProbeResultSchema),
}).strict();
export type ProbeReport = z.infer<typeof ProbeReportSchema>;

/** 凭证在上游被允许的模型范围（七牛 model groups）。由探活经 GET /v1/models 回填，运营不手填。 */
export const ModelScopeSchema = z.object({
  models: z.array(z.string()),
  at: z.string(),
}).strict();
export type ModelScope = z.infer<typeof ModelScopeSchema>;

/** 用途级请求预算（三期用；今天这些值是散在代码里的常量）。 */
export const RouteBudgetSchema = z.object({
  timeoutMs: z.number().int().positive().optional(),
  bodyMaxTokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
}).strict();
export type RouteBudget = z.infer<typeof RouteBudgetSchema>;

/** 解析结果：永远给得出一个可用值，脏数据只体现在 issue 上。 */
export interface ParsedJson<T> { value: T | null; issue: string }

function parseWith<T>(schema: z.ZodType<T>, raw: unknown, what: string): ParsedJson<T> {
  if (raw === null || raw === undefined) return { value: null, issue: '' };
  const r = schema.safeParse(raw);
  if (r.success) return { value: r.data, issue: '' };
  // 只取第一条，避免把整份 zod 报错塞进后台提示。
  const first = r.error.issues[0];
  return { value: null, issue: `${what} 结构不合法（${first?.path.join('.') || '根'}: ${first?.message}），已按未配置处理` };
}

export const parseEndpointCaps = (raw: unknown) => parseWith(EndpointCapsSchema, raw, '能力标记 capsJson');
export const parseProbeReport = (raw: unknown) => parseWith(ProbeReportSchema, raw, '探活结果 probeJson');
export const parseModelScope = (raw: unknown) => parseWith(ModelScopeSchema, raw, '模型范围 modelScope');
export const parseRouteBudget = (raw: unknown) => parseWith(RouteBudgetSchema, raw, '路由预算 budgetJson');

/** 读能力：脏数据 → 空能力（＝全 unknown），与「没探测过」同义，不会凭空拦截。 */
export function readCaps(raw: unknown): EndpointCaps {
  return parseEndpointCaps(raw).value ?? {};
}

/** 某项能力的判定。缺省/unknown 都返回 'unknown'——调用方必须自己决定 unknown 该放行还是拦截。 */
export function capOf(caps: EndpointCaps, key: 'thinking' | 'tools' | 'streaming' | 'vision'): Cap {
  return caps[key] ?? 'unknown';
}

/** 运营锁定的能力项不得被探活覆盖（探活只是证据，运营的显式判断优先）。 */
export function isCapLocked(caps: EndpointCaps, key: string): boolean {
  return (caps.locked ?? []).includes(key);
}
