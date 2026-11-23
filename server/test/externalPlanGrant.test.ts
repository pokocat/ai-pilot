// 声量AI 代售军师套餐（POST /api/s2s/plan-grants）与网页直连（/api/studio-web/*）的集成测试。
//
// 全程离线：现生成 RSA 密钥对，`${ID_ISSUER}/oauth2/jwks` 与 `/userinfo` 挂在 fetch 打桩上（同 identity.test.ts）。
// 覆盖：鉴权（只认指定客户端的机器令牌）、按订单号防重、同单号不同内容拒绝、无账号挂起→首登领取、
// 会缩短权益的开通记 blocked、对账查询、网页状态接口、过期用户只读、CORS 白名单。
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { prisma } from '../src/db.js';
import { resetIdentityJwksCache } from '../src/services/identity.js';
import { resetIdentityUserCache } from '../src/services/identityProvisioning.js';
import { __resetPlanGate } from '../src/services/planGate.js';
import sharp from 'sharp';
import { ingestChatImage } from '../src/services/chatImage.js';
import { __setStudioWebClassifierForTest } from '../src/routes/studioWeb.js';
import { api, cleanBusiness, closeApp, getApp, login, seedBaseline, uniquePhone } from './helpers.js';

const ISSUER = 'https://id.example.test';
const CLIENT = 'aistar-junshi-grant';
const GRANT_AUD = 'junshi-plan-grant';
const originalFetch = globalThis.fetch;

let signer: { kid: string; privateKey: KeyObject; jwk: Record<string, unknown> };
let userinfoByUid = new Map<string, Record<string, unknown>>();

const b64url = (buf: Buffer) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlJson = (obj: unknown) => b64url(Buffer.from(JSON.stringify(obj), 'utf8'));

function sign(payload: Record<string, unknown>): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT', kid: signer.kid };
  const body = { iss: ISSUER, iat: now, nbf: now, exp: now + 300, ...payload };
  const input = `${b64urlJson(header)}.${b64urlJson(body)}`;
  return `${input}.${b64url(cryptoSign('sha256', Buffer.from(input, 'utf8'), signer.privateKey))}`;
}

/** 声量AI 后端向账号中心换来的机器令牌形态（client_credentials：sub=azp=client_id、无 amr）。 */
function machineToken(over: Record<string, unknown> = {}) {
  return sign({ sub: CLIENT, azp: CLIENT, aud: [GRANT_AUD], scope: ['junshi:plan.grant'], ...over });
}

/** 声量AI 网页拿到的用户令牌（aud=junshi-api）。 */
function userToken(uid: string, over: Record<string, unknown> = {}) {
  return sign({
    sub: uid, azp: 'web-junshi-studio', aud: ['junshi-api'], amr: ['sms'], phone_verified: true,
    scope: 'openid profile phone', exp: Math.floor(Date.now() / 1000) + 3600, ...over,
  });
}

