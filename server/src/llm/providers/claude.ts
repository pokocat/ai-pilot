// Claude 提供方（provider=claude 时启用）。用 tool use 强制结构化成果输出。
// apiKey/model 来自运行时配置（可后台切换）。

import Anthropic from '@anthropic-ai/sdk';
import { CHAT_TAIL_DIRECTIVE, DELIVERABLE_TOOL, ZERO_USAGE, buildSystemParts, normalizeDeliverableSections, normalizePrescriptions, normalizeCover, type Deliverable, type ChatReply, type GenContext, type Metered, type Usage } from '../schema.js';
import { DELIVERABLES, TRUST_NOTE } from '../../data/deliverables.js';
import type { ResolvedAiConfig } from '../../services/aiConfig.js';
import type { LoopMessage, StepFn, Tool, ToolCall, ToolContext } from '../tools/types.js';
import { runToolLoop } from '../tools/loop.js';
import type { AdaptiveOut } from './openai.js';
import {
  assertChatBodyProduced,
  assertChatOutputComplete,
  continuationPrompt,
  dedupeContinuation,
  isTruncatedFinish,
  joinContinuation,
  noteChatTruncated,
  CHAT_MAX_TOKENS,
  CHAT_TOTAL_MAX_TOKENS,
  CONTINUE_DEADLINE_MS,
  CONTINUE_DEDUPE_BUFFER_CHARS,
  CONTINUE_ROUND_TIMEOUT_MS,
  MAX_CHAT_CONTINUATIONS,
} from './completionGuard.js';
// 全局并发闸：所有真实外呼都要过闸（压测 P0-2）。挂在 provider 层而不是 gateway 的业务分支，
// 是因为 gateway 有 17 个动态 import 调用点，逐个包既漏又难维护。
import { withLlmSlot, acquireLlmSlot, endpointLane } from '../../services/llmGate.js';
// 端点池：多路分流 + 故障转移。未启用池时只有一个候选，行为与直接过闸完全一致。
import { withEndpoint, resolveCandidates, coolEndpoint, isTransferable, noteEndpointAttempt } from '../../services/llmPool.js';
import { chatMaxTokens, maxTokensForThinking, thinkingRequestTuning, type ThinkingParam } from '../thinking.js';
import { chatTimeoutMs, deliverableTimeoutMs, streamFirstEventIdleMs, streamIdleMs } from '../providerTimeouts.js';
import { noteChatFirstToken, noteChatPartialKept, noteChatStreamStall } from '../../services/metrics.js';

const DELIVERABLE_MAX_TOKENS = 8000; // 报告产出上限（放到整份报告够用，实际按需生成不硬凑）
type ClaudeRawRequest = Anthropic.MessageCreateParamsNonStreaming & { thinking?: ThinkingParam };

// system 拆成「稳定前缀(打缓存断点) + 每轮变化的参考资料」两块，命中缓存按 ~1/10 计费。
// 提示词不足最低缓存阈值(Opus 4.8 约 4096 token、Sonnet 约 2048)时 cache_control 自动忽略，无副作用。
// 提示词缓存在现网为 GA、无需 beta header；SDK 0.32.1 的 TextBlockParam 类型尚无 cache_control 字段，
// 但真实 API 接受该字段且 SDK 原样透传，故用局部 cast 下发。命中情况看 usage.cache_read_input_tokens。
type CachedTextBlock = { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } };
function systemBlocks(stableText: string, dynamic: string): Anthropic.TextBlockParam[] {
  const out: CachedTextBlock[] = [{ type: 'text', text: stableText, cache_control: { type: 'ephemeral' } }];
  if (dynamic) out.push({ type: 'text', text: dynamic });
  return out as unknown as Anthropic.TextBlockParam[];
}

// 按 (key + baseUrl) 缓存 client（后台切换 key/接入点后自动新建）。
// 第三方 Anthropic 兼容网关（如七牛 qnaigc 的 /bypass/anthropic）：填了 baseUrl 时
// ① 透传 baseURL —— SDK 会自动补 /v1/messages，故把用户可能粘贴的 /v1 或 /v1/messages 后缀去掉，
//    避免重复成 /v1/v1/messages 后 404；
// ② 这类网关多用 Authorization: Bearer 鉴权，而官方 SDK 默认只发 x-api-key，故额外补一个 Bearer 头
//    （两头并存，官方端会忽略多余的 Authorization）。baseUrl 留空＝官方 Anthropic，保持 x-api-key 原状不变。
export function normalizeClaudeBaseUrl(baseUrl?: string): string {
  return baseUrl?.trim().replace(/\/+$/, '').replace(/\/v1\/messages$/i, '').replace(/\/v1$/i, '') || '';
}

// 按 (apiKey, baseUrl) 缓存多个 client。**必须是 Map 不能是单槽**：接了端点池之后，
// 相邻请求会在不同 (key, baseUrl) 之间交替，单槽缓存等于每次都重建 client、丢掉底层连接池。
// 上限 16，超了清空重来（端点数量级远小于此，纯属防御）。
const clients = new Map<string, Anthropic>();

