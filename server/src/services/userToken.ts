// 用户登录态 token：HS256 JWT（Node 内置 crypto HMAC，零外部依赖），向后兼容历史 `token=userId`。
//
// 渐进式上线，不破坏存量客户端：
//   - 未配 APP_JWT_SECRET（默认）：签发=原样返回 userId；校验=原样返回（与历史完全一致）。
//   - 配了 APP_JWT_SECRET：新登录签发 JWT（带 sub/iat/exp）；校验优先验 JWT，
//     验不过的「JWT 形」token 拒绝；非 JWT 形（历史 userId）默认仍放行（平滑过渡），
//     置 APP_JWT_REQUIRED=true 后强制只认 JWT（老 token 失效，需重新登录）。
//
// 注意：JWT 的 sub 仍是 userId，故 resolveUser 拿到 sub 后查库逻辑不变。

import { createHmac, timingSafeEqual } from 'node:crypto';

function secret(): string {
  return (process.env.APP_JWT_SECRET ?? '').trim();
}
function jwtRequired(): boolean {
  return (process.env.APP_JWT_REQUIRED ?? 'false') === 'true';
}
function ttlSec(): number {
  const n = Number(process.env.APP_JWT_TTL_SEC ?? 60 * 60 * 24 * 30); // 默认 30 天
  return Number.isFinite(n) && n > 0 ? n : 60 * 60 * 24 * 30;
}

export function jwtEnabled(): boolean {
  return !!secret();
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlJson(obj: unknown): string {
  return b64url(Buffer.from(JSON.stringify(obj), 'utf8'));
}
function fromB64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function sign(data: string): string {
  return b64url(createHmac('sha256', secret()).update(data).digest());
}

/** 是否长得像 JWT（三段、点分）。 */
function looksLikeJwt(token: string): boolean {
  return token.split('.').length === 3;
}

/** 签发登录态 token。未配密钥 → 返回 userId（历史口径）。 */
export function signUserToken(userId: string): string {
  if (!jwtEnabled()) return userId;
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = { sub: userId, iat: now, exp: now + ttlSec() };
  const body = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  return `${body}.${sign(body)}`;
}

/**
 * 校验 token，返回内部 userId；非法返回空串。
 * - JWT 形：验签 + 验 exp，取 sub。
 * - 非 JWT 形（历史 userId）：APP_JWT_REQUIRED=true 时拒绝；否则原样放行。
 */
export function verifyUserToken(token?: string): string {
  const t = (token ?? '').trim();
  if (!t) return '';

  if (looksLikeJwt(t)) {
    if (!jwtEnabled()) return ''; // 收到 JWT 但服务端没密钥 → 无法验，拒绝
    const [h, p, sig] = t.split('.');
    const expected = sign(`${h}.${p}`);
    // Compare decoded binary digests, not base64url string bytes, for semantic correctness.
    const a = Buffer.from(sig, 'base64');
    const b = Buffer.from(expected, 'base64');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return '';
    try {
      const payload = JSON.parse(fromB64url(p).toString('utf8')) as { sub?: string; exp?: number };
      if (!payload.sub) return '';
      if (typeof payload.exp === 'number' && payload.exp * 1000 <= Date.now()) return ''; // 过期
      return payload.sub;
    } catch {
      return '';
    }
  }

  // 非 JWT 形：历史 userId 口径
  if (jwtRequired()) return ''; // 强制 JWT：老 token 失效
  return t;
}
