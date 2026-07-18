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

// 回归：sendWechatSubscribeMessage 此前「先查 remaining>0 放行 → 调用微信真实推送接口(不可逆外部副作用)
// → 发送成功后才原子扣减 remaining」——扣减发生在发送之后，故两个并发请求（如同一用户短时间内
// 两次触发报告生成）会都通过前置校验、都真的把消息推给微信（重复打扰用户），只有其中一个能在
// 事后扣减时抢到这唯一一份 remaining；输掉竞态的一方明明已经调用了发送接口，却因扣减 0 行受影响
// 直接 return sent:false（在扣减判定之前 return，从不调用 logNotification）——不落任何审计日志，
// 是一次完全不可追溯的「幽灵推送」。修复：改为发送前原子「认领」一份额度（updateMany 增加
// remaining:decrement 且 where remaining>0），认领失败（额度已被并发请求抢走）则直接拒绝、
// 不调用发送接口；认领成功后发送失败/被拒再退回额度——与全仓 reserveCredits/reserveQuota
// 的「先预留后结算」惯例一致，从根上消除对同一份额度的重复物理发送。
test('回归：同一份订阅额度并发触发时最多真实推送一次，不会超发也不会产生未记账的幽灵推送', async () => {
  await cleanBusiness();
  process.env.WECHAT_SUBSCRIBE_REVIEW_TEMPLATE_ID = 'tpl-review-race';
  process.env.WECHAT_MINI_APPID = 'wx-test-app-race';
  process.env.WECHAT_MINI_SECRET = 'secret-test-race';
  _resetTokenCache();

  const token = await login(uniquePhone(), '并发订阅用户');
  const tenantId = (await prisma.user.findUniqueOrThrow({ where: { id: token } })).tenantId;
  await prisma.user.update({ where: { id: token }, data: { wechatOpenId: 'openid-race-user' } });
  await api('POST', '/api/wechat/subscribe', {
    token,
    body: { choices: [{ scene: 'review', templateId: 'tpl-review-race', status: 'accept' }] },
  });
  assert.equal((await prisma.wechatSubscription.findFirstOrThrow({ where: { userId: token, scene: 'review' } })).remaining, 1);

  const oldFetch = globalThis.fetch;
  let sendCalls = 0;
  globalThis.fetch = (async (url: string | URL) => {
    const href = String(url);
    if (href.includes('/stable_token')) {
      return { ok: true, headers: new Headers({ 'content-type': 'application/json' }), json: async () => ({ access_token: 'access-token-race', expires_in: 7200 }) } as unknown as Response;
    }
    // 模拟真实网络往返延迟：确保两个并发调用都先跑到「已判定可发」再各自去调用发送接口，
    // 从而在旧实现（先发后扣）下必然触发竞态；新实现（先原子认领再发）下这个延迟不影响结果，
    // 因为认领已经在调用这里之前把并发挡掉了。
    await new Promise((r) => setTimeout(r, 30));
    sendCalls += 1;
    return { ok: true, headers: new Headers({ 'content-type': 'application/json' }), json: async () => ({ errcode: 0, errmsg: 'ok' }) } as unknown as Response;
  }) as typeof fetch;
  try {
    const [r1, r2] = await Promise.all([
      sendWechatSubscribeMessage({ tenantId, userId: token, scene: 'review', title: '今晚复盘提醒 A' }),
      sendWechatSubscribeMessage({ tenantId, userId: token, scene: 'review', title: '今晚复盘提醒 B' }),
    ]);
    const sentCount = [r1, r2].filter((r) => r.sent).length;
    assert.equal(sentCount, 1, '只有一份 remaining 额度，最多只应有一次成功发送');
    assert.equal(sendCalls, 1, '不应对微信真实推送接口发起超过额度次数的调用（旧实现会调用 2 次，多打扰用户一次）');
  } finally {
    globalThis.fetch = oldFetch;
  }

  const finalSub = await prisma.wechatSubscription.findFirstOrThrow({ where: { userId: token, scene: 'review' } });
  assert.equal(finalSub.remaining, 0, '额度应恰好扣减一次，不应出现负数（超发）');
  const sentLogs = await prisma.wechatNotificationLog.findMany({ where: { userId: token, scene: 'review', status: 'sent' } });
  assert.equal(sentLogs.length, 1, '成功发送必须有且只有一条审计日志；不应存在调用了发送接口却未落审计日志的幽灵推送');
});
