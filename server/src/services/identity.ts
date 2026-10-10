// 统一账号中心（aibuzz-id / id.aibuzz.cn）RS256 令牌验签 —— 纯计算 + 取 JWKS，**不碰数据库**。
//
// 口径对齐 AIStarEcosystem 的 `com.aistareco.aep.identity.IdentityTokenVerifier`（已上线）：
// 验签名（JWKS 远端公钥，缓存 + 未知 kid 立即刷新一次）、`iss` 逐字符相等、`exp` 未过、
// `aud` 含本产品 audience 之一。
//
// **§8.0 合规（fail-closed）**：`ID_ISSUER` 留空 = 本能力整体关闭 —— RS256 令牌一律验不过，
// 调用方据此让它落 401。**不存在**「没配就放行 / 本地伪造 uid」的降级路径；关闭态下老的
// `x-user-id`（HS256 / 历史 userId）链路完全不受影响。
//
// 依赖上刻意只用 Node 内置 `crypto`：`createPublicKey({ key: jwk, format: 'jwk' })` 把 JWK 转成
// KeyObject，再 `crypto.verify('sha256', …)`（RSA 默认 PKCS#1 v1.5 padding = RS256）。不引 jose。
import { createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';

/** 允许的时钟偏差（秒）。与 Spring Security `JwtTimestampValidator` 的默认值一致。 */
const CLOCK_SKEW_SEC = 60;
/** JWKS 缓存有效期（毫秒）。契约固定 10 分钟。 */
const JWKS_TTL_MS = 10 * 60 * 1000;
/** 取 JWKS / userinfo 的单次超时（毫秒）。账号中心抖动不该把业务请求吊死。 */
const IDENTITY_HTTP_TIMEOUT_MS = 5000;
/**
 * 爱速拍的 audience。**只有它**享受 `/api/video/**` 免套餐闸（见 `app.ts` 禁写闸里的说明）：
 * 爱速拍按钻石计量、不卖军师套餐；军师自己的令牌（`x-user-id` / `junshi-api`）行为一字不变。
 */
export const QUICKREEL_AUDIENCE = 'quickreel-api';
/** 军师自己的 audience。 */
export const JUNSHI_AUDIENCE = 'junshi-api';
/** 默认产品 audience（爱速拍 + 军师）。 */
const DEFAULT_AUDIENCES = [QUICKREEL_AUDIENCE, JUNSHI_AUDIENCE];

export interface IdentityClaims {
  /** 账号中心 uid。 */
  sub: string;
  iss: string;
  aud: string[];
  exp: number;
  /** 令牌里的 `phone_verified`；账号中心保证总是有这个 claim。缺失按 false（fail-closed）。 */
  phoneVerified: boolean;
  azp?: string;
  scope?: string;
}

export class IdentityError extends Error {
  statusCode: number;
  code: string;
  constructor(message: string, statusCode: number, code: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

/** `ID_ISSUER` 原样（只 trim）。`iss` 逐字符比对用它，不做任何归一化。 */
export function identityIssuer(): string {
  return (process.env.ID_ISSUER ?? '').trim();
}

/** 拼 JWKS / userinfo / 产品接口地址用的 base（去掉末尾斜杠）。 */
export function identityBaseUrl(): string {
  return identityIssuer().replace(/\/+$/, '');
}

/**
 * 配置是否可用。留空 = 关闭；生产环境非 https 的 issuer 视为配错，同样关闭（并非静默放行：
 * 关闭态下 RS256 令牌一律验不过 → 401）。
 */
export function identityEnabled(): boolean {
  const issuer = identityIssuer();
  if (!issuer) return false;
  if (process.env.NODE_ENV === 'production' && !issuer.startsWith('https://')) {
    warnOnce('id-issuer-not-https', '[identity] 生产环境 ID_ISSUER 必须是 https，当前配置已被拒绝，账号中心接入保持关闭');
    return false;
  }
  return true;
}

/** 本服务接受的 audience 列表。`ID_AUDIENCES` 逗号分隔，留空用默认两项。 */
export function identityAudiences(): string[] {
  const raw = (process.env.ID_AUDIENCES ?? '').trim();
  if (!raw) return [...DEFAULT_AUDIENCES];
  const list = raw.split(',').map((item) => item.trim()).filter(Boolean);
  return list.length ? list : [...DEFAULT_AUDIENCES];
}

/** JWKS 地址。契约固定为 `${ID_ISSUER}/oauth2/jwks`（见 aibuzz-id README §4）。 */
export function identityJwksUri(): string {
  return `${identityBaseUrl()}/oauth2/jwks`;
}

const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

/* ────────────────────────── JWKS 缓存 ────────────────────────── */

interface JwksCache { issuer: string; fetchedAt: number; keys: Map<string, KeyObject> }
let jwks: JwksCache = { issuer: '', fetchedAt: 0, keys: new Map() };
let jwksInflight: Promise<void> | null = null;

/** 仅测试/运维用：丢弃 JWKS 缓存（换 issuer 或换密钥后重新拉）。 */
export function resetIdentityJwksCache(): void {
  jwks = { issuer: '', fetchedAt: 0, keys: new Map() };
  jwksInflight = null;
  warned.clear();
}

function jwkToKey(jwk: Record<string, unknown>): KeyObject | null {
  if (jwk.kty !== 'RSA') return null;          // 只接受 RSA —— 契约里签名算法固定 RS256
  if (jwk.use && jwk.use !== 'sig') return null; // 加密用途的公钥不能拿来验签
  if (jwk.alg && jwk.alg !== 'RS256') return null;
  try {
    const key = createPublicKey({ key: jwk as never, format: 'jwk' });
    return key.asymmetricKeyType === 'rsa' ? key : null;
  } catch { return null; }
}

async function fetchJwks(): Promise<void> {
  const issuer = identityIssuer();
  const uri = identityJwksUri();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), IDENTITY_HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(uri, { headers: { accept: 'application/json' }, signal: ctrl.signal, redirect: 'error' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json() as { keys?: unknown };
    const rows = Array.isArray(body?.keys) ? body.keys : [];
    const keys = new Map<string, KeyObject>();
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const jwk = row as Record<string, unknown>;
      const kid = typeof jwk.kid === 'string' ? jwk.kid : '';
      const key = jwkToKey(jwk);
      if (!key) continue;
      // 没有 kid 的公钥也收下（用空串占位），验签时会退化成「逐个试」。
      keys.set(kid, key);
    }
    if (!keys.size) throw new Error('JWKS 里没有可用的 RS256 公钥');
    // 拉成功才整体替换：拉失败保留旧缓存，账号中心短暂抖动不至于把所有人挡在门外。
    jwks = { issuer, fetchedAt: Date.now(), keys };
  } finally {
    clearTimeout(timer);
  }
}

/** 刷新 JWKS。并发只发一次请求；失败不缓存失败态（下次仍会重试）。 */
async function refreshJwks(): Promise<void> {
  if (jwksInflight) return jwksInflight;
  jwksInflight = fetchJwks().catch((err) => {
    console.warn(`[identity] 拉取 JWKS 失败 uri=${identityJwksUri()}：${(err as Error).message}`);
  }).finally(() => { jwksInflight = null; });
  return jwksInflight;
}

function cacheUsable(): boolean {
  return jwks.issuer === identityIssuer() && jwks.keys.size > 0 && Date.now() - jwks.fetchedAt < JWKS_TTL_MS;
}

/* ────────────────────────── 令牌解析与校验 ────────────────────────── */

interface ParsedJwt {
  kid: string;
  signingInput: string;
  signature: Buffer;
  payload: Record<string, unknown>;
}

function fromB64url(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** 拆开一枚 RS256 JWT。不是 RS256 三段式 JWT 一律返回 null（老的 HS256 token 走这条路被忽略）。 */
function parseRs256Jwt(token: string): ParsedJwt | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  if (!h || !p || !s) return null;
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(fromB64url(h).toString('utf8')) as Record<string, unknown>;
    payload = JSON.parse(fromB64url(p).toString('utf8')) as Record<string, unknown>;
  } catch { return null; }
  if (header.alg !== 'RS256') return null; // 只认 RS256：alg=none / HS256 混淆一律拒
  return {
    kid: typeof header.kid === 'string' ? header.kid : '',
    signingInput: `${h}.${p}`,
    signature: fromB64url(s),
    payload,
  };
}

function audienceOf(payload: Record<string, unknown>): string[] {
  const raw = payload.aud;
  if (typeof raw === 'string') return [raw];
  if (Array.isArray(raw)) return raw.filter((item): item is string => typeof item === 'string');
  return [];
}

/** 校验 claims（签名之外的部分）。不合法返回 null。 */
function validateClaims(payload: Record<string, unknown>): IdentityClaims | null {
  const sub = typeof payload.sub === 'string' ? payload.sub.trim() : '';
  if (!sub) return null;
  if (payload.iss !== identityIssuer()) return null;               // 逐字符相等
  const now = Math.floor(Date.now() / 1000);
  const exp = typeof payload.exp === 'number' ? payload.exp : 0;
  if (!exp || exp + CLOCK_SKEW_SEC <= now) return null;            // 过期
  if (typeof payload.nbf === 'number' && payload.nbf - CLOCK_SKEW_SEC > now) return null;
  const aud = audienceOf(payload);
  const accepted = identityAudiences();
  if (!aud.some((item) => accepted.includes(item))) return null;   // aud 不匹配
  return {
    sub,
    iss: String(payload.iss),
    aud,
    exp,
    // 账号中心恒带这个 claim；缺失/非 true 一律按「没有可信手机号」处理。
    phoneVerified: payload.phone_verified === true,
    ...(typeof payload.azp === 'string' ? { azp: payload.azp } : {}),
    ...(typeof payload.scope === 'string' ? { scope: payload.scope }
      : Array.isArray(payload.scope) && payload.scope.every((scope) => typeof scope === 'string')
        ? { scope: payload.scope.join(' ') } : {}),
  };
}

function verifySignature(parsed: ParsedJwt): boolean {
  const data = Buffer.from(parsed.signingInput, 'utf8');
  const candidates: KeyObject[] = [];
  const exact = parsed.kid ? jwks.keys.get(parsed.kid) : undefined;
  if (exact) candidates.push(exact);
  // 令牌没带 kid（或 JWKS 里的公钥没有 kid）时退化成逐个试；有 kid 且命中则只试那一把。
  if (!exact) for (const key of jwks.keys.values()) candidates.push(key);
  for (const key of candidates) {
    try { if (cryptoVerify('sha256', data, key, parsed.signature)) return true; } catch { /* 换下一把 */ }
  }
  return false;
}

/**
 * **同步**校验（只用进程内已缓存的 JWKS，绝不发起网络请求）。
 * 缓存里没有对应公钥时返回 null —— 调用方（限流键）退回按 IP 分桶即可，绝不放行。
 */
export function verifyIdentityTokenCached(token: string): IdentityClaims | null {
  if (!identityEnabled()) return null;
  const parsed = parseRs256Jwt(token);
  if (!parsed) return null;
  if (!cacheUsable()) return null;
  if (!verifySignature(parsed)) return null;
  return validateClaims(parsed.payload);
}

/**
 * 校验账号中心令牌。缓存过期或遇未知 `kid` 时刷新一次 JWKS 再试。
 * 任何不合法（未开启 / 非 RS256 / 签名不对 / iss/exp/aud 不满足）都返回 null，由调用方落 401。
 */
export async function verifyIdentityToken(token: string): Promise<IdentityClaims | null> {
  if (!identityEnabled()) return null;
  const parsed = parseRs256Jwt(token);
  if (!parsed) return null;
  // claims 先过一遍：iss/aud/exp 不对的令牌不值得为它去打一次 JWKS。
  const claims = validateClaims(parsed.payload);
  if (!claims) return null;
  if (cacheUsable() && verifySignature(parsed)) return claims;
  await refreshJwks();
  if (!cacheUsable()) return null;
  return verifySignature(parsed) ? claims : null;
}

/** 从请求头取 Bearer 令牌；没有则空串。 */
export function bearerOf(headers: Record<string, unknown>): string {
  const raw = headers['authorization'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return '';
  const m = /^Bearer\s+(.+)$/i.exec(value.trim());
  return m ? m[1].trim() : '';
}

/* ────────────────────────── userinfo ────────────────────────── */

export interface IdentityUserinfo {
  sub: string;
  phone: string;
  phoneVerified: boolean;
  name: string;
  picture?: string | null;
}

/**
 * 用**用户自己那张** access token 读 `GET ${ID_ISSUER}/userinfo`。
 *
 * 手机号只在授权含 scope `phone` 时才给，字段名是 OIDC 标准的 `phone_number`
 * （aibuzz-id `IdOidcUserInfoMapper`；README §4 里写的「phone」指的是 scope 名，不是字段名）。
 * 兼容读一下 `phone`，以防对端将来加别名。
 */
export async function fetchIdentityUserinfo(bearer: string): Promise<IdentityUserinfo> {
  if (!identityEnabled()) throw new IdentityError('账号服务尚未配置', 503, 'IDENTITY_NOT_CONFIGURED');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), IDENTITY_HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(`${identityBaseUrl()}/userinfo`, {
      headers: { accept: 'application/json', authorization: `Bearer ${bearer}` },
      signal: ctrl.signal,
      redirect: 'error',
    });
    if (res.status === 401 || res.status === 403) {
      throw new IdentityError('登录已失效，请重新登录', 401, 'UNAUTHORIZED');
    }
    if (!res.ok) throw new IdentityError('账号服务暂时不可用，请稍后再试', 502, 'IDENTITY_UPSTREAM_FAILED');
    const body = await res.json() as Record<string, unknown>;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new IdentityError('账号资料格式异常，请稍后再试', 502, 'IDENTITY_USERINFO_INVALID');
    }
    const phoneRaw = body.phone_number ?? body.phone;
    for (const key of ['phone_number_verified', 'phone_verified']) {
      if (key in body && typeof body[key] !== 'boolean') {
        throw new IdentityError('账号资料格式异常，请稍后再试', 502, 'IDENTITY_USERINFO_INVALID');
      }
    }
    if (phoneRaw != null && typeof phoneRaw !== 'string'
      || 'name' in body && typeof body.name !== 'string'
      || body.picture != null && typeof body.picture !== 'string') {
      throw new IdentityError('账号资料格式异常，请稍后再试', 502, 'IDENTITY_USERINFO_INVALID');
    }
    if (typeof body.picture === 'string' && body.picture !== '' && !/^https:\/\//.test(body.picture)) {
      throw new IdentityError('账号头像格式异常，请稍后再试', 502, 'IDENTITY_USERINFO_INVALID');
    }
    return {
      sub: typeof body.sub === 'string' ? body.sub : '',
      phone: typeof phoneRaw === 'string' ? phoneRaw.trim().replace(/^\+86/, '') : '',
      phoneVerified: 'phone_number_verified' in body ? body.phone_number_verified === true : body.phone_verified === true,
      name: [body.name, body.nickname].find((item) => typeof item === 'string' && item.trim())
        ? String([body.name, body.nickname].find((item) => typeof item === 'string' && item.trim())).trim()
        : '',
      ...('picture' in body ? { picture: body.picture ? String(body.picture) : null } : {}),
    };
  } catch (err) {
    if (err instanceof IdentityError) throw err;
    if (/abort/i.test((err as Error).message)) throw new IdentityError('账号服务响应超时，请稍后再试', 504, 'IDENTITY_UPSTREAM_TIMEOUT');
    throw new IdentityError('账号服务连接失败，请稍后再试', 502, 'IDENTITY_UPSTREAM_FAILED');
  } finally {
    clearTimeout(timer);
  }
}