// 测试注入口（同 alertConfig 的 __setFeishuTransportForTest 惯例）。
// **必须有**：SDK 用的是自带的 fetch shim（node-fetch），不是 globalThis.fetch，所以打桩全局 fetch
// 对它无效——这正是「claude 流式逐字 delta 静默失效」当初测不出来的原因之一。生产代码不许调用。
let testFetch: typeof globalThis.fetch | null = null;
export function __setClaudeFetchForTest(f: typeof globalThis.fetch | null): void {
  testFetch = f;
  clients.clear(); // client 缓存里绑着旧 fetch，必须一起丢掉
}

function getClient(apiKey: string, baseUrl?: string): Anthropic {
  const base = normalizeClaudeBaseUrl(baseUrl);
  const cacheKey = `${apiKey}|${base}`;
  let c = clients.get(cacheKey);
  if (!c) {
    if (clients.size >= 16) clients.clear();
    // maxRetries 设 0：SDK 内部重试关死，重试权唯一归任务层（withEndpoint 端点池：可转移错误
    // → 冷却 → 换端点，至多 LLM_POOL_MAX_ATTEMPTS 次）。此前 SDK 层 2 次 × 端点池 3 次层层相乘，
    // 报告最坏 3×3×120s≈18 分钟——客户端 180s 就断了，剩下的全是白烧 token 的僵尸请求
    // （2026-07-28 报告卡死修复）。关掉后最坏收敛为 3×120s=6 分钟硬上界。
    const injected = testFetch ? { fetch: testFetch } : {};
    c = new Anthropic(
      base
        ? { apiKey, baseURL: base, defaultHeaders: { Authorization: `Bearer ${apiKey}` }, maxRetries: 0, ...injected }
        : { apiKey, maxRetries: 0, ...injected },
    );
    clients.set(cacheKey, c);
  }
  return c;
}

/**
 * 端点亲和键：同一会话固定落同一端点，保住上游的提示词缓存（缓存按账号/端点隔离）。
 * 没有 sessionId 时退到 agentKey——比每次随机好，至少同一智能体的连续调用能复用缓存。
 */
function affinityOf(ctx: GenContext): string {
  return ctx.runtime?.sessionId || ctx.agentKey || 'anon';
}

// 多模态当轮 user content：有图片时组成 [image..., text] 块数组；无图片维持纯字符串（不动既有形态，
// 保住提示词缓存前缀）。导出供单测组装逻辑。
type ImageInput = { mediaType: string; base64: string };
type UserBlock = Anthropic.TextBlockParam | Anthropic.ImageBlockParam;
export function claudeUserContent(userMessage: string, images?: ImageInput[]): string | UserBlock[] {
  if (!images?.length) return userMessage;
  const blocks: UserBlock[] = images.map((im) => ({
    type: 'image',
    source: { type: 'base64', media_type: im.mediaType as Anthropic.ImageBlockParam.Source['media_type'], data: im.base64 },
  }));
  blocks.push({ type: 'text', text: userMessage || '（见图，请据图作答）' });
  return blocks;
}

function metaOf(ctx: GenContext): string {
  const parts = [ctx.companyName, ctx.profile?.industry, ctx.profile?.stage].filter(Boolean) as string[];
  return parts.length ? parts.join(' · ') : '经营快照';
}

// Anthropic usage → 归一 Usage。input_tokens 只含未缓存部分，故 total 要把 cache_read/create 加回。
//
// 三档必须分别上报：读缓存约 0.1×、写缓存约 1.25×（5m TTL）、其余 1×。早期实现把
// cache_creation 并进 inputTokens 且不单独记，于是缓存写按 1× 计价——每次写都少算 25%，
// 且用量不落库、事后无法量化。现在 cacheWrite 独立上报并持久化。
function usageOf(res: Anthropic.Message): Usage {
  const u = res.usage as { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const cacheCreate = u.cache_creation_input_tokens ?? 0;
  return {
    inputTokens: u.input_tokens + cacheRead + cacheCreate,
    outputTokens: u.output_tokens,
    cachedInput: cacheRead,
    cacheWrite: cacheCreate,
  };
}

function requireText(text: string | null | undefined, usage: Usage, where: string): string {
  const out = (text ?? '').trim();
  if (out) return out;
  const detail = usage.outputTokens > 0 ? `，输出 token=${usage.outputTokens}` : '';
  throw Object.assign(new Error(`Claude 接口返回空文本（${where}${detail}）`), { code: 'AI_EMPTY_RESPONSE' });
}

export async function claudeDeliverable(ctx: GenContext, cfg: ResolvedAiConfig): Promise<Metered<Deliverable>> {
  const tpl = ctx.deliverableKey ? DELIVERABLES[ctx.deliverableKey] : undefined;
  const { stable, dynamic } = buildSystemParts(ctx.systemPrompt, ctx, 'deliverable');
  const structureHint = tpl
    ? `参考产出结构（小标题）：${tpl.sections.map((s) => s.h).join(' / ')}。标题用「${tpl.title}」。`
    : '产出 3–4 段结构化内容。';
  const dlvHistory = (ctx.history ?? []).map((m) => ({ role: m.role === 'user' ? ('user' as const) : ('assistant' as const), content: m.text }));

  const res = await withEndpoint(cfg, (ep) => getClient(ep.apiKey, ep.baseUrl).messages.create({
    model: ep.model,
    max_tokens: DELIVERABLE_MAX_TOKENS,
    ...thinkingRequestTuning(ep, { allowThinking: false }),
    system: systemBlocks(`${stable}\n\n${structureHint}\n务必调用 emit_deliverable 工具输出结构化成果，不要输出自由长文。`, dynamic),
    tools: [DELIVERABLE_TOOL],
    tool_choice: { type: 'tool', name: 'emit_deliverable' },
    messages: [...dlvHistory, { role: 'user', content: claudeUserContent(ctx.userMessage || `请为我产出一份${tpl?.title ?? '咨询成果'}。`, ctx.images) }],
  }, { timeout: deliverableTimeoutMs(ep.timeoutMs) }), { affinityKey: affinityOf(ctx) });
  const usage = usageOf(res);

  const toolUse = res.content.find((c) => c.type === 'tool_use');
  if (toolUse && toolUse.type === 'tool_use') {
    const input = toolUse.input as { title?: string; sections?: unknown; cover?: unknown };
    const sections = normalizeDeliverableSections(input.sections);
    if (sections.length) {
      return {
        result: {
          title: input.title || tpl?.title || '咨询成果',
          icon: tpl?.icon ?? 'spark',
          meta: metaOf(ctx),
          cover: normalizeCover(input.cover),
          sections,
          trust: TRUST_NOTE,
          actions: ['save_to_library', 'export_pdf'],
          prescriptions: normalizePrescriptions((input as { prescriptions?: unknown } | null)?.prescriptions),
        },
        usage,
      };
    }
  }
  const textSections = normalizeDeliverableSections(
    res.content.filter((c) => c.type === 'text').map((c) => (c.type === 'text' ? c.text : '')).join('\n'),
  );
  if (textSections.length) {
    return {
      result: {
        title: tpl?.title || '咨询成果',
        icon: tpl?.icon ?? 'spark',
        meta: metaOf(ctx),
        sections: textSections,
        trust: TRUST_NOTE,
        actions: ['save_to_library', 'export_pdf'],
      },
      usage,
    };
  }
  // 真实调用已发生（已花 token）：即便没拿到 tool 输出，也按真实 usage 记账（成本可观测），内容兜底 mock 并标 degraded（用户侧不计费、提示可重试）。
  const { mockDeliverable } = await import('./mock.js');
  return { result: { ...mockDeliverable(ctx), degraded: true }, usage };
}

function sumUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedInput: a.cachedInput + b.cachedInput,
    cacheWrite: (a.cacheWrite ?? 0) + (b.cacheWrite ?? 0),
  };
}

