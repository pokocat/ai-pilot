// 统一账号中心（aibuzz-id）接入的集成测试：RS256 验签、首登建档、手机号闸、老链路不受影响。
//
// 全程离线：测试里现生成 RSA 密钥对，把 `${ID_ISSUER}/oauth2/jwks` 与 `${ID_ISSUER}/userinfo`
// 挂在 fetch 打桩上（与 video.test.ts 同一套路，本仓没有 nock，也不该为此加依赖）。
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { prisma } from '../src/db.js';
import { resetIdentityJwksCache, verifyIdentityToken } from '../src/services/identity.js';
import { identifyRequest, resetIdentityUserCache } from '../src/services/identityProvisioning.js';
import { __resetPlanGate } from '../src/services/planGate.js';
import { api, cleanBusiness, closeApp, getApp, login, seedBaseline, uniquePhone } from './helpers.js';

// 套餐闸用例要打一次 `/api/video/**`；给个假上游地址，由下面的 fetch 打桩接住，绝不出网。
process.env.ADMIN_TOKEN = 'test-admin-token';
process.env.AIDRAMA_CLIP_BASE_URL = 'https://aidrama.example.test';
process.env.AIDRAMA_CLIP_SERVICE_TOKEN = 'test-service-token';
process.env.AIDRAMA_CLIP_ALLOW_PRIVATE_NET = 'false';

const ISSUER = 'https://id.example.test';
const AUDIENCE = 'quickreel-api';
const AIDRAMA_ORIGIN = 'https://aidrama.example.test';

const originalFetch = globalThis.fetch;

interface Signer { kid: string; privateKey: KeyObject; jwk: Record<string, unknown> }

function makeSigner(kid: string): Signer {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  return { kid, privateKey, jwk: { ...jwk, kid, alg: 'RS256', use: 'sig' } };
}

const b64url = (buf: Buffer) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlJson = (obj: unknown) => b64url(Buffer.from(JSON.stringify(obj), 'utf8'));

