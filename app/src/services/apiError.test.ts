import test from 'node:test';
import assert from 'node:assert/strict';
import { apiErrorPresentation, httpErrorInfo } from './apiError';

test('HTTP 5xx 不向用户暴露服务端技术原文，但保留排查信息', () => {
  assert.deepEqual(httpErrorInfo(500, { error: 'PrismaClientKnownRequestError: connection pool timeout', code: 'FAIL' }), {
    message: '军师服务暂时不可用，请稍后重试。',
    code: 'FAIL',
    technicalMessage: 'PrismaClientKnownRequestError: connection pool timeout',
  });
  assert.equal(apiErrorPresentation({ statusCode: 504, message: 'upstream timeout' }, '生成失败').retryable, true);
});

test('方案、额度和算力门禁都有动作入口且不可原样重试', () => {
  assert.deepEqual(apiErrorPresentation({ code: 'PLAN_EXPIRED' }), {
    kind: 'plan_expired', message: '当前方案已到期，续费后即可继续使用。', retryable: false, action: 'plans',
  });
  assert.equal(apiErrorPresentation({ statusCode: 402, message: 'HTTP 402' }).action, 'plans');
  assert.deepEqual(apiErrorPresentation({ code: 'INSUFFICIENT_CREDITS' }), {
    kind: 'credits', message: '当前算力不足，可先查看算力明细。', retryable: false, action: 'credits',
  });
});

test('限流、校验、冲突和审核不提供立即重试，服务异常才可重试', () => {
  assert.equal(apiErrorPresentation({ code: 'RATE_LIMITED', message: '今天最多 3 次' }).retryable, false);
  assert.equal(apiErrorPresentation({ code: 'IMAGE_TOO_LARGE' }).kind, 'validation');
  assert.equal(apiErrorPresentation({ code: 'QUOTE_CHANGED' }).action, 'refresh');
  assert.equal(apiErrorPresentation({ code: 'MODERATION_BLOCK' }).action, 'edit');
  assert.equal(apiErrorPresentation({ code: 'AI_UNAVAILABLE' }).retryable, true);
});

test('未知 4xx 保留自然中文业务原因，英文技术文本退回动作兜底', () => {
  assert.equal(apiErrorPresentation({ statusCode: 422, message: '请补齐公司名称' }, '保存未完成').message, '请补齐公司名称');
  assert.equal(apiErrorPresentation({ statusCode: 422, message: 'validation failed at field company' }, '保存未完成').message, '保存未完成');
});
