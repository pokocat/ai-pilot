// 微信消息推送验签：GET 回显 echostr，POST 可信接收后返回 success。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, closeApp, api, cleanBusiness, login, uniquePhone, anyPlanId } from './helpers.js';
import { prisma } from '../src/db.js';
import { signWechatMessage, verifyWechatMessageSignature, _resetTokenCache } from '../src/services/wechat.js';
import { sendWechatSubscribeMessage } from '../src/services/wechatSubscribe.js';
import { avatarNotificationOutcome } from '../src/services/video/avatarNotification.js';

const TOKEN = 'unit-wechat-message-token';
const timestamp = '1780000000';
const nonce = 'nonce-abc';

before(async () => {
  process.env.WECHAT_MESSAGE_TOKEN = TOKEN;
  await getApp();
  await anyPlanId(); // login() 依赖测试期默认套餐（入门版）存在；本文件不跑 seedBaseline，自行补齐
});

after(async () => {
  delete process.env.WECHAT_MESSAGE_TOKEN;
  delete process.env.WECHAT_SUBSCRIBE_REVIEW_TEMPLATE_ID;
  delete process.env.WECHAT_SUBSCRIBE_AVATAR_TEMPLATE_ID;
  delete process.env.WECHAT_MINI_APPID;
  delete process.env.WECHAT_MINI_SECRET;
  await closeApp();
});

test('数字分身模板 32308 字段与完成判定对齐', async () => {
  assert.equal(avatarNotificationOutcome(null), null);
  assert.equal(avatarNotificationOutcome({ imageStatus: 'training', voiceStatus: 'ready' } as never), null);
  assert.equal(avatarNotificationOutcome({ imageStatus: 'ready', voiceStatus: 'ready' } as never), 'ready');
  assert.equal(avatarNotificationOutcome({ imageStatus: 'training', voiceStatus: 'failed' } as never), null);
  assert.equal(avatarNotificationOutcome({ imageStatus: 'failed', voiceStatus: 'ready' } as never), 'failed');

  await cleanBusiness();
  process.env.WECHAT_SUBSCRIBE_AVATAR_TEMPLATE_ID = 'tpl-avatar';
  process.env.WECHAT_MINI_APPID = 'wx-test-app';
  process.env.WECHAT_MINI_SECRET = 'secret-test';
  _resetTokenCache();
  const token = await login(uniquePhone(), '分身订阅用户');
  const user = await prisma.user.findUniqueOrThrow({ where: { id: token } });
  await prisma.user.update({ where: { id: token }, data: { wechatOpenId: 'openid-avatar-user' } });
  await api('POST', '/api/wechat/subscribe', {
    token,
    body: { choices: [{ scene: 'avatar', templateId: 'tpl-avatar', status: 'accept' }] },
  });

  const oldFetch = globalThis.fetch;
  let payload: { page?: string; data: Record<string, { value: string }> } | null = null;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    if (href.includes('/message/subscribe/send')) payload = JSON.parse(String(init!.body));
    return { ok: true, headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => (href.includes('/stable_token') ? { access_token: 'avatar-token', expires_in: 7200 } : { errcode: 0 }) } as unknown as Response;
  }) as typeof fetch;
  try {
    const sent = await sendWechatSubscribeMessage({
      tenantId: user.tenantId, userId: token, scene: 'avatar', title: '数字分身训练',
      statusText: '已完成', note: '形象和声音已就绪，可以开始出片',
    });
    assert.equal(sent.sent, true);
  } finally {
    globalThis.fetch = oldFetch;
    delete process.env.WECHAT_SUBSCRIBE_AVATAR_TEMPLATE_ID;
    delete process.env.WECHAT_MINI_APPID;
    delete process.env.WECHAT_MINI_SECRET;
    _resetTokenCache();
  }
  assert.ok(payload);
  assert.equal(payload.page, 'packages/video/clone/index?step=2');
  assert.deepEqual(Object.keys(payload.data).sort(), ['phrase16', 'thing13', 'thing5', 'time12']);
  assert.equal(payload.data.thing13.value, '数字分身训练');
  assert.equal(payload.data.phrase16.value, '已完成');
  assert.match(payload.data.time12.value, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
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
  type SendBody = { touser?: string; template_id?: string; data: Record<string, { value: string }> };
  const calls: { url: string; body?: SendBody }[] = [];
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
  // 模板字段键钉死：review = 微信后台模板 26922「最新分析报告提醒」的真实关键词编号
  // （thing2 报告类型 / thing3 报告名称 / thing5 备注 / time6 生成时间）。键错整条被拒 47003，
  // 而拒发只落在 WechatNotificationLog 里、线上无人看——2026-07-30 前这里发的是 thing1/time2/thing3，
  // 所有借 review 模板的推送（复盘/军令/周复盘/预言到期/岁验）在生产一条都没到过用户手机。
  assert.deepEqual(Object.keys(calls[1].body.data).sort(), ['thing2', 'thing3', 'thing5', 'time6']);
  assert.equal(calls[1].body.data.thing3.value, '今晚复盘提醒', '报告名称位 = title');
  assert.equal(calls[1].body.data.thing5.value, '记录今日结果，调整明天军令', '备注位 = note');
  assert.equal(calls[1].body.data.thing2.value, '军师提醒', '未传 category 时报告类型位取缺省');
  assert.match(calls[1].body.data.time6.value, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, '时间位走微信认的格式');
  assert.equal((await prisma.wechatSubscription.findFirstOrThrow({ where: { userId: token, scene: 'review' } })).remaining, 0);
  const log = await prisma.wechatNotificationLog.findFirstOrThrow({ where: { userId: token, scene: 'review' } });
  assert.equal(log.status, 'sent');
});

