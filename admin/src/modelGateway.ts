import type { AiProvider } from './api';

export interface ModelGatewayField {
  visible: boolean;
  label: string;
  placeholder: string;
  note?: string;
}

export function modelGatewayField(provider: AiProvider): ModelGatewayField {
  if (provider === 'mock') {
    return { visible: false, label: '', placeholder: '' };
  }
  if (provider === 'claude') {
    return {
      visible: true,
      label: 'Anthropic 网关 baseUrl（官方直连可留空）',
      placeholder: '如 https://api.qnaigc.com/bypass/anthropic',
      note: 'Claude 使用 Anthropic 原生 /v1/messages 协议；若厂商只提供 /v1/chat/completions，请把 provider 选为 openai。',
    };
  }
  return {
    visible: true,
    label: 'OpenAI 兼容网关 baseUrl（通常带 /v1）',
    placeholder: 'https://apihub.agnes-ai.com/v1',
    note: '适用于 OpenAI 兼容接口，包括使用 Claude 模型但请求路径为 /v1/chat/completions 的网关。',
  };
}

/** Anthropic 原生或 OpenAI 兼容 Claude 模型都可显示 Thinking 配置。 */
export function modelSupportsThinking(provider: AiProvider, model: string): boolean {
  return provider === 'claude' || /claude/i.test(model);
}

/**
 * 嵌入 / 重排还能不能「留空＝复用对话模型」。
 *
 * 服务端的回退是 `cfg.embeddingBaseUrl || cfg.baseUrl` + `cfg.embeddingApiKey || cfg.apiKey`，
 * 而请求路径是 OpenAI 风格的 `${baseUrl}/embeddings`、`${baseUrl}/rerank`。**两条独立的否决理由**：
 *
 *   ① 协议不符：对话端点走 Anthropic 协议时，baseUrl 是 Anthropic 协议根，拼出的 `/embeddings`
 *      在协议上根本不存在——与厂商是谁无关。
 *   ② 厂商没有这个能力：七牛官方明示不提供 Embedding 模型。**这一条协议上是合法的**
 *      （`api.qnaigc.com/v1` 是标准 OpenAI 兼容），所以只判协议会漏掉它。
 *
 * 域名清单是一期的临时兜底；二期由 `VendorPreset.caps.embedding` 取代（见 AI_CONFIG_REDESIGN §7.1-5）。
 */
const NO_EMBEDDING_HOSTS = ['qnaigc.com'];

export function auxReuseBlock(provider: AiProvider, baseUrl: string): { blocked: boolean; reason: string } {
  if (provider === 'claude') {
    return { blocked: true, reason: '当前对话端点走 Anthropic 协议，复用它拼出的 /embeddings、/rerank 路径不存在，必须单独填网关与 Key。' };
  }
  const host = (() => {
    try { return new URL(baseUrl).hostname; } catch { return ''; }
  })();
  if (host && NO_EMBEDDING_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) {
    return { blocked: true, reason: '七牛不提供 Embedding / Rerank 模型，复用对话端点必定失败。请指向其它厂商，或关掉开关用本地兜底。' };
  }
  return { blocked: false, reason: '' };
}

/** 检测项的中文名。后台不该把 kind 的英文枚举直接甩给运营。 */
const PROBE_NAMES: Record<string, string> = {
  connectivity: '连通性', model_scope: '模型范围', thinking: 'Thinking 写法', tools: '工具调用',
  streaming: '流式', long_output: '长输出', embedding: '嵌入', rerank: '重排',
};
export const probeName = (kind: string) => PROBE_NAMES[kind] || kind;

/**
 * 端点行的方言说明。**「已固化」和「还在推断」必须让运营一眼看得出**——
 * 推断值随 baseUrl 一改就可能变，而运营以为自己选定了什么；固化过的才是稳定事实。
 */
