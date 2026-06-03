// 大模型配置（运营后台可随时切换）。
// 解析优先级：数据库 AiSetting（单例）> 环境变量兜底。带短缓存，避免每次调用查库。
// 未配置真实 key 时 effectiveProvider 自动降级 mock，保证演示永远可跑。
//
// 安全：apiKey 在库中明文存储仅为演示便利；生产应加密 / 接密管，且对外只回传 hasKey。

import { prisma } from '../db.js';
import { env, isRealKey } from '../env.js';
import type { AiProvider, AiConfig, AiPreset } from '../llm/schema.js';

export interface ResolvedAiConfig {
  provider: AiProvider;
  label: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  embeddingModel: string;
  temperature: number;
  timeoutMs: number;
}

// 一键预设：常见大模型的 baseUrl/model（默认 Agnes 2.0 Flash）。
export const AI_PRESETS: AiPreset[] = [
  { id: 'agnes', label: 'Agnes 2.0 Flash', provider: 'openai', baseUrl: 'https://apihub.agnes-ai.com/v1', model: 'agnes-2.0-flash', note: 'SapiensAI · OpenAI 兼容（含 tool calling）' },
  { id: 'deepseek', label: 'DeepSeek', provider: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', note: '深度求索' },
  { id: 'qwen', label: '通义千问 Qwen', provider: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', embeddingModel: 'text-embedding-v3', note: '阿里云 · 兼容模式' },
  { id: 'moonshot', label: 'Moonshot (Kimi)', provider: 'openai', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', note: '月之暗面' },
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
  };
}

let cache: { cfg: ResolvedAiConfig; at: number } | null = null;
const TTL = 4000;

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
        apiKey: row.apiKey || '',
        embeddingModel: row.embeddingModel || '',
        temperature: typeof row.temperature === 'number' ? row.temperature : 0.7,
        timeoutMs: env.openaiTimeoutMs,
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

/** 写入配置（apiKey 仅在显式传入非 undefined 时更新）。 */
export async function setAiConfig(patch: {
  provider?: AiProvider; label?: string; baseUrl?: string; model?: string;
  apiKey?: string; embeddingModel?: string; temperature?: number;
}): Promise<ResolvedAiConfig> {
  const data: Record<string, unknown> = {};
  if (patch.provider !== undefined) data.provider = patch.provider;
  if (patch.label !== undefined) data.label = patch.label;
  if (patch.baseUrl !== undefined) data.baseUrl = patch.baseUrl;
  if (patch.model !== undefined) data.model = patch.model;
  if (patch.apiKey !== undefined) data.apiKey = patch.apiKey; // 空串=清空 key
  if (patch.embeddingModel !== undefined) data.embeddingModel = patch.embeddingModel;
  if (patch.temperature !== undefined) data.temperature = patch.temperature;

  await prisma.aiSetting.upsert({
    where: { id: 'default' },
    update: data,
    create: {
      id: 'default',
      provider: patch.provider ?? 'openai',
      label: patch.label ?? 'Agnes 2.0 Flash',
      baseUrl: patch.baseUrl ?? 'https://apihub.agnes-ai.com/v1',
      model: patch.model ?? 'agnes-2.0-flash',
      apiKey: patch.apiKey ?? '',
      embeddingModel: patch.embeddingModel ?? '',
      temperature: patch.temperature ?? 0.7,
    },
  });
  cache = null;
  return getAiConfig(true);
}

/** 脱敏对外视图（不含明文 key）。 */
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
  };
}
