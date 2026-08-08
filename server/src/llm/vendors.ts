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
