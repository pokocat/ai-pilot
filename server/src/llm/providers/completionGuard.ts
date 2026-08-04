import { noteOutputTruncated } from '../../services/metrics.js';

/**
 * 普通对话**单轮正文**预算。
 *
 * 注意这只是正文：Anthropic 协议里 `max_tokens` 是「thinking + 正文」的总闸，所以开了 Thinking
 * 之后必须把思考预算叠加上去（见 `chatMaxTokens`），否则运营把 thinkingBudget 拉到 7000，正文
 * 就只剩 1000 token —— 稍长的回复必然被拦腰截断，且与内容无关。这是 2026-08 截断投诉的根因。
 */
export const CHAT_MAX_TOKENS = 8000;

/**
 * 撞上限后服务端自动续写的最大轮数。
 *
 * 为什么要自动续写而不是报错：`max_tokens` 是**模型看不见的硬闸刀**，调大只是把悬崖往后挪，
 * 撞上时模型自己并不知道该收尾。成熟对话产品一律把它当「待续」而不是「失败」——保留残文、
 * 接着写完。设 2 轮是因为：正常长回复 1 轮就补齐；还补不完说明用户要的是报告，应走成果路径。
 */
export const MAX_CHAT_CONTINUATIONS = 2;

/** 单轮对话（首轮 + 续写）累计正文预算硬顶。超过即停止续写、标 truncated 交回用户决定。 */
export const CHAT_TOTAL_MAX_TOKENS = CHAT_MAX_TOKENS * (MAX_CHAT_CONTINUATIONS + 1);

/**
 * 「还允许**开始**下一轮续写」的墙钟上限（自本轮对话起算）。
 *
 * 续写把单轮总时长最多推到 3 倍，而客户端只等 180s（小程序 `Taro.request` 显式 180000、
 * nginx `proxy_read_timeout` 同为 180s）。顶穿的后果比截断更糟：`clientGone` 会退预留、
 * 不落库，用户连已经看完的那半篇都拿不到。所以宁可标 truncated 给「继续写完」，
 * 也不能为了补齐而把整轮拖死。100s + 单轮续写 60s 上限 = 最坏 160s，留 20s 余量。
 */
export const CONTINUE_DEADLINE_MS = 100_000;

/** 续写轮的流超时上限：这一轮只是把话写完（已关思考），不该比首轮还久。 */
export const CONTINUE_STREAM_TIMEOUT_MS = 60_000;

/** 续写时回看的正文尾巴长度（既要够模型定位断点，又不能白烧 input token）。 */
const CONTINUE_TAIL_CHARS = 240;

/** 去重时考虑的最大重叠长度：模型复述一般不超过一两句。 */
const OVERLAP_SCAN_CHARS = 200;

const TRUNCATED_REASONS = new Set(['length', 'max_tokens']);

/** Claude `stop_reason=max_tokens` / OpenAI `finish_reason=length` → 本轮正文被硬截断。 */
export function isTruncatedFinish(finishReason: string | null | undefined): boolean {
  return !!finishReason && TRUNCATED_REASONS.has(finishReason);
}

/** 观测：记一次撞上限，并区分是被续写救回还是最终交给用户续。 */
export function noteChatTruncated(provider: 'Claude' | 'OpenAI', resolved: 'continued' | 'given_up'): void {
  noteOutputTruncated(provider.toLowerCase(), resolved);
}

/** 撞上限且无从挽救时的统一错误（503 / AI_OUTPUT_TRUNCATED，上层据此退预留并给用户文案）。 */
export function truncatedError(
  provider: 'Claude' | 'OpenAI',
  finishReason: string | null | undefined,
  outputTokens: number,
  detail: string,
): Error {
  noteChatTruncated(provider, 'given_up');
  return Object.assign(
    new Error(`${provider} 输出达到 ${outputTokens || CHAT_MAX_TOKENS} token 上限，${detail}`),
    { code: 'AI_OUTPUT_TRUNCATED', statusCode: 503, finishReason, outputTokens },
  );
}

