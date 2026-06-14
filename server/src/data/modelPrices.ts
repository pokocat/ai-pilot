// 模型单价表（token 计费 P1）。单位统一：人民币（元）/ 1M token。
// 费率口径借用 LiteLLM 维护的 model_prices_and_context_window.json（其原值为 USD）：
//   https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json
// OpenAI/Anthropic 官方价以美元计，经 usd() × 汇率换算成元；国产网关（如 agnes）原生以元计，直接写元。
// 价格/汇率会变——更新时对照 LiteLLM 同名条目，或调整 USD_TO_CNY。未命中模型走 DEFAULT_RATE 并标「待校准」。

export interface ModelRate {
  in: number; // 元 / 1M 输入 token
  out: number; // 元 / 1M 输出 token
  cachedIn?: number; // 元 / 1M 命中提示缓存的输入 token（缺省按 in 计）
}

// 美元→人民币汇率（可调）。仅用于把 LiteLLM 的美元官方价换算成元；国产网关价请直接以元填写、不经 usd()。
export const USD_TO_CNY = 7.2;
const usd = (perMUsd: number): number => +(perMUsd * USD_TO_CNY).toFixed(4); // USD/1M → 元/1M

export const MODEL_RATES: Record<string, ModelRate> = {
  // —— OpenAI（官方美元价 × 汇率）——
  'gpt-4o': { in: usd(2.5), out: usd(10), cachedIn: usd(1.25) },
  'gpt-4o-mini': { in: usd(0.15), out: usd(0.6), cachedIn: usd(0.075) },
  'gpt-4.1': { in: usd(2), out: usd(8), cachedIn: usd(0.5) },
  'gpt-4.1-mini': { in: usd(0.4), out: usd(1.6), cachedIn: usd(0.1) },
  'gpt-4.1-nano': { in: usd(0.1), out: usd(0.4), cachedIn: usd(0.025) },
  // —— Anthropic / Claude（官方美元价 × 汇率）——
  'claude-3-5-sonnet': { in: usd(3), out: usd(15), cachedIn: usd(0.3) },
  'claude-3-5-haiku': { in: usd(0.8), out: usd(4), cachedIn: usd(0.08) },
  'claude-3-opus': { in: usd(15), out: usd(75), cachedIn: usd(1.5) },
  'claude-sonnet-4': { in: usd(3), out: usd(15), cachedIn: usd(0.3) },
  'claude-opus-4': { in: usd(15), out: usd(75), cachedIn: usd(1.5) },
  'claude-haiku-4': { in: usd(1), out: usd(5), cachedIn: usd(0.1) },
  // —— DeepSeek（OpenAI 兼容；官方美元价 × 汇率）——
  'deepseek-chat': { in: usd(0.27), out: usd(1.1), cachedIn: usd(0.07) },
  'deepseek-reasoner': { in: usd(0.55), out: usd(2.19), cachedIn: usd(0.14) },
  // —— 国产网关：原生以元计，按 provider 计费页直接填元（示例，待校准后启用）——
  // 'agnes-2.0-flash': { in: 1, out: 2 },
};

// 未知模型兜底（含当前默认 agnes-2.0-flash —— 真实单价请按 provider 计费页以「元」加入 MODEL_RATES）。
export const DEFAULT_RATE: ModelRate = { in: 1, out: 3 };

/**
 * 取某模型的费率。模型名常带日期/版本后缀（claude-3-5-sonnet-20241022、gpt-4o-2024-08-06），
 * 先精确命中，再按前缀匹配；都不中则 DEFAULT_RATE 且 calibrated=false（统计里标「待校准」）。
 */
export function rateFor(model: string): { rate: ModelRate; calibrated: boolean } {
  const m = (model || '').toLowerCase();
  if (MODEL_RATES[m]) return { rate: MODEL_RATES[m], calibrated: true };
  const key = Object.keys(MODEL_RATES).find((k) => m.startsWith(k));
  if (key) return { rate: MODEL_RATES[key], calibrated: true };
  return { rate: DEFAULT_RATE, calibrated: false };
}

/**
 * 估算本次调用成本，返回「微元」（1e-6 元）整数 —— 整数存储防浮点漂移。
 * 推导：费率是 元/1M token，成本(元)=tokens/1e6·rate，成本(微元)=成本·1e6=tokens·rate。
 * 故 微元 = token 数 × 费率(元/1M)，无需再乘除百万。
 */
export function estimateCostMicros(
  model: string,
  usage: { inputTokens: number; outputTokens: number; cachedInput?: number },
): number {
  const { rate } = rateFor(model);
  const cached = Math.min(Math.max(0, usage.cachedInput ?? 0), Math.max(0, usage.inputTokens));
  const freshInput = Math.max(0, usage.inputTokens) - cached;
  const cachedRate = rate.cachedIn ?? rate.in;
  const micros = freshInput * rate.in + Math.max(0, usage.outputTokens) * rate.out + cached * cachedRate;
  return Math.round(micros);
}
