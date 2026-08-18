import assert from 'node:assert/strict';
import test from 'node:test';
import { api, setAuthLostHandler } from './api';
import { authReasonText, shouldInterruptForUnauthorized } from './authGate';
import { setPlatform, type HttpRequestOptions, type HttpResponse } from './platform';
import { store } from './store';
import { setToken } from './token';

test('动作级登录理由均明示本次登录目的', () => {
  assert.match(authReasonText('chat'), /对话/);
  assert.match(authReasonText('upload'), /资料/);
  assert.match(authReasonText('purchase'), /购买/);
  assert.ok(authReasonText().length > 8);
});

test('401 只打断曾携带凭证的请求', () => {
  assert.equal(shouldInterruptForUnauthorized(''), false);
  assert.equal(shouldInterruptForUnauthorized('   '), false);
  assert.equal(shouldInterruptForUnauthorized('jwt-token'), true);
});

test('同一旧 token 的并发 401 只退出一次，晚到响应不清新会话', async () => {
  let token = '';
  let removed = 0;
  let authLost = 0;
  const pending: Array<(response: HttpResponse) => void> = [];
  setPlatform({
    storage: {
      get: () => token,
      set: (_key: string, value: string) => { token = value; },
      remove: () => { token = ''; removed += 1; },
    },
    request: (_options: HttpRequestOptions) => new Promise<HttpResponse>((resolve) => pending.push(resolve)),
  });
  setAuthLostHandler(() => { authLost += 1; });

  setToken('expired.session.token');
  const first = api.me();
  const second = api.me();
  pending.shift()?.({ statusCode: 401, data: { error: '令牌无效' } });
  pending.shift()?.({ statusCode: 401, data: { error: '令牌无效' } });
  const results = await Promise.allSettled([first, second]);
  for (const result of results) if (result.status === 'rejected') store.handleApiError(result.reason);
  assert.equal(removed, 1);
  assert.equal(authLost, 1);
  assert.equal(results[0].status === 'rejected' && results[0].reason.authHandled, true);
  assert.equal(results[1].status === 'rejected' && results[1].reason.staleAuth, true);

  setToken('old.session.token');
  const late = api.me();
  setToken('new.session.token');
  pending.shift()?.({ statusCode: 401, data: { error: '旧请求已失效' } });
  await assert.rejects(late, (error: unknown) => {
    store.handleApiError(error);
    return Boolean((error as { staleAuth?: boolean })?.staleAuth);
  });
  assert.equal(token, 'new.session.token');
  assert.equal(removed, 1);
  assert.equal(authLost, 1);
});
