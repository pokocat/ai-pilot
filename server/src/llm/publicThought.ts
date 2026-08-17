// 用户可见的「思路摘要」协议。
//
// 这不是 provider 的 hidden reasoning / chain-of-thought：模型在普通可见正文通道里显式写出
// 一段短摘要，网关再把它拆成独立事件。供应商的 thinking_delta / reasoning_content 仍由 provider
// 层丢弃，绝不能接到这里。

export const PUBLIC_THOUGHT_OPEN = '<public_thought>';
export const PUBLIC_THOUGHT_CLOSE = '</public_thought>';
export const PUBLIC_THOUGHT_MAX_CHARS = 600;

export type PublicThoughtStreamEvent =
  | { type: 'thought_delta'; text: string }
  | { type: 'delta'; text: string };

function cleanThought(value: string): string {
  return value
    .replaceAll(PUBLIC_THOUGHT_OPEN, '')
    .replaceAll(PUBLIC_THOUGHT_CLOSE, '')
    .trim()
    .slice(0, PUBLIC_THOUGHT_MAX_CHARS);
}

/** 从完整回复开头剥离公开摘要；不扫描正文中部，避免误伤用户讨论这些标签的普通内容。 */
export function extractPublicThought(text: string): { text: string; thoughtSummary?: string } {
  const source = String(text ?? '');
  const match = source.match(/^\s*<public_thought>\s*([\s\S]*?)\s*<\/public_thought>\s*/i);
  if (!match) return { text: source };
  const thoughtSummary = cleanThought(match[1]);
  const body = source.slice(match[0].length).trimStart();
  return thoughtSummary ? { text: body, thoughtSummary } : { text: body };
}

function partialSuffixLength(value: string, marker: string): number {
  const max = Math.min(value.length, marker.length - 1);
  for (let length = max; length > 0; length -= 1) {
    if (value.endsWith(marker.slice(0, length))) return length;
  }
  return 0;
}

/**
 * 增量拆分公开摘要与回答正文。标签可能被 provider 任意切块，因此检测态与关闭标签尾巴都要暂扣。
 * 未命中协议时原字不动地退回正文通道。
 */
export class PublicThoughtStreamParser {
  private state: 'detect' | 'thought' | 'answer' = 'detect';
  private buffer = '';
  private thoughtChars = 0;

  push(chunk: string): PublicThoughtStreamEvent[] {
    if (!chunk) return [];
    if (this.state === 'answer') return [{ type: 'delta', text: chunk }];
    this.buffer += chunk;
    if (this.state === 'detect') return this.detect();
    return this.drainThought();
  }

  finish(): PublicThoughtStreamEvent[] {
    if (!this.buffer) return [];
    const text = this.buffer;
    this.buffer = '';
    if (this.state === 'thought') return this.thoughtEvents(text);
    return [{ type: 'delta', text }];
  }

  private detect(): PublicThoughtStreamEvent[] {
    const whitespace = this.buffer.match(/^\s*/)?.[0].length ?? 0;
    const candidate = this.buffer.slice(whitespace);
    if (PUBLIC_THOUGHT_OPEN.startsWith(candidate)) return [];
    if (candidate.startsWith(PUBLIC_THOUGHT_OPEN)) {
      this.buffer = candidate.slice(PUBLIC_THOUGHT_OPEN.length);
      this.state = 'thought';
      return this.drainThought();
    }
    const text = this.buffer;
    this.buffer = '';
    this.state = 'answer';
    return text ? [{ type: 'delta', text }] : [];
  }

  private drainThought(): PublicThoughtStreamEvent[] {
    const closeAt = this.buffer.indexOf(PUBLIC_THOUGHT_CLOSE);
    if (closeAt >= 0) {
      const thought = this.buffer.slice(0, closeAt);
      const answer = this.buffer.slice(closeAt + PUBLIC_THOUGHT_CLOSE.length).replace(/^\s+/, '');
      this.buffer = '';
      this.state = 'answer';
      return [
        ...this.thoughtEvents(thought),
        ...(answer ? [{ type: 'delta' as const, text: answer }] : []),
      ];
    }
    const held = partialSuffixLength(this.buffer, PUBLIC_THOUGHT_CLOSE);
    const safeLength = this.buffer.length - held;
    if (safeLength <= 0) return [];
    const thought = this.buffer.slice(0, safeLength);
    this.buffer = this.buffer.slice(safeLength);
    return this.thoughtEvents(thought);
  }

  private thoughtEvents(text: string): PublicThoughtStreamEvent[] {
    const remaining = PUBLIC_THOUGHT_MAX_CHARS - this.thoughtChars;
    if (!text || remaining <= 0) return [];
    const visible = text.slice(0, remaining);
    this.thoughtChars += visible.length;
    return visible ? [{ type: 'thought_delta', text: visible }] : [];
  }
}
