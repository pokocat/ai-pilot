// 协议方言表（2026-08-07 · 重设计二期）。
//
// ── 这个文件存在的理由 ─────────────────────────────────────────────────────────
// `provider: 'mock' | 'claude' | 'openai'` 这个三值枚举同时扛了四件互相独立的事——
// 厂商是谁、走什么线协议、用什么方言写请求、就绪与否。信息被压掉之后，代码只能靠**猜**补回来：
//
//     if (cfg.provider === 'claude' && !cfg.baseUrl?.trim())   // 用「baseUrl 空不空」猜官方还是网关
//     provider === 'claude' || /claude/i.test(cfg.model)       // 用模型名里有没有 claude 猜支不支持思考
//
// 这两处推断在「只有七牛一家、只有一种模型」时勉强成立，多一家厂商就必错一次。三个现成反例：
//   · 七牛 Anthropic 网关：关闭思考必须显式发 {type:'disabled'} 且**不得带 budget_tokens**（带了 400）；
//     Anthropic 官方却是**整体省略**——两者都是 provider='claude'，靠 baseUrl 空不空区分纯属巧合。
//   · DeepSeek 的 Anthropic 兼容端点：接受 thinking，但 **budget_tokens 被忽略**——
//     后台显示「思考预算 4096」，上游根本没按这个数思考，运营调了个寂寞。
//   · 七牛的 OpenAI 兼容入口支持非标 thinking 扩展，OpenAI 官方不认——同为 provider='openai'。
//
// 所以：**协议决定请求长什么样，方言决定同一协议下的细节写法，厂商决定有没有这个能力。**
// 三者正交。本表把「方言」这一维显式化，让新接一家厂商 = 加一行数据，而不是加一个 provider 分支。
//
// ── 与既有行为的关系（重要）────────────────────────────────────────────────────
// 本表 + `inferDialect()` 的组合**严格复刻** thinking.ts 原有的分支结果，逐位不变；
// 生产在跑的两条链路（七牛 Anthropic 网关 / OpenAI 兼容）由 `test/dialects.test.ts` 与既有的
// `claudeBaseUrl.test.ts` 双向锁住。方言表带来的是**可声明、可校验、可固化**，不是行为变更。
//
// 推断只允许存在于本文件的 `inferDialect()` 这一个函数里。端点显式落了 `dialect` 列就不再推断——
// 后台在端点行展示推断结果并提供「确认固化」，运营点一次，这个端点从此不靠猜。

import type { AiProvider } from './schema.js';

/** 线协议：请求体与路径的形状。 */
export type WireProtocol = 'anthropic' | 'openai_chat' | 'dify' | 'mock';

/** 关闭思考的写法。三种都真实存在，不能合并。 */
export type ThinkingOffStyle =
  // 省略整个 thinking 字段（Anthropic 官方的标准做法）
  | 'omit'
  // 显式发 {type:'disabled'}（第三方 Anthropic 网关可能默认开思考，不显式关就关不掉）
  | 'explicit'
  // **仅当运营显式开过 enabled/adaptive 时**才发 {type:'disabled'}，否则整体省略。
  // 这是 OpenAI `/chat/completions` 的真实约束，不是折中：该协议没有标准 thinking 字段，
  // 对不认识它的网关发任何 thinking 都可能因未知字段报错；但运营一旦开过，就说明这个网关
  // 支持该扩展，此时工具/成果请求（allowThinking=false）必须显式发 disabled 把思考按下去，
  // 否则网关会带着思考进多轮工具调用，破坏强制 emit_deliverable 的收口。
  | 'explicit_when_configured'
  // 该方言压根没有 thinking 字段，任何情况都不发
  | 'unsupported';

