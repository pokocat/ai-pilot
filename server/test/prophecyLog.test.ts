// 预言账本（M2 PR-9）测试：记录/验证/命中率（服务端计数）、注入、到期扫描幂等、
// 真实性铁律（测试/mock 环境抽取器返回空 → 不产生伪预言）、隔离。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, login, uniquePhone } from './helpers.ts';
import { prisma } from '../src/db.ts';
import { extractAndRecordProphecies, prophecyBriefing } from '../src/services/prophecyLog.ts';
import { scanDueProphecies } from '../src/services/scheduler.ts';
import { _resetTokenCache } from '../src/services/wechat.ts';
import { buildGenContext } from '../src/services/context.ts';
import { buildSystemParts } from '../src/llm/schema.ts';

before(async () => {
  await getApp();
  await cleanBusiness();
  await seedBaseline();
});

after(async () => {
  await closeApp();
});

// scanDueProphecies 按设计扫全库（不带 userId 过滤），所以断言「本轮到期几条」的用例必须先把
// 前序用例遗留的 pending 行锚死，否则别处的 dueDate 会漂进本轮全局计数。
// 曾踩：注入用例写死 dueDate '2026-08-01'，到了那天它自己变成「到期」→ 到期扫描用例 n=2≠1。
const isolateDueScan = async () => {
  await prisma.prophecyLog.updateMany({ where: { dueNotifiedAt: null }, data: { dueNotifiedAt: new Date() } });
  await prisma.auditLog.deleteMany({ where: { action: 'system.prophecy.due' } });
};

// 相对今天的日期键，避免写死未来日期到了那天变成过去（'YYYY-MM-DD'，与 dateKey 同口径粒度）。
const dayKeyFromNow = (days: number) => new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10);

test('记录 + 验证 → 命中率服务端算；未验证时 hitRate=null 不编 0%；已验证 <5 条也不出比率', async () => {
  const token = await login(uniquePhone(), '天机用户');
  const record = (prophecy: string, extra: Record<string, unknown> = {}) => api('POST', '/api/prophecies', { token, body: { prophecy, ...extra } });
  const verify = (id: string, outcome: string, note?: string) => api('POST', `/api/prophecies/${id}/verify`, { token, body: { outcome, note } });

  const p1 = await record('3 月现金流承压，回款会延迟', { dueDate: '2026-03-31', verifyStandard: '3 月回款是否延迟两周以上' });
  assert.equal(p1.status, 200);
  assert.equal(p1.body.prophecy.seq, 1);
  const p2 = await record('4 月有意外进账');
  const p3 = await record('5 月团队可能出问题');

  const before1 = await api('GET', '/api/prophecies', { token });
  assert.equal(before1.body.stats.hitRate, null, '未验证不编命中率');

  await verify(p1.body.prophecy.id, 'hit', '回款延迟两周');
  await verify(p2.body.prophecy.id, 'hit');
  const v3 = await verify(p3.body.prophecy.id, 'miss', '团队稳定');
  // 已验证仅 3 条（<5）：批次C 最小样本保护——即使 2/3 命中也不出比率，避免样本太小就喂晋升
  assert.equal(v3.body.stats.hit, 2);
  assert.equal(v3.body.stats.miss, 1);
  assert.equal(v3.body.stats.hitRate, null, '已验证 3 条 <5，不出命中率');
  assert.equal(v3.body.stats.pending, 0);

  // 补 2 条到 ≥5 条已验证，命中率才由服务端算出
  const p4 = await record('6 月出现新客户来源');
  const p5 = await record('7 月成本会上升');
  await verify(p4.body.prophecy.id, 'hit');
  const v5 = await verify(p5.body.prophecy.id, 'hit');
  assert.equal(v5.body.stats.total, 5);
  assert.equal(v5.body.stats.hit, 4);
  assert.equal(v5.body.stats.miss, 1);
  assert.equal(v5.body.stats.hitRate, 80, '4/(4+1)=80%（已验证 5 条 ≥5）');

  const bad = await api('POST', `/api/prophecies/${p1.body.prophecy.id}/verify`, { token, body: { outcome: 'kinda' } });
  assert.equal(bad.status, 400);
});

