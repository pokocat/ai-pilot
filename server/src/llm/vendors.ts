// 厂商能力表（2026-08-07 · 重设计二期）。
//
// 与 `dialects.ts` 是**两个正交维度**，别合并：
//   · 方言（dialect）回答「同一个协议下，这家的请求细节怎么写」——关闭思考省略还是显式发之类；
//   · 厂商（vendor）回答「这家到底有没有这个能力」——比如**七牛压根不提供 Embedding 模型**。
//
// 为什么两条都得判、少一条就漏：七牛的 OpenAI 兼容入口 `api.qnaigc.com/v1` 在**协议上完全合法**，
// `${baseUrl}/embeddings` 这个路径拼得出来、格式也对，只判协议会放行；可它必定失败，因为那家
// 没有嵌入模型。反过来，Anthropic 协议根下 `/embeddings` 路径本身就不存在，这是协议问题、
// 与厂商是谁无关。两类失败长得像，成因完全不同。
//
// 判据用域名而不是 preset id：端点存的是 baseUrl，运营完全可能不走预设直接手填。
// 三期归一化后凭证上会有显式 `vendor` 字段，这张表退化为「新建端点时的默认值来源」。

import type { AiPreset } from './schema.js';

export interface VendorCaps {
  /** 提供文本向量（/embeddings）。false=该厂商下的嵌入端点必错，禁止「留空复用对话模型」。 */
  embedding: boolean;
  /** 提供重排（/rerank）。 */
  rerank: boolean;
  /** API Key 带模型范围（七牛 model groups）：key × model 是有效性组合，不是两个独立字段。 */
  keyScoped: boolean;
}

export interface VendorMeta {
  id: string;
  label: string;
  /** 匹配的域名（含子域名）。 */
  hosts: string[];
  caps: VendorCaps;
  docUrl?: string;
  note?: string;
}

export const VENDORS: VendorMeta[] = [
  {
    id: 'qiniu',
    label: '七牛云',
    hosts: ['qnaigc.com', 'modelink.ai'],
    // 官方 FAQ：「暂未提供文本向量/Embedding 模型」。rerank 同样未见提供，保守按 false。
    caps: { embedding: false, rerank: false, keyScoped: true },
    docUrl: 'https://developer.qiniu.com/aitokenapi',
    note: 'Key 有模型范围限制；范围外报 model not available in your assigned model groups',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    hosts: ['api.deepseek.com'],
    caps: { embedding: true, rerank: false, keyScoped: false },
    docUrl: 'https://api-docs.deepseek.com/',
  },
  {
    id: 'volcengine',
    label: '火山方舟',
    hosts: ['volces.com'],
    caps: { embedding: true, rerank: false, keyScoped: false },
  },
  {
    id: 'anthropic',
    label: 'Anthropic 官方',
    hosts: ['api.anthropic.com'],
    caps: { embedding: false, rerank: false, keyScoped: false },
  },
  {
    id: 'openai',
    label: 'OpenAI 官方',
    hosts: ['api.openai.com'],
    caps: { embedding: true, rerank: false, keyScoped: false },
  },
  {
    id: 'siliconflow',
    label: '硅基流动',
    hosts: ['api.siliconflow.cn'],
    caps: { embedding: true, rerank: true, keyScoped: false },
  },
  {
    id: 'aliyun',
    label: '阿里云百炼',
    hosts: ['dashscope.aliyuncs.com'],
    caps: { embedding: true, rerank: true, keyScoped: false },
  },
];

