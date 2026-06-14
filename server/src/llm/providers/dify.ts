// Dify 应用提供方（per-agent 接入：providerMode=dify 时启用）。
// 走 Dify 官方 chat-messages 接口（streaming 模式：Agent 应用只支持 streaming，Chatbot/Chatflow 也兼容）：
//   POST {difyBaseUrl}/chat-messages   Authorization: Bearer {该应用专属 api_key}
// Dify 应用内部已编排好提示词/工具/知识库；本地只把「用户问题」作为 query 传入，
// 并把每个用户不同的上下文（企业档案/长期记忆/引用资料…）按占位符映射成 Dify 的 inputs 变量
// （需在 Dify 应用里声明同名输入变量）。多轮用 conversation_id 维持，由 Dify 返回后回写 Session。
// 计费：从 streaming 末尾 message_end.metadata.usage 取真实 token，纳入月度额度扣减。

import { ZERO_USAGE, fillPlaceholders, type ChatReply, type Deliverable, type GenContext, type Usage } from '../schema.js';
import { DELIVERABLES, TRUST_NOTE } from '../../data/deliverables.js';

const DIFY_TIMEOUT = 60_000;

// Dify SSE 事件。Agent 应用走 agent_message（含 agent_thought）；Chatbot 走 message；末尾 message_end 带 usage。
interface DifyStreamEvent {
  event?: string;
  answer?: string;
  conversation_id?: string;
  message_id?: string;
  code?: string;
  message?: string;
  metadata?: { usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } };
}

// difyInputs：{ Dify输入变量名: "{企业档案}" } —— 值里的占位符用本轮真实上下文填充。
function buildInputs(ctx: GenContext): Record<string, string> {
  const map = ctx.runtime?.difyInputs ?? {};
  const inputs: Record<string, string> = {};
  for (const [k, tpl] of Object.entries(map)) {
    if (!k) continue;
    inputs[k] = fillPlaceholders(String(tpl ?? ''), ctx);
  }
  return inputs;
}

// 读完 Dify streaming SSE：累积 answer（message / agent_message），从 message_end 取 conversation_id + usage。
async function readDifyStream(res: Response): Promise<{ answer: string; conversationId: string | null; usage: Usage }> {
  let answer = '';
  let conversationId: string | null = null;
  let usage: Usage = ZERO_USAGE;
  const body = res.body;
  if (!body) return { answer, conversationId, usage };
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // SSE 事件以空行分隔；每个事件内取 data: 行。
    let sep: number;
    while ((sep = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      for (const line of block.split('\n')) {
        const s = line.trim();
        if (!s.startsWith('data:')) continue;
        const payload = s.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let ev: DifyStreamEvent;
        try { ev = JSON.parse(payload); } catch { continue; }
        if (ev.event === 'message' || ev.event === 'agent_message') {
          answer += ev.answer ?? '';
        } else if (ev.event === 'message_end') {
          conversationId = ev.conversation_id ?? conversationId;
          const u = ev.metadata?.usage;
          if (u) usage = { inputTokens: u.prompt_tokens ?? 0, outputTokens: u.completion_tokens ?? 0, cachedInput: 0 };
        } else if (ev.event === 'error') {
          throw new Error(`Dify 流式错误：${ev.message ?? ev.code ?? '未知'}`);
        }
        if (ev.conversation_id && !conversationId) conversationId = ev.conversation_id;
      }
    }
  }
  return { answer: answer.trim(), conversationId, usage };
}

async function callDify(ctx: GenContext, query: string): Promise<{ answer: string; conversationId: string | null; usage: Usage }> {
  const rt = ctx.runtime;
  const base = (rt?.difyBaseUrl ?? '').replace(/\/+$/, '');
  if (!base) throw new Error('Dify baseUrl 未配置');
  if (!rt?.difyApiKey) throw new Error('Dify api_key 未配置');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DIFY_TIMEOUT);
  try {
    const res = await fetch(`${base}/chat-messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${rt.difyApiKey}` },
      body: JSON.stringify({
        inputs: buildInputs(ctx),
        query,
        response_mode: 'streaming',
        conversation_id: rt.conversationId ?? '',
        user: rt.user || rt.sessionId || ctx.agentKey,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as DifyStreamEvent;
      throw new Error(`Dify ${res.status}: ${data.message ?? data.code ?? '请求失败'}`);
    }
    return await readDifyStream(res);
  } finally {
    clearTimeout(timer);
  }
}

export async function difyChat(ctx: GenContext): Promise<{ reply: ChatReply; conversationId: string | null; usage: Usage }> {
  const { answer, conversationId, usage } = await callDify(ctx, ctx.userMessage);
  return {
    reply: { text: answer || '（Dify 应用未返回内容，请检查应用编排与输入变量配置）' },
    conversationId,
    usage,
  };
}

export async function difyDeliverable(ctx: GenContext): Promise<{ deliverable: Deliverable; conversationId: string | null; usage: Usage }> {
  const tpl = ctx.deliverableKey ? DELIVERABLES[ctx.deliverableKey] : undefined;
  const query = ctx.userMessage || `请为我产出一份${tpl?.title ?? '咨询成果'}。`;
  const { answer, conversationId, usage } = await callDify(ctx, query);
  const meta = [ctx.companyName, ctx.profile?.industry, ctx.profile?.stage].filter(Boolean).join(' · ') || '经营快照';
  // Dify 聊天应用返回 markdown 文本，整段落入单一 section（前端按 markdown 渲染）。
  return {
    deliverable: {
      title: tpl?.title || ctx.agentName || '咨询成果',
      icon: tpl?.icon ?? 'spark',
      meta,
      sections: [{ h: tpl?.title || '产出', b: answer || '（Dify 应用未返回内容）' }],
      trust: TRUST_NOTE,
      actions: ['save_to_library', 'export_pdf'],
    },
    conversationId,
    usage,
  };
}

/** 连通性测试（后台「测试连接」用）：streaming 发一次最小 query，返回耗时与样例。
 *  注：若 Dify 应用声明了必填 inputs（如 customer_context），inputs:{} 会返回 400，提示运营去配 difyInputs。 */
export async function difyPing(opts: { difyBaseUrl?: string; difyApiKey?: string }): Promise<{ ok: boolean; latencyMs?: number; sample?: string; error?: string }> {
  const base = (opts.difyBaseUrl ?? '').replace(/\/+$/, '');
  if (!base) return { ok: false, error: '未配置 Dify baseUrl' };
  if (!opts.difyApiKey) return { ok: false, error: '未配置 Dify api_key' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DIFY_TIMEOUT);
  const t0 = Date.now();
  try {
    const res = await fetch(`${base}/chat-messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.difyApiKey}` },
      body: JSON.stringify({ inputs: {}, query: 'ping', response_mode: 'streaming', conversation_id: '', user: 'admin-test' }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as DifyStreamEvent;
      return { ok: false, latencyMs: Date.now() - t0, error: `Dify ${res.status}: ${data.message ?? data.code ?? '请求失败'}` };
    }
    const { answer } = await readDifyStream(res);
    return { ok: true, latencyMs: Date.now() - t0, sample: answer.slice(0, 40) };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - t0, error: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}
