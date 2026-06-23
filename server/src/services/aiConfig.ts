// 大模型配置（运营后台可随时切换）。
// 解析优先级：数据库 AiSetting（单例）> 环境变量兜底。带短缓存，避免每次调用查库。
// 未配置真实 key 时 effectiveProvider 自动降级 mock，保证演示永远可跑。
//
// 安全：apiKey 经 secretBox（AES-256-GCM）加密存库（配置 APP_ENCRYPTION_KEY 后生效，未配则透传明文兼容演示）；
//       读取边界解密、写入边界加密；对外一律只回传 hasKey，不出明文。

import { prisma } from '../db.js';
import { env, isRealKey } from '../env.js';
import type { ModelRate } from '../data/modelPrices.js';
import { encryptSecret, decryptSecretSafe } from './secretBox.js';
import type { AiProvider, AiConfig, AiPreset, AiModel, AiModelUpsert, AiModelTest } from '../llm/schema.js';

export interface ResolvedAiConfig {
  provider: AiProvider;
  label: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  embeddingModel: string;
  temperature: number;
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
}

// 内置接入商目录：「添加模型」向导选其一即可一键填好 baseUrl/model（仍可改）。
// 绝大多数国内厂商提供 OpenAI 兼容端点 → provider=openai；Anthropic 用 claude 原生协议。
export const AI_PRESETS: AiPreset[] = [
  { id: 'agnes', label: 'Agnes 2.0 Flash', provider: 'openai', baseUrl: 'https://apihub.agnes-ai.com/v1', model: 'agnes-2.0-flash', note: 'SapiensAI · OpenAI 兼容（含 tool calling）' },
  { id: 'deepseek', label: 'DeepSeek 深度求索', provider: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', note: '深度求索 · OpenAI 兼容' },
  { id: 'qwen', label: '通义千问 Qwen', provider: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', embeddingModel: 'text-embedding-v3', note: '阿里云 · 兼容模式' },
  { id: 'moonshot', label: 'Moonshot 月之暗面 (Kimi)', provider: 'openai', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', note: 'Kimi · OpenAI 兼容' },
  { id: 'glm', label: '智谱 GLM', provider: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus', embeddingModel: 'embedding-3', note: '智谱清言 · OpenAI 兼容' },
  { id: 'doubao', label: '火山方舟 · 豆包', provider: 'openai', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-pro-32k', note: '字节火山引擎 · model 填接入点 ID' },
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
let rateCache: { map: Map<string, ModelRate>; at: number } | null = null;

async function configuredRates(force = false): Promise<Map<string, ModelRate>> {
  if (!force && rateCache && Date.now() - rateCache.at < TTL) return rateCache.map;
  const map = new Map<string, ModelRate>();
  try {
    const rows = await prisma.aiModel.findMany({ select: { model: true, priceInput: true, priceOutput: true, priceCachedInput: true } });
    for (const r of rows) {
      if (r.model && (r.priceInput > 0 || r.priceOutput > 0)) {
        map.set(r.model, { in: r.priceInput, out: r.priceOutput, cachedIn: r.priceCachedInput > 0 ? r.priceCachedInput : undefined });
      }
    }
  } catch {
    /* DB 不可达：留空 → 回退内置价表 */
  }
  rateCache = { map, at: Date.now() };
  return map;
}

/** 解析某模型的成本费率：只用运营在模型配置里填的单价（精确名/前缀命中）。没配 → 0，不回退、不估算。 */
export async function resolveModelRate(model: string): Promise<{ rate: ModelRate; calibrated: boolean }> {
  const cfg = await configuredRates();
  const exact = cfg.get(model);
  if (exact) return { rate: exact, calibrated: true };
  const m = (model || '').toLowerCase();
  // P2-3：取**最长**匹配前缀（而非插入序第一个），避免 `gpt-4` 遮蔽更精确的 `gpt-4o`。
  let best: { len: number; v: ModelRate } | null = null;
  for (const [k, v] of cfg) {
    const kl = k.toLowerCase();
    if (m.startsWith(kl) && (!best || kl.length > best.len)) best = { len: kl.length, v };
  }
  if (best) return { rate: best.v, calibrated: true };
  return { rate: { in: 0, out: 0 }, calibrated: false }; // 没配单价 → 成本计 0（calibrated=false 供上层提示「未校准」）
}

/** 解析当前生效配置（DB 优先，env 兜底，带缓存）。 */
export async function getAiConfig(force = false): Promise<ResolvedAiConfig> {
  if (!force && cache && Date.now() - cache.at < TTL) return cache.cfg;
  let cfg = fromEnv();
  try {
    const row = await prisma.aiSetting.findUnique({ where: { id: 'default' } });
    if (row) {
      cfg = {
        provider: (row.provider as AiProvider) ?? 'mock',
        label: row.label || cfg.label,
        baseUrl: row.baseUrl || cfg.baseUrl,
        model: row.model || cfg.model,
        apiKey: decryptSecretSafe(row.apiKey),
        embeddingModel: row.embeddingModel || '',
        temperature: typeof row.temperature === 'number' ? row.temperature : 0.7,
        timeoutMs: env.openaiTimeoutMs,
        embeddingEnabled: row.embeddingEnabled ?? false,
        embeddingBaseUrl: row.embeddingBaseUrl || '',
        embeddingApiKey: decryptSecretSafe(row.embeddingApiKey),
        rerankEnabled: row.rerankEnabled ?? false,
        rerankModel: row.rerankModel || '',
        rerankBaseUrl: row.rerankBaseUrl || '',
        rerankApiKey: decryptSecretSafe(row.rerankApiKey),
      };
    }
  } catch {
    /* DB 不可达：用 env 兜底 */
  }
  cache = { cfg, at: Date.now() };
  return cfg;
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
  embeddingEnabled?: boolean; embeddingBaseUrl?: string; embeddingApiKey?: string;
  rerankEnabled?: boolean; rerankModel?: string; rerankBaseUrl?: string; rerankApiKey?: string;
}): Promise<ResolvedAiConfig> {
  const data: Record<string, unknown> = {};
  if (patch.provider !== undefined) data.provider = patch.provider;
  if (patch.label !== undefined) data.label = patch.label;
  if (patch.baseUrl !== undefined) data.baseUrl = patch.baseUrl;
  if (patch.model !== undefined) data.model = patch.model;
  if (patch.apiKey !== undefined) data.apiKey = encryptSecret(patch.apiKey); // 空串=清空 key
  if (patch.embeddingModel !== undefined) data.embeddingModel = patch.embeddingModel;
  if (patch.temperature !== undefined) data.temperature = patch.temperature;
  if (patch.embeddingEnabled !== undefined) data.embeddingEnabled = patch.embeddingEnabled;
  if (patch.embeddingBaseUrl !== undefined) data.embeddingBaseUrl = patch.embeddingBaseUrl;
  if (patch.embeddingApiKey !== undefined) data.embeddingApiKey = encryptSecret(patch.embeddingApiKey);
  if (patch.rerankEnabled !== undefined) data.rerankEnabled = patch.rerankEnabled;
  if (patch.rerankModel !== undefined) data.rerankModel = patch.rerankModel;
  if (patch.rerankBaseUrl !== undefined) data.rerankBaseUrl = patch.rerankBaseUrl;
  if (patch.rerankApiKey !== undefined) data.rerankApiKey = encryptSecret(patch.rerankApiKey);

  await prisma.aiSetting.upsert({
    where: { id: 'default' },
    update: data,
    create: {
      id: 'default',
      provider: patch.provider ?? 'openai',
      label: patch.label ?? 'Agnes 2.0 Flash',
      baseUrl: patch.baseUrl ?? 'https://apihub.agnes-ai.com/v1',
      model: patch.model ?? 'agnes-2.0-flash',
      apiKey: encryptSecret(patch.apiKey ?? ''),
      embeddingModel: patch.embeddingModel ?? '',
      temperature: patch.temperature ?? 0.7,
      embeddingEnabled: patch.embeddingEnabled ?? false,
      embeddingBaseUrl: patch.embeddingBaseUrl ?? '',
      embeddingApiKey: encryptSecret(patch.embeddingApiKey ?? ''),
      rerankEnabled: patch.rerankEnabled ?? false,
      rerankModel: patch.rerankModel ?? '',
      rerankBaseUrl: patch.rerankBaseUrl ?? '',
      rerankApiKey: encryptSecret(patch.rerankApiKey ?? ''),
    },
  });
  cache = null;
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
  priceInput: number; priceOutput: number; priceCachedInput: number; updatedAt: Date;
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
    temperature: m.temperature,
    hasKey: isRealKey(decryptSecretSafe(m.apiKey)),
    preset: m.preset ?? null,
    active: !!activeId && m.id === activeId,
    priceInput: m.priceInput ?? 0,
    priceOutput: m.priceOutput ?? 0,
    priceCachedInput: m.priceCachedInput ?? 0,
    updatedAt: m.updatedAt?.toISOString?.(),
  };
}

// 把某个模型的对话字段同步进单例 AiSetting（= 设为生效），并记 activeModelId。
// 注意：嵌入/重排是「全局检索增强」配置，独立于对话模型——切换对话模型不得动 embeddingModel 等，
// 否则会把全局嵌入模型清空（此前 per-model embeddingModel 多为空，切模型即静默清掉 embedding 生效）。
async function syncActiveSetting(m: ModelRow): Promise<void> {
  const fields = {
    provider: m.provider, label: m.label, baseUrl: m.baseUrl, model: m.model,
    // m.apiKey 来自 AiModel（已密文）；encryptSecret 幂等。embeddingModel 不随切换同步（main 06-16）。
    apiKey: encryptSecret(m.apiKey), temperature: m.temperature, activeModelId: m.id,
  };
  await prisma.aiSetting.upsert({
    where: { id: 'default' },
    update: fields,
    create: { id: 'default', ...fields },
  });
  cache = null;
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
        apiKey: encryptSecret(cfg.apiKey), embeddingModel: cfg.embeddingModel, temperature: cfg.temperature,
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

/** 添加模型（不自动生效；进入快速切换列表，由运营点选生效）。 */
export async function addModel(input: AiModelUpsert): Promise<AiModel> {
  const created = await prisma.aiModel.create({
    data: {
      provider: input.provider ?? 'openai',
      label: input.label?.trim() || '未命名模型',
      baseUrl: input.baseUrl?.trim() ?? '',
      model: input.model?.trim() ?? '',
      apiKey: encryptSecret(input.apiKey ?? ''),
      embeddingModel: input.embeddingModel?.trim() ?? '',
      temperature: typeof input.temperature === 'number' ? input.temperature : 0.7,
      preset: input.preset ?? null,
      priceInput: Math.max(0, input.priceInput ?? 0),
      priceOutput: Math.max(0, input.priceOutput ?? 0),
      priceCachedInput: Math.max(0, input.priceCachedInput ?? 0),
    },
  });
  rateCache = null;
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
  if (patch.apiKey !== undefined && patch.apiKey !== '') data.apiKey = encryptSecret(patch.apiKey); // 留空=保留现有 key
  if (patch.embeddingModel !== undefined) data.embeddingModel = patch.embeddingModel.trim();
  if (patch.temperature !== undefined) data.temperature = patch.temperature;
  if (patch.preset !== undefined) data.preset = patch.preset;
  if (patch.priceInput !== undefined) data.priceInput = Math.max(0, patch.priceInput);
  if (patch.priceOutput !== undefined) data.priceOutput = Math.max(0, patch.priceOutput);
  if (patch.priceCachedInput !== undefined) data.priceCachedInput = Math.max(0, patch.priceCachedInput);
  const updated = await prisma.aiModel.update({ where: { id }, data });
  rateCache = null;
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
  if ((!apiKey || !apiKey.length) && b.modelId) {
    const row = await prisma.aiModel.findUnique({ where: { id: b.modelId } });
    apiKey = decryptSecretSafe(row?.apiKey); // 库内密文 → 解密供探活
  }
  return {
    ...base,
    provider: b.provider,
    label: b.label || base.label,
    baseUrl: b.baseUrl ?? '',
    model: b.model ?? '',
    apiKey,
    embeddingModel: b.embeddingModel ?? base.embeddingModel,
    temperature: typeof b.temperature === 'number' ? b.temperature : base.temperature,
  };
}

/** 脱敏对外视图（不含明文 key；独立嵌入/重排 key 只回传是否已配置）。 */
export function publicConfig(cfg: ResolvedAiConfig): AiConfig {
  return {
    provider: cfg.provider,
    label: cfg.label,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    embeddingModel: cfg.embeddingModel,
    temperature: cfg.temperature,
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