function chatHistory(ctx: GenContext): Anthropic.MessageParam[] {
  return (ctx.history ?? []).map((m) => ({
    role: m.role === 'user' ? ('user' as const) : ('assistant' as const),
    content: m.text,
  }));
}

/** 对话首轮的 system（稳定段打缓存断点）+ messages。续写轮在此基础上追加两条消息。 */
function chatRequestBase(ctx: GenContext): { system: Anthropic.TextBlockParam[]; messages: Anthropic.MessageParam[] } {
  const { stable, dynamic } = buildSystemParts(ctx.systemPrompt, ctx, 'chat');
  return {
    system: systemBlocks(stable, dynamic ? `${dynamic}\n\n${CHAT_TAIL_DIRECTIVE}` : CHAT_TAIL_DIRECTIVE),
    messages: [...chatHistory(ctx), { role: 'user', content: claudeUserContent(ctx.userMessage, ctx.images) }],
  };
}

/**
 * 续写轮的 messages：把残文当**历史里的** assistant 轮，续写指令放在其后的 user 轮。
 *
 * 不能用「末轮 assistant prefill 接着写」那套老写法——Claude Opus 4.6 及以后已移除末轮 prefill，
 * 会直接 400。放 user 轮是官方替代方案，新旧模型与三方兼容网关都安全。
 */
function continuationMessages(base: Anthropic.MessageParam[], accumulated: string): Anthropic.MessageParam[] {
  return [
    ...base,
    { role: 'assistant', content: accumulated },
    { role: 'user', content: continuationPrompt(accumulated) },
  ];
}

/** 续写轮显式关思考：这一轮只是把话写完，再想一遍纯属白烧预算，也把 max_tokens 整个让给正文。 */
const CONTINUE_TUNING = { allowThinking: false } as const;

function textOf(res: Anthropic.Message): string {
  return res.content.filter((c) => c.type === 'text').map((c) => (c.type === 'text' ? c.text : '')).join('\n').trim();
}

export async function claudeChat(ctx: GenContext, cfg: ResolvedAiConfig): Promise<Metered<ChatReply>> {
  const { system, messages: base } = chatRequestBase(ctx);
  const startedAt = Date.now();
  let text = '';
  let usage: Usage = ZERO_USAGE;
  let truncated = false;

  // 撞上限即自动续写：max_tokens 是模型看不见的硬闸刀，报错丢内容是最差的处理方式。
  for (let round = 0; ; round++) {
    const messages = round === 0 ? base : continuationMessages(base, text);
    const res = await withEndpoint(cfg, (ep) => getClient(ep.apiKey, ep.baseUrl).messages.create({
      model: ep.model,
      max_tokens: chatMaxTokens(CHAT_MAX_TOKENS, ep, round === 0),
      ...thinkingRequestTuning(ep, round === 0 ? {} : CONTINUE_TUNING),
      system,
      messages,
    }, { timeout: round === 0 ? chatTimeoutMs(ep.timeoutMs) : CONTINUE_ROUND_TIMEOUT_MS }), { affinityKey: affinityOf(ctx) });
    usage = sumUsage(usage, usageOf(res));
    text = joinContinuation(text, textOf(res));

    if (!isTruncatedFinish(res.stop_reason)) break;
    // 一个字正文都没写就撞上限：没有锚点可续写，如实抛错并指向预算（见 assertChatBodyProduced）。
    if (!text) assertChatBodyProduced('Claude', res.stop_reason, usage.outputTokens);
    if (round >= MAX_CHAT_CONTINUATIONS
      || usage.outputTokens >= CHAT_TOTAL_MAX_TOKENS
      || Date.now() - startedAt > CONTINUE_DEADLINE_MS) {
      truncated = true;
      noteChatTruncated('Claude', 'given_up');
      break;
    }
    noteChatTruncated('Claude', 'continued');
  }

  return { result: { text: requireText(text, usage, 'chat'), ...(truncated ? { truncated: true } : {}) }, usage };
}

