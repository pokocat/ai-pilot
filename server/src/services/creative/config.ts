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
  PosterTemplateOption, PosterTier,
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

/**
 * 排版引擎（2026-07-29 第 3 档拍板）。
 * · `'ai'`（**默认**）：模型自己写整张海报的 HTML/CSS（宣言 → 创作 → 量测 → 无条件打磨），
 *   失败一律回落 `'template'` 的完整逻辑，付费任务永不因 AI 引擎失败；
 * · `'template'`：只走三套白名单模板（含图片供应商主视觉），即上一代行为。
 * 取值收窄成联合类型而不是任意字符串：payload 里读到别的值一律按默认处理（见 layoutEngineOf）。
 */
export const LAYOUT_ENGINES = ['ai', 'template'] as const;
export type LayoutEngine = (typeof LAYOUT_ENGINES)[number];
export const DEFAULT_LAYOUT_ENGINE: LayoutEngine = 'ai';

function layoutEngineOf(v: unknown): LayoutEngine {
  return (LAYOUT_ENGINES as readonly string[]).includes(v as string) ? (v as LayoutEngine) : DEFAULT_LAYOUT_ENGINE;
}

/**
 * AI 创作路线（2026-07-30 影像主导模式拍板）。**只在 layoutEngine='ai' 时有意义。**
 * · `'auto'`（**默认**）：模型在宣言阶段自选 graphic / photo（提示词里同时给两个选项）；
 * · `'photo'`：强制影像主导（仍受两条门禁约束，不满足时降 graphic —— 见 posterRoute.ts）；
 * · `'graphic'`：强制纯图形排印（宣言提示词里根本不给 photo 选项，省 token 也免得模型选个走不通的）。
 *
 * 为什么不做成「风险开关」文案：photo 链任一步失败退回 graphic 复用同一篇宣言，再失败才回落模板 ——
 * 交付与计费都不会因它出问题。真正要盯的是任务台上的实际路线（AI 影像 / AI 排版 / 回落模板）。
 */
export const AI_MODES = ['auto', 'graphic', 'photo'] as const;
export type AiMode = (typeof AI_MODES)[number];
export const DEFAULT_AI_MODE: AiMode = 'auto';

function aiModeOf(v: unknown): AiMode {
  return (AI_MODES as readonly string[]).includes(v as string) ? (v as AiMode) : DEFAULT_AI_MODE;
}

/**
 * 图片供应商的接口方言（2026-08-12）。**不是品牌选择，是协议差异**：三家的 images 接口长得像，
 * 但请求体互不兼容，用一套打所有家会稳定翻车。取值收窄成联合类型，脏值按 'openai' 处理。
 */
export const VISUAL_DIALECTS = ['openai', 'ark_seedream', 'gpt_image'] as const;
export type VisualDialect = (typeof VISUAL_DIALECTS)[number];
export const DEFAULT_VISUAL_DIALECT: VisualDialect = 'openai';

function dialectOf(v: unknown): VisualDialect {
  return (VISUAL_DIALECTS as readonly string[]).includes(v as string) ? (v as VisualDialect) : DEFAULT_VISUAL_DIALECT;
}

export const DEFAULT_PRICE_PER_POSTER = 10; // 标准档钻石/张（2026-07-29 拍板，可后台改）
/**
 * 高级档钻石/张。**独立单价而不是倍率**：高级档每单多一次图片大模型调用，成本结构与标准档不同，
 * 倍率会在改标准价时把高级价一起带偏。25 是个起点，上线后按真实供应商成本校准。
 */
export const DEFAULT_PREMIUM_PRICE_PER_POSTER = 25;
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
/**
 * 主视觉尺寸缺省。**3:4，与画布同比**（曾经是 `1024x1024`，那是个从一开始就不对的默认值：
 * 海报画布恒为 3:4，方图铺进去必然被 object-fit:cover 裁掉两侧）。
 *
 * 为什么是 1728×2304 而不是更小的 3:4：Seedream 5.0 有**像素下限 3,686,400**，
 * 1440×1920（2.76M）会被上游直接 400（`image size must be at least 3686400 pixels`）。
 * 1728×2304 = 3,981,312 px，同时满足「正 3:4」与「过下限」。
 * ⚠️ 顺带解释了生产那个 `1440x2560`：它恰好 = 3,686,400，是**为了压线过像素门槛而牺牲了比例**。
 * 两个约束不是二选一 —— 挑一个同时满足的尺寸就行。
 */
