import type { AiThinkingMode, AiProvider } from './schema.js';
import { resolveDialect, dialectAllowsThinking, type Dialect } from './dialects.js';
import { capOf, readCaps } from './configSchemas.js';

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
  /** 端点显式固化的方言（llm/dialects.ts）。留空＝走 inferDialect 兜底。 */
  dialect?: string | null;
  /** 探活回填的能力标记。thinking='no' 表示已被证伪，此时一律不发 thinking。 */
  capsJson?: unknown;
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

/**
 * 这个端点能不能带 thinking 字段。
 *
 * 判据的优先级：**探活证据 > 方言 + 模型名兜底**。
 * 从前这里是 `provider === 'claude' || /claude/i.test(model)` ——纯猜；现在正则只作为
 * 「还没探测过」时的兜底留在 `dialectAllowsThinking()` 里，一旦探活回填 `caps.thinking='no'`
 * （比如七牛某个模型明确不支持思考），立刻以证据为准，不再发这个必错的字段。
 */
export function supportsThinkingConfig(
  cfg: Pick<ThinkingConfigLike, 'provider' | 'model'> & Partial<Pick<ThinkingConfigLike, 'baseUrl' | 'dialect' | 'capsJson'>>,
): boolean {
  if (capOf(readCaps(cfg.capsJson), 'thinking') === 'no') return false;
  const { dialect } = resolveDialect({
    provider: cfg.provider, baseUrl: cfg.baseUrl ?? '', model: cfg.model, dialect: cfg.dialect,
  });
  return dialectAllowsThinking(dialect, cfg.model);
}

/**
 * 组装 thinking 参数。**关闭思考有三种写法，且各家不同**——这正是方言表存在的理由：
 *
 *   · Anthropic 官方   → 省略整个字段（`thinkingOff: 'omit'`）
 *   · 七牛等兼容网关   → 显式 `{type:'disabled'}`，且**不得带 `budget_tokens`**（带了 400）
 *   · OpenAI `/chat/completions` → 没有标准 thinking 字段，关闭时必须完全省略；
 *     只有运营显式开了 enabled/adaptive 才当作网关扩展发出去
 *
 * 工具调用受 Anthropic 限制（只支持 tool_choice=auto/none 且须跨轮保留 thinking block），
 * 现有强制成果工具链因此显式关闭思考——不能为一个开关破坏结构化成果链路。
 */
export function thinkingRequestTuning(
  cfg: ThinkingConfigLike,
  opts: { allowThinking?: boolean } = {},
): { temperature: number; thinking?: ThinkingParam } {
  if (!supportsThinkingConfig(cfg)) return { temperature: cfg.temperature };
  const { dialect } = resolveDialect({
    provider: cfg.provider, baseUrl: cfg.baseUrl ?? '', model: cfg.model, dialect: cfg.dialect,
  });
  const configuredMode = normalizeThinkingMode(cfg.thinkingMode);

  // 关闭态：按方言决定省略还是显式发。OpenAI 协议与 Anthropic 官方都是省略（thinkingOff='omit'），
  // 兼容网关是显式（'explicit'）——历史代码用「provider==='openai'」和「baseUrl 空不空」两个
  // 独立分支表达同一件事，正是靠猜；现在统一由方言的一个字段回答。
  const mode = opts.allowThinking === false ? 'disabled' : configuredMode;
  if (mode === 'enabled') {
    return {
      temperature: 1,
      thinking: { type: 'enabled', budget_tokens: normalizeThinkingBudget(cfg.thinkingBudget) },
    };
  }
  if (mode === 'adaptive') return { temperature: 1, thinking: { type: 'adaptive' } };

  const explicitOff = dialect.thinkingOff === 'explicit'
    // OpenAI 协议：运营没开过思考就完全省略（对不认扩展的网关发任何 thinking 都可能报错）；
    // 开过则说明网关支持该扩展，此时必须显式按下去——否则网关带着思考进多轮工具调用，
    // 会破坏强制 emit_deliverable 的收口（Anthropic Thinking 只允许 tool_choice=auto/none）。
    || (dialect.thinkingOff === 'explicit_when_configured' && configuredMode !== 'disabled');
  if (!explicitOff) return { temperature: cfg.temperature };
  // 显式关闭只发 type，绝不带 budget_tokens：七牛仅在 enabled 时接受预算字段，
  // `disabled + budget_tokens:0` 会返回 `Extra inputs are not permitted`（2026-07-27 生产实测）。
  return { temperature: cfg.temperature, thinking: { type: 'disabled' } };
}

/** 该端点的方言（供校验器 / 后台展示 / 探活复用同一份判断）。 */
export function dialectOf(cfg: Pick<ThinkingConfigLike, 'provider' | 'baseUrl' | 'model' | 'dialect'>): { dialect: Dialect; explicit: boolean } {
  return resolveDialect({ provider: cfg.provider, baseUrl: cfg.baseUrl ?? '', model: cfg.model, dialect: cfg.dialect });
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
