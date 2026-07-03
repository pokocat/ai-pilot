import { createHash, timingSafeEqual } from 'node:crypto';

export interface WechatCodeSession {
  openid: string;
  unionid?: string;
  session_key?: string;
  errcode?: number;
  errmsg?: string;
}

function httpError(message: string, statusCode: number, code: string) {
  return Object.assign(new Error(message), { statusCode, code });
}

/** 读取微信消息推送 Token（用于公众平台/小程序后台“消息推送 URL”验签）。 */
export function wechatMessageToken(): string {
  return (process.env.WECHAT_MESSAGE_TOKEN || process.env.WECHAT_PUSH_TOKEN || process.env.WECHAT_TOKEN || '').trim();
}

/** 微信消息推送明文模式签名：sha1(sort(token,timestamp,nonce).join(''))。 */
export function signWechatMessage(token: string, timestamp: string, nonce: string): string {
  return createHash('sha1')
    .update([token, timestamp, nonce].sort().join(''))
    .digest('hex');
}

function safeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a.toLowerCase(), 'hex');
  const right = Buffer.from(b.toLowerCase(), 'hex');
  if (left.length !== right.length || left.length === 0) return false;
  try {
    return timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

/** 校验微信消息推送 signature。token 未配置或参数不完整时返回 false。 */
export function verifyWechatMessageSignature(args: {
  signature?: string;
  timestamp?: string;
  nonce?: string;
  token?: string;
}): boolean {
  const token = (args.token ?? wechatMessageToken()).trim();
  const signature = args.signature?.trim();
  const timestamp = args.timestamp?.trim();
  const nonce = args.nonce?.trim();
  if (!token || !signature || !timestamp || !nonce) return false;
  return safeEqualHex(signWechatMessage(token, timestamp, nonce), signature);
}

/** 读取小程序 AppID/AppSecret（主用 WECHAT_MINI_*，兼容旧 WECHAT_*）。 */
export function wechatCreds(): { appid: string; secret: string } {
  const appid = process.env.WECHAT_MINI_APPID || process.env.WECHAT_APPID || '';
  const secret = process.env.WECHAT_MINI_SECRET || process.env.WECHAT_APPSECRET || '';
  if (!appid || !secret) {
    throw httpError('未配置微信小程序 AppID/AppSecret', 500, 'WECHAT_CONFIG_MISSING');
  }
  return { appid, secret };
}

export async function code2Session(code: string): Promise<WechatCodeSession> {
  const { appid, secret } = wechatCreds();

  const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
  url.search = new URLSearchParams({
    appid,
    secret,
    js_code: code,
    grant_type: 'authorization_code',
  }).toString();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  let data: WechatCodeSession;
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw httpError(`微信登录接口 HTTP ${res.status}`, 502, 'WECHAT_HTTP_ERROR');
    data = (await res.json()) as WechatCodeSession;
  } catch (e) {
    if ((e as { name?: string })?.name === 'AbortError') {
      throw httpError('微信登录接口超时', 504, 'WECHAT_TIMEOUT');
    }
    if ((e as { statusCode?: number })?.statusCode) throw e;
    throw httpError('微信登录接口不可达', 502, 'WECHAT_NETWORK_ERROR');
  } finally {
    clearTimeout(timer);
  }

  if (data.errcode && data.errcode !== 0) {
    throw httpError(`微信登录失败：${data.errmsg || data.errcode}`, 400, 'WECHAT_CODE_INVALID');
  }
  if (!data.openid) {
    throw httpError('微信登录失败：未返回 openid', 502, 'WECHAT_OPENID_MISSING');
  }
  return data;
}

export function wechatAccountKey(openid: string): string {
  return `wx_${openid.slice(0, 120)}`;
}

// ───────────────────────── 本机号一键登录（getPhoneNumber）─────────────────────────
// 小程序 <button open-type="getPhoneNumber"> 返回一次性 code，后端用 access_token 兑换手机号。
// access_token 走「稳定版」接口（stable_token），避免与其他业务争抢导致互相失效。