const DEFAULT_VISUAL_SIZE = '1728x2304';

/**
 * 主视觉宽高比的合法区间。海报画布是 3:4（0.75）；主视觉是**全幅铺底**，
 * 比例对不上就会被 `object-fit:cover` 裁掉一整条 —— 人像档裁掉的往往正是脸。
 *
 * 区间放宽到 [0.6, 0.9] 是为了容下 `gpt-image-1`：它只提供 1024×1536（2:3 = 0.667），
 * 拿不到正 3:4，轻微上下裁切是可接受的代价。而 9:16（0.5625）这类会被明确拒绝。
 *
 * ⚠️ 2026-08-12 生产实况：这一项当时配的是 `1440x2560`（9:16），也就是**每一张影像主导海报
 * 都在被上下裁掉一大截**，而且完全静默 —— 没有任何日志或指标会提到它。校验放在写入口，
 * 就是要把这种"配得下去、跑起来悄悄坏掉"的值变成一次看得见的保存失败。
 */
export const VISUAL_ASPECT_MIN = 0.6;
export const VISUAL_ASPECT_MAX = 0.9;

/** 配置非法（后台写入口用；路由转 422）。 */
export class CreativeConfigInvalidError extends Error {
  statusCode = 422;
  code = 'CREATIVE_CONFIG_INVALID';
}

/**
 * 校验主视觉尺寸。只校验 `宽x高` 像素形态；`2K` / `1K` 这类厂商预设原样放行
 * （它们的实际比例由 prompt 决定，服务端无从判断）。
 */
export function assertVisualSize(size: string): void {
  const m = /^(\d{2,5})\s*[x×*]\s*(\d{2,5})$/i.exec(size.trim());
  if (!m) return;
  const [w, h] = [Number(m[1]), Number(m[2])];
  if (!w || !h) return;
  const aspect = w / h;
  if (aspect < VISUAL_ASPECT_MIN || aspect > VISUAL_ASPECT_MAX) {
    throw new CreativeConfigInvalidError(
      `主视觉尺寸 ${size} 的宽高比是 ${aspect.toFixed(3)}，与 3:4 画布相差过大：`
      + '主视觉是全幅铺底，比例不符会被裁掉一整条（人像档裁掉的往往就是脸）。'
      + `请填 3:4 的尺寸（如 ${DEFAULT_VISUAL_SIZE}），或改用厂商预设（如 2K）。`,
    );
  }
}

/** 解析后的运行时配置（含明文 apiKey，仅服务端内部使用，绝不下发）。 */
export interface CreativeRuntimeConfig {
  /** 功能总开关（= FeatureFlag 行的 enabled；行缺失为 false）。唯一真源，无第二层。 */
  enabled: boolean;
  pricePerPoster: number;
  /** 高级档单价（图片大模型出主视觉）。 */
  premiumPricePerPoster: number;
  /** 每人每日任务上限；**0 = 不限量**（紧急停量用 enabled，不要靠把它设成 0）。 */
  dailyLimit: number;
  /** 单次渲染超时（传给 renderPoster）；上限见 MAX_TIMEOUT_MS 的不变式说明。 */
  timeoutMs: number;
  /** 排版引擎（默认 'ai'，AI 失败自动回落模板）。 */
  layoutEngine: LayoutEngine;
  /** AI 创作路线（默认 'auto'=模型自选）。只在 layoutEngine='ai' 时被读。 */
  aiMode: AiMode;
  templates: Record<TemplateKey, boolean>;
  visual: {
    enabled: boolean;
    /** 接口方言（决定请求体怎么拼）；脏值按 'openai'。 */
    dialect: VisualDialect;
    baseUrl: string;
    model: string;
    apiKey: string;
    size: string;
    timeoutMs: number;
    extraParams: Record<string, unknown>;
  };
}

