// Provider 上游等待口径。
//
// 普通对话必须尽快失败，让用户即时重试；成果/报告是异步生成，用户退出聊天页后服务端仍会继续，
// 会话列表通过 generating 状态恢复，因此可给模型更完整的生成时间。
export const DELIVERABLE_TIMEOUT_MS = 300_000;

export function deliverableTimeoutMs(configuredMs: number): number {
  return Math.max(configuredMs, DELIVERABLE_TIMEOUT_MS);
}

/**
 * 普通对话的上游等待**下限**。
 *
 * 「对话要尽快失败」的原则没变，但 60s 不是「快」，是「不够」：流式路径早就在用 120s 下限
 * （`Math.max(ep.timeoutMs, 120_000)`），非流式对话路径却直接吃 `cfg.timeoutMs`——线上
 * `OPENAI_TIMEOUT_MS=60000`，而实测这个上游产 8000 token 要 130–145s（≈59 token/s），
 * 60s 只够 ~3500 token。于是任何稍长一点的非流式对话必然 `Request timed out.`
 * （2026-08-04 线上「连续超时」：每次截断报错后端上补发的非流式兜底都卡在精确的 60.0s）。
 *
 * 两条路径统一到同一下限。**不要改成抬高 `OPENAI_TIMEOUT_MS`**：那个值同时管着 700 token
 * 的辅助抽取（记忆/摘要），抬高只会让网关卡住时那些短调用一起吊死。
 *
 * 续写轮不用这个下限，用 `CONTINUE_ROUND_TIMEOUT_MS`（更短）——否则「首轮 + 续写」会顶穿
 * nginx `proxy_read_timeout` 180s。
 */
export const CHAT_TIMEOUT_MS = 120_000;

export function chatTimeoutMs(configuredMs: number): number {
  return Math.max(configuredMs, CHAT_TIMEOUT_MS);
}