type StreamRoundOut = { text: string; usage: Usage; truncated: boolean };

/**
 * 一轮流式对话：逐字 yield，返回本轮正文 / 用量 / 是否撞上限。
 *
 * `dedupeAgainst` 有值时（续写轮）先把开头攒够 CONTINUE_DEDUPE_BUFFER_CHARS 再下发，
 * 好把模型复述的半句剪掉——逐字吐出去就撤不回来了。首轮无重叠可言，即时下发。
 */
async function* streamChatRound(
  ep: ResolvedAiConfig,
  system: Anthropic.TextBlockParam[],
  messages: Anthropic.MessageParam[],
  // sink：把「已经下发给用户的正文/用量」实时写给调用方。流中途抛错时调用方才拿得到它们——
  // 用户眼睛已经看过的字不能再被换成错误气泡（与撞上限同一原则）。
  opts: { allowThinking: boolean; dedupeAgainst?: string; onDelta?: () => void; timeoutMs?: number; measureFirstToken?: boolean; sink?: { text: string; usage: Usage } },
): AsyncGenerator<{ type: 'delta'; text: string }, StreamRoundOut> {
  // 这个 timeout 只约束「多久拿到响应头」——SDK 在 fetch promise 的 .finally() 里 clearTimeout，
  // 而流式 fetch 在响应头到达即 resolve。头到之后的保护由下面的空闲看门狗负责，两者职责不同。
  const stream = getClient(ep.apiKey, ep.baseUrl).messages.stream({
    model: ep.model,
    max_tokens: chatMaxTokens(CHAT_MAX_TOKENS, ep, opts.allowThinking),
    ...thinkingRequestTuning(ep, opts.allowThinking ? {} : CONTINUE_TUNING),
    system,
    messages,
  }, { timeout: opts.timeoutMs ?? chatTimeoutMs(ep.timeoutMs) });

  // 空闲看门狗（**不是总时长超时**）：连续这么久没有任何流事件就判上游装死并 abort。
  // 不设它的后果是请求永久挂起 + 占住一个 LLM 并发槽，只能等客户端断开（见 providerTimeouts 说明）。
  const startedAt = Date.now();
  let sawEvent = false;
  let stalled = false;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const armIdle = (ms: number) => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      stalled = true;
      noteChatStreamStall('claude', sawEvent ? 'mid_stream' : 'first_event');
      stream.abort();
    }, ms);
  };
  const clearIdle = () => { if (idleTimer) clearTimeout(idleTimer); idleTimer = null; };

  let text = '';
  let usage: Usage = ZERO_USAGE;
  let head: string | null = opts.dedupeAgainst ? '' : null; // null=已过缓冲期/首轮，直接下发

  let firstDeltaAt = 0;
  const emit = (chunk: string): { type: 'delta'; text: string } | null => {
    if (!chunk) return null;
    if (!firstDeltaAt) {
      firstDeltaAt = Date.now();
      // 首字延迟只在首轮有产品含义（续写轮的「首字」是接着写，不是用户的等待）。
      if (opts.measureFirstToken) noteChatFirstToken('claude', (firstDeltaAt - startedAt) / 1000);
    }
    text += chunk;
    if (opts.sink) opts.sink.text = text;
    opts.onDelta?.();
    return { type: 'delta', text: chunk };
  };

  try {
    armIdle(streamFirstEventIdleMs());
    // 注意 else-if 链的完整性：中间插任何语句都会把 `content_block_delta` 分支变成前一个 if 的 else，
    // 于是文字 delta 全被跳过、逐字流静默失效（正文还能靠下面 finalMessage 兜底，所以不报错、极难发现）。
    // 2026-08-04 就这么踩过一次。sink 赋值与看门狗续期一律放在整条链**之后**，且循环里不用 continue。
    for await (const event of stream) {
      if (event.type === 'message_start') usage = usageOf(event.message);
      else if (event.type === 'message_delta') usage = { ...usage, outputTokens: event.usage.output_tokens };
      else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        if (head !== null) {
          head += event.delta.text;
          if (head.length >= CONTINUE_DEDUPE_BUFFER_CHARS) {
            const cleaned = dedupeContinuation(opts.dedupeAgainst!, head);
            head = null;
            const ev = emit(cleaned);
            if (ev) yield ev;
          }
        } else {
          const ev = emit(event.delta.text);
          if (ev) yield ev;
        }
      }
      if (opts.sink) opts.sink.usage = usage;
      // 任何事件都算「活着」——thinking 期间来的是 thinking_delta，也该续期。
      sawEvent = true;
      armIdle(streamIdleMs());
    }
    if (head) { // 整轮短于缓冲长度（续写只补了一句）
      const ev = emit(dedupeContinuation(opts.dedupeAgainst!, head));
      if (ev) yield ev;
    }
  } catch (err) {
    // 看门狗自己 abort 的：换成语义明确的错误，别让上层把「上游装死」读成「用户取消」。
    if (stalled) {
      throw Object.assign(
        new Error(`Claude 流式静默超时（${sawEvent ? '中途' : '响应头后'}无事件，已下发 ${text.length} 字）`),
        { code: 'AI_STREAM_STALL' },
      );
    }
    throw err;
  } finally {
    clearIdle();
  }

  const final = await stream.finalMessage().catch(() => null);
  if (final) usage = usageOf(final);
  // 没收到任何 text_delta 但 finalMessage 有正文时的回落。续写轮的回落**必须同样去重**：
  // 否则「逐字流里被剪掉的重复」会从这条回落原样进落库文本，用户看到的和存下来的对不上。
  const fallback = final ? textOf(final) : '';
  const body = text || (opts.dedupeAgainst ? dedupeContinuation(opts.dedupeAgainst, fallback) : fallback);
  return { text: body, usage, truncated: isTruncatedFinish(final?.stop_reason) };
}

