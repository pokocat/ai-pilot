import { BASE_URL } from './config';
import { getToken } from './token';
import { parseSSE } from './sse';
import type { GenRequest, ChatReply } from '../../../shared/contracts';

export interface StreamHandlers {
  onSession?: (id: string) => void;
  onToken?: (text: string) => void;   // 增量 token（渐进渲染）
  onChat?: (reply: ChatReply) => void; // 完整回复兜底（含 points/acts）
  onDone?: (messageId?: string) => void;
  onError?: (message: string) => void;
}

function messageFromData(data: unknown, status: number): string {
  if (data && typeof data === 'object') {
    const d = data as { error?: string; message?: string };
    return d.error || d.message || `HTTP ${status}`;
  }
  const s = String(data || '').trim();
  if (s) {
    try { return messageFromData(JSON.parse(s), status); }
    catch { return s.slice(0, 80); }
  }
  return `HTTP ${status}`;
}

async function responseErrorMessage(res: Response): Promise<string> {
  try { return messageFromData(await res.clone().json(), res.status); }
  catch {
    try { return messageFromData(await res.text(), res.status); }
    catch { return `HTTP ${res.status}`; }
  }
}

function dispatch(events: { event: string; data: unknown }[], h: StreamHandlers): boolean {
  let ok = true;
  for (const e of events) {
    const d = e.data as { id?: string; text?: string; messageId?: string; message?: string } & ChatReply;
    if (e.event === 'session') h.onSession?.(d?.id ?? '');
    else if (e.event === 'token') h.onToken?.(d?.text ?? '');
    else if (e.event === 'chat') h.onChat?.(d);
    else if (e.event === 'done') h.onDone?.(d?.messageId);
    else if (e.event === 'error') { ok = false; h.onError?.(d?.message ?? '生成失败'); }
  }
  return ok;
}

/**
 * 流式生成（聊天）：消费 /generate SSE，逐 token 回调渐进渲染。
 * H5 走原生 fetch + ReadableStream（解析+传输均已在真实后端验证）。
 * weapp 固定不用此函数，见 STREAM_CHAT；保留平台守卫避免误触发 /generate。
 */
export async function generateStream(body: GenRequest, h: StreamHandlers): Promise<boolean> {
  if (process.env.TARO_ENV !== 'h5') return false;

  const url = `${BASE_URL}/generate`;
  const header = { 'Content-Type': 'application/json', 'x-user-id': getToken() };

  if (process.env.TARO_ENV === 'h5' && typeof fetch === 'function') {
    let res: Response;
    try { res = await fetch(url, { method: 'POST', headers: header, body: JSON.stringify(body) }); }
    catch { h.onError?.('网络请求失败'); return false; }
    if (!res.ok || !res.body) { h.onError?.(await responseErrorMessage(res)); return false; }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let ok = true;
    let sawEvent = false;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const { events, rest } = parseSSE(buf); buf = rest;
      if (events.length) sawEvent = true;
      ok = dispatch(events, h) && ok;
    }
    if (buf.trim()) {
      const events = parseSSE(buf + '\n\n').events;
      if (events.length) sawEvent = true;
      ok = dispatch(events, h) && ok;
    }
    if (!sawEvent) h.onError?.('网络请求失败');
    return ok && sawEvent;
  }

  return false;
}