function issueToken(signer: Signer, payload: Record<string, unknown>, headerOverride: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT', kid: signer.kid, ...headerOverride };
  const body = {
    iss: ISSUER, aud: [AUDIENCE], azp: 'quickreel-mini',
    iat: now, nbf: now, exp: now + 3600, scope: 'openid profile phone offline_access',
    ...payload,
  };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(body)}`;
  const sig = cryptoSign('sha256', Buffer.from(signingInput, 'utf8'), signer.privateKey);
  return `${signingInput}.${b64url(sig)}`;
}

/** 当前挂在假 JWKS 上的公钥（换钥测试会改它）。 */
let servedKeys: Signer[] = [];
/** uid → userinfo 响应；缺省给一个没有手机号的响应。 */
let userinfoByUid = new Map<string, Record<string, unknown>>();
let jwksCalls = 0;
let userinfoCalls = 0;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function subOf(bearer: string): string {
  const payload = JSON.parse(Buffer.from(bearer.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  return String(payload.sub ?? '');
}

before(async () => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin === ISSUER && url.pathname === '/oauth2/jwks') {
      jwksCalls += 1;
      return json({ keys: servedKeys.map((item) => item.jwk) });
    }
    if (url.origin === ISSUER && url.pathname === '/userinfo') {
      userinfoCalls += 1;
      const bearer = String(new Headers(init?.headers).get('authorization') ?? '').replace(/^Bearer\s+/i, '');
      const uid = subOf(bearer);
      const row = userinfoByUid.get(uid);
      return json(row ?? { sub: uid, phone_verified: false });
    }
    // 假 aidrama：套餐闸用例只关心「请求有没有被 403 拦住」，上游内容随便给一个成功体。
    if (url.origin === AIDRAMA_ORIGIN) return json({ ok: true, path: url.pathname });
    throw new Error(`未打桩的外部请求：${url.toString()}`);
  }) as typeof fetch;
  await getApp();
  await seedBaseline();
});

after(async () => {
  globalThis.fetch = originalFetch;
  process.env.ID_ISSUER = '';
  await closeApp();
});

beforeEach(async () => {
  await cleanBusiness();
  process.env.ID_ISSUER = ISSUER;
  process.env.ID_AUDIENCES = 'quickreel-api,junshi-api';
  servedKeys = [makeSigner('k1')];
  userinfoByUid = new Map();
  jwksCalls = 0;
  userinfoCalls = 0;
  resetIdentityJwksCache();
  resetIdentityUserCache();
  __resetPlanGate();
});

async function getMe(bearer: string, extra: Record<string, string> = {}) {
  const app = await getApp();
  const res = await app.inject({
    method: 'GET', url: '/api/me',
    headers: { authorization: `Bearer ${bearer}`, ...extra },
  });
  let body: any = null;
  try { body = res.json(); } catch { body = res.body; }
  return { status: res.statusCode, body };
}

function phoneUserinfo(uid: string, phone: string) {
  return { sub: uid, phone_verified: true, phone_number: phone, phone_number_verified: true };
}

test('phone_verified=false 的令牌不建档，403 PHONE_BINDING_REQUIRED', async () => {
  const token = issueToken(servedKeys[0], { sub: 'uid-nophone', phone_verified: false });
  const r = await getMe(token);
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'PHONE_BINDING_REQUIRED');
  assert.equal(r.body.error, '请先绑定手机号');
  assert.equal(await prisma.user.count(), 0, '不许建出没有手机号的账号');
});

test('首登建档：按 userinfo 的手机号建号并回填 identityUid', async () => {
  const phone = uniquePhone();
  userinfoByUid.set('uid-first', phoneUserinfo('uid-first', phone));
  const token = issueToken(servedKeys[0], { sub: 'uid-first', phone_verified: true });

  const r = await getMe(token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const rows = await prisma.user.findMany({ where: { identityUid: 'uid-first' } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].phone, phone);
  assert.equal(r.body.user?.id ?? r.body.id, rows[0].id);
  // 第二次请求直接命中，不再打 userinfo。
  const again = await getMe(token);
  assert.equal(again.status, 200);
  assert.equal(userinfoCalls, 1);
});

test('并发首登只建一行', async () => {
  const phone = uniquePhone();
  userinfoByUid.set('uid-race', phoneUserinfo('uid-race', phone));
  const token = issueToken(servedKeys[0], { sub: 'uid-race', phone_verified: true });
  resetIdentityUserCache();

  const results = await Promise.all([0, 1, 2, 3, 4].map(async () => {
    resetIdentityUserCache(); // 逼每一路都真去查库/建档，缓存不许替我们把并发消掉
    return getMe(token);
  }));
  for (const r of results) assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await prisma.user.count({ where: { identityUid: 'uid-race' } }), 1);
  assert.equal(await prisma.user.count({ where: { phone } }), 1);
});

test('手机号已有账号：回填 identityUid，沿用同一个本地账号', async () => {
  const phone = uniquePhone();
  const legacyToken = await login(phone, '老账号');
  const existing = await prisma.user.findUniqueOrThrow({ where: { phone } });
  assert.equal(existing.identityUid, null);

  userinfoByUid.set('uid-merge', phoneUserinfo('uid-merge', phone));
  const r = await getMe(issueToken(servedKeys[0], { sub: 'uid-merge', phone_verified: true }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const after = await prisma.user.findUniqueOrThrow({ where: { phone } });
  assert.equal(after.id, existing.id, '不许另建一个账号');
  assert.equal(after.identityUid, 'uid-merge');
  // 老 token 仍然指向同一个人。
  const legacy = await api('GET', '/api/me', { token: legacyToken });
  assert.equal(legacy.status, 200);
});

test('同一手机号被另一个 uid 认领：409 IDENTITY_CONFLICT', async () => {
  const phone = uniquePhone();
  userinfoByUid.set('uid-a', phoneUserinfo('uid-a', phone));
  userinfoByUid.set('uid-b', phoneUserinfo('uid-b', phone));
  assert.equal((await getMe(issueToken(servedKeys[0], { sub: 'uid-a', phone_verified: true }))).status, 200);

  const r = await getMe(issueToken(servedKeys[0], { sub: 'uid-b', phone_verified: true }));
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'IDENTITY_CONFLICT');
  assert.equal(await prisma.user.count({ where: { phone } }), 1);
});

test('aud 不匹配一律拒绝（落 401，不建档）', async () => {
  userinfoByUid.set('uid-aud', phoneUserinfo('uid-aud', uniquePhone()));
  const token = issueToken(servedKeys[0], { sub: 'uid-aud', phone_verified: true, aud: ['someone-else-api'] });
  const r = await getMe(token);
  assert.equal(r.status, 401);
  assert.equal(await prisma.user.count(), 0);
  assert.equal(await verifyIdentityToken(token), null);
});

test('iss 不是 ID_ISSUER、签名不是 JWKS 里的钥匙、令牌过期：一律验不过', async () => {
  const phone = uniquePhone();
  userinfoByUid.set('uid-bad', phoneUserinfo('uid-bad', phone));

  const wrongIss = issueToken(servedKeys[0], { sub: 'uid-bad', phone_verified: true, iss: 'https://evil.example.test' });
  assert.equal((await getMe(wrongIss)).status, 401);

  const stranger = makeSigner('k1'); // 同 kid、不同私钥
  const forged = issueToken(stranger, { sub: 'uid-bad', phone_verified: true });
  assert.equal((await getMe(forged)).status, 401);

  const now = Math.floor(Date.now() / 1000);
  const expired = issueToken(servedKeys[0], { sub: 'uid-bad', phone_verified: true, iat: now - 7200, nbf: now - 7200, exp: now - 3600 });
  assert.equal((await getMe(expired)).status, 401);

  assert.equal(await prisma.user.count(), 0);
});

test('ID_ISSUER 未配 = 整体关闭：RS256 令牌一律 401，不许静默放行', async () => {
  const signer = servedKeys[0];
  const phone = uniquePhone();
  userinfoByUid.set('uid-off', phoneUserinfo('uid-off', phone));
  const token = issueToken(signer, { sub: 'uid-off', phone_verified: true });
  process.env.ID_ISSUER = '';
  resetIdentityJwksCache();

  const r = await getMe(token);
  assert.equal(r.status, 401);
  assert.equal(await prisma.user.count(), 0);
  assert.equal(jwksCalls, 0, '关闭态不该去拉 JWKS');
});

test('遇未知 kid 立即刷新一次 JWKS', async () => {
  const phone = uniquePhone();
  userinfoByUid.set('uid-rotate', phoneUserinfo('uid-rotate', phone));
  // 先用 k1 打通一次，缓存里就有 k1 了。
  assert.equal((await getMe(issueToken(servedKeys[0], { sub: 'uid-rotate', phone_verified: true }))).status, 200);
  assert.equal(jwksCalls, 1);

  // 账号中心换钥：JWKS 换成 k2，令牌用 k2 签。
  const k2 = makeSigner('k2');
  servedKeys = [k2];
  resetIdentityUserCache();
  const r = await getMe(issueToken(k2, { sub: 'uid-rotate', phone_verified: true }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(jwksCalls, 2, '未知 kid 应当触发一次刷新');
});

test('老 x-user-id 链路完全不受影响；两个头都在时以 x-user-id 为准', async () => {
  const legacyPhone = uniquePhone();
  const legacyToken = await login(legacyPhone, '军师老用户');
  const legacyUser = await prisma.user.findUniqueOrThrow({ where: { phone: legacyPhone } });

  // ① 只带 x-user-id：与接入前一模一样。
  const plain = await api('GET', '/api/me', { token: legacyToken });
  assert.equal(plain.status, 200);
  assert.equal(plain.body.user?.id ?? plain.body.id, legacyUser.id);

  // ② 同时带一张账号中心令牌：老头优先，绝不被顶掉，也不会因此建档。
  userinfoByUid.set('uid-both', phoneUserinfo('uid-both', uniquePhone()));
  const both = await getMe(issueToken(servedKeys[0], { sub: 'uid-both', phone_verified: true }), { 'x-user-id': legacyToken });
  assert.equal(both.status, 200);
  assert.equal(both.body.user?.id ?? both.body.id, legacyUser.id);
  assert.equal(await prisma.user.count({ where: { identityUid: 'uid-both' } }), 0);

  // ③ 无任何凭据仍是 401。
  const app = await getApp();
  assert.equal((await app.inject({ method: 'GET', url: '/api/me' })).statusCode, 401);
});

test('identifyRequest：老 token → u:<userId>，账号中心 → id:<sub>，认不出来 → null', async () => {
  const phone = uniquePhone();
  const legacyToken = await login(phone, '限流键');
  const legacyUser = await prisma.user.findUniqueOrThrow({ where: { phone } });

  const reqOf = (headers: Record<string, string>) => ({ headers, url: '/api/me' } as unknown as FastifyRequest);

  assert.equal(identifyRequest(reqOf({ 'x-user-id': legacyToken }))?.key, `u:${legacyUser.id}`);
  assert.equal(identifyRequest(reqOf({}))?.key, undefined);
  assert.equal(identifyRequest(reqOf({ authorization: 'Bearer not-a-jwt' })), null);

  // JWKS 还没进缓存时同步验签取不到 sub → 返回 null（限流退回按 IP 分桶），绝不放行。
  const token = issueToken(servedKeys[0], { sub: 'uid-key', phone_verified: true });
  assert.equal(identifyRequest(reqOf({ authorization: `Bearer ${token}` })), null);
  // 走一次异步验签把 JWKS 灌进缓存后，同步路径就能取到 sub。
  assert.notEqual(await verifyIdentityToken(token), null);
  const hit = identifyRequest(reqOf({ authorization: `Bearer ${token}` }));
  assert.equal(hit?.key, 'id:uid-key');
  assert.equal(hit?.userId, null, 'identifyRequest 不查库');
});

/* ────────────────────────── 套餐闸放行爱速拍（WP-A2 第 1 条） ────────────────────────── */

async function inject(method: 'GET' | 'POST', url: string, headers: Record<string, string>, body?: unknown) {
  const app = await getApp();
  const res = await app.inject({ method, url, headers, ...(body === undefined ? {} : { payload: body }) });
  let parsed: any = null;
  try { parsed = res.json(); } catch { parsed = res.body; }
  return { status: res.statusCode, body: parsed };
}

/**
 * 让账号回到「无套餐」。测试环境 TEST_DEFAULT_PLAN_NAME=入门版，建号即自动开通；
 * 生产上账号中心首登的新账号本来就是这个裸态，本组用例要测的正是它。
 */
async function stripPlan(userId: string): Promise<void> {
  await prisma.user.update({ where: { id: userId }, data: { planId: null, planExpiresAt: null } });
  __resetPlanGate();
}

/** 用一枚指定 aud 的账号中心令牌完成首登建档，返回令牌与本地 userId。 */
async function provisionIdentityUser(uid: string, aud: string[]): Promise<{ token: string; userId: string }> {
  userinfoByUid.set(uid, phoneUserinfo(uid, uniquePhone()));
  const token = issueToken(servedKeys[0], { sub: uid, phone_verified: true, aud });
  const first = await getMe(token);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const user = await prisma.user.findUniqueOrThrow({ where: { identityUid: uid } });
  return { token, userId: user.id };
}

const VIDEO_WRITE = '/api/video/projects/cp_gate/script/reset';

test('套餐闸：quickreel-api 令牌无套餐也能写 /api/video/**，军师自己的写路径仍被拦', async () => {
  const { token, userId } = await provisionIdentityUser('uid-plan-quickreel', ['quickreel-api']);
  await stripPlan(userId);

  const video = await inject('POST', VIDEO_WRITE, { authorization: `Bearer ${token}` }, {});
  assert.notEqual(video.body?.code, 'PLAN_REQUIRED', '爱速拍按钻石计量，不该被军师套餐闸拦');
  assert.equal(video.status, 200, JSON.stringify(video.body));

  // 放行面只到 /api/video/**：同一枚令牌写军师业务仍然要套餐。
  const junshi = await inject('POST', '/api/projects', { authorization: `Bearer ${token}` }, { name: '新项目' });
  assert.equal(junshi.status, 403, JSON.stringify(junshi.body));
  assert.equal(junshi.body.code, 'PLAN_REQUIRED');
});

test('套餐闸：junshi-api 令牌与老 x-user-id 写 /api/video/** 行为一字不变（仍 403 PLAN_REQUIRED）', async () => {
  const { token, userId } = await provisionIdentityUser('uid-plan-junshi', ['junshi-api']);
  await stripPlan(userId);
  const viaJunshiAud = await inject('POST', VIDEO_WRITE, { authorization: `Bearer ${token}` }, {});
  assert.equal(viaJunshiAud.status, 403, JSON.stringify(viaJunshiAud.body));
  assert.equal(viaJunshiAud.body.code, 'PLAN_REQUIRED');

  const legacyPhone = uniquePhone();
  const legacyToken = await login(legacyPhone, '老链路无套餐');
  const legacyUser = await prisma.user.findUniqueOrThrow({ where: { phone: legacyPhone } });
  await stripPlan(legacyUser.id);
  const viaLegacy = await inject('POST', VIDEO_WRITE, { 'x-user-id': legacyToken }, {});
  assert.equal(viaLegacy.status, 403, JSON.stringify(viaLegacy.body));
  assert.equal(viaLegacy.body.code, 'PLAN_REQUIRED');

  // 老 token 同时带一张爱速拍令牌也不许蹭到放行：老头优先，aud 取不到。
  const { token: quickreelToken } = await provisionIdentityUser('uid-plan-mixed', ['quickreel-api']);
  const mixed = await inject('POST', VIDEO_WRITE, { 'x-user-id': legacyToken, authorization: `Bearer ${quickreelToken}` }, {});
  assert.equal(mixed.status, 403, JSON.stringify(mixed.body));
  assert.equal(mixed.body.code, 'PLAN_REQUIRED');
});

test('套餐闸：identifyRequest 把 aud 一并带出来（老链路恒为空数组）', async () => {
  const phone = uniquePhone();
  const legacyToken = await login(phone, 'aud 取值');
  const reqOf = (headers: Record<string, string>) => ({ headers, url: '/api/video/projects/x/script/reset' } as unknown as FastifyRequest);
  assert.deepEqual(identifyRequest(reqOf({ 'x-user-id': legacyToken }))?.aud, []);

  const token = issueToken(servedKeys[0], { sub: 'uid-aud-out', phone_verified: true, aud: ['quickreel-api', 'junshi-api'] });
  assert.notEqual(await verifyIdentityToken(token), null); // 先把 JWKS 灌进缓存
  assert.deepEqual(identifyRequest(reqOf({ authorization: `Bearer ${token}` }))?.aud, ['quickreel-api', 'junshi-api']);
});

test('已建档用户換绑同步资料，保持本地 ID、租户和套餐', async () => {
  const uid = 'uid-profile-refresh';
  const phone = uniquePhone(), nextPhone = uniquePhone();
  userinfoByUid.set(uid, { ...phoneUserinfo(uid, phone), name: '中心旧名', picture: 'https://example.test/old.png' });
  const token = issueToken(servedKeys[0], { sub: uid, phone_verified: true });
  assert.equal((await getMe(token)).status, 200);
  const before = await prisma.user.findUniqueOrThrow({ where: { identityUid: uid } });
  userinfoByUid.set(uid, { ...phoneUserinfo(uid, '+86' + nextPhone), name: '中心新名', picture: null });
  resetIdentityUserCache();
  assert.equal((await getMe(token)).status, 200);
  const after = await prisma.user.findUniqueOrThrow({ where: { identityUid: uid } });
  assert.equal(after.phone, nextPhone); assert.equal(after.name, '中心新名'); assert.equal(after.avatarUrl, null);
  assert.equal(after.id, before.id); assert.equal(after.tenantId, before.tenantId); assert.equal(after.planId, before.planId);
  const list = await api('GET', '/api/admin/users');
  assert.equal(list.body.find((row: any) => row.id === before.id)?.phone, nextPhone);
});

test('userinfo 主体不匹配或未验证号码，不能给另一身份建档', async () => {
  const uid = 'uid-wrong-profile';
  userinfoByUid.set(uid, phoneUserinfo('somebody-else', uniquePhone()));
  let result = await getMe(issueToken(servedKeys[0], { sub: uid, phone_verified: true }));
  assert.equal(result.status, 502); assert.equal(result.body.code, 'IDENTITY_SUB_MISMATCH');
  assert.equal(await prisma.user.count(), 0);
  resetIdentityUserCache();
  userinfoByUid.set(uid, { ...phoneUserinfo(uid, uniquePhone()), phone_number_verified: false, phone_verified: true });
  result = await getMe(issueToken(servedKeys[0], { sub: uid, phone_verified: true }));
  assert.equal(result.status, 403); assert.equal(await prisma.user.count(), 0);
});

test('已有 UID 缺 phone scope 保留号码，scope 数组可以读取资料', async () => {
  const uid = 'uid-scope-shapes';
  userinfoByUid.set(uid, phoneUserinfo(uid, uniquePhone()));
  assert.equal((await getMe(issueToken(servedKeys[0], { sub: uid, phone_verified: true }))).status, 200);
  const before = await prisma.user.findUniqueOrThrow({ where: { identityUid: uid } });
  userinfoByUid.set(uid, phoneUserinfo(uid, uniquePhone())); resetIdentityUserCache();
  assert.equal((await getMe(issueToken(servedKeys[0], { sub: uid, phone_verified: true, scope: 'openid profile' }))).status, 200);
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: before.id } })).phone, before.phone);
  assert.equal(userinfoCalls, 1);
  assert.equal((await getMe(issueToken(servedKeys[0], { sub: uid, phone_verified: true, scope: ['openid', 'profile', 'phone'] }))).status, 200);
  assert.notEqual((await prisma.user.findUniqueOrThrow({ where: { id: before.id } })).phone, before.phone);
});

test('已有 UID 的资料失败保留副本，换绑冲突不合并账号', async () => {
  const uid = 'uid-profile-error';
  userinfoByUid.set(uid, phoneUserinfo(uid, uniquePhone()));
  const token = issueToken(servedKeys[0], { sub: uid, phone_verified: true });
  assert.equal((await getMe(token)).status, 200);
  const before = await prisma.user.findUniqueOrThrow({ where: { identityUid: uid } });
  userinfoByUid.set(uid, { ...phoneUserinfo(uid, '139****1234'), name: '不可覆盖' }); resetIdentityUserCache();
  assert.equal((await getMe(token)).status, 502);
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: before.id } })).phone, before.phone);
  const other = uniquePhone(); await login(other, '另一个人');
  userinfoByUid.set(uid, phoneUserinfo(uid, other)); resetIdentityUserCache();
  assert.equal((await getMe(token)).status, 409);
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: before.id } })).phone, before.phone);
});

test('旧令牌缓存不能把新令牌同步的号码和昵称刷回旧值', async () => {
  const uid = 'uid-older-token-cache';
  userinfoByUid.set(uid, { ...phoneUserinfo(uid, uniquePhone()), name: '旧名' });
  const oldToken = issueToken(servedKeys[0], { sub: uid, phone_verified: true, jti: 'old' });
  assert.equal((await getMe(oldToken)).status, 200);
  const nextPhone = uniquePhone();
  userinfoByUid.set(uid, { ...phoneUserinfo(uid, nextPhone), name: '新名' });
  const newToken = issueToken(servedKeys[0], { sub: uid, phone_verified: true, jti: 'new' });
  assert.equal((await getMe(newToken)).status, 200);
  assert.equal((await getMe(oldToken)).status, 200);
  const current = await prisma.user.findUniqueOrThrow({ where: { identityUid: uid } });
  assert.equal(current.phone, nextPhone); assert.equal(current.name, '新名');
  assert.equal(userinfoCalls, 2);
});


test('已有 UID 并发资料读取应用同一结果，全部成功且只取一次 userinfo', async () => {
  const uid = 'uid-concurrent-profile';
  userinfoByUid.set(uid, { ...phoneUserinfo(uid, uniquePhone()), name: '旧名' });
  const token = issueToken(servedKeys[0], { sub: uid, phone_verified: true });
  assert.equal((await getMe(token)).status, 200);
  const nextPhone = uniquePhone();
  userinfoByUid.set(uid, { ...phoneUserinfo(uid, nextPhone), name: '并发新名' });
  resetIdentityUserCache();
  const beforeCalls = userinfoCalls;
  const results = await Promise.all(Array.from({ length: 8 }, () => getMe(token)));
  assert.deepEqual(results.map((row) => row.status), Array(8).fill(200));
  const current = await prisma.user.findUniqueOrThrow({ where: { identityUid: uid } });
  assert.equal(current.phone, nextPhone); assert.equal(current.name, '并发新名');
  assert.equal(userinfoCalls - beforeCalls, 1);
});