export async function* claudeChatStream(ctx: GenContext, cfg: ResolvedAiConfig): AsyncGenerator<{ type: 'delta'; text: string } | { type: 'done'; result: ChatReply; usage: Usage }> {
  const { system, messages: base } = chatRequestBase(ctx);
  // 流式的槽位必须持有到整条流消费完，不能只包住「建流」那一下——一条流在上游眼里全程占用一个并发，
  // 只包建流会让闸门形同虚设（8 个槽位瞬间放完 8 条流，紧接着又放 8 条）。故手动 acquire/release。
  //
  // 端点故障转移在流式下有个硬边界：**一旦已经向客户端 yield 过 delta，就不能再转移**——
  // 换端点意味着重新生成，前面已经吐给用户的半句话会和新内容对不上。所以只在「还没吐出任何内容」
  // 时才允许转移；建流阶段和首个 delta 之前的 429/5xx 都能救回来，之后只能如实报错。
  const candidates = await resolveCandidates(cfg, { affinityKey: affinityOf(ctx) });
  const maxAttempts = Math.max(1, Math.min(candidates.length, Number(process.env.LLM_POOL_MAX_ATTEMPTS ?? 3) || 3));
  const cls = cfg.lane === 'aux' ? 'aux' : 'main';
  const laneOf = (ep: ResolvedAiConfig) => (ep.endpointId ? endpointLane(cls, ep.endpointId) : cls);

  const startedAt = Date.now();
  let text = '';
  let usage: Usage = ZERO_USAGE;
  let truncated = false;
  let served: ResolvedAiConfig | null = null;
  let lastErr: unknown;
  // 「已下发正文被保全」只记一次，且要记对原因：流中途失败 vs 撞上限续写用尽。
  let partialCause: 'truncated' | 'stream_error' | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const ep = candidates[attempt];
    const slot = await acquireLlmSlot(laneOf(ep));
    const sink = { text: '', usage: ZERO_USAGE };
    let yieldedAny = false;
    try {
      noteEndpointAttempt(ep);
      const round = yield* streamChatRound(ep, system, base, {
        allowThinking: true,
        onDelta: () => { yieldedAny = true; }, // 置位后就不能再转移端点了
        measureFirstToken: true,
        sink,
      });
      served = ep;
      text = round.text;
      usage = round.usage;
      truncated = round.truncated;
      break;
    } catch (err) {
      lastErr = err;
      slot.noteError(err);
      const last = attempt === maxAttempts - 1;
      // 流中途出错但**已经有正文流给用户**（多见于慢网关打满 150s 流超时）：不能把用户
      // 已经读到的上万字换成一个错误气泡。按「没写完」收尾——与撞上限完全同一处理：
      // 内容照常落库 + 标 truncated + 端上给「继续写完」。只有一个字都没吐出来时才如实报错。
      if (yieldedAny && sink.text) {
        console.warn(`[claude] 流中途失败但已有正文（${sink.text.length} 字），按未写完交回：${(err as Error).message}`);
        partialCause = 'stream_error';
        served = ep;
        text = sink.text;
        usage = sink.usage;
        truncated = true;
        noteChatTruncated('Claude', 'given_up');
        break;
      }
      // 已经吐过内容 / 不可转移的错 → 如实抛出；可转移错误即使没有下一个候选也要共享冷却态。
      if (yieldedAny || !ep.endpointId || !isTransferable(err)) throw err;
      await coolEndpoint(ep.endpointId, 30_000, 'stream_error');
      if (last) throw err;
      console.warn(`[claude] 流式端点 ${ep.label || ep.endpointId} 建流失败，转移到下一个：${(err as Error).message}`);
    } finally {
      // 客户端中断（generator 提前 return）也会走到这里，槽位不会泄漏。
      slot.release();
    }
  }
  if (!served) throw lastErr;
  // 一个字正文都没写就撞上限：没有锚点可续写，如实抛错并指向预算（见 assertChatBodyProduced）。
  if (truncated && !text) assertChatBodyProduced('Claude', 'max_tokens', usage.outputTokens);

  // —— 续写轮：撞上限不是失败，是「还没写完」——
  // 固定用首轮那个端点（换端点=丢提示词缓存且换了口吻）；不做故障转移（已经吐过字）。
  // 续写本身失败也**不算整轮失败**：手里已有可读内容，宁可标 truncated 交给用户点「继续」，
  // 也不能把用户已经看完的半篇回答换成一个错误气泡。
  // partialCause=stream_error 时**不续写**：续写是为「撞上限」设计的，流被掐断/装死时
  // 立刻拿同一个端点再试一轮，只会再赔一个空闲超时，还把用户已有的正文压在后面不给。
  for (let round = 1; truncated && text && !partialCause && round <= MAX_CHAT_CONTINUATIONS; round++) {
    if (usage.outputTokens >= CHAT_TOTAL_MAX_TOKENS) break;
    // 墙钟兜底：宁可标 truncated 给「继续写完」，也不能为了补齐把整轮拖到客户端超时——
    // 那会走 clientGone（退预留、不落库），用户连已经看完的半篇都拿不到。
    if (Date.now() - startedAt > CONTINUE_DEADLINE_MS) break;
    const slot = await acquireLlmSlot(laneOf(served));
    try {
      noteEndpointAttempt(served);
      const cont = yield* streamChatRound(served, system, continuationMessages(base, text), {
        allowThinking: false,
        dedupeAgainst: text,
        timeoutMs: CONTINUE_ROUND_TIMEOUT_MS,
      });
      usage = sumUsage(usage, cont.usage);
      text += cont.text; // 轮内已去重，此处只做拼接（避免与已下发的 delta 对不上）
      truncated = cont.truncated;
      noteChatTruncated('Claude', 'continued');
    } catch (err) {
      slot.noteError(err);
      console.warn(`[claude] 第 ${round} 轮续写失败，按未写完交回用户：${(err as Error).message}`);
      break;
    } finally {
      slot.release();
    }
  }
  if (truncated) {
    noteChatTruncated('Claude', 'given_up');
    if (text) noteChatPartialKept('claude', partialCause ?? 'truncated');
  }

  const out = requireText(text, usage, 'chat_stream');
  yield { type: 'done', result: { text: out, ...(truncated ? { truncated: true } : {}) }, usage };
}

