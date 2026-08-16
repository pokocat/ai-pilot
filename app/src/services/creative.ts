// 海报成品图（canvas_design）前端共用件：能力状态缓存、字数上限、阶段词表、资产 URL 归一与取图。
// 页面只从这里拿，不各自散写一套——成果卡入口、确认页、详情页三处都要用同一份口径。
//
// 这里**没有**模板目录：启用中的版式清单由 GET /creative/status 下发（CreativeStatusResult.templates）。
// 曾经在本文件硬编码过三套恒可选的版式，结果两件事同时发生：一是本地描述与服务端 TEMPLATE_CATALOG
// 早已漂移（同一套版式在小程序和后台叫不同的东西），二是后台停用某套版式后用户照旧能选中它，
// 而服务端对「显式请求了被停用的版式」一律 422。前端不要再建本地目录。
import Taro from '@tarojs/taro';
import {
  api,
  type CreativeStatusResult, type PosterTier, type PosterDirectionOption, type PosterTemplateOption,
} from './api';
import { getApiBaseUrl } from './runtimeMode';
import { getToken } from './token';

/* ───────────────── 能力状态（enabled=false 就整块隐藏入口） ───────────────── */

// 按 token 缓存：换账号必须重取（上一个账号的开关不能沿用）。TTL 用来兜住后台改配置后不用杀进程也能生效。
const STATUS_TTL_MS = 5 * 60_000;
let cache: { token: string; at: number; value: CreativeStatusResult } | null = null;
let inFlight: Promise<CreativeStatusResult | null> | null = null;

/**
 * 取成品图能力状态。失败/未登录一律返回 null —— 调用方按 null 当「不显示入口」处理，
 * 不要把它当成「已关闭」写进任何持久状态。错误已由 request() 统一链路记账（401 全局打断），
 * 这里刻意不弹 toast：成果卡渲染时的探测失败不该打扰用户。
 */
export async function getCreativeStatus(opts: { force?: boolean } = {}): Promise<CreativeStatusResult | null> {
  const token = getToken();
  if (!token) return null;
  if (!opts.force && cache && cache.token === token && Date.now() - cache.at < STATUS_TTL_MS) return cache.value;
  if (inFlight) return inFlight;
  inFlight = api.creativeStatus()
    .then((v) => { cache = { token, at: Date.now(), value: v }; return v; })
    .catch(() => null)
    .finally(() => { inFlight = null; });
  return inFlight;
}

/** 已缓存的状态（同步读，供首帧渲染避免闪动）；没缓存或换了账号返回 null。 */
export function peekCreativeStatus(): CreativeStatusResult | null {
  const token = getToken();
  if (!token || !cache || cache.token !== token) return null;
  return cache.value;
}

/* ───────────────── 军师推荐组合（确认页主视图的数据来源） ───────────────── */

/**
 * 军师给的方案：这张海报按哪条路线、哪个方向、哪套版式出，外加一句为什么。
 * 服务端放在 `PosterBriefDraft.recommendation` 下发（SSOT 在 shared/contracts.d.ts，由服务端组维护）。
 * 确认页据它渲染「方案卡」——用户默认只需要点头，改的人才点开三个入口。
 */
export interface PosterRecommendation {
  tier: PosterTier;
  directionKey: PosterDirectionOption['key'];
  templateKey: string;
  reason: string;
}

/**
 * 推荐组合归一。**两端同一套判据**（原生端在 packages/work/poster/creative.js，逐条对照着写）。
 *
 * 只认「当前 status 清单里真存在」的组合：服务端保证下发那一刻合法，但用户可能停在本页，
 * 期间后台停用了某套版式 / 关掉了高级路线 —— 拿一个已停用的 key 当默认值，用户点「生成」必 422，
 * 而他压根没做过这个选择。任一项对不上就整条作废，页面回退现行为（按现逻辑预选 + 把选择器展开），
 * 不半信半疑地用一半。老服务端不下发这个字段时同样返回 null。
 */
