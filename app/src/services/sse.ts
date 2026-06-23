// 纯 SSE 解析（无平台依赖，便于单测）。增量喂入文本缓冲，吐出已完整的事件 + 剩余未完成 buffer。
export interface SSEEvent { event: string; data: unknown }

export function parseSSE(buffer: string): { events: SSEEvent[]; rest: string } {
  const events: SSEEvent[] = [];
  const blocks = buffer.split('\n\n');
  const rest = blocks.pop() ?? ''; // 最后一段可能不完整，留到下次
  for (const block of blocks) {
    if (!block.trim()) continue;
    let event = 'message';
    let dataStr = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
    }
    if (!dataStr) continue;
    let data: unknown = dataStr;
    try { data = JSON.parse(dataStr); } catch { /* 非 JSON 原样保留 */ }
    events.push({ event, data });
  }
  return { events, rest };
}
