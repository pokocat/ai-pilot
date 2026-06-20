import 'dotenv/config';

// 占位/假 key 识别：fake 一个 token 时，不浪费网络往返，直接走 mock 兜底。
export function isRealKey(k: string): boolean {
  return !!k && !/fake|replace|your[-_]?key|xxxx|0{6,}|^sk-\.{3,}$/i.test(k.trim());
}

export const env = {
  port: Number(process.env.PORT ?? 4000),
  aiProvider: (process.env.AI_PROVIDER ?? 'mock') as 'mock' | 'claude' | 'openai',

  // Claude（Anthropic）
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  claudeModel: process.env.CLAUDE_MODEL ?? 'claude-sonnet-4-6',

  // OpenAI 通用协议（兼容 DeepSeek / Moonshot / 通义千问兼容模式 等）
  openaiApiKey: process.env.OPENAI_API_KEY ?? '',
  openaiBaseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
  openaiModel: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
  openaiTimeoutMs: Number(process.env.OPENAI_TIMEOUT_MS ?? 20000),
  // 真实 provider 调用失败时是否静默兜底 mock。生产必须为 false：宁可报错，也不返回答非所问的模板。
  // §8.0 生产禁止静默降级：默认 false；联调/演示时显式设 AI_FALLBACK_MOCK=true。
  aiFallbackMock: (process.env.AI_FALLBACK_MOCK ?? 'false') === 'true',

  // 嵌入模型（知识库/语义记忆）。留空=用本地确定性嵌入（零依赖、离线）；
  // 开启后 + 真实 key，走 /embeddings 真实向量（生产建议配合 pgvector）。
  // baseUrl/key 留空则复用对话模型的 openaiBaseUrl/key。EMBEDDING_ENABLED 缺省时：配了模型即视为开（兼容旧行为）。
  embeddingModel: process.env.EMBEDDING_MODEL ?? '',
  embeddingEnabled: (process.env.EMBEDDING_ENABLED ?? (process.env.EMBEDDING_MODEL ? 'true' : 'false')) === 'true',
  embeddingBaseUrl: process.env.EMBEDDING_BASE_URL ?? '',
  embeddingApiKey: process.env.EMBEDDING_API_KEY ?? '',

  // 重排（rerank）：开启后在 hybridSearch 融合打分之后调 rerank API 重排候选。baseUrl/key 留空回退对话模型。
  rerankEnabled: (process.env.RERANK_ENABLED ?? 'false') === 'true',
  rerankModel: process.env.RERANK_MODEL ?? '',
  rerankBaseUrl: process.env.RERANK_BASE_URL ?? '',
  rerankApiKey: process.env.RERANK_API_KEY ?? '',

  moderationEnabled: (process.env.MODERATION_ENABLED ?? 'true') === 'true',

  // LLM 调用诊断 trace 是否落库 prompt/输出原文（便于排查，含 PII/敏感内容）。默认关，仅记指标。
  llmTraceCaptureText: (process.env.LLM_TRACE_CAPTURE_TEXT ?? 'false') === 'true',

  // 自定义技能（HTTP 工具）：单次调用超时；是否允许指向私网/环回（调内网自有服务时才开，默认拒，防 SSRF）。
  skillToolTimeoutMs: Number(process.env.SKILL_TOOL_TIMEOUT_MS ?? 15000),
  skillToolAllowPrivateNet: (process.env.SKILL_TOOL_ALLOW_PRIVATE_NET ?? 'false') === 'true',

  // 可分享报告页的对外基址（拼分享链接：{publicBaseUrl}/api/r/<id>）。生产配成用户可访问的域名。
  publicBaseUrl: (process.env.PUBLIC_BASE_URL ?? 'https://wxapi.aibuzz.cn').replace(/\/+$/, ''),

  // 知识/记忆向量近邻检索：默认关闭走内存余弦（零依赖）；
  // 置 true 且已执行 prisma/pgvector.sql（建 vector 列 + HNSW）后，走 pgvector 的 <=> 下推。
  pgvectorEnabled: (process.env.PGVECTOR_ENABLED ?? 'false') === 'true',

  // —— 短信验证码登录 ——
  // provider=console：开发/演示，只打日志不发真短信，验证码随响应回传（便于联调）。
  //          aliyun：阿里云短信，需补全下方 ALIYUN_SMS_* 配置。
  smsProvider: (process.env.SMS_PROVIDER ?? 'console') as 'console' | 'aliyun',
  smsRequireCode: (process.env.SMS_REQUIRE_CODE ?? 'false') === 'true', // 生产置 true：/auth/login 强制校验验证码
  smsReturnCode: (process.env.SMS_RETURN_CODE ?? 'false') === 'true',   // 强制把验证码随响应返回（默认仅 console+非生产时返回）
  smsCodeTtlSec: Number(process.env.SMS_CODE_TTL_SEC ?? 300),           // 验证码有效期
  smsResendCooldownSec: Number(process.env.SMS_RESEND_COOLDOWN_SEC ?? 60), // 同号两次发送最小间隔
  smsMaxPerHour: Number(process.env.SMS_MAX_PER_HOUR ?? 5),             // 同号每小时上限
  smsMaxAttempts: Number(process.env.SMS_MAX_ATTEMPTS ?? 5),            // 同一验证码最多校验次数
  // 阿里云短信（SMS_PROVIDER=aliyun 时必填）
  aliyunSmsKeyId: process.env.ALIYUN_SMS_ACCESS_KEY_ID ?? '',
  aliyunSmsKeySecret: process.env.ALIYUN_SMS_ACCESS_KEY_SECRET ?? '',
  aliyunSmsSignName: process.env.ALIYUN_SMS_SIGN_NAME ?? '',
  aliyunSmsTemplateCode: process.env.ALIYUN_SMS_TEMPLATE_CODE ?? '',
  aliyunSmsRegion: process.env.ALIYUN_SMS_REGION ?? 'cn-hangzhou',

  // —— 阿里云 OSS：报告网页版静态托管（不暴露后端域名）——
  // 全部配齐才启用；否则 publishReport 回退后端 /api/r/:id。上传走 endpoint（内网更快/免流量），
  // 分享链接用 baseUrl（公网）。对象以 public-read 上传。
  ossEndpoint: process.env.AEP_CDN_OSS_ENDPOINT ?? '',          // 如 oss-cn-hangzhou-internal.aliyuncs.com（内网）
  ossRegion: process.env.AEP_CDN_OSS_REGION ?? 'cn-hangzhou',   // 如 cn-hangzhou（endpoint 缺省时用）
  ossBucket: process.env.AEP_CDN_OSS_BUCKET ?? '',
  ossAccessKeyId: process.env.AEP_CDN_OSS_ACCESS_KEY_ID ?? '',
  ossAccessKeySecret: process.env.AEP_CDN_OSS_ACCESS_KEY_SECRET ?? '',
  ossBaseUrl: (process.env.AEP_CDN_OSS_BASE_URL ?? '').replace(/\/+$/, ''), // 如 https://aiartist.oss-cn-hangzhou.aliyuncs.com
  ossKeyPrefix: (process.env.AEP_CDN_OSS_KEY_PREFIX ?? '').replace(/^\/+|\/+$/g, ''), // 如 junshi
  ossTimeoutMs: Number(process.env.AEP_CDN_OSS_TIMEOUT_MS ?? 10000),
};
