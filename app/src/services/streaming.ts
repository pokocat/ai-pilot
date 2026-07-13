import { BASE_URL } from './config';
import { getToken } from './token';
import { parseSSE, decodeUtf8, sliceCompleteBlocks } from './sse';
import type { GenRequest, ChatReply, Deliverable, DeliverableSection } from '../../../shared/contracts';

export interface StreamHandlers {
  onSession?: (id: string) => void;
  onToken?: (text: string) => void;   // 增量 token（渐进渲染）
  onChat?: (reply: ChatReply) => void; // 完整回复兜底（含 points/acts）
  onReportStart?: () => void; // report meta 已到达：先渲染成果卡骨架，避免当前页长时间只有 thinking
  onReportBegin?: (data: Pick<Deliverable, 'title' | 'icon' | 'meta'>) => void;
  onReportSection?: (section: DeliverableSection & { index?: number }) => void;
  onReportFooter?: (data: Pick<Deliverable, 'trust' | 'actions'>) => void;
  onMemory?: (data: { learned?: boolean; agentName?: string }) => void;
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

function dispatch(events: { event: string; data: unknown }[], h: StreamHandlers, state: { rendered: boolean; terminal: boolean }): boolean {
  let ok = true;
  for (const e of events) {
    const d = e.data as {
      id?: string; text?: string; messageId?: string; message?: string; kind?: string;
      title?: string; icon?: string; meta?: string; index?: number; h?: string; b?: string; list?: string[];
      trust?: string; actions?: string[]; learned?: boolean; agentName?: string;
    } & ChatReply;
    if (e.event === 'session') h.onSession?.(d?.id ?? '');
    else if (e.event === 'token') { state.rendered = true; h.onToken?.(d?.text ?? ''); }
    else if (e.event === 'chat') { state.rendered = true; h.onChat?.(d); }
    else if (e.event === 'meta' && d?.kind === 'report' && h.onReportStart) { state.rendered = true; h.onReportStart(); }
    else if (e.event === 'begin' && h.onReportBegin) {
      state.rendered = true;
      h.onReportBegin({ title: d?.title ?? '', icon: d?.icon ?? 'doc', meta: d?.meta ?? '' });
    }
    else if (e.event === 'section' && h.onReportSection) {
      state.rendered = true;
      h.onReportSection({
        index: typeof d?.index === 'number' ? d.index : undefined,
        h: d?.h || '未命名段落',
        b: d?.b,
        list: Array.isArray(d?.list) ? d.list : undefined,
      });
    }
    else if (e.event === 'footer' && h.onReportFooter) {
      h.onReportFooter({
        trust: d?.trust ?? '',
        actions: Array.isArray(d?.actions) ? d.actions : [],
      });
    }
    else if (e.event === 'memory') h.onMemory?.({ learned: d?.learned, agentName: d?.agentName });
    else if (e.event === 'done') { state.terminal = true; if (state.rendered) h.onDone?.(d?.messageId); }
    else if (e.event === 'error') { ok = false; state.terminal = true; h.onError?.(d?.message ?? '生成失败'); }
  }
  return ok;
}

/**
 * 连接被截断（网络断线/代理超时/后端提前关闭）时，流可能已产出内容却始终没等到显式
 * done/error 终态事件——不补发会让报告卡/气泡的 streaming 标记永久为 true，UI 卡在「产出中」。
 * 这里在读流结束后兜底合成一次 onDone，只在「确有产出但从未见过终态事件」时触发一次。
 */
function finalizeIfUnterminated(h: StreamHandlers, state: { rendered: boolean; terminal: boolean }): void {
  if (state.rendered && !state.terminal) {
    state.terminal = true;
    h.onDone?.();
  }
}

/**
 * 流式生成（聊天）：消费 /generate SSE，逐 token 回调渐进渲染。
 * H5 走原生 fetch + ReadableStream（解析+传输均已在真实后端验证）。
 * weapp 走 wx.request enableChunked + onChunkReceived；失败返回 false，由聊天页回退 /generate-sync。
 */
export async function generateStream(body: GenRequest, h: StreamHandlers): Promise<boolean> {
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
    const state = { rendered: false, terminal: false };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const { events, rest } = parseSSE(buf); buf = rest;
      if (events.length) sawEvent = true;
      ok = dispatch(events, h, state) && ok;
    }
    if (buf.trim()) {
      const events = parseSSE(buf + '\n\n').events;
      if (events.length) sawEvent = true;
      ok = dispatch(events, h, state) && ok;
    }
    if (!sawEvent) h.onError?.('网络请求失败');
    finalizeIfUnterminated(h, state);
    return ok && state.rendered;
  }

  if (process.env.TARO_ENV === 'weapp') {
    return await new Promise<boolean>((resolve) => {
      let bytes = new Uint8Array(0);
      let ok = true;
      let sawEvent = false;
      const state = { rendered: false, terminal: false };

      const consumeText = (text: string) => {
        const { events, rest } = parseSSE(text);
        if (events.length) sawEvent = true;
        ok = dispatch(events, h, state) && ok;
        return rest;
      };

      const feed = (chunk: Uint8Array) => {
        const merged = new Uint8Array(bytes.length + chunk.length);
        merged.set(bytes);
        merged.set(chunk, bytes.length);
        const { complete, rest } = sliceCompleteBlocks(merged);
        bytes = new Uint8Array(rest);
        if (complete.length) consumeText(decodeUtf8(complete));
      };

      const finish = (data?: unknown) => {
        if (bytes.length) {
          consumeText(decodeUtf8(bytes) + '\n\n');
          bytes = new Uint8Array(0);
        }
        if (!sawEvent && typeof data === 'string' && data.trim()) {
          consumeText(data.endsWith('\n\n') ? data : `${data}\n\n`);
        }
        finalizeIfUnterminated(h, state);
        resolve(ok && state.rendered);
      };

      const wxApi = (globalThis as unknown as {
        wx?: {
          request: (opts: Record<string, unknown>) => { onChunkReceived?: (cb: (r: { data: ArrayBuffer }) => void) => void; abort?: () => void };
        };
      }).wx;
      if (!wxApi?.request) {
        resolve(false);
        return;
      }

      const task = wxApi.request({
        url,
        method: 'POST',
        data: body,
        header,
        enableChunked: true,
        success: (res: { data?: unknown }) => finish(res.data),
        fail: () => {
          // 已有产出但请求收尾失败（连接中断）：合成一次终态，避免报告卡/气泡永久卡在「产出中」。
          if (state.rendered && !state.terminal) { state.terminal = true; h.onError?.('网络连接中断'); }
          resolve(false);
        },
      });

      const onChunk = task.onChunkReceived;
      if (typeof onChunk !== 'function') {
        task.abort?.();
        resolve(false);
        return;
      }
      onChunk.call(task, (r: { data: ArrayBuffer }) => feed(new Uint8Array(r.data)));
    });
  }

  return false;
}
