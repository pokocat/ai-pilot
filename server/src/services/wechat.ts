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