async function call(method: 'GET' | 'POST' | 'PUT' | 'OPTIONS', url: string, opts: { bearer?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const app = await getApp();
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await app.inject({ method, url, headers, payload: opts.body as object | undefined });
  let body: any = null;
  try { body = res.json(); } catch { body = res.body; }
  return { status: res.statusCode, body, headers: res.headers };
}

async function planByName(name: string) {
  return prisma.plan.findFirstOrThrow({ where: { name } });
}

/** 建一个已绑定 uid 的军师账号（模拟网页首登建档）。 */
async function linkedUser(uid: string) {
  const phone = uniquePhone();
  userinfoByUid.set(uid, { sub: uid, phone_verified: true, phone_number: phone, phone_number_verified: true });
  const me = await call('GET', '/api/me', { bearer: userToken(uid) });
  assert.equal(me.status, 200, JSON.stringify(me.body));
  return prisma.user.findUniqueOrThrow({ where: { identityUid: uid } });
}

const grant = (over: Record<string, unknown> = {}) => ({
  orderNo: `SO${Date.now()}${Math.floor(Math.random() * 1e6)}`, identityUid: 'uid-x', planId: '', source: 'studio', amount: 9900, ...over,
});

before(async () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  signer = { kid: 'k1', privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' } };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin === ISSUER && url.pathname === '/oauth2/jwks') {
      return new Response(JSON.stringify({ keys: [signer.jwk] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.origin === ISSUER && url.pathname === '/userinfo') {
      const bearer = String(new Headers(init?.headers).get('authorization') ?? '').replace(/^Bearer\s+/i, '');
      const uid = JSON.parse(Buffer.from(bearer.split('.')[1], 'base64url').toString('utf8')).sub;
      return new Response(JSON.stringify(userinfoByUid.get(uid) ?? { sub: uid, phone_verified: false }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    // 产品链接回报（未配机密客户端时本来就跳过）；其它外部请求一律视为测试漏桩。
    throw new Error(`未打桩的外部请求：${url.toString()}`);
  }) as typeof fetch;
  await getApp();
  await seedBaseline();
});

after(async () => {
  globalThis.fetch = originalFetch;
  process.env.ID_ISSUER = '';
  delete process.env.JUNSHI_PLAN_GRANT_ENABLED;
  delete process.env.JUNSHI_STUDIO_WEB_ENABLED;
  process.env.TEST_DEFAULT_PLAN_NAME = '入门版';
  await closeApp();
});

beforeEach(async () => {
  await cleanBusiness();
  process.env.ID_ISSUER = ISSUER;
  process.env.ID_AUDIENCES = 'quickreel-api,junshi-api';
  process.env.JUNSHI_PLAN_GRANT_ENABLED = 'true';
  // helpers 给测试期新号默认送入门版；这里要的是生产口径（新号无套餐），否则「开通」测不出来。
  process.env.TEST_DEFAULT_PLAN_NAME = '';
  delete process.env.JUNSHI_PLAN_GRANT_AUDIENCE;
  delete process.env.JUNSHI_PLAN_GRANT_CLIENT_ID;
  userinfoByUid = new Map();
  resetIdentityJwksCache();
  resetIdentityUserCache();
  __resetPlanGate();
});

test('鉴权：只认指定客户端 + aud + scope 的机器令牌', async () => {
  const plan = await planByName('入门版');
  const body = grant({ planId: plan.id });
  const cases: [string, string | undefined, number][] = [
    ['没带令牌', undefined, 401],
    ['用户令牌（aud=junshi-api、带 amr）', userToken('uid-x'), 401],
    ['机器令牌但 scope 不对', machineToken({ scope: ['product.link'] }), 401],
    ['机器令牌但客户端不对', machineToken({ sub: 'other-s2s', azp: 'other-s2s' }), 401],
    ['机器令牌但 aud 不对', machineToken({ aud: ['junshi-api'] }), 401],
    ['aud 多一项也不行', machineToken({ aud: [GRANT_AUD, 'junshi-api'] }), 401],
    ['带 amr（人的令牌伪装）', machineToken({ amr: ['sms'] }), 401],
    ['过期', machineToken({ exp: Math.floor(Date.now() / 1000) - 600 }), 401],
    ['iss 不对', machineToken({ iss: 'https://evil.example.test' }), 401],
  ];
  for (const [name, bearer, status] of cases) {
    const r = await call('POST', '/api/s2s/plan-grants', { bearer, body });
    assert.equal(r.status, status, `${name}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.code, 'UNAUTHORIZED', name);
  }
  // 伪造签名（换一把私钥签）
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const good = machineToken();
  const [h, p] = good.split('.');
  const forged = `${h}.${p}.${b64url(cryptoSign('sha256', Buffer.from(`${h}.${p}`), privateKey))}`;
  assert.equal((await call('POST', '/api/s2s/plan-grants', { bearer: forged, body })).status, 401);
  // 开关关着：503，且不落库
  process.env.JUNSHI_PLAN_GRANT_ENABLED = 'false';
  const off = await call('POST', '/api/s2s/plan-grants', { bearer: machineToken(), body });
  assert.equal(off.status, 503);
  assert.equal(off.body.code, 'PLAN_GRANT_DISABLED');
  assert.equal(await prisma.externalPlanGrant.count(), 0);
  // 机器令牌打用户接口不建档
  const me = await call('GET', '/api/me', { bearer: machineToken() });
  assert.equal(me.status, 401);
  assert.equal(await prisma.user.count(), 0);
});

test('已有账号：开通到账；同订单号重放返回第一次结果、不重复发额度', async () => {
  const user = await linkedUser('uid-paid');
  const plan = await planByName('入门版');
  const body = grant({ identityUid: 'uid-paid', planId: plan.id, orderNo: 'SO-0001' });

  const first = await call('POST', '/api/s2s/plan-grants', { bearer: machineToken(), body });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.status, 'applied');
  assert.equal(first.body.replay, false);
  assert.equal(first.body.plan.id, plan.id);
  assert.ok(first.body.planExpiresAt);
  assert.equal(first.body.grantedTokens, plan.tokenQuotaPerMonth);
  assert.equal(first.body.tokenQuota.limit, plan.tokenQuotaPerMonth);
  assert.equal(first.body.tokenQuota.remaining, plan.tokenQuotaPerMonth);

  const ledgerBefore = await prisma.creditLedger.count({ where: { userId: user.id } });
  const again = await call('POST', '/api/s2s/plan-grants', { bearer: machineToken(), body });
  assert.equal(again.status, 200);
  assert.equal(again.body.replay, true);
  assert.equal(again.body.grantId, first.body.grantId);
  assert.equal(again.body.planExpiresAt, first.body.planExpiresAt);
  assert.equal(await prisma.creditLedger.count({ where: { userId: user.id } }), ledgerBefore, '重放不许再写钻石流水');
  assert.equal(await prisma.planEntitlement.count({ where: { userId: user.id } }), 1);
  const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  assert.equal(after.planId, plan.id);
  assert.equal(after.planExpiresAt?.toISOString(), first.body.planExpiresAt);

  // 并发重放同一单：仍只有一行、一笔权益
  const racers = await Promise.all([0, 1, 2].map(() => call('POST', '/api/s2s/plan-grants', { bearer: machineToken(), body })));
  for (const r of racers) assert.equal(r.status, 200);
  assert.equal(await prisma.externalPlanGrant.count(), 1);
  assert.equal(await prisma.planEntitlement.count({ where: { userId: user.id } }), 1);

  // 开通后用户写接口不再被套餐闸拦（缓存已清）
  const write = await call('PUT', '/api/me', { bearer: userToken('uid-paid'), body: { name: '已开通' } });
  assert.notEqual(write.status, 403, JSON.stringify(write.body));
});

test('同订单号、内容不同：409 GRANT_ORDER_CONFLICT，不改动原记录', async () => {
  await linkedUser('uid-conflict');
  const starter = await planByName('入门版');
  const decision = await planByName('决策版 · 月付');
  const body = grant({ identityUid: 'uid-conflict', planId: starter.id, orderNo: 'SO-CONFLICT' });
  assert.equal((await call('POST', '/api/s2s/plan-grants', { bearer: machineToken(), body })).status, 200);
  for (const change of [{ planId: decision.id }, { amount: 1 }, { identityUid: 'uid-other' }]) {
    const r = await call('POST', '/api/s2s/plan-grants', { bearer: machineToken(), body: { ...body, ...change } });
    assert.equal(r.status, 409, JSON.stringify(change));
    assert.equal(r.body.code, 'GRANT_ORDER_CONFLICT');
  }
  const row = await prisma.externalPlanGrant.findFirstOrThrow({ where: { orderNo: 'SO-CONFLICT' } });
  assert.equal(row.planId, starter.id);
  assert.equal(row.amount, 9900);
});

test('还没有军师账号：先挂起 202，首次带令牌进军师时建档并领取', async () => {
  const plan = await planByName('入门版');
  const body = grant({ identityUid: 'uid-new', planId: plan.id, orderNo: 'SO-PENDING' });
  const pending = await call('POST', '/api/s2s/plan-grants', { bearer: machineToken(), body });
  assert.equal(pending.status, 202, JSON.stringify(pending.body));
  assert.equal(pending.body.status, 'pending');
  assert.equal(await prisma.user.count(), 0, '只有 uid 不建号（军师账号键是手机号）');

  // 重放仍是 pending、不重复落行
  assert.equal((await call('POST', '/api/s2s/plan-grants', { bearer: machineToken(), body })).status, 202);
  assert.equal(await prisma.externalPlanGrant.count(), 1);

  // 用户第一次打开军师网页：建档 + 领取
  const user = await linkedUser('uid-new');
  assert.equal(user.planId, plan.id);
  assert.ok(user.planExpiresAt);
  const row = await prisma.externalPlanGrant.findFirstOrThrow({ where: { orderNo: 'SO-PENDING' } });
  assert.equal(row.status, 'applied');
  assert.equal(row.userId, user.id);

  // 再次通知：200 + 第一次开通的结果
  const replay = await call('POST', '/api/s2s/plan-grants', { bearer: machineToken(), body });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.status, 'applied');
  assert.equal(await prisma.planEntitlement.count({ where: { userId: user.id } }), 1);
});

test('不可代售的套餐与参数错误：不落库', async () => {
  await linkedUser('uid-bad');
  const free = await prisma.plan.create({ data: { name: '面议', price: -1, period: 'year', creditsPerMonth: -1, tokenQuotaPerMonth: -1, agentCount: 1, featuresJson: [] } });
  const r = await call('POST', '/api/s2s/plan-grants', { bearer: machineToken(), body: grant({ identityUid: 'uid-bad', planId: free.id }) });
  assert.equal(r.status, 422);
  assert.equal(r.body.code, 'PLAN_NOT_SELLABLE');
  const bad = await call('POST', '/api/s2s/plan-grants', { bearer: machineToken(), body: { orderNo: 'x y', identityUid: 'uid-bad', planId: free.id, source: 'studio', amount: 1 } });
  assert.equal(bad.status, 400);
  const badSource = await call('POST', '/api/s2s/plan-grants', { bearer: machineToken(), body: grant({ identityUid: 'uid-bad', planId: free.id, source: 'other' }) });
  assert.equal(badSource.status, 400);
  assert.equal(await prisma.externalPlanGrant.count(), 0);
});

test('会缩短现有权益（高档降低档）：记 blocked 409，用户套餐不动；重放结论相同', async () => {
  const user = await linkedUser('uid-high');
  const decision = await planByName('决策版 · 月付');
  const starter = await planByName('入门版');
  assert.equal((await call('POST', '/api/s2s/plan-grants', { bearer: machineToken(), body: grant({ identityUid: 'uid-high', planId: decision.id, orderNo: 'SO-HIGH' }) })).status, 200);
  const before = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  const body = grant({ identityUid: 'uid-high', planId: starter.id, orderNo: 'SO-LOW' });
  const r = await call('POST', '/api/s2s/plan-grants', { bearer: machineToken(), body });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, 'PLAN_CHANGE_SHORTENS');
  assert.equal(r.body.status, 'blocked');
  assert.equal(r.body.blocked.currentPlanId, decision.id);
  const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  assert.equal(after.planId, decision.id);
  assert.equal(after.planExpiresAt?.toISOString(), before.planExpiresAt?.toISOString());
  const replay = await call('POST', '/api/s2s/plan-grants', { bearer: machineToken(), body });
  assert.equal(replay.status, 409);
  assert.equal(replay.body.grantId, r.body.grantId);
});

test('对账：按订单号查、按条件列表；查询同样要机器令牌', async () => {
  await linkedUser('uid-q');
  const plan = await planByName('入门版');
  await call('POST', '/api/s2s/plan-grants', { bearer: machineToken(), body: grant({ identityUid: 'uid-q', planId: plan.id, orderNo: 'SO-Q1' }) });
  await call('POST', '/api/s2s/plan-grants', { bearer: machineToken(), body: grant({ identityUid: 'uid-nobody', planId: plan.id, orderNo: 'SO-Q2' }) });

  const one = await call('GET', '/api/s2s/plan-grants/studio/SO-Q1', { bearer: machineToken() });
  assert.equal(one.status, 200);
  assert.equal(one.body.status, 'applied');
  assert.equal(one.body.amount, 9900);
  assert.equal((await call('GET', '/api/s2s/plan-grants/studio/SO-NONE', { bearer: machineToken() })).status, 404);
  assert.equal((await call('GET', '/api/s2s/plan-grants/studio/SO-Q1', { bearer: userToken('uid-q') })).status, 401);

  const list = await call('GET', '/api/s2s/plan-grants?source=studio&status=pending', { bearer: machineToken() });
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.items.map((item: { orderNo: string }) => item.orderNo), ['SO-Q2']);
  const all = await call('GET', '/api/s2s/plan-grants?source=studio', { bearer: machineToken() });
  assert.equal(all.body.items.length, 2);
});

test('网页状态接口：只认账号中心令牌；返回套餐/额度/免费诊断', async () => {
  // 老登录（x-user-id）不能用网页接口
  const legacy = await login(uniquePhone(), '老用户');
  const old = await api('GET', '/api/studio-web/status', { token: legacy });
  assert.equal(old.status, 401);

  await linkedUser('uid-web');
  const none = await call('GET', '/api/studio-web/status', { bearer: userToken('uid-web') });
  assert.equal(none.status, 200, JSON.stringify(none.body));
  assert.equal(none.body.plan, null);
  assert.equal(none.body.planStatus.state, 'none');
  assert.equal(none.body.quickscan.freeAvailableToday, true);
  assert.equal(none.body.quickscan.availableToday, true);
  assert.equal(none.body.account.identityUid, 'uid-web');

  // quickreel 令牌不能访问军师网页接口
  userinfoByUid.set('uid-qr', { sub: 'uid-qr', phone_verified: true, phone_number: uniquePhone(), phone_number_verified: true });
  const qr = await call('GET', '/api/studio-web/status', { bearer: userToken('uid-qr', { aud: ['quickreel-api'] }) });
  assert.equal(qr.status, 403);
  assert.equal(qr.body.code, 'STUDIO_WEB_AUDIENCE_REQUIRED');

  // 先付款后打开：状态接口顺手领取挂起订单
  const plan = await planByName('入门版');
  await call('POST', '/api/s2s/plan-grants', { bearer: machineToken(), body: grant({ identityUid: 'uid-web', planId: plan.id, orderNo: 'SO-WEB' }) });
  const active = await call('GET', '/api/studio-web/status', { bearer: userToken('uid-web') });
  assert.equal(active.body.plan.id, plan.id);
  assert.equal(active.body.planStatus.state, 'active');
  assert.equal(active.body.tokenQuota.limit, plan.tokenQuotaPerMonth);
});

test('过期用户用 Bearer：只读接口能读，写接口 403 PLAN_EXPIRED，免费诊断不可用', async () => {
  const user = await linkedUser('uid-expired');
  const plan = await planByName('入门版');
  await prisma.user.update({ where: { id: user.id }, data: { planId: plan.id, planActivatedAt: new Date(Date.now() - 40 * 864e5), planExpiresAt: new Date(Date.now() - 864e5) } });
  __resetPlanGate();
  const bearer = userToken('uid-expired');
  for (const url of ['/api/casefile', '/api/progress', '/api/reviews', '/api/reports', '/api/sessions', '/api/prescriptions', '/api/journey', '/api/me']) {
    const r = await call('GET', url, { bearer });
    assert.equal(r.status, 200, `${url}: ${JSON.stringify(r.body)}`);
  }
  const status = await call('GET', '/api/studio-web/status', { bearer });
  assert.equal(status.body.planStatus.state, 'expired');
  assert.equal(status.body.quickscan.availableToday, false);
  const write = await call('POST', '/api/quickscan', { bearer, body: { industry: '餐饮', revenueBand: '100万以下', pain: '客流少' } });
  assert.equal(write.status, 403);
  assert.equal(write.body.code, 'PLAN_EXPIRED');
});

test('网页制作方案与参考图：开关关闭时安全降级；参考图只给本人', async () => {
  await linkedUser('uid-intent');
  const bearer = userToken('uid-intent');
  delete process.env.JUNSHI_STUDIO_WEB_ENABLED;
  const off = await call('GET', '/api/studio-web/references/abc', { bearer });
  assert.equal(off.status, 404);
  process.env.JUNSHI_STUDIO_WEB_ENABLED = 'true';
  const missing = await call('GET', '/api/studio-web/references/not-mine', { bearer });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, 'REFERENCE_NOT_FOUND');
  // 小程序原接口对 Bearer 不发票据（小程序草稿开关在测试环境关闭时同样只回 chat）
  const mini = await call('POST', '/api/studio/intent', { bearer, body: { text: '做一张海报', clientRequestId: 'c1' } });
  assert.equal(mini.body.studioIntentTicket, undefined);
});

test('CORS：白名单 Origin 回显，其它 Origin 不给头', async () => {
  const ok = await call('OPTIONS', '/api/studio-web/status', { headers: { origin: 'https://aiavatar.aibuzz.cn', 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' } });
  assert.equal(ok.headers['access-control-allow-origin'], 'https://aiavatar.aibuzz.cn');
  const dev = await call('OPTIONS', '/api/generate', { headers: { origin: 'http://localhost:3013', 'access-control-request-method': 'POST' } });
  assert.equal(dev.headers['access-control-allow-origin'], 'http://localhost:3013');
  const evil = await call('OPTIONS', '/api/studio-web/status', { headers: { origin: 'https://evil.example.com', 'access-control-request-method': 'GET' } });
  assert.equal(evil.headers['access-control-allow-origin'], undefined);
  process.env.CORS_ALLOWED_ORIGINS = 'https://only.example.com';
  try {
    const custom = await call('OPTIONS', '/api/me', { headers: { origin: 'https://aiavatar.aibuzz.cn', 'access-control-request-method': 'GET' } });
    assert.equal(custom.headers['access-control-allow-origin'], undefined);
  } finally { delete process.env.CORS_ALLOWED_ORIGINS; }
});

test('网页制作方案：draft 明文返回方案与参考图地址；参考图原图只给本人', async () => {
  process.env.JUNSHI_STUDIO_WEB_ENABLED = 'true';
  const user = await linkedUser('uid-draft');
  const plan = await planByName('入门版');
  await call('POST', '/api/s2s/plan-grants', { bearer: machineToken(), body: grant({ identityUid: 'uid-draft', planId: plan.id, orderNo: 'SO-DRAFT' }) });
  const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#204060' } }).png().toBuffer();
  const image = await ingestChatImage({ userId: user.id, tenantId: user.tenantId, mime: 'image/png', buf: png, fileName: '门店.png' });
  __setStudioWebClassifierForTest(async () => ({ action: 'draft', kind: 'image', prompt: '门店开业海报', specs: { ratio: '3:4' }, images: [1] }));
  try {
    const r = await call('POST', '/api/studio-web/intent', {
      bearer: userToken('uid-draft'),
      body: { text: '这张图片做成3:4开业海报', clientRequestId: 'web-1', refs: [{ kind: 'image', id: image.id, label: '门店' }] },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.action, 'draft');
    assert.equal(r.body.plan.kind, 'image');
    assert.equal(r.body.plan.prompt, '门店开业海报');
    assert.deepEqual(r.body.plan.referenceIds, [image.id]);
    assert.equal(r.body.plan.specs.ratio, '3:4');
    assert.equal(r.body.references[0].url, `/api/studio-web/references/${image.id}`);
    assert.equal(r.body.source.clientRequestId, 'web-1');
    assert.equal(r.body.studioIntentTicket, undefined, '网页不拿加密票据');

    const raw = await (await getApp()).inject({ method: 'GET', url: r.body.references[0].url, headers: { authorization: `Bearer ${userToken('uid-draft')}` } });
    assert.equal(raw.statusCode, 200);
    assert.equal(raw.headers['content-type'], 'image/png');
    assert.equal(raw.headers['cache-control'], 'private, no-store');
    assert.ok(raw.rawPayload.length > 0);
    // 别人拿同一个 id 取不到
    await linkedUser('uid-other');
    const other = await call('GET', r.body.references[0].url, { bearer: userToken('uid-other') });
    assert.equal(other.status, 404);

    // 无套餐用户：intent 与小程序同口径被套餐闸拦
    const none = await call('POST', '/api/studio-web/intent', { bearer: userToken('uid-other'), body: { text: '做一张海报', clientRequestId: 'web-2' } });
    assert.equal(none.status, 403);
    assert.equal(none.body.code, 'PLAN_REQUIRED');
  } finally {
    __setStudioWebClassifierForTest(undefined);
  }
});
