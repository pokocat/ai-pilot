// 海报成品图（canvas_design）的运行时配置：价格 / 日限额 / 并发 / 模板启停 / 图片供应商接入点。
//
// 持久化选型：**复用现成的 FeatureFlag 单行（id='creative-poster'）**，`enabled` 承担运行时开关、
// `payload` 承担全部数值与供应商配置。理由（最小侵入原则）：
//   ① 不新增 prisma 模型 → 生产不用再 db push 一张只有一行的配置表；
//   ② featureFlag.ts 已有「60s 读缓存 + 写时失效」的成熟读写路径，无需重造；
//   ③ 与 review-grace / 告警阈值同一机制，运维心智一致（都是「后台改 payload，约 1 分钟内生效」）。
// 不选 AiSetting：那是对话模型单例，字段是对话语义，塞海报配置会污染 getAiConfig 的口径。
//
// 密钥：供应商 apiKey 经 secretBox 加密后存在 payload 里（与 skillTools 的 encryptHeaderValues 同口径），
// 对外一律只回 hasKey。**env CANVAS_DESIGN_ENABLED 与本行 enabled 两层任一关闭即整体关闭**：
// env 是部署级硬开关（默认 false，先上线代码后放量），DB 是运营的即时熔断闸（行缺省视为开）。
import { env } from '../../env.js';
import { isFeatureEnabled, featureFlagPayload, setFeatureFlag, setFeatureFlagPayload } from '../featureFlag.js';
import { encryptSecret, decryptSecretSafe } from '../secretBox.js';
import type { Prisma } from '@prisma/client';
import type {
  AdminCreativeConfig, AdminCreativeConfigUpdate, AdminCreativeVisualConfig,
} from '../../../../shared/contracts';

export const CREATIVE_FLAG_ID = 'creative-poster';

/** 模板白名单（MVP 三套 3:4）。服务端只认这三个 key，其余一律按 scene 回退默认。 */
export const TEMPLATE_KEYS = ['person_hero', 'editorial', 'business_launch'] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

export const DEFAULT_PRICE_PER_POSTER = 10; // 钻石/张（2026-07-29 拍板，可后台改）
export const DEFAULT_DAILY_LIMIT = 20;      // 每用户每日任务数
const DEFAULT_VISUAL_TIMEOUT_MS = 60_000;
const DEFAULT_VISUAL_SIZE = '1024x1024';

/** 解析后的运行时配置（含明文 apiKey，仅服务端内部使用，绝不下发）。 */
export interface CreativeRuntimeConfig {
  /** env 与 DB 双开的最终结论。 */
  enabled: boolean;
  dbEnabled: boolean;
  envEnabled: boolean;
  pricePerPoster: number;
  dailyLimit: number;
  maxConcurrency: number;
  timeoutMs: number;
  templates: Record<TemplateKey, boolean>;
  visual: {
    enabled: boolean;
    baseUrl: string;
    model: string;
    apiKey: string;
    size: string;
    timeoutMs: number;
    extraParams: Record<string, unknown>;
  };
  imageModerationProvider: 'none' | 'http';
}

type RawPayload = {
  pricePerPoster?: unknown; dailyLimit?: unknown; maxConcurrency?: unknown; timeoutMs?: unknown;
  templates?: unknown; visual?: unknown; imageModerationProvider?: unknown;
};

function num(v: unknown, def: number, min: number, max: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}
function str(v: unknown, def = ''): string {
  return typeof v === 'string' ? v.trim() : def;
}
function plainObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function templatesOf(v: unknown): Record<TemplateKey, boolean> {
  const raw = plainObject(v);
  const out = {} as Record<TemplateKey, boolean>;
  // 缺省一律视为「启用」：运营只需显式停用问题模板，不必先把三个都打开。
  for (const k of TEMPLATE_KEYS) out[k] = raw[k] === undefined ? true : !!raw[k];
  return out;
}

/** 读运行时配置（走 featureFlag 的 60s 缓存；fresh=true 绕过缓存，供后台读回自己刚写的值）。 */
export async function getCreativeConfig(opts: { fresh?: boolean } = {}): Promise<CreativeRuntimeConfig> {
  const [dbEnabled, payloadRaw] = await Promise.all([
    isFeatureEnabled(CREATIVE_FLAG_ID, true, opts),
    featureFlagPayload(CREATIVE_FLAG_ID, opts),
  ]);
  const p = (payloadRaw ?? {}) as RawPayload;
  const visualRaw = plainObject(p.visual);
  const envEnabled = env.canvasDesignEnabled;
  return {
    enabled: envEnabled && dbEnabled,
    dbEnabled,
    envEnabled,
    pricePerPoster: num(p.pricePerPoster, DEFAULT_PRICE_PER_POSTER, 0, 10_000),
    dailyLimit: num(p.dailyLimit, DEFAULT_DAILY_LIMIT, 0, 1000),
    maxConcurrency: num(p.maxConcurrency, env.canvasDesignMaxConcurrency, 1, 8),
    timeoutMs: num(p.timeoutMs, env.canvasDesignTimeoutMs, 10_000, 900_000),
    templates: templatesOf(p.templates),
    visual: {
      enabled: !!(visualRaw.enabled as boolean),
      baseUrl: str(visualRaw.baseUrl),
      model: str(visualRaw.model),
      apiKey: decryptSecretSafe(typeof visualRaw.apiKey === 'string' ? visualRaw.apiKey : ''),
      size: str(visualRaw.size) || DEFAULT_VISUAL_SIZE,
      timeoutMs: num(visualRaw.timeoutMs, DEFAULT_VISUAL_TIMEOUT_MS, 1000, 300_000),
      extraParams: plainObject(visualRaw.extraParams),
    },
    imageModerationProvider: p.imageModerationProvider === 'http' ? 'http' : 'none',
  };
}

