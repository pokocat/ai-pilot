import Taro from '@tarojs/taro';
import { BASE_URL } from './config';
import { getToken } from './token';
import { parseSSE, decodeUtf8, sliceCompleteBlocks } from './sse';
import type { GenRequest, ChatReply } from '../../../shared/contracts';

export interface StreamHandlers {
  onSession?: (id: string) => void;
  onToken?: (text: string) => void;   // 增量 token（渐进渲染）
  onChat?: (reply: ChatReply) => void; // 完整回复兜底（含 points/acts）
  onDone?: (messageId?: string) => void;
  onError?: (message: string) => void;
}

function dispatch(events: { event: string; data: unknown }[], h: StreamHandlers): void {
  for (const e of events) {
    const d = e.data as { id?: string; text?: string; messageId?: string; message?: string } & ChatReply;
    if (e.event === 'session') h.onSession?.(d?.id ?? '');
    else if (e.event === 'token') h.onToken?.(d?.text ?? '');
    else if (e.event === 'chat') h.onChat?.(d);
    else if (e.event === 'done') h.onDone?.(d?.messageId);
    else if (e.event === 'error') h.onError?.(d?.message ?? '生成失败');
  }
}

/**
 * 流式生成（聊天）：消费 /generate SSE，逐 token 回调渐进渲染。
 * H5 走原生 fetch + ReadableStream（解析+传输均已在真实后端验证）；
 * weapp 走 Taro.request enableChunked + onChunkReceived（按微信文档实现，需真机 QA）。
 */
export async function generateStream(body: GenRequest, h: StreamHandlers): Promise<void> {
  const url = `${BASE_URL}/generate`;
  const header = { 'Content-Type': 'application/json', 'x-user-id': getToken() };

  if (process.env.TARO_ENV === 'h5' && typeof fetch === 'function') {
    let res: Response;
    try { res = await fetch(url, { method: 'POST', headers: header, body: JSON.stringify(body) }); }
    catch { h.onError?.('网络请求失败'); return; }
    if (!res.ok || !res.body) { h.onError?.(`HTTP ${res.status}`); return; }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const { events, rest } = parseSSE(buf); buf = rest;
      dispatch(events, h);
    }
    if (buf.trim()) dispatch(parseSSE(buf + '\n\n').events, h);
    return;
  }

  // weapp：分块接收（enableChunked / onChunkReceived 为微信扩展，Taro 类型未覆盖，故 as any）。
  // weapp 运行时无全局 TextDecoder → 按字节累积，切出完整 \n\n block 再 decodeUtf8（规避中文跨 chunk 截断）。
  await new Promise<void>((resolve) => {
    let bytes = new Uint8Array(0);
    const feed = (chunk: Uint8Array) => {
      const merged = new Uint8Array(bytes.length + chunk.length);
      merged.set(bytes); merged.set(chunk, bytes.length);
      const { complete, rest } = sliceCompleteBlocks(merged);
      bytes = new Uint8Array(rest); // 拷成 ArrayBuffer-backed，避免 TS 类型(ArrayBufferLike)不匹配
      if (complete.length) dispatch(parseSSE(decodeUtf8(complete)).events, h);
    };
    const task = Taro.request({
      url, method: 'POST', data: body, header,
      enableChunked: true,
      success: () => {
        // 流结束时冲刷残余字节（若最后一个 done 事件与上一块数据同包到达，可能未含 \n\n 边界）。
        if (bytes.length) dispatch(parseSSE(decodeUtf8(bytes) + '\n\n').events, h);
        resolve();
      },
      fail: () => { h.onError?.('网络请求失败'); resolve(); },
    } as unknown as Parameters<typeof Taro.request>[0]);
    const onChunk = (task as unknown as { onChunkReceived?: (cb: (r: { data: ArrayBuffer }) => void) => void }).onChunkReceived;
    onChunk?.call(task, (r: { data: ArrayBuffer }) => feed(new Uint8Array(r.data)));
  });
}
