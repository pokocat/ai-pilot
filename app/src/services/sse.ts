// 纯 SSE 解析（无平台依赖，便于单测）。增量喂入文本缓冲，吐出已完整的事件 + 剩余未完成 buffer。
export interface SSEEvent { event: string; data: unknown }

// UTF-8 字节→字符串（weapp 无全局 TextDecoder）。须对「完整字节段」解码（不可在多字节中途切断），
// 调用方按 \n\n（ASCII 边界）切出完整 SSE block 后再解码，规避中文跨 chunk 截断。
export function decodeUtf8(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i++];
    if (b < 0x80) out += String.fromCharCode(b);
    else if (b < 0xe0) out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i++] & 0x3f));
    else if (b < 0xf0) out += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f));
    else {
      const cp = ((b & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
      const c = cp - 0x10000;
      out += String.fromCharCode(0xd800 + (c >> 10), 0xdc00 + (c & 0x3ff));
    }
  }
  return out;
}

// 从字节缓冲切出「到最后一个 \n\n 为止」的完整部分（返回 [完整段, 剩余]）。
export function sliceCompleteBlocks(bytes: Uint8Array): { complete: Uint8Array; rest: Uint8Array } {
  for (let i = bytes.length - 2; i >= 0; i--) {
    if (bytes[i] === 0x0a && bytes[i + 1] === 0x0a) {
      return { complete: bytes.subarray(0, i + 2), rest: bytes.slice(i + 2) };
    }
  }
  return { complete: new Uint8Array(0), rest: bytes };
}

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
