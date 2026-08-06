import assert from 'node:assert/strict';
import test from 'node:test';
import { authReasonText, shouldInterruptForUnauthorized } from './authGate';

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
