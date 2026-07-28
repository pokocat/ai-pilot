// Token 成本核算：把一次调用的 token 用量按「单价（元 / 1M token）」折算成「微元」（1e-6 元）整数。
// 单价由运营在「模型」配置里逐个模型填写（见 aiConfig.resolveModelRate）；
// 没配单价的模型成本一律计 0 —— 不做任何内置价表估算或回退。

export interface ModelRate {
  in: number;         // 元 / 1M 输入 token（未命中缓存的部分）
  out: number;        // 元 / 1M 输出 token
  cachedIn?: number;  // 元 / 1M 命中缓存输入 token（缺省按 in 计）
  cacheWrite?: number; // 元 / 1M 写入缓存输入 token（缺省按 in × CACHE_WRITE_MULTIPLIER 计）
}

/**
 * 缓存写入相对基础输入价的倍数。
 *
 * Anthropic 官方计价：命中缓存读 0.1×，写入缓存 **1.25×**（5 分钟 TTL）/ 2×（1 小时 TTL）。
 * 运营后台目前只填 in / out / cachedIn 三档，没有缓存写这一档，故在此按官方倍数推导；
 * 真要精确到 1 小时 TTL，运营需显式填 rate.cacheWrite。
 *
 * 修这个默认值之前：先确认上游是否透传缓存计价 —— 若供应商按统一单价结算，
 * 这里应设为 1（等同 in），否则会高估成本。
 */
export const CACHE_WRITE_MULTIPLIER = 1.25;

/**
 * 估算本次调用成本，返回「微元」（1e-6 元）整数 —— 整数存储防浮点漂移。
 * 推导：费率是 元/1M token，成本(元)=tokens/1e6·rate，成本(微元)=成本·1e6=tokens·rate（无需再乘除百万）。
 * rate 由调用方解析（运营配置的单价；没配 → 传 {in:0,out:0} → 成本 0）。
 *
 * 输入 token 拆三档，各自计价：
 *   ① 命中缓存（cachedInput）→ cachedIn，约 0.1×
 *   ② 写入缓存（cacheWrite）  → cacheWrite，约 1.25×
 *   ③ 其余未缓存部分          → in，1×
 * usage.inputTokens 约定为**三者之和**（provider 侧的 usageOf 负责归一），
 * 故 ③ = inputTokens − ① − ②。provider 不报 cacheWrite 时该档为 0，
 * 行为与旧版（只拆命中/未命中两档）完全一致。
 */
export function estimateCostMicros(
  usage: { inputTokens: number; outputTokens: number; cachedInput?: number; cacheWrite?: number },
  rate: ModelRate,
): number {
  const total = Math.max(0, usage.inputTokens);
  // 逐档 clamp 并保证 ①+② 不超过总输入，避免 provider 报数异常时把 ③ 算成负数。
  const cached = Math.min(Math.max(0, usage.cachedInput ?? 0), total);
  const written = Math.min(Math.max(0, usage.cacheWrite ?? 0), total - cached);
  const freshInput = total - cached - written;

  const cachedRate = rate.cachedIn ?? rate.in;
  const writeRate = rate.cacheWrite ?? rate.in * CACHE_WRITE_MULTIPLIER;

  const micros = freshInput * rate.in
    + written * writeRate
    + cached * cachedRate
    + Math.max(0, usage.outputTokens) * rate.out;
  return Math.round(micros);
}
