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
  // 真实 provider 调用失败时是否静默兜底 mock。生产应设 false：宁可报错重试，也不返回答非所问的模板。
  aiFallbackMock: (process.env.AI_FALLBACK_MOCK ?? 'true') === 'true',

  // 嵌入模型（知识库/语义记忆）。留空=用本地确定性嵌入（零依赖、离线）；
  // 配置后 + openai 兼容真实 key，走 /embeddings 真实向量（生产建议配合 pgvector）。
  embeddingModel: process.env.EMBEDDING_MODEL ?? '',

  moderationEnabled: (process.env.MODERATION_ENABLED ?? 'true') === 'true',

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
};
