import dotenv from 'dotenv';

// —— 环境变量装载（业务侧唯一入口；注意进程里还有 @prisma/client 会自行读 .env，见下）——
// 测试运行（NODE_ENV=test，由 `npm test` 的 `node --env-file=.env.test` 在进程启动时注入）
// 一律**不**加载 `server/.env`：dotenv 虽然不覆盖已存在的 process.env，但 `.env` 里那些
// 「`.env.test` 没声明」的键仍会被注入，于是开发机的真实配置（微信订阅模板 ID、OSS、短信…）
// 渗进测试环境——同一份用例在「有 .env 的开发机」红、在「没有 .env 的 CI」绿，测试结果取决于
// 谁的机器。历史坑（2026-07-27 修）：`wechatMessage`「订阅消息 accept 后累计一次额度」与
// `reminders`「三条提醒节奏」两例因 `.env` 里的 WECHAT_SUBSCRIBE_*_TEMPLATE_ID 长期本地失败。
// 故测试环境必须自足：需要什么变量就写进 `.env.test`，或在用例里显式 set/delete，
// 绝不隐式依赖开发机配置——这样以后往 `.env` 里加任何新键都不会再弄红测试。
//
// ⚠️ 只关掉这里**不够**：`@prisma/client` 也会在 import 与每次 `new PrismaClient()` 时无条件读
// `server/.env`（无 opt-out 开关），那条路径由 `test/hermeticEnv.mjs` + `src/db.ts` 的抹除钩子兜住。
// 三层机制与守卫用例见 `test/hermeticEnv.mjs` 顶部注释与 `test/envHermetic.test.ts`。
const loadDotenv = process.env.NODE_ENV !== 'test';
if (loadDotenv) dotenv.config();

/** 本进程是否加载过 `server/.env`。测试环境恒为 false（见上方注释：测试环境必须自足）。 */
export const dotenvLoaded = loadDotenv;

// 占位/假 key 识别：fake 一个 token 时，不浪费网络往返，直接走 mock 兜底。
export function isRealKey(k: string): boolean {
  return !!k && !/fake|replace|your[-_]?key|xxxx|0{6,}|^sk-\.{3,}$/i.test(k.trim());
}

// 测试运行（NODE_ENV=test）：LLM 一律不触达真实 provider（claude/openai/dify），
// 产出走确定性 mock。与短信 isSmsTestMode 同源——测试绝不调用付费/限流外部 API，
// 避免被 DB 里残留的真实接入配置（如 general 的 dify 绑定）拖累成偶发 429/超时。
// 例外：gatewayProvider.test.ts 用 AI_ALLOW_REAL_PROVIDER=1 显式放行真实 provider 代码路径，
// 以便配合 globalThis.fetch stub 测「429/500/超时 → 兜底/503 映射」——放行的是代码路径，不是网络（fetch 被打桩）。
export function isAiTestMode(): boolean {
  if (process.env.AI_ALLOW_REAL_PROVIDER === '1') return false;
  return process.env.NODE_ENV === 'test';
}

/** 测试期可指定新注册用户默认套餐；运行时读取，便于测试隔离与关闭后即时恢复默认体验版。 */
export function registrationDefaultPlanName(): string {
  return (process.env.TEST_DEFAULT_PLAN_NAME ?? '').trim();
}

/**
 * 读数值型环境变量。**任何数值 env 都必须走这里，不要写 `Number(process.env.X ?? 默认值)`。**
 *
 * `??` 只挡 `undefined`，挡不住空串；而 `.env` 与 docker-compose 里「设了但留空」极常见
 * （`RATE_LIMIT_MAX=`、`MAX_IN_FLIGHT: ""`）。`Number('')` 是 **0** 而不是 NaN，于是空串会被
 * 当成「显式配了 0」，默认值形同虚设。这个坑已经咬过三次：
 *   · `services/llmGate.ts` 的并发上限被算成 1，把上游吞吐锁死（已修，见该文件 num()）；
 *   · `app.ts` 的 `MAX_IN_FLIGHT` 空串 → 0 → 过载闸被 `if (maxInFlight > 0)` 判掉，**保护静默关闭**；
 *   · `app.ts` 的 `RATE_LIMIT_MAX` 空串 → `max: 0` → **每个请求都 429**，等于全站宕机。
 *
 * 语义：未设置 / 空串 / 非有限数 / 负数 → 返回默认值；显式写 `0` 才真的是 0。
 * 需要「0 有特殊含义（如关闭开关）」时，调用方自己判 raw 是否为 '0'，不要靠本函数区分。
 */