// 内置接入商目录：「添加接入点」向导选其一即可一键填好 baseUrl/model（仍可改）。
//
// **一个厂商可能要占两条预设**：同一家的 OpenAI 协议与 Anthropic 协议是两个不同的 baseUrl。
// 这属于厂商接入事实，和运行时配置解析无关，所以跟 VENDORS 放在同一个模块里。
export const AI_PRESETS: AiPreset[] = [
  {
    id: 'qiniu-anthropic', label: '七牛云 · Anthropic 协议', provider: 'claude',
    baseUrl: 'https://api.qnaigc.com', model: 'claude-opus-4-6',
    note: 'Anthropic /v1/messages。关闭 Thinking 时发 {type:"disabled"} 且不得带 budget_tokens（带了返回 400）',
  },
  {
    id: 'qiniu', label: '七牛云 · OpenAI 兼容', provider: 'openai',
    baseUrl: 'https://api.qnaigc.com/v1', model: '',
    note: '模型名见控制台或 GET /v1/models。注意：七牛不提供 Embedding；API Key 有模型范围限制',
  },
  { id: 'agnes', label: 'Agnes 2.0 Flash', provider: 'openai', baseUrl: 'https://apihub.agnes-ai.com/v1', model: 'agnes-2.0-flash', note: 'SapiensAI · OpenAI 兼容（含 tool calling）' },
  { id: 'deepseek', label: 'DeepSeek 深度求索', provider: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', note: '深度求索 · OpenAI 兼容' },
  {
    id: 'deepseek-anthropic', label: 'DeepSeek · Anthropic 协议', provider: 'claude',
    baseUrl: 'https://api.deepseek.com/anthropic', model: '',
    note: 'Claude 模型名会被映射到 deepseek-v4-*（opus→pro，sonnet/haiku→flash）；thinking 接受但 budget_tokens 被忽略',
  },
  { id: 'qwen', label: '通义千问 Qwen', provider: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', embeddingModel: 'text-embedding-v3', note: '阿里云 · 兼容模式' },
  { id: 'moonshot', label: 'Moonshot 月之暗面 (Kimi)', provider: 'openai', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', note: 'Kimi · OpenAI 兼容' },
  { id: 'glm', label: '智谱 GLM', provider: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus', embeddingModel: 'embedding-3', note: '智谱清言 · OpenAI 兼容' },
  { id: 'doubao', label: '火山方舟 · 豆包', provider: 'openai', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-pro-32k', note: '字节火山引擎 · model 填接入点 ID' },
  {
    id: 'volcengine-anthropic', label: '火山方舟 · Anthropic 协议', provider: 'claude',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/coding', model: '',
    note: '来自 Coding Plan 形态；标准 Chat API 是否另有 Anthropic 入口未见官方原文，接入前务必用「测试连接」直测',
  },
  { id: 'siliconflow', label: '硅基流动 SiliconFlow', provider: 'openai', baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-72B-Instruct', note: '多模型聚合 · OpenAI 兼容' },
  { id: 'minimax', label: 'MiniMax', provider: 'openai', baseUrl: 'https://api.minimaxi.com/v1', model: 'abab6.5s-chat', note: 'MiniMax · OpenAI 兼容' },
  { id: 'baichuan', label: '百川 Baichuan', provider: 'openai', baseUrl: 'https://api.baichuan-ai.com/v1', model: 'Baichuan4', note: '百川智能 · OpenAI 兼容' },
  { id: 'openai', label: 'OpenAI', provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', embeddingModel: 'text-embedding-3-small', note: '官方' },
  { id: 'claude', label: 'Claude (Anthropic)', provider: 'claude', baseUrl: '', model: 'claude-sonnet-4-6', note: 'Anthropic 官方协议' },
  { id: 'mock', label: '本地模板 (mock)', provider: 'mock', baseUrl: '', model: 'template', note: '零成本离线，演示兜底' },
];

/**
 * 未登记厂商的缺省能力。**必须是「都当作有」**，不是「都当作没有」：
 * 这张表只列得出我们查证过的几家，任意兼容网关都可能自建嵌入。缺省按没有会把大量正常配置误拦，
 * 而误拦的代价（运营被挡住、来问我们）比放行的代价（探活时失败一次）大得多。
 * 换句话说：**这张表只用来「拦已知不行的」，不用来「批准未知的」。**
 */
const UNKNOWN_VENDOR: VendorCaps = { embedding: true, rerank: true, keyScoped: false };

function hostOf(baseUrl: string): string {
  try { return new URL(baseUrl).hostname.toLowerCase(); } catch { return ''; }
}

export function vendorOf(baseUrl: string): VendorMeta | null {
  const host = hostOf(baseUrl);
  if (!host) return null;
  return VENDORS.find((v) => v.hosts.some((h) => host === h || host.endsWith(`.${h}`))) ?? null;
}

export function vendorCapsOf(baseUrl: string): VendorCaps {
  return vendorOf(baseUrl)?.caps ?? UNKNOWN_VENDOR;
}
