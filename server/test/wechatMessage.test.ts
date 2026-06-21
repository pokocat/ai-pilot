// 微信消息推送验签：GET 回显 echostr，POST 可信接收后返回 success。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, closeApp } from './helpers.js';
import { signWechatMessage, verifyWechatMessageSignature } from '../src/services/wechat.js';

const TOKEN = 'unit-wechat-message-token';
const timestamp = '1780000000';
const nonce = 'nonce-abc';

before(async () => {
  process.env.WECHAT_MESSAGE_TOKEN = TOKEN;
  await getApp();
});

after(async () => {
  delete process.env.WECHAT_MESSAGE_TOKEN;
  await closeApp();
});

test('服务层按微信规则生成并校验 signature', () => {
  const signature = signWechatMessage(TOKEN, timestamp, nonce);
  assert.match(signature, /^[0-9a-f]{40}$/);
  assert.equal(verifyWechatMessageSignature({ signature, timestamp, nonce }), true);
  assert.equal(verifyWechatMessageSignature({ signature: 'bad', timestamp, nonce }), false);
});

test('GET /api/wechat/message 验签通过后原样返回 echostr', async () => {
  const app = await getApp();
  const signature = signWechatMessage(TOKEN, timestamp, nonce);
  const res = await app.inject({
    method: 'GET',
    url: `/api/wechat/message?signature=${signature}&timestamp=${timestamp}&nonce=${nonce}&echostr=hello-wechat`,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type']?.toString().includes('text/plain'), true);
  assert.equal(res.body, 'hello-wechat');
});

test('GET /api/wechat/message 签名错误时拒绝', async () => {
  const app = await getApp();
  const res = await app.inject({
    method: 'GET',
    url: `/api/wechat/message?signature=bad&timestamp=${timestamp}&nonce=${nonce}&echostr=hello-wechat`,
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.body, 'invalid signature');
});

test('POST /api/wechat/message 支持 XML 推送体并返回 success', async () => {
  const app = await getApp();
  const signature = signWechatMessage(TOKEN, timestamp, nonce);
  const res = await app.inject({
    method: 'POST',
    url: `/api/wechat/message?signature=${signature}&timestamp=${timestamp}&nonce=${nonce}`,
    headers: { 'content-type': 'text/xml' },
    payload: '<xml><MsgType><![CDATA[text]]></MsgType></xml>',
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, 'success');
});