export function normalizeRecommendation(
  raw: unknown,
  ctx: { directions: PosterDirectionOption[]; templates: PosterTemplateOption[]; premiumAvailable: boolean },
): PosterRecommendation | null {
  const r = raw as { tier?: unknown; directionKey?: unknown; templateKey?: unknown; reason?: unknown } | null;
  if (!r || typeof r !== 'object') return null;
  // 高级路线不可用却推了高级：整条作废，不悄悄降标准 —— 降了之后方案卡上的价格与那句
  // 「军师为什么这么定」就对不上，用户看到的是一句解释配着另一档的价。
  if (r.tier === 'premium' && ctx.premiumAvailable !== true) return null;
  const tier: PosterTier = r.tier === 'premium' ? 'premium' : 'standard';
  const direction = ctx.directions.find((item) => item.key === r.directionKey && item.tier === tier);
  const template = ctx.templates.find((item) => item.key === r.templateKey);
  if (!direction || !template) return null;
  return { tier, directionKey: direction.key, templateKey: template.key, reason: String(r.reason ?? '').trim() };
}

/* ───────────────── 文案字数上限（确认页与详情页共用一份） ───────────────── */

/**
 * 前置校验用的字数上限。**权威在服务端** `server/src/services/creative/schema.ts` 的 LIMITS：
 * 超限一律 422，前端这份只为「敲字时就标红」的即时反馈，不是判定依据。
 * 之所以复制而不是共享：SSOT `shared/contracts.d.ts` 是 .d.ts，放不了运行时值。改服务端那份务必回头改这里。
 *
 * 确认页用全部字段，详情页（改文字 / 换方向）只用其中 4 项——曾经各存一份，
 * 结果同一个上限有两个来源，改一处漏一处就会出现「前端放行、服务端 422」。
 */
export const POSTER_LIMITS = {
  goal: 60,
  audience: 40,
  headline: 20,
  subheadline: 30,
  proofPoint: 20,
  cta: 15,
  visualDirection: 100,
} as const;

/* ───────────────── 制作中阶段文案（服务端 progress 取值 → 用户可读） ───────────────── */

/** 服务端 progress 的取值顺序，详情页照它画进度点（顺序即阶段先后）。 */
export const PROGRESS_STAGES = ['philosophy', 'visual', 'render', 'upload'] as const;
export type PosterProgressStage = typeof PROGRESS_STAGES[number];

const PROGRESS_TEXT: Record<string, string> = {
  philosophy: '构思视觉',
  visual: '生成主视觉',
  render: '排版渲染',
  upload: '上传收尾',
};
export function progressText(progress?: string): string {
  return PROGRESS_TEXT[progress ?? ''] ?? '构思视觉';
}

/* ───────────────── 资产 URL ───────────────── */

/**
 * 归一资产链接。服务端配了 OSS 时给的是绝对短签名 URL（600 秒，**不要缓存**）；
 * 未配 OSS 时给的是相对路径 `/api/creative/assets/:id/file`，必须补上 API 源站才能下载。
 */
export function absoluteCreativeUrl(url?: string): string {
  const u = String(url ?? '').trim();
  if (!u) return '';
  if (/^(https?:|data:)/i.test(u)) return u;
  const origin = getApiBaseUrl().replace(/\/api\/?$/, '').replace(/\/$/, '');
  return `${origin}${u.startsWith('/') ? '' : '/'}${u}`;
}

/**
 * 取成品图本地临时文件路径（保存相册 / 转发好友都要本地文件）。
 * - data: URI（mock 占位图）→ 写进本地文件系统，不走网络；
 * - 其余 → downloadFile（自有域名端点要带登录头）。
 * 失败抛错，由调用方给可读提示。
 */
export async function fetchPosterFile(url?: string): Promise<string> {
  const u = absoluteCreativeUrl(url);
  if (!u) throw new Error('成品图链接已失效');
  if (u.startsWith('data:')) {
    const base64 = u.slice(u.indexOf(',') + 1);
    const fs = Taro.getFileSystemManager?.();
    const dir = (Taro.env as { USER_DATA_PATH?: string } | undefined)?.USER_DATA_PATH;
    if (!fs || !dir) throw new Error('当前环境不支持保存图片');
    const path = `${dir}/poster-${Date.now()}.png`;
    fs.writeFileSync(path, base64, 'base64');
    return path;
  }
  const res = await Taro.downloadFile({ url: u, header: { 'x-user-id': getToken() } });
  if (res.statusCode !== 200 || !res.tempFilePath) throw new Error('成品图下载失败');
  return res.tempFilePath;
}
