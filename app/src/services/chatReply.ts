// 落库 assistant 消息 contentJson → 可渲染的 ChatReply。
//
// 从 packages/main/chat/index.tsx 抽出来的纯函数（同 liveGenCore 的做法）：它是历史还原与
// 流式收尾的**唯一收口**，漏掉一个字段就会让那条回复的能力静默消失（比如漏掉 truncated，
// 退出重进后「继续写完」入口就没了），所以要能单测。
import type { ChatReply } from '../../../shared/contracts';

type AskRow = { q: string; options: string[] };

function stripSerializedAsksTail(text: string, expected: AskRow[]): string {
  if (!text || !expected.length) return text;
  const normalize = (value: unknown): AskRow[] => Array.isArray(value)
    ? value
        .filter((row): row is Record<string, unknown> => !!row && typeof row === 'object')
        .map((row) => ({
          q: typeof (row.q ?? row.question) === 'string' ? String(row.q ?? row.question).trim() : '',
          options: Array.isArray(row.options) ? row.options.filter((item): item is string => typeof item === 'string' && !!item) : [],
        }))
        .filter((row) => row.q && row.options.length)
    : [];
  const parse = (source: string): AskRow[] => {
    try {
      const parsed = JSON.parse(source) as unknown;
      return normalize(parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>).asks
        : parsed);
    } catch { return []; }
  };
  const same = (rows: AskRow[]) => rows.length === expected.length && rows.every((row, index) =>
    row.q === expected[index].q
    && row.options.length === expected[index].options.length
    && row.options.every((option, optionIndex) => option === expected[index].options[optionIndex]));

  const askFence = text.match(/```ask\s*([\s\S]*?)```\s*$/);
  if (askFence) return text.slice(0, askFence.index).trimEnd();
  const jsonFence = text.match(/```(?:json)?\s*([\s\S]*?)```\s*$/i);
  if (jsonFence && same(parse(jsonFence[1]))) return text.slice(0, jsonFence.index).trimEnd();
  const trimmed = text.trimEnd();
  for (let index = trimmed.length - 1; index >= 0; index -= 1) {
    if (trimmed[index] !== '[' && trimmed[index] !== '{') continue;
    const lineStart = trimmed.lastIndexOf('\n', index - 1) + 1;
    if (trimmed.slice(lineStart, index).trim()) continue;
    if (same(parse(trimmed.slice(index)))) return trimmed.slice(0, lineStart).trimEnd();
  }
  return text;
}

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
  const rawFact = c.factConfirmation && typeof c.factConfirmation === 'object'
    ? c.factConfirmation as Record<string, unknown>
    : null;
  const factItems = rawFact && Array.isArray(rawFact.items)
    ? rawFact.items
        .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
        .map((item) => ({
          id: txt(item.id),
          factKey: txt(item.factKey),
          valueText: txt(item.valueText),
          reason: ['assistant_inference', 'document_extraction', 'conflict', 'high_impact'].includes(txt(item.reason))
            ? txt(item.reason) as 'assistant_inference' | 'document_extraction' | 'conflict' | 'high_impact'
            : 'assistant_inference' as const,
        }))
        .filter((item) => item.id && item.factKey && item.valueText)
    : [];
  return {
    text: stripSerializedAsksTail(txt(c.text), asks ?? []),
    ...(Array.isArray(c.points) ? { points: c.points.map(txt).filter(Boolean) } : {}),
    ...(Array.isArray(c.acts) ? { acts: c.acts as ChatReply['acts'] } : {}),
    ...(asks?.length ? { asks } : {}),
    ...(factItems.length ? { factConfirmation: { title: txt(rawFact?.title) || '这条是我的推断，想请你核一下', items: factItems } } : {}),
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

/** 用户只附资料、不输入文字时，为模型补一条自然且可见的请求，避免发送空 text。 */
export function attachmentOnlyPrompt(refs: Array<{ kind?: string; label?: string }>): string {
  const rows = Array.isArray(refs) ? refs.filter(Boolean) : [];
  if (!rows.length) return '';
  if (rows.length === 1 && rows[0]?.kind === 'image') {
    return '请看我附上的图片，先说明你看到了什么，再给我最关键的判断。';
  }
  const label = rows.length === 1 ? String(rows[0]?.label || '').trim() : `${rows.length}份资料`;
  return `请通读我附上的${label ? `《${label}》` : '资料'}，先概括重点，再告诉我最值得注意的判断。`;
}