test('真实性铁律：mock/测试环境抽取器返回空 → 不产生伪预言（即使有命盘和天势文本）', async () => {
  const token = await login(uniquePhone(), '抽取用户');
  const user = await prisma.user.findFirstOrThrow({ where: { id: token } });
  await api('PUT', '/api/profile/bazi', { token, body: { calendar: 'solar', year: 1988, month: 3, day: 15, hour: 10, gender: 'male' } });

  const n = await extractAndRecordProphecies({
    tenantId: user.tenantId,
    userId: user.id,
    text: '结合你的命盘，7 月忌神当令要防守，预计 8 月中旬会有一个转介绍大单落地，9 月是进攻窗口。'.repeat(3),
  });
  assert.equal(n, 0, 'liveProvider=null → 抽取为空');
  assert.equal(await prisma.prophecyLog.count({ where: { userId: user.id } }), 0);

  // 无命盘用户直接短路（连抽取都不调）
  const t2 = await login(uniquePhone(), '无盘用户');
  const u2 = await prisma.user.findFirstOrThrow({ where: { id: t2 } });
  assert.equal(await extractAndRecordProphecies({ tenantId: u2.tenantId, userId: u2.id, text: 'x'.repeat(200) }), 0);
});

test('注入：有预言 → dynamic 段带【天机账本】；未命中口径含「人谋可以改命」提示', async () => {
  const token = await login(uniquePhone(), '注入天机用户');
  const user = await prisma.user.findFirstOrThrow({ where: { id: token } });
  await api('POST', '/api/prophecies', { token, body: { prophecy: '下月有贵人引荐', dueDate: dayKeyFromNow(30) } });

  const line = await prophecyBriefing(user.id);
  assert.ok(line);
  assert.match(line!, /【天机账本（系统计数/);
  assert.match(line!, /人谋可以改命/);

  const { ctx } = await buildGenContext({ userId: user.id, tenantId: user.tenantId, agentKey: 'general', userMessage: '月度复盘' });
  const { dynamic } = buildSystemParts(ctx.systemPrompt, ctx, 'chat');
  assert.match(dynamic, /【天机账本/);
  assert.match(dynamic, /下月有贵人引荐/);
});

test('到期扫描：pending 且到期 → 登记对账候选，行级幂等；未到期/已验证不动', async () => {
  await isolateDueScan();
  const token = await login(uniquePhone(), '到期用户');
  const user = await prisma.user.findFirstOrThrow({ where: { id: token } });
  const mk = (prophecy: string, dueDate: string | null, status = 'pending') =>
    prisma.prophecyLog.create({ data: { tenantId: user.tenantId, userId: user.id, seq: Math.floor(Math.random() * 1e9), prophecy, dueDate, status } });
  const due = await mk('已到期预言', dayKeyFromNow(-30));
  await mk('未到期预言', dayKeyFromNow(30));
  await mk('已验证预言', dayKeyFromNow(-60), 'hit');

  const n = await scanDueProphecies();
  assert.equal(n, 1);
  const rows = await prisma.auditLog.findMany({ where: { action: 'system.prophecy.due', userId: user.id } });
  assert.equal(rows.length, 1);
  assert.equal((rows[0].payloadJson as { prophecyId: string }).prophecyId, due.id);

  // 重扫幂等（dueNotifiedAt 已置）
  assert.equal(await scanDueProphecies(), 0);
});