/** 轻量纯文本补全（供记忆抽取 / 汇总归纳）：返回文本。 */
// maxTokens：**缺省仍是 700**（辅助抽取的既定预算，不动）。只有产物本身就长的调用方才传大值——
// 目前唯一的是海报 AI 排版引擎（gateway.completeText，一整页 HTML/CSS 几千 token，700 会被硬截断成半张页面）。
type ClaudeRawOptions = { allowThinking?: boolean; affinityKey?: string; maxTokens?: number };

export function claudeRawRequest(
  cfg: ResolvedAiConfig,
  system: string,
  user: string,
  opts: ClaudeRawOptions = {},
): ClaudeRawRequest {
  const allowThinking = opts.allowThinking ?? true;
  return {
    model: cfg.model,
    max_tokens: maxTokensForThinking(opts.maxTokens ?? 700, cfg, allowThinking),
    ...thinkingRequestTuning(cfg, { allowThinking }),
    system,
    messages: [{ role: 'user', content: user }],
  };
}

export async function claudeRaw(
  cfg: ResolvedAiConfig,
  system: string,
  user: string,
  opts: ClaudeRawOptions = {},
): Promise<string> {
  // 轻量补全必须设超时：SDK 默认 600s，网关一挂会把同步等它的路由（如 /casefile/accept）吊死。
  // 重试不在此处配——client 已 maxRetries:0，统一由 withEndpoint 控制。
  const res = await withEndpoint(cfg, (ep) => getClient(ep.apiKey, ep.baseUrl).messages.create(
    claudeRawRequest(ep, system, user, opts),
    { timeout: ep.timeoutMs },
  ), { affinityKey: opts.affinityKey, laneClass: cfg.lane === 'aux' ? 'aux' : 'main' });
  return res.content.filter((c) => c.type === 'text').map((c) => (c.type === 'text' ? c.text : '')).join('\n').trim();
}

// —— 工具调用循环的 provider step（Anthropic tool_use / tool_result 形态）——

// LoopMessage[] → Anthropic system（顶层）+ messages（含 tool_use / tool_result 块）。
// images：本轮图片挂到「最后一条 user 文本消息」（即当轮用户原文；历史 user 不挂，图片不重发）。
function toClaudeMessages(messages: LoopMessage[], images?: ImageInput[]): { system: string; msgs: Anthropic.MessageParam[] } {
  let system = '';
  const msgs: Anthropic.MessageParam[] = [];
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user') { lastUserIdx = i; break; }
  messages.forEach((m, i) => {
    if (m.role === 'system') system = m.text;
    else if (m.role === 'user') msgs.push({ role: 'user', content: i === lastUserIdx ? claudeUserContent(m.text, images) : m.text });
    else if (m.role === 'assistant') msgs.push({ role: 'assistant', content: m.text });
    else if (m.role === 'assistant_tools') {
      msgs.push({ role: 'assistant', content: m.calls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.args ?? {} })) });
    } else if (m.role === 'tool_results') {
      msgs.push({ role: 'user', content: m.results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.content, is_error: r.isError })) });
    }
  });
  return { system, msgs };
}

