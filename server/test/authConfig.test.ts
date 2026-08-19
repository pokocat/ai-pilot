import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertProductionAuthSafe,
  productionAuthConfigErrors,
  smsLoginEnabled,
  wechatLoginEnabled,
} from '../src/services/authConfig.ts';
import { signUserToken, verifyUserToken } from '../src/services/userToken.ts';

const STRONG_SECRET = 'f9Bq7!Lz2#Vx8@Nm4$Rt6%Yp1&Kc3*Hs';

function secureBase() {
  return {
    NODE_ENV: 'production',
    APP_JWT_SECRET: STRONG_SECRET,
    APP_JWT_REQUIRED: 'true',
  };
}

test('非生产环境不执行生产鉴权配置闸门', () => {
  assert.deepEqual(productionAuthConfigErrors({ NODE_ENV: 'test' }), []);
});

test('生产允许只开启配置完整的快捷登录通道', () => {
  const source = {
    ...secureBase(),
    AUTH_SMS_LOGIN_ENABLED: 'false',
    AUTH_WECHAT_LOGIN_ENABLED: 'true',
    WECHAT_MINI_APPID: 'wx-test-app',
    WECHAT_MINI_SECRET: 'wechat-test-secret',
  };
  assert.deepEqual(productionAuthConfigErrors(source), []);
  assert.doesNotThrow(() => assertProductionAuthSafe(source));
});

test('生产允许只开启配置完整的短信验证码通道', () => {
  const source = {
    ...secureBase(),
    AUTH_SMS_LOGIN_ENABLED: 'true',
    AUTH_WECHAT_LOGIN_ENABLED: 'false',
    SMS_REQUIRE_CODE: 'true',
    SMS_PROVIDER: 'aliyun',
    ALIYUN_SMS_ACCESS_KEY_ID: 'ak',
    ALIYUN_SMS_ACCESS_KEY_SECRET: 'sk',
    ALIYUN_SMS_SIGN_NAME: 'sign',
    ALIYUN_SMS_TEMPLATE_CODE: 'tpl',
  };
  assert.deepEqual(productionAuthConfigErrors(source), []);
});

test('生产危险默认配置聚合报错并拒绝启动', () => {
  const errors = productionAuthConfigErrors({ NODE_ENV: 'production' });
  assert.ok(errors.some((item) => item.includes('APP_JWT_SECRET')));
  assert.ok(errors.some((item) => item.includes('APP_JWT_REQUIRED')));
  assert.ok(errors.some((item) => item.includes('SMS_REQUIRE_CODE')));
  assert.ok(errors.some((item) => item.includes('SMS_PROVIDER')));
  assert.ok(errors.some((item) => item.includes('WECHAT_MINI_SECRET')));
  assert.throws(
    () => assertProductionAuthSafe({ NODE_ENV: 'production' }),
    (error: unknown) => (error as { code?: string }).code === 'UNSAFE_PRODUCTION_AUTH_CONFIG',
  );
});

test('生产不能关闭全部登录通道，弱 JWT 密钥也不合格', () => {
  const errors = productionAuthConfigErrors({
    NODE_ENV: 'production',
    APP_JWT_SECRET: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    APP_JWT_REQUIRED: 'true',
    AUTH_SMS_LOGIN_ENABLED: 'false',
    AUTH_WECHAT_LOGIN_ENABLED: 'false',
  });
  assert.ok(errors.some((item) => item.includes('高强度随机串')));
  assert.ok(errors.some((item) => item.includes('不能同时关闭')));
});

test('登录通道开关默认开启且可显式关闭', () => {
  assert.equal(smsLoginEnabled({}), true);
  assert.equal(wechatLoginEnabled({}), true);
  assert.equal(smsLoginEnabled({ AUTH_SMS_LOGIN_ENABLED: 'false' }), false);
  assert.equal(wechatLoginEnabled({ AUTH_WECHAT_LOGIN_ENABLED: '0' }), false);
});

test('token 模块在 production 自身拒绝裸 userId 与无密钥签发', () => {
  const oldNodeEnv = process.env.NODE_ENV;
  const oldSecret = process.env.APP_JWT_SECRET;
  const oldRequired = process.env.APP_JWT_REQUIRED;
  try {
    process.env.NODE_ENV = 'production';
    delete process.env.APP_JWT_SECRET;
    delete process.env.APP_JWT_REQUIRED;
    assert.equal(verifyUserToken('legacy-user-id'), '');
    assert.throws(
      () => signUserToken('user-1'),
      (error: unknown) => (error as { code?: string }).code === 'AUTH_JWT_CONFIG_INVALID',
    );
  } finally {
    if (oldNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = oldNodeEnv;
    if (oldSecret === undefined) delete process.env.APP_JWT_SECRET;
    else process.env.APP_JWT_SECRET = oldSecret;
    if (oldRequired === undefined) delete process.env.APP_JWT_REQUIRED;
    else process.env.APP_JWT_REQUIRED = oldRequired;
  }
});
