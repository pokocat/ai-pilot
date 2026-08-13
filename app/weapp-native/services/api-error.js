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
  // 快出片 · 数字人引擎（石榴）的供应商侧错误。这些不是用户操作错误，也不是我们服务故障，
  // 说成「军师服务暂不可用」会把运营该处理的事（充值/换密钥）伪装成系统故障。
  // 实测：石榴的「账户权益不足」其实是可保存数量占满，不是余额不够。按真因给文案，
  // 否则用户/运营会去充值，钱花了问题还在。
  CLIP_ENGINE_CAPACITY_FULL: '数字人形象或声音的保存数量已满，删掉不用的再创建。',
  CLIP_ENGINE_BALANCE_INSUFFICIENT: '数字人服务的额度用完了，请联系运营处理。',
  CLIP_ENGINE_CREDENTIAL_INVALID: '数字人服务鉴权失效了，请联系运营处理。',
  CLIP_ENGINE_NOT_CONFIGURED: '数字人服务还没配置好，请联系运营。',
  CLIP_ENGINE_CALL_FAILED: '数字人服务没有受理这次任务，请稍后重试或联系运营。',
  CLIP_ENGINE_AUDIO_TOO_SHORT: '录音太短了，完整念一遍采集文案再提交。',
  CLIP_ENGINE_AUDIO_UNREADABLE: '这段录音读不出来，请重新录一段。',
  CLIP_ENGINE_SPEECH_UNCLEAR: '没听清人声，换个安静的地方重录一段。',
  CLIP_ENGINE_VOICE_REJECTED: '这段声音没通过声纹安全检查，请确认是本人录制。',
  CLIP_ENGINE_VIDEO_UNREADABLE: '这段视频读不出来，请重新录一段。',
  CLIP_ENGINE_SPEAKER_NOT_FOUND: '声音模型不存在了，请重新采集声音。',
  // 「这个形象用谁的声音」必须由用户决定 —— 曾经服务端会静默挑一条最近的，
  // 结果成片里男声女声错位而用户毫不知情。现在宁可拦住也不猜。
  CLIP_VOICE_NOT_SELECTED: '这个数字人还没有关联声音，先去分身管理里选一个或采集一个。',
  CLIP_UPSTREAM_TIMEOUT: '视频服务响应超时，请稍后重试。',
  CLIP_UPSTREAM_UNAVAILABLE: '视频服务暂时连不上，请稍后重试。',
  CLIP_MEDIA_MODERATION_NOT_CONFIGURED: '素材审核能力还没配置好，请联系运营。',
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
  // \u4e0a\u9762\u90a3\u6761\u7528\u4e86 \b \u8bcd\u8fb9\u754c\uff0c\u6321\u4e0d\u4f4f\u9a7c\u5cf0\u6807\u8bc6\u7b26\uff1a`PrismaClientKnownRequestError` \u91cc
  // `Prisma` \u540e\u9762\u7d27\u8ddf `C`\uff0c\u4e24\u8fb9\u90fd\u662f\u8bcd\u5b57\u7b26\uff0c\u6ca1\u6709\u8fb9\u754c\uff0c\u4e8e\u662f\u6574\u6761\u5f02\u5e38\u540d\u88ab\u5f53\u6210"\u53ef\u8bfb\u4e2d\u6587\u539f\u56e0"
  // \u6f0f\u7ed9\u7528\u6237\u3002\u9a7c\u5cf0\u9a7c\u5cf0\uff08\u5c0f\u5199\u7d27\u8ddf\u5927\u5199\uff09\u662f\u6807\u8bc6\u7b26\u7684\u7279\u5f81\uff0c\u6b63\u5e38\u6587\u6848\u4e0d\u4f1a\u6709\uff1b
  // \u800c WAV / MP3 / AAC / H.264 \u8fd9\u7c7b\u5168\u5927\u5199\u7f29\u5199\u4e0d\u542b\u9a7c\u5cf0\uff0c\u4e0d\u4f1a\u8bef\u4f24\u3002
  if (/[a-z][A-Z]/.test(message)) return '';
  return message;
}

function httpErrorInfo(statusCode, data, noun) {
  const body = data && typeof data === 'object' ? data : {};
  const code = body.code;
  const technical = body.error || `HTTP ${statusCode}`;
  if (statusCode === 408 || statusCode === 504) return { message: '军师响应超时了，请稍后重试。', code, technicalMessage: technical };
  if (statusCode === 429) return { message: '请求有点频繁，请稍后再试。', code, technicalMessage: technical };
  if (statusCode >= 500) {
    // 5xx 默认不外露服务端原文（多半是堆栈/内部细节），但**服务端特意给了业务 code
    // 或可读中文原因时，那就是写给用户看的**，不该丢。
    //
    // 起因：石榴余额耗尽时 AIStar 回 502 + code=CLIP_ENGINE_CALL_FAILED +
    // 「石榴 AI 未受理任务：账户权益不足，无法进行声音克隆」，BFF 一路透传到端上，
    // 却在这里被压成「军师服务暂时不可用」—— 用户以为是我们系统坏了，排查得上服务器翻日志。
    // readableBusinessMessage 已经挡掉了含 Error/Exception/Prisma/SQL/stack 的文本
    // 并要求必须有中文，所以拿它兜底不会把内部细节漏出去。
    // technicalMessage 只进日志/排查，不显示给用户，所以 5xx 一律保留 —— 别为了"文案更好看"
    // 把排查线索也一起丢了。
    const explained = USER_MESSAGES[code] || readableBusinessMessage(body.error);
    return { message: explained || '军师服务暂时不可用，请稍后重试。', code, technicalMessage: technical };
  }
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
