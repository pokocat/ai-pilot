// Token 成本核算：把一次调用的 token 用量按「单价（元 / 1M token）」折算成「微元」（1e-6 元）整数。
// 单价由运营在「模型」配置里逐个模型填写（见 aiConfig.resolveModelRate）；
// 没配单价的模型成本一律计 0 —— 不做任何内置价表估算或回退。

export interface ModelRate {
  in: number;        // 元 / 1M 输入 token
  out: number;       // 元 / 1M 输出 token
  cachedIn?: number; // 元 / 1M 命中缓存输入 token（缺省按 in 计）
}

/**
 * 估算本次调用成本，返回「微元」（1e-6 元）整数 —— 整数存储防浮点漂移。
 * 推导：费率是 元/1M token，成本(元)=tokens/1e6·rate，成本(微元)=成本·1e6=tokens·rate（无需再乘除百万）。
 * rate 由调用方解析（运营配置的单价；没配 → 传 {in:0,out:0} → 成本 0）。
 */
export function estimateCostMicros(
  usage: { inputTokens: number; outputTokens: number; cachedInput?: number },
  rate: ModelRate,
): number {
  const cached = Math.min(Math.max(0, usage.cachedInput ?? 0), Math.max(0, usage.inputTokens));
  const freshInput = Math.max(0, usage.inputTokens) - cached;
  const cachedRate = rate.cachedIn ?? rate.in;
  const micros = freshInput * rate.in + Math.max(0, usage.outputTokens) * rate.out + cached * cachedRate;
  return Math.round(micros);
}