test('到期推送：有额度→推一条并扣减；岁验预言用谶语措辞；同轮多条到期只打扰一次；重扫不复推', async () => {
  process.env.WECHAT_SUBSCRIBE_REVIEW_TEMPLATE_ID = 'tpl-review-prophecy';
  process.env.WECHAT_MINI_APPID = 'wx-test-app';
  process.env.WECHAT_MINI_SECRET = 'secret-test';
  _resetTokenCache();
  const oldFetch = globalThis.fetch;
  const calls: { url: string; body?: { touser?: string; data?: Record<string, { value: string }> } }[] = [];
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
    await isolateDueScan(); // 同上：本用例断言全局到期条数与推送条数，前序遗留的 pending 行必须先锚死
    // 用户 A：岁验预言到期（basis 走 registerVerseOmen 的约定前缀）
    const tokenA = await login(uniquePhone(), '岁验推送用户');
    const userA = await prisma.user.findFirstOrThrow({ where: { id: tokenA } });
    await prisma.user.update({ where: { id: tokenA }, data: { wechatOpenId: 'openid-omen-due' } });
    await prisma.wechatSubscription.create({
      data: { tenantId: userA.tenantId, userId: userA.id, scene: 'review', templateId: 'tpl-review-prophecy', status: 'accept', remaining: 3, acceptedAt: new Date() },
    });
    await prisma.prophecyLog.create({
      data: { tenantId: userA.tenantId, userId: userA.id, seq: 900001, prophecy: '利刃藏锋不轻鸣，今岁南风助势成', basis: '年度谶语·岁验·2025', dueDate: '2026-02-04', status: 'pending' },
    });
    // 用户 B：两条普通预言同日到期 → 只推一条
    const tokenB = await login(uniquePhone(), '普通预言推送用户');
    const userB = await prisma.user.findFirstOrThrow({ where: { id: tokenB } });
    await prisma.user.update({ where: { id: tokenB }, data: { wechatOpenId: 'openid-prophecy-due' } });
    await prisma.wechatSubscription.create({
      data: { tenantId: userB.tenantId, userId: userB.id, scene: 'review', templateId: 'tpl-review-prophecy', status: 'accept', remaining: 3, acceptedAt: new Date() },
    });
    await prisma.prophecyLog.create({ data: { tenantId: userB.tenantId, userId: userB.id, seq: 900002, prophecy: '3 月回款延迟', dueDate: '2026-03-31', status: 'pending' } });
    await prisma.prophecyLog.create({ data: { tenantId: userB.tenantId, userId: userB.id, seq: 900003, prophecy: '4 月有意外进账', dueDate: '2026-04-30', status: 'pending' } });

    const n = await scanDueProphecies();
    assert.equal(n, 3, '三条到期都登记对账候选');

    const sends = calls.filter((c) => c.url.includes('/message/subscribe/send'));
    assert.equal(sends.length, 2, '每用户每轮至多一条推送（B 的两条只打扰一次）');
    const toA = sends.find((c) => c.body?.touser === 'openid-omen-due');
    assert.ok(toA, '岁验用户收到推送');
    // 字段键 = review 模板 26922 的真实关键词（thing2 类型 / thing3 名称 / thing5 备注）
    assert.equal(toA!.body!.data!.thing2.value, '岁验', '岁验走专属类型位');
    assert.equal(toA!.body!.data!.thing3.value, '一年前那句话，今日对账', '岁验专属措辞');
    assert.equal(toA!.body!.data!.thing5.value, '利刃藏锋不轻鸣，今岁南风助势成', '谶语整句可见（恰 15 字 ≤ 20 字上限）');
    const toB = sends.find((c) => c.body?.touser === 'openid-prophecy-due');
    assert.equal(toB!.body!.data!.thing2.value, '预言对账');
    assert.equal(toB!.body!.data!.thing3.value, '预言到期·今日对账');

    // 额度各扣一份；推送有日志
    assert.equal((await prisma.wechatSubscription.findFirstOrThrow({ where: { userId: userA.id } })).remaining, 2);
    assert.equal((await prisma.wechatSubscription.findFirstOrThrow({ where: { userId: userB.id } })).remaining, 2);
    assert.equal(await prisma.wechatNotificationLog.count({ where: { userId: userB.id, scene: 'review', status: 'sent' } }), 1);

    // 重扫：dueNotifiedAt 已置 → 不复推不复记
    const before = calls.length;
    assert.equal(await scanDueProphecies(), 0);
    assert.equal(calls.length, before, '重扫零网络调用');
  } finally {
    globalThis.fetch = oldFetch;
    delete process.env.WECHAT_SUBSCRIBE_REVIEW_TEMPLATE_ID;
    delete process.env.WECHAT_MINI_APPID;
    delete process.env.WECHAT_MINI_SECRET;
    _resetTokenCache();
  }
});

test('隔离：他人不能验证我的预言', async () => {
  const token = await login(uniquePhone(), '我预言');
  const other = await login(uniquePhone(), '他预言');
  const p = await api('POST', '/api/prophecies', { token, body: { prophecy: '我的预言' } });
  const r = await api('POST', `/api/prophecies/${p.body.prophecy.id}/verify`, { token: other, body: { outcome: 'hit' } });
  assert.equal(r.status, 404);
});