/**
 * **结构化成果路径专用**：半份报告不能出厂。
 *
 * 成果是可分享、可持久化、会被当成交付物的东西，截断的 tool 入参本身就是坏 JSON，
 * 半截 sections 更不能冒充完整报告——这一路仍按失败抛，由上层退预留 + 提示重试。
 * 普通对话不要用这个函数：对话走 `isTruncatedFinish` + 续写。
 */
export function assertChatOutputComplete(
  provider: 'Claude' | 'OpenAI',
  finishReason: string | null | undefined,
  outputTokens: number,
): void {
  if (!isTruncatedFinish(finishReason)) return;
  throw truncatedError(provider, finishReason, outputTokens, '产出未完整结束');
}

/**
 * 「一个字正文都没写就撞上限」——没有锚点可续写，只能如实报错。
 *
 * 这个形态几乎总是**思考预算把 max_tokens 占满了**：`max_tokens` 管的是 thinking + 正文的总量，
 * 早期 chat 路径写死 8000 而 thinkingBudget 可配到 7000，于是正文预算只剩 1000、甚至归零。
 * 文案直接指向预算，别让排查的人从「空响应」开始猜。
 */
export function assertChatBodyProduced(
  provider: 'Claude' | 'OpenAI',
  finishReason: string | null | undefined,
  outputTokens: number,
): void {
  if (!isTruncatedFinish(finishReason)) return;
  throw truncatedError(provider, finishReason, outputTokens, '且没有产出任何正文（检查思考预算是否占满了输出预算）');
}

/**
 * 续写指令（放在 **user 轮**，不是 assistant prefill）。
 *
 * 老办法「把残文当 assistant 最后一轮接着写」在 Claude Opus 4.6 及以后会直接 400
 * （末轮 assistant prefill 已被移除）。放进 user 轮是官方给的替代写法，新旧模型都安全，
 * OpenAI 兼容网关同样吃得下，所以两个 provider 共用这一条。
 */
export function continuationPrompt(accumulated: string): string {
  const tail = accumulated.slice(-CONTINUE_TAIL_CHARS);
  return [
    '（系统提示，不要在回复里提到这条提示）',
    '你上一条回复因为输出长度上限被截断了，并没有写完。它的结尾是：',
    `「${tail}」`,
    '请直接从这个断点往后接着写完，注意：',
    '1. 不要重复已经写过的内容，不要重新开头、不要复述前文；',
    '2. 不要写「接上文」「继续」这类过渡语，直接续上文字；',
    '3. 如果上一句话或某个词被截断了，先把它补完整；',
    '4. 剩下的内容请收敛着写完，优先给出结论和可执行动作。',
  ].join('\n');
}

/**
 * 去掉续写开头与已有正文的重叠。
 *
 * 即使有上面的指令，模型仍会偶尔复述最后半句。取「已有正文的最长后缀 ∩ 续写的前缀」剪掉，
 * 用户看到的就是一条连续的话，而不是磕巴一下。只在续写的**开头**做一次，不影响正文其余部分。
 */
export function dedupeContinuation(accumulated: string, next: string): string {
  if (!accumulated || !next) return next;
  const scan = Math.min(OVERLAP_SCAN_CHARS, accumulated.length, next.length);
  for (let len = scan; len > 0; len--) {
    if (accumulated.endsWith(next.slice(0, len))) return next.slice(len);
  }
  return next;
}

/**
 * 拼接续写 = 去重叠后直接贴上，**不补空格**。
 * 截断可能发生在词中间（"毛利率大约是 3" + "8%"），补任何分隔符都会写坏数字。
 */
export function joinContinuation(accumulated: string, next: string): string {
  return accumulated + dedupeContinuation(accumulated, next);
}

/**
 * 流式续写轮开头先攒这么多字符再下发。
 * 攒一小段才有东西可去重——否则模型复述的半句话已经逐字吐给用户了，撤不回来。
 * 只影响续写轮的头部，首轮与续写轮的后续 token 一律即时下发，不牺牲流式手感。
 */
export const CONTINUE_DEDUPE_BUFFER_CHARS = 200;