type RawPayload = {
  pricePerPoster?: unknown; premiumPricePerPoster?: unknown; dailyLimit?: unknown; timeoutMs?: unknown;
  layoutEngine?: unknown; aiMode?: unknown; templates?: unknown; visual?: unknown;
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
    premiumPricePerPoster: num(p.premiumPricePerPoster, DEFAULT_PREMIUM_PRICE_PER_POSTER, 0, 10_000),
    dailyLimit: num(p.dailyLimit, DEFAULT_DAILY_LIMIT, 0, 1000),
    timeoutMs: num(p.timeoutMs, DEFAULT_TIMEOUT_MS, 10_000, MAX_TIMEOUT_MS),
    // 缺省即 'ai'：这意味着**部署即切 AI 引擎**（运营不需要动配置）。安全性由回落矩阵兜住，
    // 见 worker.ts 的 runPipeline —— AI 引擎任何一步失败都退回模板路径，不影响交付与计费。
    layoutEngine: layoutEngineOf(p.layoutEngine),
    // 缺省 'auto'：模型自选路线。photo 走不通时自动降 graphic（posterRoute.ts 的两条门禁），
    // graphic 走不通时回落模板 —— 所以这个旋钮同样不是风险开关。
    aiMode: aiModeOf(p.aiMode),
    templates: templatesOf(p.templates),
    visual: {
      enabled: !!(visualRaw.enabled as boolean),
      dialect: dialectOf(visualRaw.dialect),
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

/**
 * 高级档此刻能不能下单。
 *
 * 两个条件缺一不可：
 * ① 图片供应商已配置并启用 —— 高级档的全部溢价就是那次图片大模型调用，供应商没配就没有高级档；
 * ② 运营没把 `aiMode` 锁成 `'graphic'` —— 那是「全局禁用影像路线」的熔断闸（比如供应商在出事故），
 *    锁着的时候高级单必然降级成标准产物，那就不该收高级的钱。
 *
 * ⚠️ 这个判断同时供 `GET /creative/status`（决定前端露不露出高级档）与建单闸门用，**必须同一个函数**：
 * 两处各写一遍的下场是前端露着入口、后端一律 422（模板清单当初就是这么对不上的）。
 */
export function premiumTierAvailable(cfg: CreativeRuntimeConfig): boolean {
  return visualProviderConfigured(cfg) && cfg.aiMode !== 'graphic';
}

/** 本单该扣多少钻（档位定价的唯一口径，路由与退款都走它）。 */
export function priceForTier(cfg: CreativeRuntimeConfig, tier: PosterTier): number {
  return tier === 'premium' ? cfg.premiumPricePerPoster : cfg.pricePerPoster;
}

/** 脱敏对外视图（后台 GET 用；apiKey 只回 hasKey）。 */
export function publicCreativeConfig(cfg: CreativeRuntimeConfig): AdminCreativeConfig {
  const visual: AdminCreativeVisualConfig = {
    enabled: cfg.visual.enabled,
    dialect: cfg.visual.dialect,
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
    premiumPricePerPoster: cfg.premiumPricePerPoster,
    dailyLimit: cfg.dailyLimit,
    timeoutMs: cfg.timeoutMs,
    layoutEngine: cfg.layoutEngine,
    aiMode: cfg.aiMode,
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
  // 尺寸校验放在**写入口**：跑起来才发现比例不对的代价是一整批被裁坏的成品图，
  // 而那是静默的（渲染成功、任务是绿的、图是坏的）。
  if (vp.size !== undefined) assertVisualSize(str(vp.size) || DEFAULT_VISUAL_SIZE);
  const nextApiKey = vp.apiKey === undefined
    ? curEncrypted                                  // 不动：保留库内密文
    : vp.apiKey === '' ? '' : encryptSecret(vp.apiKey); // 空串=清空；否则加密

  const payload = {
    pricePerPoster: patch.pricePerPoster === undefined ? cur.pricePerPoster : num(patch.pricePerPoster, cur.pricePerPoster, 0, 10_000),
    premiumPricePerPoster: patch.premiumPricePerPoster === undefined
      ? cur.premiumPricePerPoster
      : num(patch.premiumPricePerPoster, cur.premiumPricePerPoster, 0, 10_000),
    dailyLimit: patch.dailyLimit === undefined ? cur.dailyLimit : num(patch.dailyLimit, cur.dailyLimit, 0, 1000),
    timeoutMs: patch.timeoutMs === undefined ? cur.timeoutMs : num(patch.timeoutMs, cur.timeoutMs, 10_000, MAX_TIMEOUT_MS),
    layoutEngine: patch.layoutEngine === undefined ? cur.layoutEngine : layoutEngineOf(patch.layoutEngine),
    aiMode: patch.aiMode === undefined ? cur.aiMode : aiModeOf(patch.aiMode),
    templates: patch.templates === undefined ? cur.templates : templatesOf({ ...cur.templates, ...plainObject(patch.templates) }),
    visual: {
      enabled: vp.enabled === undefined ? cur.visual.enabled : !!vp.enabled,
      dialect: vp.dialect === undefined ? cur.visual.dialect : dialectOf(vp.dialect),
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
