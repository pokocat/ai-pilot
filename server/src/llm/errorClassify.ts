// LLM 上游错误分类：把「我方内部控制码」「HTTP 状态码」「provider 结构化错误类型」统一成
// 一个有限的 bucket，供 Prometheus 错误分布指标与告警分组使用。
//
// 只读错误对象上已经存在的结构化字段（code/status/error.type/providerErrorType 等），
// 不解析 errorMessage 自由文本——文案会随供应商/版本变化，解析文本注定越用越漂移，
// 宁可分类粗一点（落进 unknown）也不要靠正则猜错误语义。
//
// 三种 provider 的结构化信息来源不同：
//   - Claude：@anthropic-ai/sdk 的 APIError 原样透传，`.status` 是 HTTP 状态码，
//     `.error` 是完整响应体 { type: 'error', error: { type, message } }（见 sdk/error.mjs generate()）。
//   - OpenAI 兼容网关：本仓库在 providers/openai.ts 抛错时附加 statusCode + providerErrorType/
//     providerErrorCode（来自响应体 error.type / error.code）。
//   - Dify：providers/dify.ts 抛错时附加 statusCode + providerErrorCode（来自响应体 code）。

export type LlmErrorBucket =
  | 'busy'             // 我方并发闸主动拒绝/排队超时（AI_BUSY）——不是上游故障
  | 'moderation'       // 我方审核拦截（MODERATION_BLOCK）
  | 'output_truncated' // 撞输出上限且续写失败（AI_OUTPUT_TRUNCATED）
  | 'timeout'          // 我方判定超时/看门狗（AI_TIMEOUT/AI_STREAM_STALL/AbortError）
  | 'empty_response'   // provider 返回空文本（AI_EMPTY_RESPONSE）
  | 'auth'             // 401/403，多为密钥失效或权限不足
  | 'rate_limit'       // 429
  | 'context_length'   // 输入/上下文超过模型限制
  | 'content_filter'   // provider 侧内容策略拒绝（区别于我方 moderation）
  | 'invalid_request'  // 其余 4xx（参数错误等）
  | 'overloaded'       // provider 明确表示过载（如 Claude overloaded_error / 529）
  | 'server_error'     // 其余 5xx
  | 'network'          // 连接/DNS/fetch failed
  | 'unknown';

interface ClassifiableError {
  code?: string;
  name?: string;
  message?: string;
  status?: number;
  statusCode?: number;
  /** Claude SDK APIError：完整响应体 { type: 'error', error: { type, message } }。 */
  error?: { error?: { type?: string } } | null;
  /** OpenAI 兼容网关 / Dify：本仓库抛错时附加的结构化字段。 */
  providerErrorType?: string;
  providerErrorCode?: string;
}

const CONTEXT_LENGTH_MARKERS = new Set(['context_length_exceeded']);
const CONTENT_FILTER_MARKERS = new Set(['content_filter', 'content_policy_violation']);
const OVERLOADED_MARKERS = new Set(['overloaded_error']);

function providerType(e: ClassifiableError): string | undefined {
  return e.error?.error?.type || e.providerErrorType;
}

export function classifyLlmError(err: unknown): LlmErrorBucket {
  const e = (err ?? {}) as ClassifiableError;

  // 我方内部决策码无歧义，优先判——这些根本不是「上游出错了」。
  switch (e.code) {
    case 'AI_BUSY': return 'busy';
    case 'MODERATION_BLOCK': return 'moderation';
    case 'AI_OUTPUT_TRUNCATED': return 'output_truncated';
    case 'AI_TIMEOUT':
    case 'AI_STREAM_STALL': return 'timeout';
    case 'AI_EMPTY_RESPONSE': return 'empty_response';
  }
  if (e.name === 'AbortError') return 'timeout';

  const type = providerType(e);
  const code = e.providerErrorCode;
  if ((code && CONTEXT_LENGTH_MARKERS.has(code)) || (type && CONTEXT_LENGTH_MARKERS.has(type))) return 'context_length';
  if (type && CONTENT_FILTER_MARKERS.has(type)) return 'content_filter';
  if (type && OVERLOADED_MARKERS.has(type)) return 'overloaded';

  const status = e.status ?? e.statusCode;
  if (status === 429) return 'rate_limit';
  if (status === 401 || status === 403) return 'auth';
  if (status === 529) return 'overloaded';
  if (typeof status === 'number') {
    if (status >= 500) return 'server_error';
    if (status >= 400) return 'invalid_request';
  }

  if (typeof e.message === 'string' && /timeout|abort|socket|ECONN|ETIMEDOUT|fetch failed|network|ENOTFOUND|EAI_AGAIN/i.test(e.message)) {
    return 'network';
  }
  return 'unknown';
}
