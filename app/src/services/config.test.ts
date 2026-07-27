import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveImpersonationBaseUrl } from './config';

test('附身验令在 server 模式复用当前环境 API', () => {
  assert.equal(
    resolveImpersonationBaseUrl('server', 'https://example.test/api', ''),
    'https://example.test/api'
  );
});

test('附身验令在 mock 模式也直连真实 API，避免误走 mock.me', () => {
  assert.equal(
    resolveImpersonationBaseUrl('mock', 'http://localhost:4000/api', ''),
    'https://wxapi.aibuzz.cn/api'
  );
  assert.equal(
    resolveImpersonationBaseUrl('mock', 'https://preprod.test/api', 'https://preprod.test/api'),
    'https://preprod.test/api'
  );
});
