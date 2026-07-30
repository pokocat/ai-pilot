// Provider 上游等待口径。
//
// 普通对话必须尽快失败，让用户即时重试；成果/报告是异步生成，用户退出聊天页后服务端仍会继续，
// 会话列表通过 generating 状态恢复，因此可给模型更完整的生成时间。
export const DELIVERABLE_TIMEOUT_MS = 300_000;

export function deliverableTimeoutMs(configuredMs: number): number {
  return Math.max(configuredMs, DELIVERABLE_TIMEOUT_MS);
}
