// 端上错误文案映射。
//
// 专门钉住一条回归：5xx 曾经无条件返回「军师服务暂时不可用」，把服务端特意写好的
// 业务原因（如石榴额度耗尽）全丢掉，用户以为是我们系统坏了，排查得上服务器翻日志。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(APP_ROOT, 'package.json'));
const { httpErrorInfo } = require(path.join(APP_ROOT, 'weapp-native/services/api-error.js'));

test('5xx 带已知业务 code → 用该 code 的专属文案，不再说「服务暂不可用」', () => {
  const info = httpErrorInfo(502, { code: 'CLIP_ENGINE_BALANCE_INSUFFICIENT', error: '数字人服务额度不足' }, '提交');
  assert.equal(info.message, '数字人服务的额度用完了，请联系运营处理。');
  assert.ok(!info.message.includes('军师服务暂时不可用'));
});

test('供应商权益类错误既不提充值也不提删除——两者实测都无效', () => {
  const info = httpErrorInfo(409, { code: 'CLIP_ENGINE_CAPACITY_FULL', error: '克隆权益不足' }, '提交');
  assert.ok(!info.message.includes('充值'), `充点数没用，不该这么写：${info.message}`);
  assert.ok(!info.message.includes('删掉') && !info.message.includes('删除'), `删旧对象也没用：${info.message}`);
  assert.match(info.message, /运营/);
});

test('没关联声音要拦住并让用户去选，不能替他挑一条', () => {
  const info = httpErrorInfo(409, { code: 'CLIP_VOICE_NOT_SELECTED' }, '出片');
  assert.match(info.message, /还没有关联声音/);
  assert.match(info.message, /选一个|采集/);
});

test('5xx 带未知 code 但服务端给了可读中文原因 → 保留该原因', () => {
  const info = httpErrorInfo(502, { code: 'CLIP_ENGINE_CALL_FAILED', error: '石榴 AI 未受理任务：账户权益不足，无法进行声音克隆' }, '提交');
  // CLIP_ENGINE_CALL_FAILED 在映射表里，优先用表里的文案
  assert.match(info.message, /数字人服务没有受理这次任务/);
});

test('5xx 未知 code + 未知中文原因 → 仍然保留服务端原因', () => {
  const info = httpErrorInfo(503, { code: 'SOME_NEW_CODE', error: '第三方语音服务正在维护，预计一小时后恢复' }, '提交');
  assert.equal(info.message, '第三方语音服务正在维护，预计一小时后恢复');
});

test('5xx 原文是堆栈/英文技术细节 → 不外露，回落通用文案', () => {
  for (const raw of ['Error: connect ECONNREFUSED 127.0.0.1:8081', 'PrismaClientKnownRequestError: P2002', '']) {
    const info = httpErrorInfo(500, { error: raw }, '提交');
    assert.equal(info.message, '军师服务暂时不可用，请稍后重试。', `原文「${raw}」不该外露`);
    assert.ok(info.technicalMessage, '技术原文仍要留在 technicalMessage 供排查');
  }
});

test('5xx 含中文但夹带技术标识 → 判为不可读，不外露', () => {
  const info = httpErrorInfo(500, { error: '数据库写入失败 PrismaClientKnownRequestError' }, '提交');
  assert.equal(info.message, '军师服务暂时不可用，请稍后重试。');
});

test('超时与限流仍走各自的专属文案，不被上面的改动影响', () => {
  assert.match(httpErrorInfo(504, {}, '提交').message, /响应超时/);
  assert.match(httpErrorInfo(429, {}, '提交').message, /有点频繁/);
});

test('Nginx 在应用前拦下 413 时也要明确说文件过大', () => {
  assert.equal(
    httpErrorInfo(413, '<html>Request Entity Too Large</html>', '上传').message,
    '文件太大，超过当前上传上限，请压缩或拆分后重新上传。',
  );
  assert.equal(
    httpErrorInfo(413, { code: 'CLIP_CAPTURE_TOO_LARGE' }, '上传').message,
    '形象视频超过 100MB，请压缩或缩短后重新上传。',
  );
  assert.equal(
    httpErrorInfo(413, { code: 'KNOWLEDGE_FILE_TOO_LARGE' }, '上传').message,
    '文件超过 20MB，请压缩、拆分或导出较小文件后重新上传。',
  );
});

test('4xx 行为不变：优先 code 表，其次服务端中文原因', () => {
  assert.equal(httpErrorInfo(409, { code: 'CLIP_ENGINE_SPEAKER_NOT_FOUND' }, '提交').message,
    '声音模型不存在了，请重新采集声音。');
  assert.equal(httpErrorInfo(422, { error: '录音太短了' }, '提交').message, '录音太短了');
});

test('微信身份冲突有明确说明，不被压成通用 409', () => {
  const info = httpErrorInfo(409, { code: 'WECHAT_ACCOUNT_CONFLICT' }, '登录');
  assert.equal(info.message, '当前登录身份已关联其他账号，请改用原账号登录或联系客服。');
});
