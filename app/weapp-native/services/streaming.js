const env = require('../config/env');
const { getToken } = require('./token');
const { getApiBaseUrl, useMockApi } = require('./runtime-mode');
const { networkErrorInfo, unauthorized, parseBody } = require('./request');
const { apiErrorPresentation, httpErrorInfo } = require('./api-error');

function decodeUtf8(bytes) {
  let out = ''; let i = 0;
  while (i < bytes.length) {
    const b = bytes[i++];
    if (b < 0x80) out += String.fromCharCode(b);
    else if (b < 0xe0) out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i++] & 0x3f));
    else if (b < 0xf0) out += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f));
    else { const cp = ((b & 7) << 18) | ((bytes[i++] & 63) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63); const c = cp - 0x10000; out += String.fromCharCode(0xd800 + (c >> 10), 0xdc00 + (c & 1023)); }
  }
  return out;
}

function splitBlocks(bytes) {
  for (let i = bytes.length - 2; i >= 0; i -= 1) if (bytes[i] === 10 && bytes[i + 1] === 10) return { complete: bytes.subarray(0, i + 2), rest: bytes.slice(i + 2) };
  return { complete: new Uint8Array(0), rest: bytes };
}

function parseSSE(text) {
  const blocks = text.split('\n\n'); const rest = blocks.pop() || ''; const events = [];
  for (const block of blocks) {
    let event = 'message'; let dataText = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataText += line.slice(5).trim();
    }
    if (!dataText) continue;
    let data = dataText; try { data = JSON.parse(dataText); } catch (_) { /* text event */ }
    events.push({ event, data });
  }
  return { events, rest };
}

function generateStream(body, handlers) {
  if (useMockApi() || env.STREAM_CHAT === false) return Promise.resolve({ available: false });
  return new Promise((resolve) => {
    const tokenAtRequest = getToken();
    const origin = getApiBaseUrl();
    let pending = new Uint8Array(0); let textBuffer = ''; let rendered = false; let finished = false; let settled = false;
    const state = { available: true, generationId: '', sessionId: '', messageId: '', kind: '', reply: null, deliverable: null };
    const done = (extra) => { if (settled) return; settled = true; resolve(Object.assign(state, { rendered, finished }, extra || {})); };
    const dispatch = (events) => {
      for (const entry of events) {
        const data = entry.data && typeof entry.data === 'object' ? entry.data : {};
        if (entry.event === 'generation' || entry.event === 'snapshot') { state.generationId = data.generationId || data.id || state.generationId; state.sessionId = data.sessionId || state.sessionId; handlers.onGeneration && handlers.onGeneration(data); }
        else if (entry.event === 'session') { state.sessionId = data.id || state.sessionId; handlers.onSession && handlers.onSession(state.sessionId); }
        else if (entry.event === 'meta') { state.kind = data.kind || state.kind; handlers.onMeta && handlers.onMeta(data); }
        else if (entry.event === 'thought') { rendered = true; handlers.onThought && handlers.onThought(String(data.text || '')); }
        else if (entry.event === 'token') { rendered = true; handlers.onToken && handlers.onToken(String(data.text || ''), data.replace === true); }
        else if (entry.event === 'chat') { rendered = true; state.reply = data; handlers.onChat && handlers.onChat(data); }
        else if (entry.event === 'begin') { rendered = true; state.kind = 'report'; state.deliverable = { title: data.title || '', icon: data.icon || 'doc', meta: data.meta || '', sections: [], trust: '', actions: [] }; handlers.onReport && handlers.onReport(state.deliverable); }
        else if (entry.event === 'section') { rendered = true; if (!state.deliverable) state.deliverable = { title: '', sections: [], trust: '', actions: [] }; state.deliverable.sections.push(data); handlers.onReport && handlers.onReport(state.deliverable); }
        else if (entry.event === 'footer') { if (!state.deliverable) state.deliverable = { title: '', sections: [], trust: '', actions: [] }; state.deliverable.trust = data.trust || ''; state.deliverable.actions = data.actions || []; handlers.onReport && handlers.onReport(state.deliverable); }
        else if (entry.event === 'done') { state.messageId = data.messageId || ''; finished = true; handlers.onDone && handlers.onDone(data); }
        else if (entry.event === 'error') {
          finished = true;
          const source = Object.assign(new Error(data.message || ''), { code: data.code || 'GENERATION_FAILED' });
          const view = apiErrorPresentation(source, '军师暂时没能完成这次回答，请稍后重试。');
          state.error = Object.assign(new Error(view.message), { code: source.code, technicalMessage: data.message || undefined });
          handlers.onError && handlers.onError(state.error);
        }
      }
    };
    const consume = (text) => { const parsed = parseSSE(text); dispatch(parsed.events); return parsed.rest; };
    const feed = (arrayBuffer) => {
      const chunk = new Uint8Array(arrayBuffer); const merged = new Uint8Array(pending.length + chunk.length); merged.set(pending); merged.set(chunk, pending.length);
      const sliced = splitBlocks(merged); pending = new Uint8Array(sliced.rest); if (sliced.complete.length) textBuffer = consume(textBuffer + decodeUtf8(sliced.complete));
    };
    const finish = (data) => {
      if (pending.length) { textBuffer += decodeUtf8(pending); pending = new Uint8Array(0); }
      if (typeof data === 'string' && data.trim() && !textBuffer.trim()) textBuffer = data;
      if (textBuffer.trim()) consume(`${textBuffer}\n\n`);
      done();
    };
    const task = wx.request({
      url: `${origin}/generate`, method: 'POST', data: body, enableChunked: true, timeout: 180000,
      header: Object.assign({ 'content-type': 'application/json' }, tokenAtRequest ? { 'x-user-id': tokenAtRequest } : {}),
      success: (res) => {
        const data = parseBody(res.data);
        if (res.statusCode === 401) state.error = unauthorized(tokenAtRequest, data);
        else if (res.statusCode < 200 || res.statusCode >= 300) {
          const info = httpErrorInfo(res.statusCode, data, '请求');
          state.error = Object.assign(new Error(info.message), {
            code: info.code || `HTTP_${res.statusCode}`,
            statusCode: res.statusCode,
            data,
            technicalMessage: info.technicalMessage,
          });
        }
        finish(data);
      },
      fail: (error) => {
        if (/abort/i.test(String(error.errMsg || ''))) done({ error: Object.assign(new Error('本次回复已停止'), { code: 'CANCELLED' }) });
        else done({ error: networkErrorInfo(error && error.errMsg, origin) });
      },
    });
    if (!task || typeof task.onChunkReceived !== 'function') { if (task && task.abort) task.abort(); done({ available: false }); return; }
    task.onChunkReceived((event) => feed(event.data));
    state.abort = () => task.abort && task.abort();
    handlers.onControl && handlers.onControl(state);
  });
}

module.exports = { generateStream, parseSSE, decodeUtf8, splitBlocks };