/** 绑定 cfg（+ 本轮图片），返回 provider 无关循环所需的 step 函数。 */
export function claudeStep(cfg: ResolvedAiConfig, images?: ImageInput[], affinityKey?: string): StepFn {
  return async (messages, tools, opts) => {
    const finalName = opts.finalTool?.name;
    const { system, msgs } = toClaudeMessages(messages, images);
    const toolDefs: Anthropic.Tool[] = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema as Anthropic.Tool['input_schema'] }));
    if (opts.finalTool) toolDefs.push({ name: opts.finalTool.name, description: opts.finalTool.description, input_schema: opts.finalTool.schema as Anthropic.Tool['input_schema'] });

    const req: ClaudeRawRequest = {
      model: cfg.model,
      max_tokens: opts.finalTool ? DELIVERABLE_MAX_TOKENS : CHAT_MAX_TOKENS,
      system: systemBlocks(system, ''),
      messages: msgs,
    };
    if (opts.forceFinal) {
      // 最后一轮收口。deliverable(强制)→强制 emit_deliverable；自适应(forceFinalTool=false)→只给 emit 但 auto(可 emit 可出文本)；chat→去掉工具出文本。
      if (opts.finalTool && opts.forceFinalTool !== false) {
        req.tools = toolDefs; req.tool_choice = { type: 'tool', name: opts.finalTool.name };
      } else if (opts.finalTool) {
        const emitDef: Anthropic.Tool = { name: opts.finalTool.name, description: opts.finalTool.description, input_schema: opts.finalTool.schema as Anthropic.Tool['input_schema'] };
        req.tools = [emitDef]; req.tool_choice = { type: 'auto' };
      }
    } else if (toolDefs.length) {
      req.tools = toolDefs;
      req.tool_choice = { type: 'auto' };
    }

    const res = await withEndpoint(cfg, (ep) => getClient(ep.apiKey, ep.baseUrl).messages.create(
      { ...req, model: ep.model, ...thinkingRequestTuning(ep, { allowThinking: false }) },
      { timeout: opts.finalTool ? deliverableTimeoutMs(ep.timeoutMs) : chatTimeoutMs(ep.timeoutMs) },
    ), { affinityKey });
    const usage = usageOf(res);
    const toolUses = res.content.filter((c): c is Anthropic.ToolUseBlock => c.type === 'tool_use');
    // 撞上限的处理按「产物能不能半份出厂」分两种：
    //   · 有 tool_use 块 / 本轮期待结构化成果 → 截断的 tool 入参就是坏 JSON，半份报告不能出厂，按失败抛；
    //   · 纯文本对话（含自适应回落文本）→ 内容是可读的，标 truncated 交回，由端上给「继续」。
    const truncated = isTruncatedFinish(res.stop_reason);
    if (truncated && (toolUses.length || (opts.finalTool && opts.forceFinalTool !== false))) {
      assertChatOutputComplete('Claude', res.stop_reason, usage.outputTokens);
    }

    if (finalName) {
      const fin = toolUses.find((c) => c.name === finalName);
      if (fin) return { kind: 'final', toolInput: fin.input as Record<string, unknown>, usage };
    }
    const regular = toolUses.filter((c) => c.name !== finalName);
    if (regular.length) {
      const mapped: ToolCall[] = regular.map((c) => ({ id: c.id, name: c.name, args: (c.input as Record<string, unknown>) ?? {} }));
      return { kind: 'tool_calls', calls: mapped, usage };
    }
    return { kind: 'final', text: textOf(res), usage, truncated };
  };
}

// —— P1-D1：claude 的工具调用循环（此前 gateway 从不路由工具到 claude，claudeStep 形同死代码）——

type LoopMeteredC<T> = Metered<T> & { toolCalls: number; iterations: number };

function toolCtxOf(ctx: GenContext): ToolContext {
  return { tenantId: ctx.tenantId ?? null, userId: ctx.userId ?? null, agentKey: ctx.agentKey, projectId: ctx.projectId ?? null, query: ctx.userMessage };
}

/** 启用技能时的对话（claude）：多轮工具调用循环，模型自行检索知识/召回记忆后出文本。 */
export async function claudeChatWithTools(ctx: GenContext, cfg: ResolvedAiConfig, tools: Tool[]): Promise<LoopMeteredC<ChatReply>> {
  const { stable, dynamic } = buildSystemParts(ctx.systemPrompt, ctx, 'chat');
  const system = dynamic ? `${stable}\n\n${dynamic}` : stable;
  const r = await runToolLoop({
    step: claudeStep(cfg, ctx.images, affinityOf(ctx)),
    system: `${system}\n\n${CHAT_TAIL_DIRECTIVE}`,
    history: ctx.history,
    userMessage: ctx.userMessage,
    tools,
    toolCtx: toolCtxOf(ctx),
  });
  return {
    result: { text: requireText(r.text, r.usage, 'chat_tools'), ...(r.truncated ? { truncated: true } : {}) },
    usage: r.usage,
    toolCalls: r.toolCalls,
    iterations: r.iterations,
  };
}

