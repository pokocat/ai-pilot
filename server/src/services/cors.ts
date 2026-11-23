// 浏览器跨域白名单（2026-11-23：声量AI 网页直连军师后端，`origin:true` 收成白名单）。
//
// · 小程序 `wx.request`、服务端之间的调用都不带 Origin，不受本白名单影响。
// · `CORS_ALLOWED_ORIGINS`（逗号分隔，逐字符比对 scheme://host[:port]）配了就只认它；
//   留空用下面的内置清单：军师自己的 H5/PC 域名 + 声量AI 的线上域名。
// · 非 production 另外放行任意 `http://localhost:<port>` / `http://127.0.0.1:<port>`（本地开发，
//   声量AI 网页 dev 端口 3013、军师 H5 5173、后台 5174）。production 不放行 localhost。
// · SSE 接口（/generate、/generations/:id/stream）用 `reply.raw.writeHead` 直接写头，
//   @fastify/cors 挂在 reply 上的头不会跟着发出，所以 SSE 自己调 `sseCorsHeaders()` 补同一套口径。
import type { FastifyReply } from 'fastify';

export const DEFAULT_CORS_ORIGINS = [
  'https://aibuzz.cn',
  'https://www.aibuzz.cn',
  'https://wxapi.aibuzz.cn',
  'https://copilot.aibuzz.cn',
  // 声量AI 主站（StudioBridge.WEB_ORIGIN 与账号中心 web-aiavatar 回调域名）
  'https://aiavatar.aibuzz.cn',
  'https://aistar.aibuzz.cn',
  'https://www.aistar.aibuzz.cn',
];

const LOCAL_DEV = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/;

export function corsAllowedOrigins(): string[] {
  const raw = (process.env.CORS_ALLOWED_ORIGINS ?? '').trim();
  if (!raw) return [...DEFAULT_CORS_ORIGINS];
  return raw.split(',').map((item) => item.trim().replace(/\/+$/, '')).filter(Boolean);
}

export function isCorsOriginAllowed(origin: string | undefined | null): boolean {
  if (!origin) return false;
  if (corsAllowedOrigins().includes(origin)) return true;
  return process.env.NODE_ENV !== 'production' && LOCAL_DEV.test(origin);
}

/** SSE 用：请求来自白名单 Origin 时回显它；否则一个 CORS 头都不给（浏览器拦，非浏览器无影响）。 */
export function sseCorsHeaders(reply: FastifyReply): Record<string, string> {
  const raw = reply.request?.headers?.origin;
  const origin = Array.isArray(raw) ? raw[0] : raw;
  return isCorsOriginAllowed(origin) ? { 'Access-Control-Allow-Origin': origin!, Vary: 'Origin' } : {};
}
