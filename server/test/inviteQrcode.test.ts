/**
 * 邀请小程序码（静态传播链）。
 *
 * 这条链的价值在于**转发到不了的地方**：名片、门店台卡、提案封底、展会物料。
 * 所以它的失败模式也不同——码是印出去的，scene 形状错了、或者码指向登录门，
 * 物料就废了，而且没法召回。下面几条守的正是这些。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { QR_SLOTS, parseSlot, sceneFor } from '../src/services/inviteQrcode.ts';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, uniquePhone } from './helpers.ts';
import { prisma } from '../src/db.ts';

test.before(async () => { await getApp(); await seedBaseline(); });
test.after(async () => { await closeApp(); });

test('scene 形状：ic: 前缀 + 可选物料位，且绝不超微信 32 字符硬限制', () => {
  // 32 是微信 getwxacode/unlimit 的 scene 上限。超了微信直接报错，
  // 而这错误只有真去生成码才会暴露——所以在这里钉死。
  assert.equal(sceneFor('JS2K7P', 'default'), 'ic:JS2K7P');
  assert.equal(sceneFor('JS2K7P', 'card'), 'ic:JS2K7P:card');
  for (const slot of QR_SLOTS) {
    const scene = sceneFor('JS2K7P', slot);
    assert.ok(scene.length <= 32, `${slot} 的 scene 有 ${scene.length} 字符，超 32 上限`);
    assert.ok(scene.startsWith('ic:'), 'scene 必须带 ic: 前缀——端上 invite.js 只认这个形状');
  }
  // 即使邀请码将来变长（现在是 JS+4=6 位），也要留够余量
  const longest = sceneFor('JS' + 'X'.repeat(10), 'event');
  assert.ok(longest.length <= 32, `码变长后仍不能超限，当前 ${longest.length}`);
});

test('物料位白名单：脏值一律落回 default，不能把未知位拼进 scene', () => {
  // scene 是印在物料上的，拼进未知字符串等于印出一张归因不了的码。
  assert.equal(parseSlot('card'), 'card');
  assert.equal(parseSlot('store'), 'store');
  assert.equal(parseSlot(undefined), 'default');
  assert.equal(parseSlot(''), 'default');
  assert.equal(parseSlot('../../etc'), 'default', '未知位必须落回 default');
  assert.equal(parseSlot('CARD'), 'default', '大小写不匹配也算未知');
  assert.equal(parseSlot(123), 'default');
});

test('端点：生成失败也回 200 + dataUri:null，不能让邀请页整页打不开', async () => {
  // 测试环境 inviteQrcode 恒返回 null（与 miniCodeDataUri 同一条铁律），
  // 正好用来验降级：这条链是增强，微信限流不该把页面拖垮。
  await cleanBusiness();
  const phone = uniquePhone();
  const login = await api<{ token: string }>('POST', '/api/auth/login', { body: { phone, name: '扫码老板' } });
  assert.equal(login.status, 200, `注册应成功，实际 ${login.status} ${JSON.stringify(login.body)}`);
  const token = login.body.token;

  const r = await api('GET', '/api/invite/qrcode', { token });
  assert.equal(r.status, 200, '生成失败必须回 200 而不是 5xx');
  assert.equal(r.body.dataUri, null, '测试环境应降级为 null');
  assert.match(r.body.inviteCode, /^JS[0-9A-HJKMNP-TV-Z]{4}$/, '要顺带把邀请码给客户端（降级时显示大字用）');
  assert.equal(r.body.slot, 'default');

  // 落地页必须是公开页：陌生人扫码第一屏撞上登录门，这张印出去的码就废了
  assert.equal(r.body.landingPage, 'pages/sessions/index');

  const withSlot = await api('GET', '/api/invite/qrcode?slot=card', { token });
  assert.equal(withSlot.body.slot, 'card');
  assert.equal(withSlot.body.inviteCode, r.body.inviteCode, '同一用户的码在不同物料位下必须一致');

  const dirty = await api('GET', '/api/invite/qrcode?slot=%2E%2E%2Fetc', { token });
  assert.equal(dirty.body.slot, 'default', '脏 slot 落回 default');
});

test('未登录不得取码：邀请码能反查到人，属个人数据', async () => {
  const r = await api('GET', '/api/invite/qrcode');
  assert.equal(r.status, 401);
});

test('邀请码惰性生成：从没打开过 /me 也能直接取码', async () => {
  await cleanBusiness();
  const phone = uniquePhone();
  const login = await api<{ token: string }>('POST', '/api/auth/login', { body: { phone, name: '扫码老板' } });
  assert.equal(login.status, 200);
  const token = login.body.token;
  // 刻意不调 /me，直接要码
  const r = await api('GET', '/api/invite/qrcode', { token });
  assert.equal(r.status, 200);
  assert.ok(r.body.inviteCode, '必须现场生成邀请码，不能因为没进过 /me 就回空');
  const inDb = await prisma.user.findFirstOrThrow({ where: { phone }, select: { inviteCode: true } });
  assert.equal(inDb.inviteCode, r.body.inviteCode, '生成的码要落库，下次取到同一个');
});
