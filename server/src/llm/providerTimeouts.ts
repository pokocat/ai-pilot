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
 * 为什么是 150s 而不是原来流式那个 120s：线上实测这个上游 55–130 token/s（干净时 ~127，
 * 带负载/思考时 ~55），而开思考后 max_tokens 是 8000 正文 + 7000 思考 = 15000，最长回复
 * 在慢的时候要 200s+。120s 会在「已经流出上万字之后」把整轮判失败——那正是这次要消灭的
 * 那类事故。150s + 续写 60s 的最坏组合仍留在 nginx 180s 内（见 CONTINUE_DEADLINE_MS）。
 *
 * 续写轮不用这个下限，用 `CONTINUE_ROUND_TIMEOUT_MS`（更短）——否则「首轮 + 续写」会顶穿
 * nginx `proxy_read_timeout` 180s。
 */
export const CHAT_TIMEOUT_MS = 150_000;

export function chatTimeoutMs(configuredMs: number): number {
  return Math.max(configuredMs, CHAT_TIMEOUT_MS);
}

/**
 * 流式的**空闲**看门狗：多久没有任何流事件就判上游装死。
 *
 * 为什么必须是空闲而不是总时长：一条正常写着的长回复不能因为「写了太久」被判失败——那正是
 * 2026-08-04 那类事故的形状。但**完全不设保护也不行**：网关发完响应头就静默，会把请求一直挂着
 * 并占住一个 LLM 并发槽，只能等客户端断开。
 *
 * 为什么 claude 侧非补不可：`@anthropic-ai/sdk` 的 `fetchWithTimeout` 在 fetch promise 的
 * `.finally()` 里 `clearTimeout`，而流式 fetch 在**响应头到达时**就 resolve，`streaming.js` /
 * `MessageStream.js` 里再无任何超时逻辑——所以 SDK 的 `timeout` 只约束「多久拿到响应头」，
 * 之后零保护。openai 侧本来就是空闲口径（`readOpenAIStream` 每收到字节 refresh），这里把两边
 * 统一到同一组阈值。
 *
 * 首个事件给得宽（90s）：开着 thinking 时模型可能先想很久，期间**可能一个事件都不发**。
 * 之后收紧（30s）：实测相邻 delta 间隔在毫秒级，30s 已经极宽松，还留着网关抖动的余量。
 */
export const STREAM_FIRST_EVENT_IDLE_MS = 90_000;
export const STREAM_IDLE_MS = 30_000;
