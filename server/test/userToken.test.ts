// userToken 单测：未配密钥透传 userId / 配密钥后 JWT 往返 / 过期 / 篡改 / 强制模式。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { signUserToken, verifyUserToken, jwtEnabled } from '../src/services/userToken.ts';

/** Build a JWT with the given payload using the provided secret — for test-only control over exp. */
function buildJwt(secret: string, payload: Record<string, unknown>): string {
  const b64url = (buf: Buffer) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const header = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const data = `${header}.${body}`;
  const sig = b64url(createHmac('sha256', secret).update(data).digest());
  return `${data}.${sig}`;
}

function clearEnv() {
  delete process.env.APP_JWT_SECRET;
  delete process.env.APP_JWT_REQUIRED;
  delete process.env.APP_JWT_TTL_SEC;
}

test('未配 APP_JWT_SECRET：签发=校验=透传 userId（历史兼容）', () => {
  clearEnv();
  assert.equal(jwtEnabled(), false);
  assert.equal(signUserToken('user_123'), 'user_123');
  assert.equal(verifyUserToken('user_123'), 'user_123');
  assert.equal(verifyUserToken(''), '');
});

test('配置密钥：JWT 签发 + 校验往返；历史 userId 默认仍放行', () => {
  clearEnv();
  process.env.APP_JWT_SECRET = 'unit-jwt-secret';
  assert.equal(jwtEnabled(), true);

  const tok = signUserToken('user_abc');
  assert.equal(tok.split('.').length, 3, '应为三段 JWT');
  assert.notEqual(tok, 'user_abc');
  assert.equal(verifyUserToken(tok), 'user_abc', 'JWT 应解析出 sub');

  // 历史 userId（非 JWT 形）默认放行
  assert.equal(verifyUserToken('legacy_user_id'), 'legacy_user_id');

  // 篡改签名 → 拒绝
  const tampered = tok.slice(0, -3) + 'xxx';
  assert.equal(verifyUserToken(tampered), '');

  clearEnv();
});

test('过期 JWT 被拒绝', () => {
  clearEnv();
  process.env.APP_JWT_SECRET = 'unit-jwt-secret';
  // Construct a valid-signature token whose exp is 1 second after Unix epoch (long past).
  // This actually exercises the exp < Date.now() branch in verifyUserToken, unlike the
  // previous version that just called signUserToken() with an invalid TTL and checked success.
  const expiredTok = buildJwt('unit-jwt-secret', { sub: 'u1', iat: 1, exp: 1 });
  assert.equal(verifyUserToken(expiredTok), '', '过期 JWT 应被拒绝');
  clearEnv();
});

test('APP_JWT_REQUIRED=true：历史 userId token 失效，仅认 JWT', () => {
  clearEnv();
  process.env.APP_JWT_SECRET = 'unit-jwt-secret';
  process.env.APP_JWT_REQUIRED = 'true';
  assert.equal(verifyUserToken('legacy_user_id'), '', '强制模式拒绝非 JWT');
  const tok = signUserToken('u2');
  assert.equal(verifyUserToken(tok), 'u2', '强制模式仍认有效 JWT');
  clearEnv();
});