export function dialectLine(
  m: { provider: string; dialect?: string | null; resolvedDialect?: string },
  labelOf: (id?: string | null) => string,
): string {
  if (m.provider === 'mock' || !m.resolvedDialect) return '';
  return m.dialect
    ? `方言 ${labelOf(m.resolvedDialect)}（已固化）`
    : `方言 ${labelOf(m.resolvedDialect)}（推断中 · 点右侧「固化方言」确认）`;
}

/** 端点行的检测态。本次结果优先于库里的历史值；从没测过要如实说「从未检测」。 */
export function probeLine(
  m: { lastProbeAt?: string | null; lastProbeOk?: boolean | null },
  fresh?: { results: { ok: boolean }[] },
  fmt: (iso: string) => string = (iso) => new Date(iso).toLocaleString(),
): string {
  if (fresh) {
    const bad = fresh.results.filter((x) => !x.ok).length;
    return ` · 检测 ${bad ? `${bad} 项未过` : '全部通过'}`;
  }
  if (m.lastProbeAt) return ` · 上次检测 ${fmt(m.lastProbeAt)} ${m.lastProbeOk ? '通过' : '未过'}`;
  return ' · 从未检测';
}

/**
 * 嵌入/重排开着却没填独立网关或 Key 时，给出该拦下的原因；可保存时返回空串。
 * 只在 `auxReuseBlock` 命中时才拦——没命中说明「留空复用」本来就合法。
 */
export function auxMissingReason(
  blocked: boolean,
  aux: { embeddingEnabled: boolean; embeddingBaseUrl: string; embeddingApiKey: string; rerankEnabled: boolean; rerankBaseUrl: string; rerankApiKey: string },
  saved: { hasEmbeddingKey: boolean; hasRerankKey: boolean },
): string {
  if (!blocked) return '';
  if (aux.embeddingEnabled && !aux.embeddingBaseUrl.trim()) return '嵌入已开启，请填写独立的接入地址 baseUrl';
  if (aux.rerankEnabled && !aux.rerankBaseUrl.trim()) return '重排已开启，请填写独立的接入地址 baseUrl';
  if (aux.embeddingEnabled && !saved.hasEmbeddingKey && !aux.embeddingApiKey.trim()) return '嵌入已开启，请填写独立的 API Key';
  if (aux.rerankEnabled && !saved.hasRerankKey && !aux.rerankApiKey.trim()) return '重排已开启，请填写独立的 API Key';
  return '';
}

/**
 * 某用途路由里「非生效」的成员该怎么呈现。
 *
 * 这些成员是 `setPrimary` 攒下来的：对话/成果两个可分流用途在切换生效接入点时**保留旧成员**，
 * 于是被切走的端点会留在路由里。旧版界面只在分流开着时才列它们——单端点模式下它们不接流量、
 * 也不显示，运营看不见更删不掉，直到打开「多路分流」的那一刻池子里凭空多出一个混协议的成员。
 * 协议判据取**方言的协议**而不是 provider：provider=claude 却被固化成 openai 方言的端点，
 * 只看 provider 是看不出来的（与 server 端 validateRoute 同口径）。
 */
export function routeMemberRow(
  member: { endpointId: string },
  ep: { dialect?: string | null; resolvedDialect?: string } | undefined,
  primaryEp: { dialect?: string | null; resolvedDialect?: string } | undefined,
  dialects: { id: string; protocol: string }[],
): { sameProtocol: boolean; removable: true } {
  const protocolOf = (x?: { dialect?: string | null; resolvedDialect?: string }) =>
    (x ? dialects.find((d) => d.id === (x.dialect || x.resolvedDialect))?.protocol : undefined);
  const mine = protocolOf(ep);
  const theirs = protocolOf(primaryEp);
  // 判不出协议（端点已删、方言目录里没这条）时不诬告——说「不同」会让运营去移出一个没问题的成员。
  return { sameProtocol: !mine || !theirs || mine === theirs, removable: true };
}
