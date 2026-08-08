// 大模型接入配置的运行时投影。
// 解析优先级：用途路由（默认）> 旧 AiSetting 历史快照 > 环境变量兜底。带短缓存。
// 未配置真实 key 时 effectiveProvider 自动降级 mock，保证演示永远可跑。
//
// 存储：AiCredential 是正常凭证真源；旧 AiSetting/AiModel 只作迁移历史。均兼容读取历史 enc:v1，
//       部署脚本会做一次性明文化迁移。对外一律只回传 hasKey，不出明文。

import { prisma } from '../db.js';
import { env, isRealKey } from '../env.js';
import type { ModelRate } from '../data/modelPrices.js';
import { aiCredentialReadFailed, readAiCredential } from './aiCredentialStorage.js';
import type { AiProvider, AiThinkingMode, AiEndpointTest } from '../llm/schema.js';
import {
  DEFAULT_THINKING_MODE,
  normalizeThinkingBudget,
  normalizeThinkingMode,
} from '../llm/thinking.js';
import { configForPurpose, v2Enabled } from './aiRoutes.js';

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
  // 端点池选中的 AiEndpoint.id（services/llmPool）。未启用池时为 undefined。
  // 有值时闸门按「每端点」独立计并发与冷却，一个端点被限流不连累其它端点。
  endpointId?: string;
  // 仅供 LlmTrace 归因，不参与并发车道/路由。single 模式下记录 primary endpointId；
  // pool 模式下 services/llmPool 会用本次候选覆盖成实际命中的端点。
  traceEndpointId?: string;
  traceEndpointLabel?: string;
  // 辅助抽取等已显式选择独立模型/账号的调用不得再被主端点池覆盖。
  poolBypass?: boolean;
}

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

// P2-6：进程内短缓存 + 写时失效（归一化写路径统一经 aiV2Admin.invalidate）→ 单实例配置变更即时生效。
// 多实例部署下其它实例最多 TTL 陈旧，
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
    // 单价配在**端点**上（三期收尾后旧表不再被写）。仍从旧表读的话，运营在后台填的价
    // 一分钱都进不了成本核算，而且不会报错——只会看到成本恒为 0。
    const rows = await prisma.aiEndpoint.findMany({ select: { model: true, priceInput: true, priceOutput: true, priceCachedInput: true, priceCacheWrite: true } });
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
 * 清掉「已解析配置」与费率两层缓存。**任何写接入配置的路径都必须调它。**
 *
 * 旧结构里这件事由 `setAiConfig` 顺手做（`cache = null`）。三期收尾删掉那套 CRUD 后，
 * 一度没人接手——后果是运营在后台改完配置，运行时最多 4 秒仍在用旧值，
 * 而且不报错、页面还显示已保存。这正是本次重设计要消灭的那类故障，
 * 所以它必须是写路径 `invalidate()` 的一部分，而不是靠调用方记得。
 */
export function __resetAiConfigCache(): void {
  cache = null;
  rateCache = null;
}

/**
 * 解析当前生效配置（DB 优先，env 兜底，带缓存）。
 *
 * 三期起默认走归一化表；`purpose='chat'` 没有可用路由时**静默回落旧路径**，避免迁移
 * 没跑完、路由被清空或数据库刚恢复时让 AI 停摆。显式 `AI_CONFIG_V2=false` 也会读取旧表，
 * 但旧表不再被后台更新，只能作为切换当天的短时历史快照。
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

/* ────────────── 旧表的写路径已全部删除（三期收尾，2026-08-08）──────────────
 *
 * 这里原本有 `setAiConfig` / `addModel` / `updateModel` / `deleteModel` / `activateModel`
 * 与 `syncActiveSetting` / `ensureSeededModels` —— 整套针对 `AiSetting` + `AiModel` 的增删改。
 * 其中 `syncActiveSetting` 就是「拷贝式生效」的实现：把某一行 AiModel 的 8 个字段拷进单例。
 *
 * 三期收尾后**后台只写四张归一化表**（services/aiV2Admin.ts），所以这些全部删除，而不是留着不用：
 * 留着的话，下一个人看到两套写路径并存，迟早会往错的那套上加东西，而两套一分叉，
 * 「后台改完线上没变」就会以新的形态回来。
 *
 * 旧表自本次上线起只读：`getLegacyAiConfig()` 仍读它，作为 `AI_CONFIG_V2=false` 的应急快照；
 * 一次性迁移在 `services/aiConfigMigrate.ts`。观察一个发布周期后按
 * `npm run ai:check-drop` 的结论删列。
 */

/** 把「添加/编辑端点」表单（含未保存改动）解析成可探活的配置；endpointId 传入且 key 空则取该端点已存 key。 */
export async function mergedTestConfig(b: AiEndpointTest): Promise<ResolvedAiConfig> {
  const base = await getAiConfig(true); // 复用 timeoutMs / 全局嵌入兜底
  let apiKey = b.apiKey ?? '';
  // 能力标记不在表单里（它是探活写的，不是运营填的），编辑既有端点时从库里取。
  // 探活正是要验证这些标记，所以必须用被测端点自己的那份，不能用全局配置的。
  let testCaps: unknown = null;
  if (b.endpointId) {
    const row = await prisma.aiEndpoint.findUnique({ where: { id: b.endpointId }, include: { credential: true } });
    if (!apiKey || !apiKey.length) apiKey = readAiCredential(row?.credential.apiKey ?? '');
    testCaps = row?.capsJson ?? null;
  }
  return {
    ...base,
    provider: b.provider,
    label: b.label || base.label,
    baseUrl: b.baseUrl ?? '',
    model: b.model ?? '',
    apiKey,
    embeddingModel: base.embeddingModel,
    thinkingMode: normalizeThinkingMode(b.thinkingMode ?? base.thinkingMode),
    thinkingBudget: normalizeThinkingBudget(b.thinkingBudget ?? base.thinkingBudget),
    temperature: typeof b.temperature === 'number' ? b.temperature : base.temperature,
    // 方言/能力也必须来自被测端点，否则探活验的是另一套请求组装规则。
    dialect: b.dialect ?? null,
    capsJson: testCaps,
    poolBypass: true, // 见下方说明：探活必须打**被测端点本身**
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
