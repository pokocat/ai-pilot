// 落库 assistant 消息 contentJson → 可渲染的 ChatReply。
//
// 从 packages/main/chat/index.tsx 抽出来的纯函数（同 liveGenCore 的做法）：它是历史还原与
// 流式收尾的**唯一收口**，漏掉一个字段就会让那条回复的能力静默消失（比如漏掉 truncated，
// 退出重进后「继续写完」入口就没了），所以要能单测。
import type { ChatReply } from '../../../shared/contracts';

/**
 * 服务端写的是 { text, points?, acts?, asks?, truncated? }，但存量/异常数据里出现过：
 * 整条不是对象、缺 text、points/asks 不是数组。这些值一路带进渲染期后：`m.reply.text` 交给
 * MarkdownText 会在 parseBlocks 抛错，`mm.reply.asks?.length` 在 activeAskIdx 计算里抛错
 * ——都是整页白屏。这里把它收成「一定能渲染」的形状；asks 逐项也要保证 options 是数组。
 */
export function asReply(content: unknown): ChatReply {
  // 口径与服务端 llm/schema.ts 的 textOf 一致：非字符串标量转字符串，对象丢弃。
  const txt = (v: unknown): string =>
    typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
  const c = (content && typeof content === 'object' ? content : {}) as Record<string, unknown>;
  const asks = Array.isArray(c.asks)
    ? c.asks
        .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object')
        .map((a) => ({ q: txt(a.q), options: (Array.isArray(a.options) ? a.options : []).map(txt).filter(Boolean) }))
        .filter((a) => a.q || a.options.length)
    : undefined;
  return {
    text: txt(c.text),
    ...(Array.isArray(c.points) ? { points: c.points.map(txt).filter(Boolean) } : {}),
    ...(Array.isArray(c.acts) ? { acts: c.acts as ChatReply['acts'] } : {}),
    ...(asks?.length ? { asks } : {}),
    // 「还没写完」要跟着历史一起还原：退出重进本会话后，那条回复仍应带「继续写完」入口，
    // 而不是变成一条看起来正常结束、实际断在半句的回复。只认布尔 true，不做真值转换——
    // 存量数据里的字符串 "false" 之类不能被当成「未写完」。
    ...(c.truncated === true ? { truncated: true as const } : {}),
  };
}

/** 复制/朗读用：正文 + 要点拼成一段纯文本。 */
export function replyToText(reply: ChatReply): string {
  return [reply?.text, ...(Array.isArray(reply?.points) ? reply.points : [])].filter(Boolean).join('\n\n');
}
