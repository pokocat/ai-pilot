import { BASE_URL } from './config';
import { getToken } from './token';
import { parseSSE, decodeUtf8, sliceCompleteBlocks } from './sse';
import type { GenRequest, ChatReply, Deliverable, DeliverableSection } from '../../../shared/contracts';

export interface StreamHandlers {
  onSession?: (id: string) => void;
  onToken?: (text: string) => void;   // 增量 token（渐进渲染）
  onChat?: (reply: ChatReply) => void; // 完整回复兜底（含 points/acts）
  onReportStart?: () => void; // report meta 已到达：先渲染成果卡骨架，避免当前页长时间只有 thinking
  onChatStart?: () => void; // chat meta 已到达：先建聊天气泡（think-dots），避免 LLM 首字延迟期无反馈
  // 引用未尽之处（超 9 份被丢下 / 仍在拆读 / 读不出）：随 meta 先到，气泡下明说，不静默丢弃。
  onRefNotices?: (notices: string[]) => void;
  onReportBegin?: (data: Pick<Deliverable, 'title' | 'icon' | 'meta'>) => void;
  onReportSection?: (section: DeliverableSection & { index?: number }) => void;
  onReportFooter?: (data: Pick<Deliverable, 'trust' | 'actions'>) => void;
  onMemory?: (data: { learned?: boolean; agentName?: string }) => void;
  onDone?: (messageId?: string) => void;
  onError?: (message: string) => void;
}

// B2 停止生成：调用方传入一个 control 对象，generateStream 在启动时把 abort 句柄挂上去；
// 点「停止」时调用 control.abort() 即可中断底层请求（h5 走 AbortController，weapp 走 RequestTask.abort）。
export interface StreamControl {
  abort: () => void;
}

// B5 网络异常友好话术：SSE / HTTP 兜底不再把「HTTP 500」直接灌进气泡，按状态段映射中文，raw 只进日志。
function friendlyStatus(status: number): string {
  if (status === 429) return '军师有点忙，请过一会儿再试。';
  if (status === 401 || status === 403) return '登录态好像失效了，请重新登录后再试。';
  if (status === 408 || status === 504) return '网络有点慢，请再试一次。';
  if (status >= 500) return '军师暂时联系不上，请稍后再试。';
  return '军师暂时没能回应，请稍后再试。';
}

const NETWORK_HINT = '网络不太稳，请再试一次。';
// wx.request 默认总超时约 60 秒；真实模型的长回复即使持续下发 token，也会被客户端先断开。
// 服务端流式已按上游空闲时间续期，这里给同一轮用户请求留出足够的总预算。
const WEAPP_STREAM_TIMEOUT_MS = 180_000;

function messageFromData(data: unknown, status: number): string {
  if (data && typeof data === 'object') {
    const d = data as { error?: string; message?: string };
    // 后端下发的 error/message 已是中文可读话术，优先透传；否则按状态段兜底为友好话术。
    if (d.error || d.message) return (d.error || d.message)!;
    console.warn('[stream] http error', status, data);
    return friendlyStatus(status);
  }
  const s = String(data || '').trim();
  if (s) {
    try { return messageFromData(JSON.parse(s), status); }
    catch { console.warn('[stream] http error raw', status, s.slice(0, 200)); return friendlyStatus(status); }
  }
  return friendlyStatus(status);
}

async function responseErrorMessage(res: Response): Promise<string> {
  try { return messageFromData(await res.clone().json(), res.status); }
  catch {
    try { return messageFromData(await res.text(), res.status); }
    catch { return `HTTP ${res.status}`; }
  }
}

function dispatch(events: { event: string; data: unknown }[], h: StreamHandlers, state: { rendered: boolean; finished: boolean }): boolean {
  let ok = true;
  for (const e of events) {
    const d = e.data as {
      id?: string; text?: string; messageId?: string; message?: string; kind?: string;
      title?: string; icon?: string; meta?: string; index?: number; h?: string; b?: string; list?: string[];
      trust?: string; actions?: string[]; learned?: boolean; agentName?: string; refNotices?: string[];
    } & ChatReply;
    if (e.event === 'meta' && Array.isArray(d?.refNotices) && d.refNotices.length) h.onRefNotices?.(d.refNotices);
    if (e.event === 'session') h.onSession?.(d?.id ?? '');
    else if (e.event === 'token') { state.rendered = true; h.onToken?.(d?.text ?? ''); }
    else if (e.event === 'chat') { state.rendered = true; h.onChat?.(d); }
    else if (e.event === 'meta' && d?.kind === 'report' && h.onReportStart) { state.rendered = true; h.onReportStart(); }
    // meta kind=chat：仅建气泡占位，不置 state.rendered——占位≠已产出内容。若随后静默失败（无 token/chat），
    // rendered 保持 false，调用方据此走「同步补发替换空占位」兜底；report 骨架则相反（rendered=true，由 P0-5/finally 收尾）。
    else if (e.event === 'meta' && d?.kind === 'chat' && h.onChatStart) { h.onChatStart(); }
    else if (e.event === 'begin' && h.onReportBegin) {
      state.rendered = true;
      h.onReportBegin({ title: d?.title ?? '', icon: d?.icon ?? 'doc', meta: d?.meta ?? '' });
    }
    else if (e.event === 'section' && h.onReportSection) {
      state.rendered = true;
      // 报告 V2：原样透传完整 typed section（含 paras/items/people/rows/text/salute… 及 type 判别字段），
      // 不再只抽 {h,b,list} 子集——否则 9 种类型 section 在流式期间正文被剥空、只剩标题。
      // 向后兼容：旧后端只发 {h,b,list} 时，此处照样整体透传，无多余字段也无害。
      const raw = (e.data && typeof e.data === 'object' ? e.data : {}) as DeliverableSection & { index?: number; h?: string };
      h.onReportSection({ ...raw, h: raw.h || '未命名段落' } as DeliverableSection & { index?: number });
    }
    else if (e.event === 'footer' && h.onReportFooter) {
      h.onReportFooter({
        trust: d?.trust ?? '',
        actions: Array.isArray(d?.actions) ? d.actions : [],
      });
    }
    else if (e.event === 'memory') h.onMemory?.({ learned: d?.learned, agentName: d?.agentName });
    else if (e.event === 'done') { if (state.rendered) { h.onDone?.(d?.messageId); state.finished = true; } }
    else if (e.event === 'error') { ok = false; state.finished = true; h.onError?.(d?.message ?? '生成失败'); }
  }
  return ok;
}

