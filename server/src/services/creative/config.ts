// 海报成品图（canvas_design）的运行时配置：开关 / 价格 / 日限额 / 渲染超时 / 模板启停 / 图片供应商接入点。
//
// 持久化选型：**复用现成的 FeatureFlag 单行（id='creative-poster'）**，`enabled` 承担运行时开关、
// `payload` 承担全部数值与供应商配置。理由（最小侵入原则）：
//   ① 不新增 prisma 模型 → 生产不用再 db push 一张只有一行的配置表；
//   ② featureFlag.ts 已有「60s 读缓存 + 写时失效」的成熟读写路径，无需重造；
//   ③ 与 review-grace / 告警阈值同一机制，运维心智一致（都是「后台改 payload，约 1 分钟内生效」）。
// 不选 AiSetting：那是对话模型单例，字段是对话语义，塞海报配置会污染 getAiConfig 的口径。
//
// ★ 开关只有一层（2026-07-29 起）：本行 `enabled` 就是唯一真源，**行缺失视为关**（安全默认——
//   放量动作 = 运营在后台打开，不需要发版也不需要重启）。曾经还有一层部署级 env CANVAS_DESIGN_ENABLED
//   与它取合取，已删除：合取让「后台开了却没生效」变成静默失败，而它作为熔断闸又要 SSH + 重启，
//   比后台点一下慢一个数量级。详见 env.ts 里那段说明。
//
// 密钥：供应商 apiKey 经 secretBox 加密后存在 payload 里（与 skillTools 的 encryptHeaderValues 同口径），
// 对外一律只回 hasKey。
import { isFeatureEnabled, featureFlagPayload, setFeatureFlag, setFeatureFlagPayload } from '../featureFlag.js';
import { encryptSecret, decryptSecretSafe } from '../secretBox.js';
import type { Prisma } from '@prisma/client';
import type {
  AdminCreativeConfig, AdminCreativeConfigUpdate, AdminCreativeVisualConfig,
  PosterTemplateOption,
} from '../../../../shared/contracts';

export const CREATIVE_FLAG_ID = 'creative-poster';

/** 模板白名单（MVP 三套 3:4）。服务端只认这三个 key，未指定时按 scene 回退默认。 */
export const TEMPLATE_KEYS = ['person_hero', 'editorial', 'business_launch'] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

/**
 * 模板中文名与说明的**唯一真源**：由 GET /creative/status 下发给小程序（只发启用中的）。
 * 曾有三份各自维护（app / admin / 这里），到 P4 上线时 app 与 admin 的描述已经对不上 ——
 * 同一套版式在两端叫不同的东西，运营和用户没法对话。前端不要再建本地目录。
 */
export const TEMPLATE_CATALOG: Record<TemplateKey, { name: string; desc: string }> = {
  person_hero: { name: '人物主视觉', desc: '真人照片打底，人物占据主视觉' },
  editorial: { name: '编辑杂志', desc: '杂志内页式排版，图文并重' },
  business_launch: { name: '商业发布', desc: '发布会 / 新品公告气质' },
};

export const DEFAULT_PRICE_PER_POSTER = 10; // 钻石/张（2026-07-29 拍板，可后台改）
export const DEFAULT_DAILY_LIMIT = 20;      // 每用户每日任务数（0 = 不限量）
/**
 * 渲染超时缺省与上限。**上限 480s 是个不变式，不是随手写的数**：
 * worker.ts 的 `STALE_RUNNING_MS`（10 分钟）之后 sweep 会把 running 任务判为卡死并重新入队。
 * 若允许把渲染超时配到大于它，一次正常的长渲染就会在还没结束时被 sweep 抢回队列 →
 * 同一单被跑两遍、产出两张资产。改这两个数其中任何一个都必须回头看另一个。
 */
const DEFAULT_TIMEOUT_MS = 180_000;
export const MAX_TIMEOUT_MS = 480_000;
const DEFAULT_VISUAL_TIMEOUT_MS = 60_000;
const DEFAULT_VISUAL_SIZE = '1024x1024';