export interface Dialect {
  id: string;
  label: string;
  protocol: WireProtocol;
  /** 关闭思考怎么写。 */
  thinkingOff: ThinkingOffStyle;
  /**
   * `thinking.type='disabled'` 时能否携带 `budget_tokens`。
   * 七牛=false —— `{type:'disabled', budget_tokens:0}` 会返回
   * `thinking.disabled.budget_tokens: Extra inputs are not permitted`（2026-07-27 生产实测）。
   */
  disabledAcceptsBudget: boolean;
  /**
   * 开启思考时 `budget_tokens` 是否真的被上游采纳。
   * DeepSeek 的 Anthropic 兼容端点=false（接受字段但忽略取值）→ 后台必须提示运营「这个数不生效」，
   * 否则运营会以为调大预算就想得更深。
   */
  budgetHonored: boolean;
  /** 是否可用 `GET {base}/v1/models` 自省（用于校验 model 是否在 key 的模型范围内）。 */
  listModels: boolean;
  /**
   * 嵌入 / 重排能否与对话端点同源（同 baseUrl + 同 key）。
   * Anthropic 协议=false：`${baseUrl}/embeddings` 是 OpenAI 风格路径，在 Anthropic 协议根下不存在。
   * 注意这**只是协议层的判断**；厂商有没有嵌入模型是另一回事（七牛的 OpenAI 入口协议合法但没有嵌入），
   * 那一条由 `VendorPreset.caps.embedding` 管，两条都要判。
   */
  auxEndpointsSameOrigin: boolean;
  note?: string;
}

export const DIALECTS: Dialect[] = [
  {
    id: 'anthropic_official',
    label: 'Anthropic 官方直连',
    protocol: 'anthropic',
    thinkingOff: 'omit',
    disabledAcceptsBudget: false,
    budgetHonored: true,
    listModels: true,
    auxEndpointsSameOrigin: false,
    note: '官方协议关闭思考＝省略字段；官方不提供 embedding/rerank',
  },
  {
    id: 'anthropic_gateway',
    label: 'Anthropic 兼容网关（七牛等）',
    protocol: 'anthropic',
    thinkingOff: 'explicit',
    disabledAcceptsBudget: false,
    budgetHonored: true,
    listModels: true,
    auxEndpointsSameOrigin: false,
    note: '网关可能默认开思考，必须显式发 {type:"disabled"}；且不得携带 budget_tokens（七牛会 400）',
  },
  {
    id: 'anthropic_deepseek',
    label: 'DeepSeek · Anthropic 兼容',
    protocol: 'anthropic',
    // 与通用网关同为 'explicit'：DeepSeek 是否接受 `{type:'disabled'}` 官方文档没写，
    // 而「所有第三方 Anthropic 网关都显式关」是现网既有口径——沿用它就不会给任何存量端点带来行为变化，
    // 真不接受也会被 thinking 探活项当场抓出来。**不要**因为「DeepSeek 号称兼容官方」就改成 'omit'：
    // 那是拿一个没验证的猜测去换一个已经在跑的行为。
    thinkingOff: 'explicit',
    disabledAcceptsBudget: false,
    budgetHonored: false, // 官方文档明示 budget_tokens 被忽略——后台据此提示运营「这个预算不生效」
    listModels: true,
    auxEndpointsSameOrigin: false,
    note: 'thinking 接受但 budget_tokens 被忽略；不支持 anthropic-beta / top_k / 图片与文档内容块',
  },
  {
    id: 'openai_chat',
    label: 'OpenAI 兼容（含网关 thinking 扩展）',
    protocol: 'openai_chat',
    thinkingOff: 'explicit_when_configured',
    disabledAcceptsBudget: false,
    budgetHonored: true,
    listModels: true,
    auxEndpointsSameOrigin: true,
    note: '/chat/completions 没有标准 thinking 字段：关闭时必须完全省略；只有网关扩展支持时才发 enabled/adaptive',
  },
  {
    id: 'openai_official',
    label: 'OpenAI 官方',
    protocol: 'openai_chat',
    thinkingOff: 'unsupported',
    disabledAcceptsBudget: false,
    budgetHonored: false,
    listModels: true,
    auxEndpointsSameOrigin: true,
    note: '官方 /chat/completions 没有 thinking 扩展，配了也发不出去',
  },
  {
    id: 'dify',
    label: 'Dify 应用',
    protocol: 'dify',
    thinkingOff: 'unsupported',
    disabledAcceptsBudget: false,
    budgetHonored: false,
    listModels: false,
    auxEndpointsSameOrigin: false,
  },
  {
    id: 'mock',
    label: '本地模板',
    protocol: 'mock',
    thinkingOff: 'unsupported',
    disabledAcceptsBudget: false,
    budgetHonored: false,
    listModels: false,
    auxEndpointsSameOrigin: false,
  },
];