/** 图片供应商是否可用（配齐且启用；缺 baseUrl/model 视为未配置 → 任务走纯排版路径，不报错）。 */
export function visualProviderConfigured(cfg: CreativeRuntimeConfig): boolean {
  return cfg.visual.enabled && !!cfg.visual.baseUrl && !!cfg.visual.model;
}

/** 脱敏对外视图（后台 GET 用；apiKey 只回 hasKey）。 */
export function publicCreativeConfig(cfg: CreativeRuntimeConfig): AdminCreativeConfig {
  const visual: AdminCreativeVisualConfig = {
    enabled: cfg.visual.enabled,
    baseUrl: cfg.visual.baseUrl,
    model: cfg.visual.model,
    size: cfg.visual.size,
    timeoutMs: cfg.visual.timeoutMs,
    extraParams: cfg.visual.extraParams,
    hasKey: !!cfg.visual.apiKey,
  };
  return {
    enabled: cfg.dbEnabled,
    envEnabled: cfg.envEnabled,
    pricePerPoster: cfg.pricePerPoster,
    dailyLimit: cfg.dailyLimit,
    maxConcurrency: cfg.maxConcurrency,
    timeoutMs: cfg.timeoutMs,
    templates: cfg.templates,
    visual,
    imageModerationProvider: cfg.imageModerationProvider,
  };
}

/**
 * 写配置（局部更新，未传字段保持原值）。
 * apiKey 语义对齐 aiConfig：`undefined`=不动、`''`=清空、非空=加密写入（明文绝不落库）。
 */
export async function updateCreativeConfig(patch: AdminCreativeConfigUpdate): Promise<AdminCreativeConfig> {
  const cur = await getCreativeConfig({ fresh: true });
  const curEncrypted = ((plainObject((await featureFlagPayload(CREATIVE_FLAG_ID, { fresh: true })) ?? {}).visual as
    Record<string, unknown> | undefined)?.apiKey ?? '') as string;

  const vp = patch.visual ?? {};
  const nextApiKey = vp.apiKey === undefined
    ? curEncrypted                                  // 不动：保留库内密文
    : vp.apiKey === '' ? '' : encryptSecret(vp.apiKey); // 空串=清空；否则加密

  const payload = {
    pricePerPoster: patch.pricePerPoster === undefined ? cur.pricePerPoster : num(patch.pricePerPoster, cur.pricePerPoster, 0, 10_000),
    dailyLimit: patch.dailyLimit === undefined ? cur.dailyLimit : num(patch.dailyLimit, cur.dailyLimit, 0, 1000),
    maxConcurrency: patch.maxConcurrency === undefined ? cur.maxConcurrency : num(patch.maxConcurrency, cur.maxConcurrency, 1, 8),
    timeoutMs: patch.timeoutMs === undefined ? cur.timeoutMs : num(patch.timeoutMs, cur.timeoutMs, 10_000, 900_000),
    templates: patch.templates === undefined ? cur.templates : templatesOf({ ...cur.templates, ...plainObject(patch.templates) }),
    visual: {
      enabled: vp.enabled === undefined ? cur.visual.enabled : !!vp.enabled,
      baseUrl: vp.baseUrl === undefined ? cur.visual.baseUrl : str(vp.baseUrl),
      model: vp.model === undefined ? cur.visual.model : str(vp.model),
      size: vp.size === undefined ? cur.visual.size : (str(vp.size) || DEFAULT_VISUAL_SIZE),
      timeoutMs: vp.timeoutMs === undefined ? cur.visual.timeoutMs : num(vp.timeoutMs, cur.visual.timeoutMs, 1000, 300_000),
      extraParams: vp.extraParams === undefined ? cur.visual.extraParams : plainObject(vp.extraParams),
      apiKey: nextApiKey,
    },
    imageModerationProvider: patch.imageModerationProvider === undefined
      ? cur.imageModerationProvider
      : (patch.imageModerationProvider === 'http' ? 'http' : 'none'),
  };

  await setFeatureFlagPayload(CREATIVE_FLAG_ID, payload as unknown as Prisma.InputJsonValue);
  if (patch.enabled !== undefined) await setFeatureFlag(CREATIVE_FLAG_ID, !!patch.enabled);
  return publicCreativeConfig(await getCreativeConfig({ fresh: true }));
}

/** 功能整体关闭时的统一错误（路由转 403 CANVAS_DISABLED）。 */
export class CanvasDisabledError extends Error {
  statusCode = 403;
  code = 'CANVAS_DISABLED';
  constructor(msg = '海报成品图功能暂未开放') { super(msg); }
}

/** 门禁第一道：功能开关（env && DB 双开）。 */
export async function assertCreativeEnabled(): Promise<CreativeRuntimeConfig> {
  const cfg = await getCreativeConfig();
  if (!cfg.enabled) throw new CanvasDisabledError();
  return cfg;
}