async function postJson<T>(url: string, body: object, timeoutMs = 8000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw httpError(`微信接口 HTTP ${res.status}`, 502, 'WECHAT_HTTP_ERROR');
    return (await res.json()) as T;
  } catch (e) {
    if ((e as { name?: string })?.name === 'AbortError') throw httpError('微信接口超时', 504, 'WECHAT_TIMEOUT');
    if ((e as { statusCode?: number })?.statusCode) throw e;
    throw httpError('微信接口不可达', 502, 'WECHAT_NETWORK_ERROR');
  } finally {
    clearTimeout(timer);
  }
}

let tokenCache: { token: string; exp: number } | null = null;

/** 获取（并缓存）小程序全局 access_token；提前 60s 视为过期。 */
export async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (tokenCache && tokenCache.exp > now + 60_000) return tokenCache.token;
  const { appid, secret } = wechatCreds();
  const data = await postJson<{ access_token?: string; expires_in?: number; errcode?: number; errmsg?: string }>(
    'https://api.weixin.qq.com/cgi-bin/stable_token',
    { grant_type: 'client_credential', appid, secret },
  );
  if (!data.access_token) {
    throw httpError(`获取微信 access_token 失败：${data.errmsg || data.errcode || '未知错误'}`, 502, 'WECHAT_TOKEN_FAILED');
  }
  tokenCache = { token: data.access_token, exp: now + (data.expires_in ?? 7200) * 1000 };
  return tokenCache.token;
}

/** 仅供测试：清空 access_token 缓存。 */
export function _resetTokenCache(): void {
  tokenCache = null;
}

interface PhoneInfoResp {
  errcode?: number;
  errmsg?: string;
  phone_info?: { phoneNumber?: string; purePhoneNumber?: string; countryCode?: string };
}

/** 用 getPhoneNumber 返回的 code 兑换手机号；返回不含国家码的纯号码（国内即 11 位）。 */
export async function getPhoneNumberByCode(code: string): Promise<string> {
  const token = await getAccessToken();
  const data = await postJson<PhoneInfoResp>(
    `https://api.weixin.qq.com/wxa/business/getuserphonenumber?access_token=${token}`,
    { code },
  );
  if (data.errcode && data.errcode !== 0) {
    throw httpError(`获取手机号失败：${data.errmsg || data.errcode}`, 400, 'WECHAT_PHONE_FAILED');
  }
  const phone = data.phone_info?.purePhoneNumber || data.phone_info?.phoneNumber;
  if (!phone) throw httpError('获取手机号失败：未返回号码', 502, 'WECHAT_PHONE_MISSING');
  return String(phone).trim();
}

// ───────────────────────── 小程序码（网页卡片 → 小程序回流） ─────────────────────────
// getwxacode/unlimit：scene 携带来源（如 card=daily），码打在 B 级卡片页脚，微信内长按识别直达小程序。
// 铁律：测试环境 / 凭据未配置 / 接口失败一律返回 null——卡片降级为无码，绝不让分享链路被外部依赖卡死。
export async function miniCodeDataUri(scene: string): Promise<string | null> {
  if (process.env.NODE_ENV === 'test') return null;
  let token: string;
  try {
    token = await getAccessToken();
  } catch {
    return null; // 未配置凭据/取 token 失败：降级无码
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`https://api.weixin.qq.com/wxa/getwxacode/unlimit?access_token=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // check_path:false → 不校验 page 已发布；不传 page 默认落在小程序主页，对老版本/体验版都安全
      body: JSON.stringify({ scene: scene.slice(0, 32), width: 280, check_path: false }),
      signal: controller.signal,
    });
    const type = res.headers.get('content-type') || '';
    if (!res.ok || !type.includes('image')) return null; // 出错时微信返回 JSON（如 41030）
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 100) return null;
    return `data:image/png;base64,${buf.toString('base64')}`;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
