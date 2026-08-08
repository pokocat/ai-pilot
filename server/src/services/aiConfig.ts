// 大模型配置（运营后台可随时切换）。
// 解析优先级：数据库 AiSetting（单例）> 环境变量兜底。带短缓存，避免每次调用查库。
// 未配置真实 key 时 effectiveProvider 自动降级 mock，保证演示永远可跑。
//
// 存储：AiSetting / AiModel 的对话、Embedding、Rerank API Key 明文存库；读取兼容历史 enc:v1 密文，
//       部署脚本会做一次性明文化迁移。对外一律只回传 hasKey，不出明文。

import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { env, isRealKey } from '../env.js';
import type { ModelRate } from '../data/modelPrices.js';
import { aiCredentialReadFailed, plainAiCredential, readAiCredential, storeAiCredential } from './aiCredentialStorage.js';
import type { AiProvider, AiThinkingMode, AiConfig, AiConfigUpdate, AiPreset, AiModel, AiModelUpsert, AiModelTest } from '../llm/schema.js';
import {
  DEFAULT_THINKING_MODE,
  dialectOf,
  normalizeThinkingBudget,
  normalizeThinkingMode,
} from '../llm/thinking.js';
import { readCaps } from '../llm/configSchemas.js';
import { configForPurpose, syncV2FromLegacy, v2Enabled } from './aiRoutes.js';

export interface ResolvedAiConfig {
  provider: AiProvider;
  label: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  embeddingModel: string;
  temperature: number;
  thinkingMode: AiThinkingMode;
  thinkingBudget: number;
  // 协议方言（llm/dialects.ts）。显式值＝已固化，留空＝走 inferDialect 兜底。
  // 必须一路带到 provider 的请求组装处：关闭思考该省略还是显式发、能不能带 budget_tokens，
  // 全看它——端点池里每个端点可以是不同方言，不能用全局配置的方言去组装别的端点的请求。
  dialect?: string | null;
  /** 探活回填的能力标记（EndpointCaps）。thinking='no' 时一律不发 thinking 字段。 */
  capsJson?: unknown;
  timeoutMs: number;
  // 向量嵌入接入（独立开关 + 可选凭证；baseUrl/key 留空回退对话模型）。
  embeddingEnabled: boolean;
  embeddingBaseUrl: string;
  embeddingApiKey: string;
  // 重排接入。
  rerankEnabled: boolean;
  rerankModel: string;
  rerankBaseUrl: string;
  rerankApiKey: string;
  // 滚动迁移期若库内仍是历史密文但解不开 → 这是**配置故障**，不是「未配置」。
  // 迁移完成后明文凭证不再依赖 APP_ENCRYPTION_KEY，此标记应恒为 false。
  keyDecryptFailed?: boolean;
  // 并发闸车道（services/llmGate）。仅当本配置是「独立账号的辅助档」时才为 'aux'，
  // 表示它有自己的上游配额、不该和主对话抢槽位。未配辅助档时恒为 undefined（= main）。
  lane?: 'main' | 'aux';
  // 端点池选中的 AiModel.id（services/llmPool）。未启用池时为 undefined。
  // 有值时闸门按「每端点」独立计并发与冷却，一个端点被限流不连累其它端点。
  endpointId?: string;
  // 仅供 LlmTrace 归因，不参与并发车道/路由。single 模式下记录 activeModelId；
  // pool 模式下 services/llmPool 会用本次候选覆盖成实际命中的端点。
  traceEndpointId?: string;
  traceEndpointLabel?: string;
  // 辅助抽取等已显式选择独立模型/账号的调用不得再被主端点池覆盖。
  poolBypass?: boolean;
}