/* ────────────────────────── 产品链接回报（可选，§9.2） ────────────────────────── */

/** `aud` → 账号中心 product code。两个产品各自的服务令牌只能读写自己那条线。 */
const PRODUCT_BY_AUDIENCE: Record<string, string> = { [QUICKREEL_AUDIENCE]: 'quickreel', [JUNSHI_AUDIENCE]: 'junshi' };

export function productCodeOf(aud: string[]): string {
  for (const item of aud) if (PRODUCT_BY_AUDIENCE[item]) return PRODUCT_BY_AUDIENCE[item];
  return '';
}

function serverClient(): { id: string; secret: string } | null {
  const id = (process.env.ID_SERVER_CLIENT_ID ?? '').trim();
  const secret = (process.env.ID_SERVER_CLIENT_SECRET ?? '').trim();
  return id && secret ? { id, secret } : null;
}

let serviceToken: { value: string; expiresAt: number } | null = null;

async function serviceAccessToken(): Promise<string> {
  const client = serverClient();
  if (!client) throw new IdentityError('未配置机密客户端', 503, 'IDENTITY_CLIENT_NOT_CONFIGURED');
  if (serviceToken && serviceToken.expiresAt > Date.now() + 30_000) return serviceToken.value;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), IDENTITY_HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(`${identityBaseUrl()}/oauth2/token`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`${encodeURIComponent(client.id)}:${encodeURIComponent(client.secret)}`).toString('base64')}`,
      },
      body: 'grant_type=client_credentials&scope=product.link',
      signal: ctrl.signal,
      redirect: 'error',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json() as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error('响应缺少 access_token');
    serviceToken = {
      value: body.access_token,
      expiresAt: Date.now() + Math.max(30, Number(body.expires_in ?? 300)) * 1000,
    };
    return serviceToken.value;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 首登建档后回报产品链接（aibuzz-id README §9.2）。**best-effort**：
 * 未配机密客户端就跳过并 WARN 一次；失败只记日志，绝不把用户挡在登录外。
 */
export async function reportProductLink(opts: { uid: string; localUserId: string; aud: string[] }): Promise<void> {
  if (!identityEnabled()) return;
  if (!serverClient()) {
    warnOnce('id-server-client', '[identity] 未配置 ID_SERVER_CLIENT_ID / ID_SERVER_CLIENT_SECRET，跳过产品链接回报');
    return;
  }
  const product = productCodeOf(opts.aud);
  if (!product) {
    warnOnce('id-product-code', `[identity] 令牌 aud 无法映射到 product code，跳过产品链接回报 aud=${opts.aud.join(',')}`);
    return;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), IDENTITY_HTTP_TIMEOUT_MS);
  try {
    const token = await serviceAccessToken();
    const res = await fetch(`${identityBaseUrl()}/api/products/${encodeURIComponent(product)}/links/${encodeURIComponent(opts.uid)}`, {
      method: 'PUT',
      headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ localSubjectId: opts.localUserId, status: 'PROVISIONED' }),
      signal: ctrl.signal,
      redirect: 'error',
    });
    if (!res.ok) {
      if (res.status === 401) serviceToken = null; // 令牌被吊销/过期，下次重新换
      console.warn(`[identity] 产品链接回报失败 product=${product} uid=${opts.uid} status=${res.status}`);
    }
  } catch (err) {
    console.warn(`[identity] 产品链接回报异常 uid=${opts.uid}：${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Fixed-issuer product machine calls; never expose a service token to user clients. */
export async function identityMachineRequest(method: 'GET' | 'PUT', product: string, path: string, body?: object): Promise<unknown> {
  if (!/^[a-z][a-z0-9-]*$/.test(product) || !(/^(?:outbox(?:[/?]|$)|links\/[A-Za-z0-9%._~-]+$)/.test(path))) throw new IdentityError('身份事件配置无效', 503, 'IDENTITY_CLIENT_NOT_CONFIGURED');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), IDENTITY_HTTP_TIMEOUT_MS);
  try {
    const token = await serviceAccessToken();
    const response = await fetch(`${identityBaseUrl()}/api/products/${product}/${path}`, {
      method, headers: { accept: 'application/json', authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal, redirect: 'error',
    });
    if (!response.ok) {
      if (response.status === 401) serviceToken = null;
      throw new IdentityError('身份事件服务暂时不可用', 503, 'IDENTITY_OUTBOX_UNAVAILABLE');
    }
    const envelope = await response.json() as { success?: unknown; data?: unknown };
    if (envelope?.success !== true) throw new IdentityError('身份事件响应无效', 502, 'IDENTITY_OUTBOX_INVALID');
    return envelope.data;
  } finally { clearTimeout(timer); }
}
