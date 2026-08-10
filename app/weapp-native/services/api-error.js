const USER_MESSAGES = {
  PLAN_REQUIRED: '尚未开通方案，开通后即可使用。',
  NO_PLAN: '尚未开通方案，开通后即可使用。',
  PLAN_EXPIRED: '当前方案已到期，续费后即可继续使用。',
  INSUFFICIENT_QUOTA: '本月方案用量已用完，可查看恢复时间或更换方案。',
  KNOWLEDGE_QUOTA: '当前方案的知识库容量已用完，可查看或调整方案。',
  INSUFFICIENT_CREDITS: '当前算力不足，可先查看算力明细。',
  PAYMENT_REQUIRED: '这项操作需要有效方案，请先查看方案与权益。',
  AGENT_LOCKED: '这位军师尚未启用，请先到锦囊中查看。',
  AGENT_NOT_FOUND: '这位军师暂时不可用，请换一位再试。',
  SKU_REQUIRED: '这项专项能力尚未启用。',
  FEATURE_DISABLED: '这项能力暂未开放。',
  MODERATION_BLOCK: '这条内容暂时无法处理，请调整后重新发送。',
  IMAGE_MODERATION_BLOCKED: '这张图片暂时无法处理，请更换后重试。',
  RATE_LIMITED: '操作有点频繁，请稍后再试。',
  FORCES_RATE_LIMIT: '今天的刷新次数已用完，请稍后再试。',
  ORDER_RATE_LIMITED: '订单创建有点频繁，请稍后再试。',
  FILE_REQUIRED: '请先选择要上传的文件。',
  IMAGE_TOO_LARGE: '图片太大，请压缩后重新上传。',
  IMAGE_BAD_TYPE: '暂不支持这种图片格式，请更换后上传。',
  AVATAR_BAD_TYPE: '暂不支持这种头像格式，请更换后上传。',
  NOT_ANALYZABLE: '这份资料暂时无法分析，请检查内容或更换文件。',
  CONSENT_REQUIRED: '请先完成必要的确认后再继续。',
  PHONE_TAKEN: '这个手机号已绑定其他账号，请更换或联系客服。',
  SMS_CODE_REQUIRED: '请输入短信验证码。',
  SMS_CODE_INVALID: '验证码不正确或已失效，请重新获取。',
  SESSION_NOT_FOUND: '这段对话已不存在，请返回后重新进入。',
  GENERATION_NOT_FOUND: '这次回答已失效，请重新发起。',
  GENERATION_IN_PROGRESS: '这段对话已有回答正在生成，请稍候。',
  CLIENT_REQUEST_ID_REQUIRED: '请求信息已失效，请重新发起。',
  IDEMPOTENCY_CONFLICT: '本次操作内容已变化，请重新确认。',
  PROJECT_SLUG_CONFLICT: '已存在同名案卷，请换个名称。',
  QUOTE_CHANGED: '方案价格或权益状态已变化，请重新确认。',
  ORDER_CREATING: '订单正在创建，请稍后刷新。',
  PENDING_ORDER_UNRESOLVED: '上一笔订单状态正在确认，请稍后再试。',
  ORDER_NOT_PAYABLE: '订单已过支付时限，请重新下单。',
  ORDER_EXPIRED: '订单已过支付时限，请重新下单。',
  PAYMENT_NOT_CONFIGURED: '支付暂未开放。',
  PAYMENT_COMING_SOON: '支付即将开放。',
  PAPAY_NOT_CONFIGURED: '自动续费暂未开放，可选择单次购买。',
  PLAN_AUTO_RENEW_UNAVAILABLE: '该方案暂不支持自动续费，可选择单次购买。',
  AI_BUSY: '军师当前比较忙，请稍后重试。',
  AI_UNAVAILABLE: '军师服务暂时不可用，请稍后重试。',
  AI_EMPTY_RESPONSE: '军师这次没有生成有效内容，请重新尝试。',
  AI_CONFIG_INVALID: '军师服务配置异常，请稍后再试。',
  OSS_NOT_CONFIGURED: '文件服务暂未就绪，请稍后再试。',
  AVATAR_UPLOAD_FAILED: '头像上传没有完成，请稍后重试。',
  REPORT_RENDER_FAILED: '方案文件生成没有完成，请稍后重试。',
  PDF_UNAVAILABLE: 'PDF 暂时无法生成，请稍后重试。',
  POSTER_RENDER_FAILED: '图片生成没有完成，请稍后重试。',
  INTERNAL: '军师服务暂时不可用，请稍后重试。',
  FAIL: '军师服务暂时不可用，请稍后重试。',
  CANCELLED: '请求已取消。',
};