// 内置接入商目录：「添加模型」向导选其一即可一键填好 baseUrl/model（仍可改）。
//
// **一个厂商可能要占两条预设**：同一家的 OpenAI 协议与 Anthropic 协议是**两个不同的 baseUrl**
// （七牛 `…/v1` vs 根路径、DeepSeek `/v1` vs `/anthropic`、火山 `/api/v3` vs `/api/coding`），
// 选错入口就是上线后 404/400。协议不是「模型名的属性」，必须在选接入商这一步就定下来。
//
// model 只在**已实测可用**时才预填；没验证过的一律留空并把查法写进 note——
// 预填一个不存在的模型名，失败时看起来像我们的 bug，比留空更糟。
export const AI_PRESETS: AiPreset[] = [
  // —— 七牛（生产在用）——
  {
    id: 'qiniu-anthropic', label: '七牛云 · Anthropic 协议', provider: 'claude',
    baseUrl: 'https://api.qnaigc.com', model: 'claude-opus-4-6',
    note: 'Anthropic /v1/messages。关闭 Thinking 时发 {type:"disabled"} 且**不得带 budget_tokens**（带了返回 400）',
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
    note: 'Claude 模型名会被映射到 deepseek-v4-*（opus→pro，sonnet/haiku→flash）；**thinking 接受但 budget_tokens 被忽略**',
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

// env 兜底（DB 无行 / 不可达时）：沿用原 env 行为。
function fromEnv(): ResolvedAiConfig {
  const provider = env.aiProvider;
  const apiKey = provider === 'claude' ? env.anthropicApiKey : provider === 'openai' ? env.openaiApiKey : '';
  const model = provider === 'claude' ? env.claudeModel : provider === 'openai' ? env.openaiModel : 'template';
  return {
    provider,
    label: provider === 'claude' ? 'Claude' : provider === 'openai' ? 'OpenAI 兼容' : '本地模板',
    baseUrl: env.openaiBaseUrl,
    model,
    apiKey,
    embeddingModel: env.embeddingModel,
    temperature: 0.7,
    thinkingMode: DEFAULT_THINKING_MODE,
    thinkingBudget: 1024,
    timeoutMs: env.openaiTimeoutMs,
    embeddingEnabled: env.embeddingEnabled,
    embeddingBaseUrl: env.embeddingBaseUrl,
    embeddingApiKey: env.embeddingApiKey,
    rerankEnabled: env.rerankEnabled,
    rerankModel: env.rerankModel,
    rerankBaseUrl: env.rerankBaseUrl,
    rerankApiKey: env.rerankApiKey,
  };
}

// P2-6：进程内短缓存 + 写时失效（所有 config/model/rate 写路径均清缓存：updateAiConfig / syncActiveSetting
// /addModel/updateModel/deleteModel）→ 单实例配置变更即时生效。多实例部署下其它实例最多 TTL 陈旧，
// 需跨进程失效（Redis pub-sub 等基建）才能消除——属基建项，单实例无碍。
let cache: { cfg: ResolvedAiConfig; at: number } | null = null;
const TTL = 4000;

// 运营在「模型」配置里填的 token 单价（元/1M）：model 名 → 费率。短缓存，配置变更时清空。
// 端点池允许多个接入点使用同一个 model 名，因此这里把价格定义成「模型级 SSOT」：
// 同名模型只有完整且一致的 in/out 价格才校准；历史冲突/半配置确定性退回裸 token，不再由无序查询随机覆盖。
let rateCache: { map: Map<string, ModelRate>; at: number } | null = null;
let lastRateIssueSignature = '';

type RateRow = {
  model: string; priceInput: number; priceOutput: number; priceCachedInput: number;
  // 2026-08-07 新增第四档。历史行/未传值按 0 处理 → estimateCostMicros 继续用
  // `in × CACHE_WRITE_MULTIPLIER` 推导，折算结果与加这一档之前逐位相同。
  priceCacheWrite?: number;
};

export function buildConfiguredRateMap(rows: RateRow[]): { map: Map<string, ModelRate>; issues: string[] } {
  const grouped = new Map<string, ModelRate[]>();
  const issues: string[] = [];
  for (const r of rows) {
    const key = r.model.trim().toLowerCase();
    if (!key) continue;
    const cacheWrite = r.priceCacheWrite ?? 0;
    const hasAny = r.priceInput > 0 || r.priceOutput > 0 || r.priceCachedInput > 0 || cacheWrite > 0;
    if (!hasAny) continue;
    if (!(r.priceInput > 0) || !(r.priceOutput > 0)) {
      issues.push(`${r.model}: 输入价和输出价必须同时配置`);
      continue;
    }
    const rate: ModelRate = {
      in: r.priceInput,
      out: r.priceOutput,
      cachedIn: r.priceCachedInput > 0 ? r.priceCachedInput : undefined,
      cacheWrite: cacheWrite > 0 ? cacheWrite : undefined,
    };
    const list = grouped.get(key) ?? [];
    list.push(rate);
    grouped.set(key, list);
  }

  const map = new Map<string, ModelRate>();
  for (const [model, rates] of grouped) {
    const first = rates[0];
    // 四档全部纳入一致性判定：只要有一档在同名端点间不一致，整个模型退回未校准，
    // 而不是让无序 findMany() 的最后一行随机决定单价。
    const same = rates.every((r) =>
      r.in === first.in && r.out === first.out
      && (r.cachedIn ?? 0) === (first.cachedIn ?? 0)
      && (r.cacheWrite ?? 0) === (first.cacheWrite ?? 0));
    if (!same) {
      issues.push(`${model}: 同名模型存在冲突单价`);
      continue;
    }
    map.set(model, first);
  }
  return { map, issues };
}

async function configuredRates(force = false): Promise<Map<string, ModelRate>> {
  if (!force && rateCache && Date.now() - rateCache.at < TTL) return rateCache.map;
  const map = new Map<string, ModelRate>();
  try {
    const rows = await prisma.aiModel.findMany({ select: { model: true, priceInput: true, priceOutput: true, priceCachedInput: true, priceCacheWrite: true } });
    const built = buildConfiguredRateMap(rows);
    for (const [model, rate] of built.map) map.set(model, rate);
    const issueSignature = built.issues.join('；');
    if (issueSignature && issueSignature !== lastRateIssueSignature) {
      console.error(`[aiConfig] 模型单价未校准：${issueSignature}`);
    }
    lastRateIssueSignature = issueSignature;
  } catch {
    /* DB 不可达：留空 → 成本未校准、用户额度回退裸 token */
  }
  rateCache = { map, at: Date.now() };
  return map;
}

/** 解析某模型的成本费率：只用运营在模型配置里填的单价（精确名/前缀命中）。没配 → 0，不回退、不估算。 */
export async function resolveModelRate(model: string): Promise<{ rate: ModelRate; calibrated: boolean }> {
  const cfg = await configuredRates();
  const m = (model || '').trim().toLowerCase();
  const exact = cfg.get(m);
  if (exact) return { rate: exact, calibrated: true };
  // P2-3：取**最长**匹配前缀（而非插入序第一个），避免 `gpt-4` 遮蔽更精确的 `gpt-4o`。
  let best: { len: number; v: ModelRate } | null = null;
  for (const [k, v] of cfg) {
    const kl = k.toLowerCase();
    if (m.startsWith(kl) && (!best || kl.length > best.len)) best = { len: kl.length, v };
  }
  if (best) return { rate: best.v, calibrated: true };
  return { rate: { in: 0, out: 0 }, calibrated: false }; // 没配单价 → 成本计 0（calibrated=false 供上层提示「未校准」）
}

/** 生成前并不知道端点池最终落点，故取所有已校准模型中的最贵相对权重做并发预留上界。 */
export async function maxConfiguredRateWeights(): Promise<ModelRate> {
  const rates = [...(await configuredRates()).values()];
  if (!rates.length) return { in: 0, out: 0 };
  let outputWeight = 1;
  for (const rate of rates) {
    outputWeight = Math.max(outputWeight, rate.out / rate.in);
  }
  return { in: 1, out: outputWeight };
}

/**
 * 解析当前生效配置（DB 优先，env 兜底，带缓存）。
 *
 * 三期起多了一层：`AI_CONFIG_V2=true` 且 `purpose='chat'` 真有可用路由时，走归一化表；
 * 否则**静默回落旧路径**。回落不是兜底摆设——迁移没跑完、路由被清空、数据库刚恢复，
 * 这几种情况都不该让 AI 停摆，而把开关关掉就是完整回滚（旧表一个字段都没动）。
 */
export async function getAiConfig(force = false): Promise<ResolvedAiConfig> {
  if (!force && cache && Date.now() - cache.at < TTL) return cache.cfg;
  const legacy = await getLegacyAiConfig();
  if (!v2Enabled()) { cache = { cfg: legacy, at: Date.now() }; return legacy; }

  // chat 路由是主配置；嵌入 / 重排各自的路由投影回同一份 cfg 上的对应字段，
  // 这样 services/{embedding,rerank} 那些既有消费方零改动就能吃到用途化的结果。
  let cfg = (await configForPurpose('chat', legacy)) ?? legacy;
  cfg = await auxServiceConfig('embedding', cfg);
  cfg = await auxServiceConfig('rerank', cfg);
  cache = { cfg, at: Date.now() };
  return cfg;
}

/** 旧读路径（AiSetting 单例 > env）。三期切换后仍作为回落与迁移来源保留。 */
async function getLegacyAiConfig(): Promise<ResolvedAiConfig> {
  let cfg = fromEnv();
  try {
    const row = await prisma.aiSetting.findUnique({ where: { id: 'default' } });
    if (row) {
      cfg = {
        provider: (row.provider as AiProvider) ?? 'mock',
        label: row.label || cfg.label,
        baseUrl: row.baseUrl || cfg.baseUrl,
        model: row.model || cfg.model,
        apiKey: readAiCredential(row.apiKey),
        embeddingModel: row.embeddingModel || '',
        thinkingMode: normalizeThinkingMode(row.thinkingMode),
        thinkingBudget: normalizeThinkingBudget(row.thinkingBudget),
        dialect: row.dialect ?? null,
        capsJson: row.capsJson ?? null,
        // 永远保留运营配置原值；Thinking 对 temperature=1 的约束只在最终请求组装时临时生效。
        temperature: typeof row.temperature === 'number' ? row.temperature : 0.7,
        timeoutMs: env.openaiTimeoutMs,
        embeddingEnabled: row.embeddingEnabled ?? false,
        embeddingBaseUrl: row.embeddingBaseUrl || '',
        embeddingApiKey: readAiCredential(row.embeddingApiKey),
        rerankEnabled: row.rerankEnabled ?? false,
        rerankModel: row.rerankModel || '',
        rerankBaseUrl: row.rerankBaseUrl || '',
        rerankApiKey: readAiCredential(row.rerankApiKey),
        keyDecryptFailed: aiCredentialReadFailed(row.apiKey),
        traceEndpointId: row.activeModelId ?? undefined,
        traceEndpointLabel: row.label || undefined,
      };
      // 滚动迁移保护：历史密文解不开时明确记 error 级日志，供告警。
      if (cfg.keyDecryptFailed) {
        console.error('[aiConfig] 对话模型 apiKey 解密失败（APP_ENCRYPTION_KEY 轮换错误或未配但库内为密文）——'
          + '生产将抛 AI_UNAVAILABLE 而非静默降级 mock。请核对主密钥。');
      }
    }
  } catch (err) {
    // 读不到配置 → 回落 env（多半是 provider=mock），**全站产出因此静默降级成本地模板**。
    // 以前这里连一行日志都没有，理由写的是「DB 不可达」——但那个假设已经不成立了：
    // 2026-08-08 实测最常见的成因是**新代码 + 旧 schema**（部署时 db push 没跑或跑失败），
    // 报错原文是 `The column ai_setting.dialect does not exist in the current database`。
    // 这种情况下所有东西看起来都在正常运行，只是每个用户拿到的都是模板 —— 必须喊出来。
    // 保留回落行为不变（DB 抖一下不该变成事故），只是不再沉默。
    noteAiConfigFallback(err as Error);
  }
  return cfg;
}

// 同一个原因不重复刷屏：getAiConfig 有 4s 缓存，持续故障会每 4 秒来一次。
let lastFallbackSig = '';
let lastFallbackAt = 0;
function noteAiConfigFallback(err: Error): void {
  const msg = err?.message ?? String(err);
  const schemaDrift = /does not exist in the current database|Unknown argument|Invalid `prisma/.test(msg);
  const sig = schemaDrift ? 'schema' : msg.slice(0, 80);
  const now = Date.now();
  if (sig === lastFallbackSig && now - lastFallbackAt < 60_000) return;
  lastFallbackSig = sig;
  lastFallbackAt = now;
  console.error(
    schemaDrift
      ? `[aiConfig] ❗ 数据库 schema 与代码不一致，读取模型配置失败 → **全站产出正在降级为本地模板**。`
        + `请在服务端执行 \`npx prisma db push\` 后重启（部署脚本里 db push 应先于 restart）。原始报错：${msg}`
      : `[aiConfig] ❗ 读取模型配置失败 → 已回落环境变量兜底，**产出可能降级为本地模板**：${msg}`,
  );
}

/**
 * 辅助档（aux tier）：后台抽取类调用用的小模型配置。
 *
 * 背景（2026-07 压测后核对）：一条用户消息实际触发 3–4 次模型调用——主生成 + `extractInsights`
 * （记忆学习）+ `extractProphecies`（预言抽取）+ 首条消息的 `summarizeSessionTitle`。这些辅助抽取
 * 原来和主对话共用同一个 `getAiConfig()`：同账号、同模型、同一批并发槽位。也就是说**上游 8 个槽位
 * 里有 2–3 个被后台任务占着**，而它们既不需要主模型的质量，也不面向用户延迟。
 *
 * 配了 `AI_AUX_MODEL` 就把这些调用切到小模型；再配 `AI_AUX_BASE_URL` / `AI_AUX_API_KEY` 指向
 * **独立账号**时，还会切到独立的并发车道（lane='aux'），主配额从此完全留给用户可见的生成。
 *
 * **未配 `AI_AUX_MODEL` → 原样返回主配置，行为与改动前完全一致**（不改默认口径）。
 * 只影响抽取类任务，不影响对话与成果生成——那两条路径永远走主配置。
 */
export function resolveAuxConfig(main: ResolvedAiConfig): ResolvedAiConfig {
  const model = (process.env.AI_AUX_MODEL ?? '').trim();
  if (!model) return main;

  const baseUrl = (process.env.AI_AUX_BASE_URL ?? '').trim();
  const apiKey = (process.env.AI_AUX_API_KEY ?? '').trim();
  // 只有 baseUrl 或 key 之一被显式指定，才说明是独立接入点/独立账号 → 独立车道。
  // 仅换模型名（同账号）时保持 lane=main：配额本来就是共享的，分两个计数器等于把限额悄悄放大一倍。
  const separateAccount = !!baseUrl || !!apiKey;
  const provider = (process.env.AI_AUX_PROVIDER ?? '').trim() || (baseUrl ? 'openai' : main.provider);

  return {
    ...main,
    provider: provider as AiProvider,
    label: `${main.label} · aux(${model})`,
    model,
    baseUrl: baseUrl || main.baseUrl,
    apiKey: apiKey || main.apiKey,
    // 抽取类任务应当快失败：拖长了既占车道又没人等它的结果。
    timeoutMs: Number(process.env.AI_AUX_TIMEOUT_MS ?? '') > 0
      ? Number(process.env.AI_AUX_TIMEOUT_MS)
      : Math.min(main.timeoutMs, 20_000),
    // 抽取要的是稳定可解析的结构，不是文采。
    temperature: Number.isFinite(Number(process.env.AI_AUX_TEMPERATURE))
      ? Number(process.env.AI_AUX_TEMPERATURE)
      : 0,
    lane: separateAccount ? 'aux' : 'main',
    poolBypass: true,
    // 独立辅助档不是全局 activeModelId 对应的接入点，不能把主端点误记到 trace。
    traceEndpointId: separateAccount ? undefined : main.traceEndpointId,
    traceEndpointLabel: separateAccount ? `${main.label} · aux(${model})` : main.traceEndpointLabel,
    // key 换过就不能沿用主档的解密失败标记（否则主 key 坏了会连累辅助档全线短路）。
    keyDecryptFailed: apiKey ? false : main.keyDecryptFailed,
  };
}

/**
 * 辅助档解析（三期版）：**优先用 `purpose='aux'` 路由**，没有才回落 `AI_AUX_*` 环境变量。
 *
 * 这就是「用途化」最直接的收益：辅助抽取此前**只能**改 env + 重启，运营在后台看不见它、
 * 也测不了它。迁移把它收编成一条路由之后，它和主对话享有同一套 UI、校验与探活。
 * env 仍保留一个版本作兜底，不立刻删——迁移期两条路都要能走。
 */
export async function resolveAuxConfigAsync(main: ResolvedAiConfig): Promise<ResolvedAiConfig> {
  const routed = await configForPurpose('aux', main);
  if (routed) return { ...routed, label: `${routed.label} · aux` };
  return resolveAuxConfig(main);
}

/** 嵌入 / 重排：同样优先走各自的路由，没配才用 AiSetting 上的散字段。 */
export async function auxServiceConfig(
  kind: 'embedding' | 'rerank', main: ResolvedAiConfig,
): Promise<ResolvedAiConfig> {
  const routed = await configForPurpose(kind, main);
  if (!routed) return main;
  // 嵌入/重排的调用方读的是 embeddingBaseUrl / rerankBaseUrl 这组字段，
  // 所以把路由结果投影回这组字段，调用方零改动。
  return kind === 'embedding'
    ? { ...main, embeddingEnabled: true, embeddingModel: routed.model, embeddingBaseUrl: routed.baseUrl, embeddingApiKey: routed.apiKey }
    : { ...main, rerankEnabled: true, rerankModel: routed.model, rerankBaseUrl: routed.baseUrl, rerankApiKey: routed.apiKey };
}

/** 辅助档是否已独立配置（诊断 / 运维可见性用）。 */
export function auxConfigured(): boolean {
  return !!(process.env.AI_AUX_MODEL ?? '').trim();
}

export function isReady(cfg: ResolvedAiConfig): boolean {
  if (cfg.provider === 'mock') return false;
  return isRealKey(cfg.apiKey);
}
/** 实际生效 provider：未就绪一律 mock。 */
export function effectiveProvider(cfg: ResolvedAiConfig): AiProvider {
  return isReady(cfg) ? cfg.provider : 'mock';
}

/** 写入配置（各 apiKey 仅在显式传入非 undefined 时更新；空串=清空、undefined=不动）。 */
export async function setAiConfig(patch: {
  provider?: AiProvider; label?: string; baseUrl?: string; model?: string;
  apiKey?: string; embeddingModel?: string; temperature?: number;
  thinkingMode?: AiThinkingMode; thinkingBudget?: number;
  embeddingEnabled?: boolean; embeddingBaseUrl?: string; embeddingApiKey?: string;
  rerankEnabled?: boolean; rerankModel?: string; rerankBaseUrl?: string; rerankApiKey?: string;
}): Promise<ResolvedAiConfig> {
  const data: Record<string, unknown> = {};
  if (patch.provider !== undefined) data.provider = patch.provider;
  if (patch.label !== undefined) data.label = patch.label;
  if (patch.baseUrl !== undefined) data.baseUrl = patch.baseUrl;
  if (patch.model !== undefined) data.model = patch.model;
  if (patch.apiKey !== undefined) data.apiKey = storeAiCredential(patch.apiKey); // 空串=清空 key
  if (patch.embeddingModel !== undefined) data.embeddingModel = patch.embeddingModel;
  if (patch.temperature !== undefined) data.temperature = patch.temperature;
  if (patch.thinkingMode !== undefined) data.thinkingMode = normalizeThinkingMode(patch.thinkingMode);
  if (patch.thinkingBudget !== undefined) data.thinkingBudget = normalizeThinkingBudget(patch.thinkingBudget);
  if (patch.embeddingEnabled !== undefined) data.embeddingEnabled = patch.embeddingEnabled;
  if (patch.embeddingBaseUrl !== undefined) data.embeddingBaseUrl = patch.embeddingBaseUrl;
  if (patch.embeddingApiKey !== undefined) data.embeddingApiKey = storeAiCredential(patch.embeddingApiKey);
  if (patch.rerankEnabled !== undefined) data.rerankEnabled = patch.rerankEnabled;
  if (patch.rerankModel !== undefined) data.rerankModel = patch.rerankModel;
  if (patch.rerankBaseUrl !== undefined) data.rerankBaseUrl = patch.rerankBaseUrl;
  if (patch.rerankApiKey !== undefined) data.rerankApiKey = storeAiCredential(patch.rerankApiKey);

  await prisma.aiSetting.upsert({
    where: { id: 'default' },
    update: data,
    create: {
      id: 'default',
      // 首次建行时不再预置某一家厂商（历史值是已不在用的 Agnes，会把「没配过」显示成「配好了」）。
      // 缺省落到 mock：未配 key 时 effectiveProvider 本来就降级 mock，这里只是把真相写进库。
      provider: patch.provider ?? 'mock',
      label: patch.label ?? '未配置',
      baseUrl: patch.baseUrl ?? '',
      model: patch.model ?? '',
      apiKey: storeAiCredential(patch.apiKey),
      embeddingModel: patch.embeddingModel ?? '',
      thinkingMode: normalizeThinkingMode(patch.thinkingMode),
      thinkingBudget: normalizeThinkingBudget(patch.thinkingBudget),
      temperature: patch.temperature ?? 0.7,
      embeddingEnabled: patch.embeddingEnabled ?? false,
      embeddingBaseUrl: patch.embeddingBaseUrl ?? '',
      embeddingApiKey: storeAiCredential(patch.embeddingApiKey),
      rerankEnabled: patch.rerankEnabled ?? false,
      rerankModel: patch.rerankModel ?? '',
      rerankBaseUrl: patch.rerankBaseUrl ?? '',
      rerankApiKey: storeAiCredential(patch.rerankApiKey),
    },
  });
  cache = null;
  await syncV2FromLegacy();
  return getAiConfig(true);
}

/* ────────────── 已添加模型（注册表 + 快速切换） ──────────────
 * AiModel 是运营添加的模型接入点列表；快速切换 = 把某个 AiModel 设为生效。
 * 「生效」= 把该模型的对话字段拷进单例 AiSetting + 记 activeModelId；
 * getAiConfig 仍只读 AiSetting，运行时路径不变。嵌入/重排为全局配置，不随切换变动。
 */
type ModelRow = {
  id: string; provider: string; label: string; baseUrl: string; model: string;
  apiKey: string; embeddingModel: string; temperature: number; preset: string | null;
  thinkingMode: string; thinkingBudget: number; dialect?: string | null; capsJson?: unknown;
  lastProbeAt?: Date | null; lastProbeOk?: boolean | null; probeJson?: unknown;
  priceInput: number; priceOutput: number; priceCachedInput: number; priceCacheWrite?: number; updatedAt: Date;
  poolEnabled?: boolean; weight?: number; tier?: number; maxConcurrency?: number;
};

/** 脱敏对外视图（不回明文 key；active 由 AiSetting.activeModelId 决定）。 */
export function publicModel(m: ModelRow, activeId: string | null): AiModel {
  return {
    id: m.id,
    provider: (m.provider as AiProvider) ?? 'mock',
    label: m.label,
    baseUrl: m.baseUrl,
    model: m.model,
    embeddingModel: m.embeddingModel,
    thinkingMode: normalizeThinkingMode(m.thinkingMode),
    thinkingBudget: normalizeThinkingBudget(m.thinkingBudget),
    temperature: m.temperature,
    // 方言：显式值直接回传；没固化时把推断结果一并回传，后台标灰并提供「确认固化」，
    // 让运营看得见「这个端点现在还在靠猜」。
    dialect: m.dialect ?? null,
    resolvedDialect: dialectOf({ provider: (m.provider as AiProvider) ?? 'mock', baseUrl: m.baseUrl, model: m.model, dialect: m.dialect }).dialect.id,
    caps: readCaps(m.capsJson),
    lastProbeAt: m.lastProbeAt?.toISOString?.() ?? null,
    lastProbeOk: m.lastProbeOk ?? null,
    hasKey: isRealKey(readAiCredential(m.apiKey)),
    preset: m.preset ?? null,
    active: !!activeId && m.id === activeId,
    priceInput: m.priceInput ?? 0,
    priceOutput: m.priceOutput ?? 0,
    priceCachedInput: m.priceCachedInput ?? 0,
    priceCacheWrite: m.priceCacheWrite ?? 0,
    poolEnabled: m.poolEnabled ?? false,
    weight: m.weight ?? 1,
    tier: m.tier ?? 0,
    maxConcurrency: m.maxConcurrency ?? 0,
    updatedAt: m.updatedAt?.toISOString?.(),
  };
}

// 把某个模型的对话字段同步进单例 AiSetting（= 设为生效），并记 activeModelId。
// 注意：嵌入/重排是「全局检索增强」配置，独立于对话模型——切换对话模型不得动 embeddingModel 等，
// 否则会把全局嵌入模型清空（此前 per-model embeddingModel 多为空，切模型即静默清掉 embedding 生效）。
async function syncActiveSetting(m: ModelRow): Promise<void> {
  const fields = {
    provider: m.provider, label: m.label, baseUrl: m.baseUrl, model: m.model,
    // 历史密文先解开再拷贝，保证 AiSetting 新写入始终是明文。embeddingModel 不随切换同步（main 06-16）。
    apiKey: plainAiCredential(m.apiKey),
    thinkingMode: normalizeThinkingMode(m.thinkingMode),
    thinkingBudget: normalizeThinkingBudget(m.thinkingBudget),
    // 方言与能力必须一起拷：只拷 thinkingMode 而漏掉方言，生效后请求会按推断值组装，
    // 运营在端点上「确认固化」的那一次点击就白点了。
    dialect: m.dialect ?? null,
    // 可空 Json 列要清空必须用 Prisma.DbNull（JS 的 null 在 Prisma 里是「JSON null 值」而非 SQL NULL）。
    capsJson: (m.capsJson ?? Prisma.DbNull) as Prisma.InputJsonValue,
    temperature: m.temperature,
    activeModelId: m.id,
  };
  await prisma.aiSetting.upsert({
    where: { id: 'default' },
    update: fields,
    create: { id: 'default', ...fields },
  });
  cache = null;
  // 切到 V2 后运行时读的是路由表：不投影过去，「切换生效模型」就只改了旧表、线上纹丝不动。
  await syncV2FromLegacy();
}

// 首次进入：库里还没有任何模型时，用当前生效配置（DB 或 env 兜底）落一行并设为生效，平滑迁移。
async function ensureSeededModels(): Promise<void> {
  if ((await prisma.aiModel.count()) > 0) return; // 快路径：已有模型，免锁
  // P2-5：首次种子在 advisory lock 内串行 + 锁内重检，避免并发首载（GET 触发）各建一份重复种子（TOCTOU）。
  const created = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('ai-model-seed'))`;
    if ((await tx.aiModel.count()) > 0) return null;
    const cfg = await getAiConfig(true);
    return tx.aiModel.create({
      data: {
        provider: cfg.provider, label: cfg.label || '当前模型', baseUrl: cfg.baseUrl, model: cfg.model,
        apiKey: storeAiCredential(cfg.apiKey), embeddingModel: cfg.embeddingModel, temperature: cfg.temperature,
        thinkingMode: cfg.thinkingMode, thinkingBudget: cfg.thinkingBudget,
      },
    });
  });
  if (created) await syncActiveSetting(created as ModelRow);
}

/** 已添加模型列表（带 active 标记）；首次自动迁移当前配置。DB 不可达返回空。 */
export async function listModels(): Promise<AiModel[]> {
  try {
    await ensureSeededModels();
    const setting = await prisma.aiSetting.findUnique({ where: { id: 'default' } });
    const rows = await prisma.aiModel.findMany({ orderBy: { createdAt: 'asc' } });
    return rows.map((r) => publicModel(r as ModelRow, setting?.activeModelId ?? null));
  } catch {
    return [];
  }
}

// 端点池参数的取值口径（addModel / updateModel 必须同源）：
// weight≥1（0 会让 HRW 打分恒为 0，等于悄悄踢出池）、tier≥0、maxConcurrency≥0（0=用全局默认）。
const clampWeight = (v: number) => Math.max(1, Math.floor(v));
const clampTier = (v: number) => Math.max(0, Math.floor(v));
const clampConcurrency = (v: number) => Math.max(0, Math.floor(v));

/** 添加模型（不自动生效；进入快速切换列表，由运营点选生效）。 */
export async function addModel(input: AiModelUpsert): Promise<AiModel> {
  const created = await prisma.aiModel.create({
    data: {
      provider: input.provider ?? 'openai',
      label: input.label?.trim() || '未命名模型',
      baseUrl: input.baseUrl?.trim() ?? '',
      model: input.model?.trim() ?? '',
      apiKey: storeAiCredential(input.apiKey),
      embeddingModel: input.embeddingModel?.trim() ?? '',
      thinkingMode: normalizeThinkingMode(input.thinkingMode),
      thinkingBudget: normalizeThinkingBudget(input.thinkingBudget),
      temperature: typeof input.temperature === 'number' ? input.temperature : 0.7,
      preset: input.preset ?? null,
      dialect: input.dialect ?? null,
      priceInput: Math.max(0, input.priceInput ?? 0),
      priceOutput: Math.max(0, input.priceOutput ?? 0),
      priceCachedInput: Math.max(0, input.priceCachedInput ?? 0),
      priceCacheWrite: Math.max(0, input.priceCacheWrite ?? 0),
      // 池参数此前漏写：路由层为 poolEnabled 做了协议校验（会 409），校验通过后却没落库，
      // 于是「新增时勾了入池」静默变成未入池，只有事后再 PATCH 一次才生效。
      poolEnabled: !!input.poolEnabled,
      weight: clampWeight(input.weight ?? 1),
      tier: clampTier(input.tier ?? 0),
      maxConcurrency: clampConcurrency(input.maxConcurrency ?? 0),
    },
  });
  rateCache = null;
  // 新增的就是池端点时，让 llmPool 的 5s 配置缓存立刻失效（与 updateModel 同口径）。
  void import('./llmPool.js').then((m) => m.__resetLlmPool()).catch(() => {});
  await syncV2FromLegacy();
  const setting = await prisma.aiSetting.findUnique({ where: { id: 'default' } });
  return publicModel(created as ModelRow, setting?.activeModelId ?? null);
}

/** 编辑模型（apiKey 留空=不改）；若编辑的是生效模型，同步进 AiSetting 立即生效。 */
export async function updateModel(id: string, patch: AiModelUpsert): Promise<AiModel | null> {
  const existing = await prisma.aiModel.findUnique({ where: { id } });
  if (!existing) return null;
  const data: Record<string, unknown> = {};
  if (patch.provider !== undefined) data.provider = patch.provider;
  if (patch.label !== undefined) data.label = patch.label.trim() || existing.label;
  if (patch.baseUrl !== undefined) data.baseUrl = patch.baseUrl.trim();
  if (patch.model !== undefined) data.model = patch.model.trim();
  if (patch.apiKey !== undefined && patch.apiKey !== '') data.apiKey = storeAiCredential(patch.apiKey); // 留空=保留现有 key
  if (patch.embeddingModel !== undefined) data.embeddingModel = patch.embeddingModel.trim();
  if (patch.temperature !== undefined) data.temperature = patch.temperature;
  if (patch.thinkingMode !== undefined) {
    data.thinkingMode = normalizeThinkingMode(patch.thinkingMode);
  }
  if (patch.thinkingBudget !== undefined) data.thinkingBudget = normalizeThinkingBudget(patch.thinkingBudget);
  if (patch.preset !== undefined) data.preset = patch.preset;
  if (patch.dialect !== undefined) data.dialect = patch.dialect || null;
  if (patch.priceInput !== undefined) data.priceInput = Math.max(0, patch.priceInput);
  if (patch.priceOutput !== undefined) data.priceOutput = Math.max(0, patch.priceOutput);
  if (patch.priceCachedInput !== undefined) data.priceCachedInput = Math.max(0, patch.priceCachedInput);
  if (patch.priceCacheWrite !== undefined) data.priceCacheWrite = Math.max(0, patch.priceCacheWrite);
  if (patch.poolEnabled !== undefined) data.poolEnabled = !!patch.poolEnabled;
  if (patch.weight !== undefined) data.weight = clampWeight(patch.weight);
  if (patch.tier !== undefined) data.tier = clampTier(patch.tier);
  if (patch.maxConcurrency !== undefined) data.maxConcurrency = clampConcurrency(patch.maxConcurrency);
  const updated = await prisma.aiModel.update({ where: { id }, data });
  rateCache = null;
  await syncV2FromLegacy();
  // 端点池配置变了 → 让 llmPool 的 5s 缓存立刻失效（本进程；其它实例最多 5s 陈旧）。
  void import('./llmPool.js').then((m) => m.__resetLlmPool()).catch(() => {});
  const setting = await prisma.aiSetting.findUnique({ where: { id: 'default' } });
  if (setting?.activeModelId === id) await syncActiveSetting(updated as ModelRow);
  return publicModel(updated as ModelRow, setting?.activeModelId ?? null);
}

/** 删除模型（生效模型若仍有其它模型则拒绝，提示先切换）。 */
export async function deleteModel(id: string): Promise<{ ok: boolean; reason?: string }> {
  const setting = await prisma.aiSetting.findUnique({ where: { id: 'default' } });
  if (setting?.activeModelId === id) {
    const others = await prisma.aiModel.count({ where: { id: { not: id } } });
    if (others > 0) return { ok: false, reason: '当前生效模型不能删除，请先切换到其它模型' };
    // 删最后一个：清指针；运行时仍用 AiSetting 里已拷贝的配置兜底，不中断。
    await prisma.aiSetting.update({ where: { id: 'default' }, data: { activeModelId: null } });
  }
  await prisma.aiModel.delete({ where: { id } });
  rateCache = null;
  // 投影会顺带清掉这一行对应的孤儿端点——否则它会继续留在路由里接流量。
  await syncV2FromLegacy();
  return { ok: true };
}

/** 快速切换：把目标模型设为生效（即时）。 */
export async function activateModel(id: string): Promise<ResolvedAiConfig> {
  const m = await prisma.aiModel.findUnique({ where: { id } });
  if (!m) throw new Error('模型不存在');
  await syncActiveSetting(m as ModelRow);
  return getAiConfig(true);
}

/** 把「添加/编辑模型」表单（含未保存改动）解析成可探活的配置；modelId 传入且 key 空则取该模型已存 key。 */
export async function mergedTestConfig(b: AiModelTest): Promise<ResolvedAiConfig> {
  const base = await getAiConfig(true); // 复用 timeoutMs / 全局嵌入兜底
  let apiKey = b.apiKey ?? '';
  // 能力标记不在表单里（它是探活写的，不是运营填的），编辑既有端点时从库里取。
  // 探活正是要验证这些标记，所以必须用被测端点自己的那份，不能用全局配置的。
  let testCaps: unknown = null;
  if (b.modelId) {
    const row = await prisma.aiModel.findUnique({ where: { id: b.modelId } });
    if ((!apiKey || !apiKey.length)) apiKey = readAiCredential(row?.apiKey); // 明文直读；滚动迁移期兼容历史密文
    testCaps = row?.capsJson ?? null;
  }
  return {
    ...base,
    provider: b.provider,
    label: b.label || base.label,
    baseUrl: b.baseUrl ?? '',
    model: b.model ?? '',
    apiKey,
    embeddingModel: b.embeddingModel ?? base.embeddingModel,
    thinkingMode: normalizeThinkingMode(b.thinkingMode ?? base.thinkingMode),
    thinkingBudget: normalizeThinkingBudget(b.thinkingBudget ?? base.thinkingBudget),
    temperature: typeof b.temperature === 'number' ? b.temperature : base.temperature,
    // 方言/能力也必须来自被测端点，否则探活验的是另一套请求组装规则。
    dialect: b.dialect ?? null,
    capsJson: testCaps,
    poolBypass: true, // 见下方说明：探活必须打**被测端点本身**
  };
}

/**
 * 把「当前保存配置」叠加本次未保存的改动，得到 `/admin/ai-config/test` 的探活配置。
 * 各 apiKey 留空＝沿用已存 key（与保存路径同口径）。纯函数，不查库，便于回归。
 */
export function mergedConfigTest(saved: ResolvedAiConfig, b: AiConfigUpdate): ResolvedAiConfig {
  return {
    ...saved,
    provider: b.provider ?? saved.provider,
    baseUrl: b.baseUrl ?? saved.baseUrl,
    model: b.model ?? saved.model,
    apiKey: b.apiKey && b.apiKey.length ? b.apiKey : saved.apiKey,
    embeddingModel: b.embeddingModel ?? saved.embeddingModel,
    temperature: b.temperature ?? saved.temperature,
    thinkingMode: b.thinkingMode ?? saved.thinkingMode,
    thinkingBudget: b.thinkingBudget ?? saved.thinkingBudget,
    embeddingEnabled: b.embeddingEnabled ?? saved.embeddingEnabled,
    embeddingBaseUrl: b.embeddingBaseUrl ?? saved.embeddingBaseUrl,
    embeddingApiKey: b.embeddingApiKey && b.embeddingApiKey.length ? b.embeddingApiKey : saved.embeddingApiKey,
    rerankEnabled: b.rerankEnabled ?? saved.rerankEnabled,
    rerankModel: b.rerankModel ?? saved.rerankModel,
    rerankBaseUrl: b.rerankBaseUrl ?? saved.rerankBaseUrl,
    rerankApiKey: b.rerankApiKey && b.rerankApiKey.length ? b.rerankApiKey : saved.rerankApiKey,
    poolBypass: true, // 见下方说明
  };
}

/*
 * 为什么探活配置必须带 poolBypass（2026-08-07 修）
 * ────────────────────────────────────────────────
 * 探活走的是 pingModel → claudeRaw/openaiRaw → withEndpoint → resolveCandidates 这条正常外呼链路。
 * `routingMode=pool` 时，resolveCandidates 会把传进去的配置**整体换成池成员**（llmPool.toCfg 覆盖
 * baseUrl/apiKey/model/temperature/thinking），于是「测试连接」测的根本不是运营正在编辑的那个端点：
 *   - 刚粘错的 key / URL 照样返回「连通 ✓」；
 *   - 想确认某个端点是否已恢复，测到的却是另一个；
 *   - 探活没有 affinityKey，HRW 的 key 恒为 'anon' → 永远命中同一个池成员，多测几次也发现不了。
 * 探活的语义就是「测这一个端点」，任何路由改写都是错的，故走与辅助档同一个 bypass 通道。
 */

/** 脱敏对外视图（不含明文 key；独立嵌入/重排 key 只回传是否已配置）。 */
export function publicConfig(cfg: ResolvedAiConfig): AiConfig {
  return {
    provider: cfg.provider,
    label: cfg.label,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    embeddingModel: cfg.embeddingModel,
    temperature: cfg.temperature,
    thinkingMode: cfg.thinkingMode,
    thinkingBudget: cfg.thinkingBudget,
    hasKey: isRealKey(cfg.apiKey),
    ready: isReady(cfg),
    effectiveProvider: effectiveProvider(cfg),
    embeddingEnabled: cfg.embeddingEnabled,
    embeddingBaseUrl: cfg.embeddingBaseUrl,
    hasEmbeddingKey: isRealKey(cfg.embeddingApiKey),
    rerankEnabled: cfg.rerankEnabled,
    rerankModel: cfg.rerankModel,
    rerankBaseUrl: cfg.rerankBaseUrl,
    hasRerankKey: isRealKey(cfg.rerankApiKey),
  };
}
