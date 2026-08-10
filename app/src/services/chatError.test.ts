import test from 'node:test';
import assert from 'node:assert/strict';
import { chatErrorPresentation } from './chatError';

test('额度耗尽改为方案入口，不提供必失败的原样重试', () => {
  assert.deepEqual(
    chatErrorPresentation({ code: 'INSUFFICIENT_QUOTA', message: '本月 token 额度已用尽，请续费或升级套餐' }),
    {
      message: '本月方案用量已用完。可前往「方案与权益」查看恢复时间或更换方案。',
      retryable: false,
      action: 'plans',
    },
  );
  assert.equal(chatErrorPresentation('本月额度已用尽，可在「我的」升级套餐').retryable, false);
});

test('网络类失败仍保留重试，审核类失败不重复撞相同内容', () => {
  assert.deepEqual(chatErrorPresentation(new Error('网络不太稳，请再试一次。')), {
    message: '网络不太稳，请再试一次。', retryable: true,
  });
  assert.equal(chatErrorPresentation({ code: 'MODERATION_BLOCK', message: '内容未通过审核' }).retryable, false);
});

test('算力、限流和参数错误不再显示必失败的重新回答', () => {
  assert.deepEqual(chatErrorPresentation({ code: 'INSUFFICIENT_CREDITS' }), {
    message: '当前算力不足，可前往「算力明细」查看。', retryable: false, action: 'credits',
  });
  assert.equal(chatErrorPresentation({ code: 'RATE_LIMITED' }).retryable, false);
  assert.equal(chatErrorPresentation({ code: 'CLIENT_REQUEST_ID_REQUIRED' }).retryable, false);
});
