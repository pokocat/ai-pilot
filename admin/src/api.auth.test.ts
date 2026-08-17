// 回归测试：运营后台的 403 ≠ 401。
//
// 根因（2026-07-29 修）：api.ts 的 req() 曾写成 `if (res.status === 401 || res.status === 403)`
// ——两者一起清 token + 广播 `admin:unauth` 踢回登录页。于是普通运营点任何 requireSuper 接口
// （支付退款、创作任务改价 /admin/creative/config、供应商 dry-run、新增智能体…）看到的都是
// 「掉线，请重新登录」，而真相是「这一步需要 owner 权限」。运营会去查密钥和网络，而不是找
// owner 要授权；重新登录还会重现同一现象，等于把一个权限问题伪装成故障。
//
// 契约：401 → 清登录态 + 广播；403 → 保留登录态、不广播，抛带 code 的错误交给页面就地提示。
//   cd admin && npm test
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { api, adminAuth, isForbidden } from './api.js';
import { getAdminToken, setAdminToken } from './auth.js';

interface FakeRes { status: number; ok: boolean; json: () => Promise<unknown> }

const events: string[] = [];
let last: { url: string; init?: RequestInit } | null = null;

/** 让 auth.ts 的 localStorage 与 api.ts 的 window.dispatchEvent 在 node 下可观测。 */
function installEnv(): void {
  const store = new Map<string, string>();
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
  };
  (globalThis as unknown as { window: unknown }).window = {
    dispatchEvent: (e: Event) => { events.push(e.type); return true; },
  };
}

/** 下一次 fetch 的返回。body=undefined 模拟「非 JSON 响应」（如反代直接回一页 HTML）。 */
function stubFetch(status: number, body?: unknown): void {
  (globalThis as unknown as { fetch: unknown }).fetch = (url: string, init?: RequestInit): Promise<FakeRes> => {
    last = { url, init };
    return Promise.resolve({
      status,
      ok: status >= 200 && status < 300,
      json: () => (body === undefined ? Promise.reject(new Error('not json')) : Promise.resolve(body)),
    });
  };
}

async function expectReject(p: Promise<unknown>): Promise<Error & { code?: string; status?: number }> {
  try {
    await p;
  } catch (e) {
    return e as Error & { code?: string; status?: number };
  }
  throw new Error('期望抛错，但请求成功了');
}

describe('admin api · 401 踢回登录页 / 403 只提示权限不足', () => {
  beforeEach(() => {
    installEnv();
    events.length = 0;
    last = null;
    setAdminToken('operator-token');
  });

  test('401：清登录态 + 广播 admin:unauth（唯一该踢回登录页的状态）', async () => {
    stubFetch(401, { error: '未授权访问运营后台', code: 'ADMIN_UNAUTHORIZED' });
    const e = await expectReject(api.overview());
    assert.equal(e.code, 'ADMIN_UNAUTHORIZED');
    assert.equal(getAdminToken(), '', 'token 必须被清掉');
    assert.deepEqual(events, ['admin:unauth']);
    assert.equal(isForbidden(e), false);
  });

  test('403 退款（requireSuper）：保留登录态、不广播，带回服务端权限文案', async () => {
    stubFetch(403, { error: '需要 owner 权限', code: 'OWNER_ONLY' });
    const e = await expectReject(api.refundPayment('J20260729001', '重复下单'));
    assert.equal(e.code, 'OWNER_ONLY');
    assert.equal(e.status, 403);
    assert.equal(e.message, '需要 owner 权限');
    assert.equal(getAdminToken(), 'operator-token', '403 不是掉线，登录态必须留着');
    assert.deepEqual(events, [], '403 不得广播 admin:unauth');
    assert.equal(isForbidden(e), true);
  });

  test('403 创作任务改价：服务端没给文案时也要是人话，不能是裸 HTTP 403', async () => {
    stubFetch(403, { code: 'OWNER_ONLY' });
    const e = await expectReject(api.saveCreativeConfig({ pricePerPoster: 20 }));
    assert.match(e.message, /owner/);
    assert.equal(getAdminToken(), 'operator-token');
    assert.deepEqual(events, []);
  });

  // 克隆定价与创作任务改价同级（都是 requireSuper 的营收动作），同一条契约必须一起守住：
  // 普通运营点保存看到的应该是「需要 owner 权限」，而不是被踢回登录页。
  test('403 克隆定价改价：保留登录态，提示去要授权而不是重新登录', async () => {
    stubFetch(403, { error: '需要 owner 权限', code: 'OWNER_ONLY' });
    const e = await expectReject(api.saveClonePricing({ voiceCreate: 300, voiceRetrain: 80, avatarVideo: 260, avatarImage: 120 }));
    assert.equal(e.code, 'OWNER_ONLY');
    assert.equal(getAdminToken(), 'operator-token');
    assert.deepEqual(events, []);
    assert.equal(isForbidden(e), true);
    assert.match(last?.url ?? '', /\/api\/admin\/video\/clone-pricing$/);
  });

  test('403 且响应体不是 JSON（反代兜的 403 页）：仍走权限提示，不踢登录', async () => {
    stubFetch(403);
    const e = await expectReject(api.creativeProviderDryRun());
    assert.equal(e.code, 'ADMIN_FORBIDDEN');
    assert.ok(e.message.length > 0);
    assert.equal(getAdminToken(), 'operator-token');
    assert.deepEqual(events, []);
  });

  test('其它错误（500）：既不清登录态也不吞服务端文案', async () => {
    stubFetch(500, { error: '数据库连接失败' });
    const e = await expectReject(api.creativeConfig());
    assert.equal(e.message, '数据库连接失败');
    assert.equal(e.status, 500);
    assert.equal(getAdminToken(), 'operator-token');
    assert.deepEqual(events, []);
    assert.equal(isForbidden(e), false);
    assert.match(last?.url ?? '', /\/api\/admin\/creative\/config$/);
  });
});

describe('admin 登录状态 · 失败不能伪装成未初始化', () => {
  test('服务端 500：透出可重试错误，不返回 initialized=false', async () => {
    stubFetch(500, { error: '数据库连接失败' });
    const e = await expectReject(adminAuth.status());
    assert.equal(e.message, '数据库连接失败');
  });

  test('网络断开：明确报连接失败', async () => {
    (globalThis as unknown as { fetch: unknown }).fetch = () => Promise.reject(new Error('ECONNREFUSED'));
    const e = await expectReject(adminAuth.status());
    assert.match(e.message, /无法连接后台服务/);
  });

  test('状态成功：保留后端初始化事实', async () => {
    stubFetch(200, { initialized: true, masterKeyEnabled: false });
    assert.deepEqual(await adminAuth.status(), { initialized: true, masterKeyEnabled: false });
  });
});