// 三个模板的字段键都必须与微信后台「详细内容」逐字一致，否则整条 47003 拒发、且只在
// WechatNotificationLog 里留痕（线上无人翻）——2026-07-30 核对发现 review 与 payment 两条全错，
// 上线以来一条都没真正送达。键集本身就是契约，故逐 scene 钉死。
test('订阅消息模板字段键与微信后台模板逐字一致（review 26922 / report 76218 / payment 29967）', async () => {
  await cleanBusiness();
  process.env.WECHAT_SUBSCRIBE_REVIEW_TEMPLATE_ID = 'tpl-review';
  process.env.WECHAT_SUBSCRIBE_REPORT_TEMPLATE_ID = 'tpl-report';
  process.env.WECHAT_SUBSCRIBE_PAYMENT_TEMPLATE_ID = 'tpl-payment';
  process.env.WECHAT_MINI_APPID = 'wx-test-app';
  process.env.WECHAT_MINI_SECRET = 'secret-test';
  _resetTokenCache();

  const token = await login(uniquePhone(), '模板字段用户');
  const user = await prisma.user.findUniqueOrThrow({ where: { id: token } });
  await prisma.user.update({ where: { id: token }, data: { wechatOpenId: 'openid-template-keys' } });
  for (const [scene, templateId] of [['review', 'tpl-review'], ['report', 'tpl-report'], ['payment', 'tpl-payment']] as const) {
    await prisma.wechatSubscription.create({
      data: { tenantId: user.tenantId, userId: token, scene, templateId, status: 'accept', remaining: 1, acceptedAt: new Date() },
    });
  }

  const oldFetch = globalThis.fetch;
  const sent: Record<string, { value: string }>[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    if (href.includes('/message/subscribe/send')) sent.push(JSON.parse(String(init!.body)).data);
    return {
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => (href.includes('/stable_token')
        ? { access_token: 'access-token-test', expires_in: 7200 }
        : { errcode: 0, errmsg: 'ok' }),
    } as unknown as Response;
  }) as typeof fetch;
  try {
    const base = { tenantId: user.tenantId, userId: token };
    await sendWechatSubscribeMessage({ ...base, scene: 'review', category: '复盘提醒', title: '今晚复盘提醒', note: '记录今日结果' });
    await sendWechatSubscribeMessage({ ...base, scene: 'report', title: '三城布局方略' });
    await sendWechatSubscribeMessage({ ...base, scene: 'payment', title: '将帅版·年付', amountFen: 688800, orderNo: '4200002026073012345678' });
  } finally {
    globalThis.fetch = oldFetch;
    delete process.env.WECHAT_SUBSCRIBE_REVIEW_TEMPLATE_ID;
    delete process.env.WECHAT_SUBSCRIBE_REPORT_TEMPLATE_ID;
    delete process.env.WECHAT_SUBSCRIBE_PAYMENT_TEMPLATE_ID;
    delete process.env.WECHAT_MINI_APPID;
    delete process.env.WECHAT_MINI_SECRET;
    _resetTokenCache();
  }
  assert.equal(sent.length, 3, '三条都发出去了');
  const [review, report, payment] = sent;

  // review（26922）：thing2 报告类型 / thing3 报告名称 / thing5 备注 / time6 生成时间
  assert.deepEqual(Object.keys(review).sort(), ['thing2', 'thing3', 'thing5', 'time6']);
  assert.equal(review.thing2.value, '复盘提醒');
  assert.equal(review.thing3.value, '今晚复盘提醒');

  // report（76218）：thing1 报告名称 / phrase2 生成状态 / time3 完成时间 / thing4 温馨提示
  assert.deepEqual(Object.keys(report).sort(), ['phrase2', 'thing1', 'thing4', 'time3']);
  assert.equal(report.thing1.value, '三城布局方略');
  assert.equal(report.phrase2.value, '已生成');

  // payment（29967）：thing1 类型 / amount2 金额 / thing3 用户 / time5 时间 / number6 订单号
  assert.deepEqual(Object.keys(payment).sort(), ['amount2', 'number6', 'thing1', 'thing3', 'time5']);
  assert.equal(payment.thing1.value, '将帅版·年付');
  assert.equal(payment.amount2.value, '¥6888.00', '金额位带币种符号 + 两位小数');
  assert.equal(payment.thing3.value, '模板字段用户', '用户位取账户昵称');
  assert.equal(payment.number6.value, '4200002026073012345678', '订单号位纯数字');
  assert.match(payment.time5.value, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);

  // 商户单号（js{时间戳}{hex}，带字母）走 number 位时必须抽成纯数字，否则整条 47003
  assert.match(
    (await (async () => {
      const calls: Record<string, { value: string }>[] = [];
      process.env.WECHAT_SUBSCRIBE_PAYMENT_TEMPLATE_ID = 'tpl-payment';
      process.env.WECHAT_MINI_APPID = 'wx-test-app';
      process.env.WECHAT_MINI_SECRET = 'secret-test';
      _resetTokenCache();
      await prisma.wechatSubscription.updateMany({ where: { userId: token, scene: 'payment' }, data: { remaining: 1 } });
      const prev = globalThis.fetch;
      globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
        const href = String(url);
        if (href.includes('/message/subscribe/send')) calls.push(JSON.parse(String(init!.body)).data);
        return { ok: true, headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => (href.includes('/stable_token') ? { access_token: 't', expires_in: 7200 } : { errcode: 0 }) } as unknown as Response;
      }) as typeof fetch;
      try {
        await sendWechatSubscribeMessage({ tenantId: user.tenantId, userId: token, scene: 'payment', title: '入门版', amountFen: 9900, orderNo: 'js1780000000abcd1234' });
      } finally {
        globalThis.fetch = prev;
        delete process.env.WECHAT_SUBSCRIBE_PAYMENT_TEMPLATE_ID;
        delete process.env.WECHAT_MINI_APPID;
        delete process.env.WECHAT_MINI_SECRET;
        _resetTokenCache();
      }
      return calls[0].number6.value;
    })()),
    /^\d+$/,
    '带字母的商户单号被抽成纯数字',
  );
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