export function envNum(name: string, dflt: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

export const env = {
  port: envNum('PORT', 4000),
  aiProvider: (process.env.AI_PROVIDER ?? 'mock') as 'mock' | 'claude' | 'openai',

  // Claude（Anthropic）
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  claudeModel: process.env.CLAUDE_MODEL ?? 'claude-sonnet-4-6',

  // OpenAI 通用协议（兼容 DeepSeek / Moonshot / 通义千问兼容模式 等）
  openaiApiKey: process.env.OPENAI_API_KEY ?? '',
  openaiBaseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
  openaiModel: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
  openaiTimeoutMs: envNum('OPENAI_TIMEOUT_MS', 20000),
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
  skillToolTimeoutMs: envNum('SKILL_TOOL_TIMEOUT_MS', 15000),
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
  smsCodeTtlSec: envNum('SMS_CODE_TTL_SEC', 300),           // 验证码有效期
  smsResendCooldownSec: envNum('SMS_RESEND_COOLDOWN_SEC', 60), // 同号两次发送最小间隔
  smsMaxPerHour: envNum('SMS_MAX_PER_HOUR', 5),             // 同号每小时上限
  smsMaxAttempts: envNum('SMS_MAX_ATTEMPTS', 5),            // 同一验证码最多校验次数
  // 阿里云短信（SMS_PROVIDER=aliyun 时必填）
  aliyunSmsKeyId: process.env.ALIYUN_SMS_ACCESS_KEY_ID ?? '',
  aliyunSmsKeySecret: process.env.ALIYUN_SMS_ACCESS_KEY_SECRET ?? '',
  aliyunSmsSignName: process.env.ALIYUN_SMS_SIGN_NAME ?? '',
  aliyunSmsTemplateCode: process.env.ALIYUN_SMS_TEMPLATE_CODE ?? '',
  aliyunSmsRegion: process.env.ALIYUN_SMS_REGION ?? 'cn-hangzhou',

  // —— 阿里云 OSS：报告网页版 CDN 镜像 ——
  // 全部配齐才启用；报告 htmlUrl 仍返回自有域名 /api/r/:id 供小程序 web-view 打开。
  // 上传走 endpoint（内网更快/免流量），cdnUrl 用 baseUrl（公网）。对象以 public-read 上传。
  ossEndpoint: process.env.AEP_CDN_OSS_ENDPOINT ?? '',          // 如 oss-cn-hangzhou-internal.aliyuncs.com（内网）
  ossRegion: process.env.AEP_CDN_OSS_REGION ?? 'cn-hangzhou',   // 如 cn-hangzhou（endpoint 缺省时用）
  ossBucket: process.env.AEP_CDN_OSS_BUCKET ?? '',
  ossAccessKeyId: process.env.AEP_CDN_OSS_ACCESS_KEY_ID ?? '',
  ossAccessKeySecret: process.env.AEP_CDN_OSS_ACCESS_KEY_SECRET ?? '',
  ossBaseUrl: (process.env.AEP_CDN_OSS_BASE_URL ?? '').replace(/\/+$/, ''), // 如 https://aiartist.oss-cn-hangzhou.aliyuncs.com
  ossKeyPrefix: (process.env.AEP_CDN_OSS_KEY_PREFIX ?? '').replace(/^\/+|\/+$/g, ''), // 如 junshi
  ossTimeoutMs: envNum('AEP_CDN_OSS_TIMEOUT_MS', 10000),

  // —— 海报成品图（canvas_design 产物型技能）——
  // 刻意**一个环境变量都没有**（2026-07-29 删掉了 CANVAS_DESIGN_ENABLED / _ENGINE /
  // _MAX_CONCURRENCY / _TIMEOUT_MS 四个）。全部收在后台 FeatureFlag 行 'creative-poster'，
  // 单一真源见 services/creative/config.ts。删除理由（别再加回来）：
  //   · ENABLED 与 DB 开关是合取 → 运营在后台打开却不生效，是静默失败；作熔断也比后台点一下慢
  //     （要 SSH + 改 env + 重启）。上面 embedding/rerank/moderation/pgvector 那批 env 开关回答的是
  //     「外部依赖是否存在」，而 puppeteer/OSS 是既有功能的硬依赖、字体已在镜像里，不属于那一类。
  //   · ENGINE 全仓没有一处 `engine ===` 分支，anthropic_skill 也无实现 → 一个会撒谎的旋钮。
  //   · MAX_CONCURRENCY / TIMEOUT_MS 只作 payload 缺省值，而后台保存是全量重写 payload
  //     → 运营点过一次保存后，改 env 重启永久无效果（双真源）。
};
