// 邀请落地捕获凭证：游客打开分享后，由服务端按自己的时钟签发 HMAC token。
// 登录归因只信本凭证里的 capturedAt/source，不再信客户端自报毫秒数。
import { createHmac, timingSafeEqual } from 'node:crypto';
import { now } from './clock.js';
import { isInviteCodeShape } from './referral.js';
import type { ReferralSource } from '../../../shared/contracts';

type PublicReferralSource = Exclude<ReferralSource, 'manual'>;

interface CaptureClaims {
  v: 1;
  code: string;
  capturedAt: number;
  source: PublicReferralSource;
}

const PUBLIC_SOURCES = new Set<PublicReferralSource>(['share_friend', 'share_timeline', 'poster_qr']);
const MAX_TOKEN_LENGTH = 2048;

function secret(): string {
  const configured = (process.env.APP_JWT_SECRET ?? '').trim();
  if (configured) return createHmac('sha256', configured).update('junshi:referral-capture:v1').digest('hex');
  // 测试/本地开发必须可离线跑通；生产没有登录密钥本来就是启动告警，这里进一步 fail-closed，
  // 绝不能退回一个写死的线上签名密钥。
  if (process.env.NODE_ENV !== 'production') return 'junshi-referral-capture-dev-only';
  throw Object.assign(new Error('邀请捕获凭证签名未配置'), {
    statusCode: 503,
    code: 'REFERRAL_CAPTURE_SECRET_MISSING',
  });
}

function b64url(value: Buffer | string): string {
  const buf = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeB64url(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function signature(body: string): Buffer {
  return createHmac('sha256', secret()).update(body).digest();
}

export function issueReferralCapture(inviteCode: string, source: PublicReferralSource): { token: string; capturedAt: Date } {
  if (!isInviteCodeShape(inviteCode)) {
    throw Object.assign(new Error('邀请码格式不正确'), { statusCode: 400, code: 'BAD_INVITE_CODE' });
  }
  if (!PUBLIC_SOURCES.has(source)) {
    throw Object.assign(new Error('邀请来源不正确'), { statusCode: 400, code: 'BAD_REFERRAL_SOURCE' });
  }
  const capturedAt = now();
  const claims: CaptureClaims = { v: 1, code: inviteCode, capturedAt: capturedAt.getTime(), source };
  const body = b64url(JSON.stringify(claims));
  return { token: `${body}.${b64url(signature(body))}`, capturedAt };
}

/** 验签成功返回服务端捕获事实；任何脏输入均返回 null，登录本身不得因此失败。 */
export function verifyReferralCapture(token: unknown): CaptureClaims | null {
  if (typeof token !== 'string' || !token || token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, rawSig] = parts;
  let got: Buffer;
  let expected: Buffer;
  // 签名配置缺失时签发接口应 503，但登录验签必须 fail-closed 成无可信时间戳；
  // 不能让一个历史/伪造 referralToken 把原本可正常完成的登录打成 5xx。
  try {
    got = decodeB64url(rawSig);
    expected = signature(body);
  } catch { return null; }
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null;
  try {
    const claims = JSON.parse(decodeB64url(body).toString('utf8')) as Partial<CaptureClaims>;
    if (claims.v !== 1 || !isInviteCodeShape(claims.code) || !PUBLIC_SOURCES.has(claims.source as PublicReferralSource)) return null;
    if (typeof claims.capturedAt !== 'number' || !Number.isSafeInteger(claims.capturedAt) || claims.capturedAt <= 0) return null;
    // 正常 token 的时间来自服务端，不会在未来；留 5 分钟只兼容多实例极小校时差。
    if (claims.capturedAt > now().getTime() + 5 * 60_000) return null;
    return claims as CaptureClaims;
  } catch {
    return null;
  }
}
