// 海报成品图（canvas_design）前端共用件：能力状态缓存、字数上限、阶段词表、资产 URL 归一与取图。
// 页面只从这里拿，不各自散写一套——成果卡入口、确认页、详情页三处都要用同一份口径。
//
// 这里**没有**模板目录：启用中的版式清单由 GET /creative/status 下发（CreativeStatusResult.templates）。
// 曾经在本文件硬编码过三套恒可选的版式，结果两件事同时发生：一是本地描述与服务端 TEMPLATE_CATALOG
// 早已漂移（同一套版式在小程序和后台叫不同的东西），二是后台停用某套版式后用户照旧能选中它，
// 而服务端对「显式请求了被停用的版式」一律 422。前端不要再建本地目录。
import Taro from '@tarojs/taro';
import { api, type CreativeStatusResult } from './api';
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

/* ───────────────── 文案字数上限（确认页与详情页共用一份） ───────────────── */

/**
 * 前置校验用的字数上限。**权威在服务端** `server/src/services/creative/schema.ts` 的 LIMITS：
 * 超限一律 422，前端这份只为「敲字时就标红」的即时反馈，不是判定依据。
 * 之所以复制而不是共享：SSOT `shared/contracts.d.ts` 是 .d.ts，放不了运行时值。改服务端那份务必回头改这里。
 *
 * 确认页用全部字段，详情页（改文字 / 换风格）只用其中 4 项——曾经各存一份，
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
