// 微信消息推送验签：GET 回显 echostr，POST 可信接收后返回 success。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, closeApp, api, cleanBusiness, login, uniquePhone } from './helpers.js';
import { prisma } from '../src/db.js';
import { signWechatMessage, verifyWechatMessageSignature, _resetTokenCache } from '../src/services/wechat.js';
import { sendWechatSubscribeMessage } from '../src/services/wechatSubscribe.js';

const TOKEN = 'unit-wechat-message-token';
const timestamp = '1780000000';
const nonce = 'nonce-abc';

before(async () => {
  process.env.WECHAT_MESSAGE_TOKEN = TOKEN;
  await getApp();
});

after(async () => {
  delete process.env.WECHAT_MESSAGE_TOKEN;
  delete process.env.WECHAT_SUBSCRIBE_REVIEW_TEMPLATE_ID;
  delete process.env.WECHAT_MINI_APPID;
  delete process.env.WECHAT_MINI_SECRET;
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

test('订阅消息 accept 后累计一次额度，发送成功后扣减', async () => {
  await cleanBusiness();
  process.env.WECHAT_SUBSCRIBE_REVIEW_TEMPLATE_ID = 'tpl-review';
  process.env.WECHAT_MINI_APPID = 'wx-test-app';
  process.env.WECHAT_MINI_SECRET = 'secret-test';
  _resetTokenCache();

  const token = await login(uniquePhone(), '订阅用户');
  await prisma.user.update({ where: { id: token }, data: { wechatOpenId: 'openid-subscribe-user' } });

  const cfg = await api<{ scenes: { scene: string; templateId: string }[] }>('GET', '/api/wechat/subscribe/templates', { token });
  assert.equal(cfg.status, 200);
  assert.deepEqual(cfg.body.scenes.map((s) => [s.scene, s.templateId]), [['review', 'tpl-review']]);

  const rec = await api('POST', '/api/wechat/subscribe', {
    token,
    body: { choices: [{ scene: 'review', templateId: 'tpl-review', status: 'accept' }] },
  });
  assert.equal(rec.status, 200);
  assert.equal(rec.body.accepted, 1);
  assert.equal((await prisma.wechatSubscription.findFirstOrThrow({ where: { userId: token, scene: 'review' } })).remaining, 1);

  const oldFetch = globalThis.fetch;
  const calls: { url: string; body?: unknown }[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    calls.push({ url: href, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return {
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => (href.includes('/stable_token')
        ? { access_token: 'access-token-test', expires_in: 7200 }
        : { errcode: 0, errmsg: 'ok' }),
    } as unknown as Response;
  }) as typeof fetch;
  try {
    const sent = await sendWechatSubscribeMessage({
      tenantId: (await prisma.user.findUniqueOrThrow({ where: { id: token } })).tenantId,
      userId: token,
      scene: 'review',
      title: '今晚复盘提醒',
      note: '记录今日结果，调整明天军令',
    });
    assert.equal(sent.sent, true);
  } finally {
    globalThis.fetch = oldFetch;
  }

  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.touser, 'openid-subscribe-user');
  assert.equal(calls[1].body.template_id, 'tpl-review');
  assert.equal((await prisma.wechatSubscription.findFirstOrThrow({ where: { userId: token, scene: 'review' } })).remaining, 0);
  const log = await prisma.wechatNotificationLog.findFirstOrThrow({ where: { userId: token, scene: 'review' } });
  assert.equal(log.status, 'sent');
});
