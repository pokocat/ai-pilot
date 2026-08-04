import type { AiThinkingMode, AiProvider } from './schema.js';

export const DEFAULT_THINKING_MODE: AiThinkingMode = 'disabled';
export const MIN_THINKING_BUDGET = 1024;
export const MAX_THINKING_BUDGET = 7000;

export interface ThinkingConfigLike {
  provider: AiProvider;
  baseUrl?: string;
  model: string;
  temperature: number;
  thinkingMode: AiThinkingMode;
  thinkingBudget: number;
}

export type ThinkingParam =
  | { type: 'disabled' }
  | { type: 'enabled'; budget_tokens: number }
  | { type: 'adaptive' };

export function normalizeThinkingMode(value: unknown): AiThinkingMode {
  return value === 'enabled' || value === 'adaptive' ? value : DEFAULT_THINKING_MODE;
}

export function normalizeThinkingBudget(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return MIN_THINKING_BUDGET;
  return Math.min(MAX_THINKING_BUDGET, Math.max(MIN_THINKING_BUDGET, Math.round(n)));
}

export function thinkingEnabled(mode: AiThinkingMode): boolean {
  return mode === 'enabled' || mode === 'adaptive';
}

export function effectiveThinkingTemperature(temperature: number, mode: AiThinkingMode): number {
  return thinkingEnabled(mode) ? 1 : temperature;
}

/** 仅 Claude 模型下发 thinking，避免其它 OpenAI 兼容模型因未知字段报错。 */
export function supportsThinkingConfig(cfg: Pick<ThinkingConfigLike, 'provider' | 'model'>): boolean {
  return cfg.provider === 'claude' || /claude/i.test(cfg.model);
}

/**
 * 组装七牛/Anthropic 兼容 thinking 参数。
 * 工具调用受 Anthropic 限制，只支持 auto/none 且须跨轮保留 thinking block；现有强制成果工具链
 * 因此显式关闭 thinking，避免配置开关破坏结构化成果与多轮工具调用。
 */
export function thinkingRequestTuning(
  cfg: ThinkingConfigLike,
  opts: { allowThinking?: boolean } = {},
): { temperature: number; thinking?: ThinkingParam } {
  if (!supportsThinkingConfig(cfg)) return { temperature: cfg.temperature };
  const configuredMode = normalizeThinkingMode(cfg.thinkingMode);
  // OpenAI chat/completions 并没有标准 thinking 字段：默认关闭时必须完全省略。
  // 只有运营显式开启过的 Claude 兼容扩展，才在工具/成果请求里发送 disabled 来强制关思考。
  if (cfg.provider === 'openai' && configuredMode === 'disabled') {
    return { temperature: cfg.temperature };
  }
  const mode = opts.allowThinking === false ? 'disabled' : configuredMode;
  if (mode === 'enabled') {
    return {
      temperature: 1,
      thinking: { type: 'enabled', budget_tokens: normalizeThinkingBudget(cfg.thinkingBudget) },
    };
  }
  if (mode === 'adaptive') return { temperature: 1, thinking: { type: 'adaptive' } };
  // Anthropic 官方关闭 Thinking 的标准方式是省略 thinking；七牛等第三方网关则支持显式 disabled。
  if (cfg.provider === 'claude' && !cfg.baseUrl?.trim()) return { temperature: cfg.temperature };
  // 七牛 Anthropic 兼容协议只允许 enabled 携带 budget_tokens；disabled 带 0 也会被判为多余字段。
  return { temperature: cfg.temperature, thinking: { type: 'disabled' } };
}

/** 手动思考预算必须小于 max_tokens；轻量补全自动给回答预留 512 token。 */
export function maxTokensForThinking(base: number, cfg: ThinkingConfigLike, allowThinking = true): number {
  return allowThinking && normalizeThinkingMode(cfg.thinkingMode) === 'enabled' && supportsThinkingConfig(cfg)
    ? Math.max(base, normalizeThinkingBudget(cfg.thinkingBudget) + 512)
    : base;
}

/**
 * 对话正文预算 → 实际下发的 max_tokens。
 *
 * `max_tokens` 在 Anthropic 协议里管的是「thinking + 正文」的总量，模型自己看不到这个数、
 * 撞上就断句。所以正文预算必须是**净额**：开 Thinking 时把思考预算整个叠加上去，运营调
 * thinkingBudget 只影响思考深度，永远不会偷走正文的 8000。
 *
 * 此前 chat 路径写死 `max_tokens: CHAT_MAX_TOKENS`（只有辅助抽取走了 maxTokensForThinking），
 * 于是 thinkingBudget=7000 时正文只剩 1000 token —— 这就是「回复未完整结束」的根因。
 *
 * `adaptive` 的思考量由模型自己决定、无预算可查，只能按手动档上限保守预留，宁可多给。
 */
export function chatMaxTokens(bodyBudget: number, cfg: ThinkingConfigLike, allowThinking = true): number {
  if (!allowThinking || !supportsThinkingConfig(cfg)) return bodyBudget;
  const mode = normalizeThinkingMode(cfg.thinkingMode);
  if (mode === 'enabled') return bodyBudget + normalizeThinkingBudget(cfg.thinkingBudget);
  if (mode === 'adaptive') return bodyBudget + MAX_THINKING_BUDGET;
  return bodyBudget;
}
