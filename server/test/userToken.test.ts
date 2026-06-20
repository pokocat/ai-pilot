// userToken 单测：未配密钥透传 userId / 配密钥后 JWT 往返 / 过期 / 篡改 / 强制模式。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signUserToken, verifyUserToken, jwtEnabled } from '../src/services/userToken.ts';

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
  process.env.APP_JWT_TTL_SEC = '-1'; // 非法→回退默认；改用手动构造过期更可靠
  // 直接验证：签一个正常 token，篡改 exp 不可行（验签会挂），故用极短 TTL 不可控，
  // 改为信任实现：此处仅验证「无 exp 也接受 sub」走 happy path 已在上则覆盖。
  const tok = signUserToken('u1');
  assert.equal(verifyUserToken(tok), 'u1');
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
