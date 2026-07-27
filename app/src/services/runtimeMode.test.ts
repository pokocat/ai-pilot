import test from 'node:test';
import assert from 'node:assert/strict';
import { isSignedUserToken, resolveRuntimeBaseUrl, shouldUseMock } from './runtimeModeCore';

const jwt = 'header.payload.signature';

test('普通 mock 登录继续使用本地数据源', () => {
  assert.equal(isSignedUserToken('mock-13800138000'), false);
  assert.equal(shouldUseMock('mock', 'mock-13800138000'), true);
});

test('mock 包落地附身 JWT 后，整个会话切到真实 API', () => {
  assert.equal(isSignedUserToken(jwt), true);
  assert.equal(shouldUseMock('mock', jwt), false);
  assert.equal(
    resolveRuntimeBaseUrl('mock', 'http://localhost:4000/api', 'https://wxapi.aibuzz.cn/api', jwt),
    'https://wxapi.aibuzz.cn/api'
  );
});

test('server 包始终使用自身环境 API', () => {
  assert.equal(shouldUseMock('server', ''), false);
  assert.equal(
    resolveRuntimeBaseUrl('server', 'https://preprod.test/api', 'https://prod.test/api', jwt),
    'https://preprod.test/api'
  );
});
