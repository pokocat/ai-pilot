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

export async function code2Session(code: string): Promise<WechatCodeSession> {
  const appid = process.env.WECHAT_MINI_APPID || process.env.WECHAT_APPID || '';
  const secret = process.env.WECHAT_MINI_SECRET || process.env.WECHAT_APPSECRET || '';
  if (!appid || !secret) {
    throw httpError('未配置微信小程序 AppID/AppSecret', 500, 'WECHAT_CONFIG_MISSING');
  }

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