/** 启用技能时的产出（claude）：循环里可先检索/召回，最后强制 emit_deliverable 收口。 */
export async function claudeDeliverableWithTools(ctx: GenContext, cfg: ResolvedAiConfig, tools: Tool[]): Promise<LoopMeteredC<Deliverable>> {
  const tpl = ctx.deliverableKey ? DELIVERABLES[ctx.deliverableKey] : undefined;
  const { stable, dynamic } = buildSystemParts(ctx.systemPrompt, ctx, 'deliverable');
  const system = dynamic ? `${stable}\n\n${dynamic}` : stable;
  const structureHint = tpl
    ? `参考产出结构（小标题）：${tpl.sections.map((s) => s.h).join(' / ')}。标题用「${tpl.title}」。`
    : '产出 3–4 段结构化内容。';
  const r = await runToolLoop({
    step: claudeStep(cfg, ctx.images, affinityOf(ctx)),
    system: `${system}\n\n${structureHint}\n可先调用工具检索知识/召回记忆，掌握依据后务必调用 emit_deliverable 输出结构化成果，不要输出自由长文。`,
    history: ctx.history,
    userMessage: ctx.userMessage || `请为我产出一份${tpl?.title ?? '咨询成果'}。`,
    tools,
    toolCtx: toolCtxOf(ctx),
    finalTool: { name: DELIVERABLE_TOOL.name, description: DELIVERABLE_TOOL.description, schema: DELIVERABLE_TOOL.input_schema },
  });
  const input = (r.toolInput ?? {}) as { title?: string; sections?: unknown; cover?: unknown };
  const sections = normalizeDeliverableSections(input.sections);
  if (sections.length) {
    return {
      result: {
        title: input.title || tpl?.title || '咨询成果',
        icon: tpl?.icon ?? 'spark',
        meta: metaOf(ctx),
        cover: normalizeCover(input.cover),
        sections,
        trust: TRUST_NOTE,
        actions: ['save_to_library', 'export_pdf'],
        prescriptions: normalizePrescriptions((input as { prescriptions?: unknown } | null)?.prescriptions),
      },
      usage: r.usage, toolCalls: r.toolCalls, iterations: r.iterations,
    };
  }
  const textSections = normalizeDeliverableSections(r.text);
  if (textSections.length) {
    return {
      result: {
        title: tpl?.title || '咨询成果',
        icon: tpl?.icon ?? 'spark',
        meta: metaOf(ctx),
        sections: textSections,
        trust: TRUST_NOTE,
        actions: ['save_to_library', 'export_pdf'],
      },
      usage: r.usage, toolCalls: r.toolCalls, iterations: r.iterations,
    };
  }
  const { mockDeliverable } = await import('./mock.js');
  return { result: { ...mockDeliverable(ctx), degraded: true }, usage: r.usage, toolCalls: r.toolCalls, iterations: r.iterations };
}

/** 按需产出（claude）：对话优先，模型自行决定是否调用 emit_deliverable。emit→结构化成果(report)；否则→文本对话(chat)。
 *  与 openaiAdaptive 契约一致（forceFinalTool=false → emit 可选）；总军师 general 走此路，平时聊天、时机到位才出报告。 */
export async function claudeAdaptive(ctx: GenContext, cfg: ResolvedAiConfig, tools: Tool[]): Promise<AdaptiveOut> {
  const { stable, dynamic } = buildSystemParts(ctx.systemPrompt, ctx, 'chat');
  const system = dynamic ? `${stable}\n\n${dynamic}` : stable;
  const hint = '默认用文字正常对话回答用户。只有当你判断此刻需要交付一份完整的报告或卡片成果时，才调用 emit_deliverable 以结构化分段输出（含标题与各段小标题/正文/要点）；其余所有情况都直接用文字回复，不要调用 emit_deliverable。';
  const r = await runToolLoop({
    step: claudeStep(cfg, ctx.images, affinityOf(ctx)),
    system: `${system}\n\n${hint}\n\n${CHAT_TAIL_DIRECTIVE}`,
    history: ctx.history,
    userMessage: ctx.userMessage,
    tools,
    toolCtx: toolCtxOf(ctx),
    finalTool: { name: DELIVERABLE_TOOL.name, description: DELIVERABLE_TOOL.description, schema: DELIVERABLE_TOOL.input_schema },
    forceFinalTool: false, // emit_deliverable 可选，不强制
  });
  const input = (r.toolInput ?? null) as { title?: string; sections?: unknown; cover?: unknown } | null;
  const sections = normalizeDeliverableSections(input?.sections);
  if (sections.length) {
    const tpl = ctx.deliverableKey ? DELIVERABLES[ctx.deliverableKey] : undefined;
    return {
      kind: 'report',
      deliverable: {
        title: input?.title || tpl?.title || '咨询成果',
        icon: tpl?.icon ?? 'spark',
        meta: metaOf(ctx),
        cover: normalizeCover(input?.cover),
        sections,
        trust: TRUST_NOTE,
        actions: ['save_to_library', 'export_pdf'],
        prescriptions: normalizePrescriptions((input as { prescriptions?: unknown } | null)?.prescriptions),
      },
      usage: r.usage, toolCalls: r.toolCalls, iterations: r.iterations,
    };
  }
  return {
    kind: 'chat',
    reply: { text: requireText(r.text, r.usage, 'adaptive'), ...(r.truncated ? { truncated: true } : {}) },
    usage: r.usage, toolCalls: r.toolCalls, iterations: r.iterations,
  };
}