/**
 * 流式生成（聊天）：消费 /generate SSE，逐 token 回调渐进渲染。
 * H5 走原生 fetch + ReadableStream（解析+传输均已在真实后端验证）。
 * weapp 走 wx.request enableChunked + onChunkReceived；失败返回 false，由聊天页回退 /generate-sync。
 */
export async function generateStream(body: GenRequest, h: StreamHandlers, control?: StreamControl): Promise<boolean> {
  const url = `${BASE_URL}/generate`;
  const header = { 'Content-Type': 'application/json', 'x-user-id': getToken() };
  // B2：aborted 标记贯穿两端；被主动中断时静默收尾，不走 onError（避免留下「网络失败」气泡）。
  let aborted = false;

  if (process.env.TARO_ENV === 'h5' && typeof fetch === 'function') {
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
    if (control) control.abort = () => { aborted = true; ac?.abort(); };
    let res: Response;
    try { res = await fetch(url, { method: 'POST', headers: header, body: JSON.stringify(body), signal: ac?.signal }); }
    catch { if (aborted) return false; h.onError?.(NETWORK_HINT); return false; }
    if (!res.ok || !res.body) { h.onError?.(await responseErrorMessage(res)); return false; }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let ok = true;
    let sawEvent = false;
    const state = { rendered: false, finished: false };
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try { chunk = await reader.read(); }
      catch { break; } // 中断或链路断开：跳出循环，下面按 aborted / 已渲染分别收尾
      if (chunk.done) break;
      buf += dec.decode(chunk.value, { stream: true });
      const { events, rest } = parseSSE(buf); buf = rest;
      if (events.length) sawEvent = true;
      ok = dispatch(events, h, state) && ok;
    }
    if (aborted) return false; // 主动停止：静默，保留已渲染的部分内容
    if (buf.trim()) {
      const events = parseSSE(buf + '\n\n').events;
      if (events.length) sawEvent = true;
      ok = dispatch(events, h, state) && ok;
    }
    if (!sawEvent) h.onError?.(NETWORK_HINT);
    // P0-5：流正常收尾但未收到 done/error 事件时补发一次 onDone，避免报告卡永久停在「产出中」。
    // finished 幂等保护：已由 done/error 收尾的流不再补发。
    if (state.rendered && !state.finished) { state.finished = true; h.onDone?.(); }
    return ok && state.rendered;
  }

  if (process.env.TARO_ENV === 'weapp') {
    return await new Promise<boolean>((resolve) => {
      let bytes = new Uint8Array(0);
      let ok = true;
      let sawEvent = false;
      const state = { rendered: false, finished: false };

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
        // P0-5：流正常收尾但未收到 done/error 事件时补发一次 onDone，避免报告卡永久停在「产出中」。
        // finished 幂等保护：已由 done/error 收尾的流不再补发。
        if (state.rendered && !state.finished) { state.finished = true; h.onDone?.(); }
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
        timeout: WEAPP_STREAM_TIMEOUT_MS,
        success: (res: { data?: unknown }) => finish(res.data),
        // B2：主动中断时 fail 也会触发，此时静默 resolve(false)（aborted 标记让调用方跳过兜底重发）。
        // 非主动中断（真实网络失败）且已有产出但从未收到终态事件时，补发一次 onError，
        // 否则聊天气泡的 streaming 标记会永久为 true，卡在「产出中」（report 卡由 chat/index.tsx
        // 的 finally 兜底了，普通聊天气泡没有等价兜底，只能从这里堵住）。
        fail: () => {
          if (!aborted && state.rendered && !state.finished) { state.finished = true; h.onError?.('网络连接中断'); }
          resolve(false);
        },
      });
      // B2：挂上停止句柄。weapp 无 AbortController，直接调用 RequestTask.abort()。
      if (control) control.abort = () => { aborted = true; task.abort?.(); };

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
