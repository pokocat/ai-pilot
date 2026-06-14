// Dify 应用提供方（per-agent 接入：providerMode=dify 时启用）。
// 走 Dify 官方 chat-messages 接口（blocking 模式，贴合 /generate-sync 同步流）：
//   POST {difyBaseUrl}/chat-messages   Authorization: Bearer {该应用专属 api_key}
// Dify 应用内部已编排好提示词/工具/知识库；本地只把「用户问题」作为 query 传入，
// 并把每个用户不同的上下文（企业档案/长期记忆/引用资料…）按占位符映射成 Dify 的 inputs 变量
// （需在 Dify 应用里声明同名输入变量）。多轮用 conversation_id 维持，由 Dify 返回后回写 Session。

import { fillPlaceholders, type ChatReply, type Deliverable, type GenContext } from '../schema.js';
import { DELIVERABLES, TRUST_NOTE } from '../../data/deliverables.js';

const DIFY_TIMEOUT = 60_000;

interface DifyChatResponse {
  answer?: string;
  conversation_id?: string;
  message_id?: string;
  code?: string;
  message?: string;
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

async function callDify(ctx: GenContext, query: string): Promise<{ answer: string; conversationId: string | null }> {
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
        response_mode: 'blocking',
        conversation_id: rt.conversationId ?? '',
        user: rt.user || rt.sessionId || ctx.agentKey,
      }),
      signal: ctrl.signal,
    });
    const data = (await res.json().catch(() => ({}))) as DifyChatResponse;
    if (!res.ok) throw new Error(`Dify ${res.status}: ${data.message ?? data.code ?? '请求失败'}`);
    return { answer: (data.answer ?? '').trim(), conversationId: data.conversation_id || null };
  } finally {
    clearTimeout(timer);
  }
}

export async function difyChat(ctx: GenContext): Promise<{ reply: ChatReply; conversationId: string | null }> {
  const { answer, conversationId } = await callDify(ctx, ctx.userMessage);
  return {
    reply: { text: answer || '（Dify 应用未返回内容，请检查应用编排与输入变量配置）' },
    conversationId,
  };
}

export async function difyDeliverable(ctx: GenContext): Promise<{ deliverable: Deliverable; conversationId: string | null }> {
  const tpl = ctx.deliverableKey ? DELIVERABLES[ctx.deliverableKey] : undefined;
  const query = ctx.userMessage || `请为我产出一份${tpl?.title ?? '咨询成果'}。`;
  const { answer, conversationId } = await callDify(ctx, query);
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
  };
}

/** 连通性测试（后台「测试连接」用）：发一次最小 query，返回耗时与样例。 */
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
      body: JSON.stringify({ inputs: {}, query: 'ping', response_mode: 'blocking', conversation_id: '', user: 'admin-test' }),
      signal: ctrl.signal,
    });
    const data = (await res.json().catch(() => ({}))) as DifyChatResponse;
    if (!res.ok) return { ok: false, latencyMs: Date.now() - t0, error: `Dify ${res.status}: ${data.message ?? data.code ?? '请求失败'}` };
    return { ok: true, latencyMs: Date.now() - t0, sample: (data.answer ?? '').slice(0, 40) };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - t0, error: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}