/** 解析后的运行时配置（含明文 apiKey，仅服务端内部使用，绝不下发）。 */
export interface CreativeRuntimeConfig {
  /** 功能总开关（= FeatureFlag 行的 enabled；行缺失为 false）。唯一真源，无第二层。 */
  enabled: boolean;
  pricePerPoster: number;
  /** 每人每日任务上限；**0 = 不限量**（紧急停量用 enabled，不要靠把它设成 0）。 */
  dailyLimit: number;
  /** 单次渲染超时（传给 renderPoster）；上限见 MAX_TIMEOUT_MS 的不变式说明。 */
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
}

type RawPayload = {
  pricePerPoster?: unknown; dailyLimit?: unknown; timeoutMs?: unknown;
  templates?: unknown; visual?: unknown;
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

/**
 * 读运行时配置（走 featureFlag 的 60s 缓存；fresh=true 绕过缓存，供后台读回自己刚写的值）。
 * 开关默认 **false**：行缺失 = 未放量。worker 每轮 tick 都调它，靠这层 60s 缓存把 DB 查询压到
 * 每分钟一次（别把 fresh 传进热路径）。
 */
export async function getCreativeConfig(opts: { fresh?: boolean } = {}): Promise<CreativeRuntimeConfig> {
  const [enabled, payloadRaw] = await Promise.all([
    isFeatureEnabled(CREATIVE_FLAG_ID, false, opts),
    featureFlagPayload(CREATIVE_FLAG_ID, opts),
  ]);
  const p = (payloadRaw ?? {}) as RawPayload;
  const visualRaw = plainObject(p.visual);
  return {
    enabled,
    pricePerPoster: num(p.pricePerPoster, DEFAULT_PRICE_PER_POSTER, 0, 10_000),
    dailyLimit: num(p.dailyLimit, DEFAULT_DAILY_LIMIT, 0, 1000),
    timeoutMs: num(p.timeoutMs, DEFAULT_TIMEOUT_MS, 10_000, MAX_TIMEOUT_MS),
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
  };
}

/** 启用中的版式清单（下发给小程序渲染选择器；停用的不出现）。 */
export function enabledTemplateOptions(cfg: CreativeRuntimeConfig): PosterTemplateOption[] {
  return TEMPLATE_KEYS.filter((k) => cfg.templates[k]).map((k) => ({ key: k, ...TEMPLATE_CATALOG[k] }));
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
    enabled: cfg.enabled,
    pricePerPoster: cfg.pricePerPoster,
    dailyLimit: cfg.dailyLimit,
    timeoutMs: cfg.timeoutMs,
    templates: cfg.templates,
    visual,
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
    timeoutMs: patch.timeoutMs === undefined ? cur.timeoutMs : num(patch.timeoutMs, cur.timeoutMs, 10_000, MAX_TIMEOUT_MS),
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
  };

  await setFeatureFlagPayload(CREATIVE_FLAG_ID, payload as unknown as Prisma.InputJsonValue);
  // ★ enabled **每次都显式落一遍**，即使 patch 没带它。
  // 原因：FeatureFlag.enabled 在 prisma 里是 `@default(true)`，而 setFeatureFlagPayload 是 upsert ——
  // 生产库本来没有 'creative-poster' 这一行，运营第一次进后台只改了个单价并保存，行被创建时
  // enabled 就取了默认值 true → **一次改价操作把还没验收的功能放量了**。
  // 这里用 cur.enabled（行缺失时读到 false）兜住：想开就得显式点那个开关。
  await setFeatureFlag(CREATIVE_FLAG_ID, patch.enabled === undefined ? cur.enabled : !!patch.enabled);
  return publicCreativeConfig(await getCreativeConfig({ fresh: true }));
}

/** 功能整体关闭时的统一错误（路由转 403 CANVAS_DISABLED）。 */
export class CanvasDisabledError extends Error {
  statusCode = 403;
  code = 'CANVAS_DISABLED';
  constructor(msg = '海报成品图功能暂未开放') { super(msg); }
}

/** 门禁第一道：功能开关（后台 FeatureFlag 行，行缺失视为关）。 */
export async function assertCreativeEnabled(): Promise<CreativeRuntimeConfig> {
  const cfg = await getCreativeConfig();
  if (!cfg.enabled) throw new CanvasDisabledError();
  return cfg;
}