const BY_ID = new Map(DIALECTS.map((d) => [d.id, d]));

export function dialectById(id: string | null | undefined): Dialect | null {
  return (id && BY_ID.get(id)) || null;
}

/** 域名 → 方言。只登记**方言确有差异**的厂商；没差异的走通用方言即可。 */
const HOST_DIALECT: { host: string; dialect: string; protocol: WireProtocol }[] = [
  { host: 'api.deepseek.com', dialect: 'anthropic_deepseek', protocol: 'anthropic' },
  { host: 'api.openai.com', dialect: 'openai_official', protocol: 'openai_chat' },
];

function hostOf(baseUrl: string): string {
  try { return new URL(baseUrl).hostname.toLowerCase(); } catch { return ''; }
}

/**
 * **全仓唯一的方言推断兜底**（存量端点 `dialect` 列为空时用）。
 *
 * 严格复刻 thinking.ts 的历史分支，逐位不变：
 *   · claude + baseUrl 为空 → 官方直连（历史上正是靠这个条件省略 thinking 字段）
 *   · claude + baseUrl 非空 → 第三方网关（历史上一律显式发 disabled）
 * 所以**不要**顺手把显式填了 `api.anthropic.com` 的端点也认成官方：那会改掉它的请求组装。
 * 这类端点应由运营在后台点一次「确认固化」显式选 `anthropic_official`，而不是被我们猜过去。
 */
export function inferDialect(provider: AiProvider, baseUrl: string, _model = ''): Dialect {
  if (provider === 'mock') return BY_ID.get('mock')!;
  const host = hostOf(baseUrl);
  const known = HOST_DIALECT.find((h) => host === h.host || host.endsWith(`.${h.host}`));

  if (provider === 'claude') {
    if (known && known.protocol === 'anthropic') return BY_ID.get(known.dialect)!;
    // 见上：空 baseUrl 才算官方，非空一律网关——这是历史行为的判据，不能"优化"。
    return BY_ID.get(baseUrl.trim() ? 'anthropic_gateway' : 'anthropic_official')!;
  }
  if (known && known.protocol === 'openai_chat') return BY_ID.get(known.dialect)!;
  return BY_ID.get('openai_chat')!;
}

/** 端点显式落了 dialect 就用它，否则推断。`explicit` 供后台区分「已固化」与「还在猜」。 */
export function resolveDialect(
  cfg: { provider: AiProvider; baseUrl?: string; model?: string; dialect?: string | null },
): { dialect: Dialect; explicit: boolean } {
  const named = dialectById(cfg.dialect);
  if (named) return { dialect: named, explicit: true };
  return { dialect: inferDialect(cfg.provider, cfg.baseUrl ?? '', cfg.model ?? ''), explicit: false };
}

/**
 * 该方言下，这个模型能不能带 thinking 字段。
 *
 * 复刻 `supportsThinkingConfig` 的历史口径：Anthropic 协议一律可以；OpenAI 协议只有 Claude 系模型
 * 才可以（那是网关的私有扩展，发给非 Claude 模型会因未知字段报错）。模型名正则**只在这一处**保留，
 * 且只作为「没有 caps 证据时的兜底」——探活一旦回填 caps.thinking，就以证据为准。
 */
export function dialectAllowsThinking(dialect: Dialect, model: string): boolean {
  // 唯一一处与历史行为的**刻意差异**：`openai_official` 上挂一个名字带 claude 的模型时，
  // 历史代码会把 thinking 发出去（然后被官方 API 拒），现在直接不发。该组合本身就是错配
  // （模型在 OpenAI 官方也不存在），且校验器会在保存时就拦下来，这里不必陪着发一个必错的字段。
  if (dialect.thinkingOff === 'unsupported') return false;
  if (dialect.protocol === 'anthropic') return true;
  // OpenAI 协议下 thinking 是网关私有扩展：只有 Claude 系模型才可能被网关认，
  // 发给别的模型会因未知字段报错。模型名正则**全仓只剩这一处**，且仅作 caps 缺席时的兜底。
  if (dialect.protocol === 'openai_chat') return /claude/i.test(model);
  return false;
}