const PLAN_CODES = new Set(['PLAN_REQUIRED', 'NO_PLAN', 'PLAN_EXPIRED', 'INSUFFICIENT_QUOTA', 'KNOWLEDGE_QUOTA', 'PAYMENT_REQUIRED']);
const CREDIT_CODES = new Set(['INSUFFICIENT_CREDITS']);
const MODERATION_CODES = new Set(['MODERATION_BLOCK', 'IMAGE_MODERATION_BLOCKED']);
const RATE_CODES = new Set(['RATE_LIMITED', 'FORCES_RATE_LIMIT', 'ORDER_RATE_LIMITED']);
const RETRYABLE_CODES = new Set([
  'AI_BUSY', 'AI_UNAVAILABLE', 'AI_EMPTY_RESPONSE', 'AVATAR_UPLOAD_FAILED',
  'REPORT_RENDER_FAILED', 'PDF_UNAVAILABLE', 'POSTER_RENDER_FAILED',
]);
const CONFLICT_CODES = new Set([
  'GENERATION_IN_PROGRESS', 'GENERATION_NOT_FOUND', 'IDEMPOTENCY_CONFLICT',
  'PROJECT_SLUG_CONFLICT', 'QUOTE_CHANGED', 'ORDER_CREATING', 'PENDING_ORDER_UNRESOLVED',
  'ORDER_NOT_PAYABLE', 'ORDER_EXPIRED', 'JOB_NOT_RETRIABLE',
]);
const NOT_FOUND_RE = /(?:^|_)(?:NOT_FOUND|NOT_EXIST|NOT_EXISTS)$/;
const VALIDATION_RE = /^(?:BAD_|EMPTY_|PARAM_|TEXT_REQUIRED|TITLE_REQUIRED|FILE_REQUIRED|CLIENT_REQUEST_ID_REQUIRED|CONSENT_REQUIRED|IMAGE_TOO_LARGE|IMAGE_BAD_TYPE|AVATAR_BAD_TYPE|NOT_ANALYZABLE)/;

function errorCode(error) {
  return String((error && (error.code || (error.data && error.data.code))) || '');
}

function errorStatus(error) {
  const value = Number(error && (error.statusCode || error.status));
  return Number.isFinite(value) ? value : 0;
}

function rawMessage(error) {
  if (typeof error === 'string') return error.trim();
  return String((error && error.message) || '').trim();
}

function readableBusinessMessage(message) {
  if (!message || !/[\u3400-\u9fff]/.test(message)) return '';
  if (/\b(?:Error|Exception|Prisma|Fastify|SQL|stack|undefined|null)\b/i.test(message)) return '';
  return message;
}

function httpErrorInfo(statusCode, data, noun) {
  const body = data && typeof data === 'object' ? data : {};
  const code = body.code;
  const technical = body.error || `HTTP ${statusCode}`;
  if (statusCode === 408 || statusCode === 504) return { message: '军师响应超时了，请稍后重试。', code, technicalMessage: technical };
  if (statusCode === 429) return { message: '请求有点频繁，请稍后再试。', code, technicalMessage: technical };
  if (statusCode >= 500) return { message: '军师服务暂时不可用，请稍后重试。', code, technicalMessage: technical };
  const fallback = `${noun || '请求'}未能完成，请检查后再试。`;
  return { message: USER_MESSAGES[code] || readableBusinessMessage(body.error) || fallback, code, technicalMessage: readableBusinessMessage(body.error) ? undefined : technical };
}

/**
 * 所有 C 端错误的语义入口。页面只提供本动作的 fallback，不再自行猜 HTTP 状态或重试性。
 * 未识别的 4xx 优先保留服务端中文业务原因；技术原文只留在 technicalMessage。
 */
function apiErrorPresentation(error, fallback) {
  const code = errorCode(error);
  const status = errorStatus(error);
  const raw = rawMessage(error);
  const message = USER_MESSAGES[code]
    || readableBusinessMessage(raw)
    || fallback
    || (status >= 500 ? '军师服务暂时不可用，请稍后重试。' : '操作没有完成，请稍后再试。');

  if (code === 'UNAUTHORIZED') return { kind: 'unauthorized', message: '请先登录后再继续。', retryable: false, action: 'login' };
  if (code === 'NETWORK_ERROR') return { kind: 'network', message, retryable: true, action: '' };
  if (code === 'CANCELLED') return { kind: 'cancelled', message, retryable: false, action: '' };
  if (PLAN_CODES.has(code) || status === 402) return { kind: code === 'PLAN_EXPIRED' ? 'plan_expired' : code === 'INSUFFICIENT_QUOTA' || code === 'KNOWLEDGE_QUOTA' ? 'quota' : 'plan_required', message, retryable: false, action: 'plans' };
  if (CREDIT_CODES.has(code)) return { kind: 'credits', message, retryable: false, action: 'credits' };
  if (MODERATION_CODES.has(code)) return { kind: 'moderation', message, retryable: false, action: 'edit' };
  if (RATE_CODES.has(code) || status === 429) return { kind: 'rate_limited', message, retryable: false, action: 'retry_later' };
  if (CONFLICT_CODES.has(code) || status === 409) return { kind: 'conflict', message, retryable: false, action: 'refresh' };
  if (NOT_FOUND_RE.test(code) || status === 404) return { kind: 'not_found', message, retryable: false, action: 'refresh' };
  if (VALIDATION_RE.test(code) || [400, 413, 415, 422].includes(status)) return { kind: 'validation', message, retryable: false, action: 'edit' };
  if (RETRYABLE_CODES.has(code) || status === 408 || status >= 500) return { kind: 'unavailable', message, retryable: true, action: '' };
  if (code === 'AGENT_LOCKED' || code === 'SKU_REQUIRED' || code === 'FEATURE_DISABLED' || code === 'AI_CONFIG_INVALID') return { kind: 'blocked', message, retryable: false, action: '' };
  return { kind: 'other', message, retryable: status === 0, action: '' };
}

module.exports = { apiErrorPresentation, errorCode, errorStatus, httpErrorInfo };
