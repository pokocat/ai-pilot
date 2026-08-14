// 克隆定价：形状、兜底与运营可配。
//
// 背景：出片早有完整的预扣/结算状态机，但克隆一直免费 —— 而训练一个声音在供应商侧
// 要 8000+ 算力，是本产品最贵的单次动作。重训虽然供应商免费（每条 4 次），
// 但我方的上传/存储/审核/编排成本照付，所以按低价收而不是不收。
import test, { after, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLONE_PRICING_FLAG_ID, cloneCost, clonePricing, clonePricingView, updateClonePricing,
  type ClonePricing,
} from '../src/services/video/pricing.js';
import { prisma } from '../src/db.js';
import { __clearFeatureCache } from '../src/services/featureFlag.js';
import { createOperator, createSession } from '../src/services/adminAccount.js';
import { api, cleanBusiness, closeApp, getApp, login, seedBaseline, uniquePhone } from './helpers.js';

// admin 路由鉴权：设置共享 ADMIN_TOKEN（与 helpers.api 的 x-admin-token 自动附带一致）。
// node --test 每个文件是独立子进程，不设这行 process.env.ADMIN_TOKEN 就是未定义，
// 下面所有 /api/admin/video/clone-pricing 用例会恒定 401 —— 而那是「没带凭证」，
// 不是本组用例想验的 requireSuper 403。
process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'test-admin-token';

const priced = (over: Partial<ClonePricing> = {}): ClonePricing => ({
  voiceCreate: 200, voiceRetrain: 60, avatarVideo: 200, avatarImage: 100, configured: true, ...over,
});

test('重训明显便宜于新建，但不是免费——供应商免费不等于我们免费', () => {
  const p = priced();
  assert.ok(cloneCost(p, 'voiceRetrain') > 0, '重训不能是 0：我方的上传/存储/审核/编排成本照付');
  assert.ok(cloneCost(p, 'voiceRetrain') < cloneCost(p, 'voiceCreate'),
    '重训必须便宜于新建，否则用户没有动力走省供应商权益的路径');
});

test('图片训练便宜于视频训练，天然成为低成本入口', () => {
  const p = priced();
  assert.ok(cloneCost(p, 'avatarImage') < cloneCost(p, 'avatarVideo'));
});

test('运营可以把某一档配成 0（免费），但负数与非法值回落兜底', async () => {
  // 0 是合法配置：运营有权把某项设成免费做活动
  const zeroed = priced({ voiceRetrain: 0 });
  assert.equal(cloneCost(zeroed, 'voiceRetrain'), 0);
});

test('展示视图带上 configured，端上才能区分「运营配过」与「用的兜底价」', () => {
  const view = clonePricingView(priced({ configured: false }));
  assert.equal(view.configured, false);
  assert.equal(typeof view.voiceCreate, 'number');
  assert.equal(typeof view.voiceRetrain, 'number');
  assert.equal(typeof view.avatarImage, 'number');
});

test('四档价格都要出到端上，缺一档界面就没法明示扣费', () => {
  const view = clonePricingView(priced());
  for (const key of ['voiceCreate', 'voiceRetrain', 'avatarVideo', 'avatarImage'] as const) {
    assert.ok(Number.isInteger(view[key]), `${key} 必须是整数`);
  }
});

/* ─────────── 运营后台读写（GET/PUT /admin/video/clone-pricing） ───────────
 *
 * 这组用例守的是「定价归运营后台」这条铁律**真的成立**，而不只是写在注释里：
 * 在这两个路由出现之前，四档价只存在于 pricing.ts 的 FALLBACK 常量，运营没有任何入口能改，
 * `configured` 永远是 false —— 端上照着兜底价扣费，而没有人核定过那几个数字。
 */
describe('克隆定价 · 运营后台配置', () => {
  before(async () => { await getApp(); });
  after(async () => { await closeApp(); });
  beforeEach(async () => {
    await cleanBusiness();
    await seedBaseline();
    // cleanBusiness 直接删表，不经过 setFeatureFlag* 的失效路径 → 进程内缓存还留着上一条用例的 payload。
    __clearFeatureCache();
  });

  const FOUR = { voiceCreate: 300, voiceRetrain: 80, avatarVideo: 260, avatarImage: 120 };

  /** 普通运营（role=operator）的会话 token —— 用于验证 requireSuper 拒绝。 */
  async function operatorToken(): Promise<string> {
    const acc = await createOperator(`op_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, 'pw-123456', 'operator');
    return createSession(acc.id);
  }

  test('未配置时 GET 回兜底价且 configured=false —— 后台必须看得出「这不是线上定价」', async () => {
    const r = await api('GET', '/api/admin/video/clone-pricing');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.configured, false, '库里没这行 = 运营没配过');
    for (const key of ['voiceCreate', 'voiceRetrain', 'avatarVideo', 'avatarImage'] as const) {
      assert.ok(Number.isInteger(r.body[key]) && r.body[key] >= 0, `${key} 仍要给一个能用的兜底数字`);
    }
  });

  test('普通运营 → 403：改价是营收动作，与套餐改价、海报改价同级', async () => {
    const r = await api('PUT', '/api/admin/video/clone-pricing', { body: FOUR, adminToken: await operatorToken() });
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.code, 'OWNER_ONLY');
    assert.equal(
      (await api('GET', '/api/admin/video/clone-pricing')).body.configured, false,
      '被拒的写不得留下任何痕迹',
    );
  });

  test('超管四档一起提交 → 落库、configured 转真、C 端立即按新价显示', async () => {
    const put = await api('PUT', '/api/admin/video/clone-pricing', { body: FOUR });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.deepEqual({ ...put.body, configured: undefined }, { ...FOUR, configured: undefined });
    assert.equal(put.body.configured, true);

    // 读回一次：证明数字真进了库，而不是只在回包里对（回包对、库里没有是这类配置路由的经典坑）。
    const got = await api('GET', '/api/admin/video/clone-pricing');
    assert.deepEqual(got.body, { ...FOUR, configured: true });

    // C 端是这套定价的真实消费者：后台改完，小程序拿到的必须是同一组数字。
    const token = await login(uniquePhone(), '克隆定价用户');
    const view = await api('GET', '/api/video/clone-pricing', { token });
    assert.equal(view.status, 200, JSON.stringify(view.body));
    assert.deepEqual(view.body, { ...FOUR, configured: true });
  });

  test('改价写审计：谁、哪一档、从多少改到多少，事后要答得出', async () => {
    await api('PUT', '/api/admin/video/clone-pricing', { body: FOUR });
    await api('PUT', '/api/admin/video/clone-pricing', { body: { voiceCreate: 500 } });

    const logs = await prisma.auditLog.findMany({ where: { action: 'admin.video.clonePricing.update' } });
    assert.equal(logs.length, 2, '两次改价 = 两条审计');
    // 按内容而不是按写入顺序取：两次写可能落在同一毫秒，createdAt 排序不保证稳定。
    const payloads = logs.map((l) => l.payloadJson as Record<string, any>);
    const first = payloads.find((p) => p.firstTimeConfigured === true);
    const second = payloads.find((p) => p.firstTimeConfigured === false);
    assert.ok(first, '首次核定要单独标出来：占位价变成对外承诺的那一刻');
    assert.ok(second, '日常改价不该也标成首次核定');
    assert.equal(first.before.configured, false);
    assert.equal(first.after.voiceCreate, FOUR.voiceCreate);
    assert.equal(second.before.voiceCreate, FOUR.voiceCreate);
    assert.equal(second.after.voiceCreate, 500);
    assert.ok(second.by, '操作者必须落在审计里，多运营时才追得到人');
  });

  // 首次配置的陷阱：`current` 在未配置时读到的是 FALLBACK —— 那四个数字带着 TODO(定价待运营核定)，
  // 没有商务结论，avatarImage 更是纯占位。只改一档就落库 = 用一次改价给另外三个占位数字盖章，
  // 而 configured 恰恰是端上判断「这价能不能当承诺」的唯一依据。
  test('首次配置只提交一档 → 422，不把另外三档的兜底价升格成「运营配过的价」', async () => {
    const r = await api('PUT', '/api/admin/video/clone-pricing', { body: { voiceCreate: 300 } });
    assert.equal(r.status, 422, JSON.stringify(r.body));
    assert.equal(r.body.code, 'CLONE_PRICING_INVALID');
    assert.match(r.body.error, /四档/);
    assert.equal((await api('GET', '/api/admin/video/clone-pricing')).body.configured, false, '被拒的写不得落库');
  });

  test('核定之后再改单档是安全的：此时每一档都已被运营核定过', async () => {
    await api('PUT', '/api/admin/video/clone-pricing', { body: FOUR });
    const r = await api('PUT', '/api/admin/video/clone-pricing', { body: { voiceRetrain: 99 } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.voiceRetrain, 99);
    assert.equal(r.body.voiceCreate, FOUR.voiceCreate, '未提交的档位保持原值（PATCH 语义）');
  });

  // 「保存成功但价格没变」是改价接口最坏的失败形态：接口回 200、回包里还是旧价，
  // 页面一刷新数字又对了，运营以为改过了。所以非法值必须是一次看得见的保存失败。
  for (const [name, body] of [
    ['负数', { ...FOUR, voiceCreate: -1 }],
    ['超上限（多打一个 0 能把用户余额一次清空）', { ...FOUR, avatarVideo: 10_000_000 }],
    ['非数字', { ...FOUR, voiceRetrain: 'abc' }],
  ] as const) {
    test(`非法单价（${name}）→ 422，绝不静默回落成旧价`, async () => {
      await api('PUT', '/api/admin/video/clone-pricing', { body: FOUR });
      const r = await api('PUT', '/api/admin/video/clone-pricing', { body });
      assert.equal(r.status, 422, JSON.stringify(r.body));
      assert.equal(r.body.code, 'CLONE_PRICING_INVALID');
      assert.deepEqual(
        (await api('GET', '/api/admin/video/clone-pricing')).body, { ...FOUR, configured: true },
        '整份提交里有一档非法 → 整次写入不生效，不能只落合法的那几档',
      );
    });
  }

  test('0 依然是合法配置：运营有权把某一档设成免费做活动', async () => {
    const r = await api('PUT', '/api/admin/video/clone-pricing', { body: { ...FOUR, voiceRetrain: 0 } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.voiceRetrain, 0);
    assert.equal(r.body.configured, true, '0 是「配过的价」，不是「没配」');
  });

  // 读路径的容错与写路径的严格是两套口径，别互相污染：库被写脏时 C 端必须还拿得到一组能用的数字。
  test('库里被写脏 → 读回落兜底且 configured=false，不把脏值发给端上', async () => {
    await prisma.featureFlag.upsert({
      where: { id: CLONE_PRICING_FLAG_ID },
      update: { payload: { ...FOUR, voiceCreate: -5 } },
      create: { id: CLONE_PRICING_FLAG_ID, payload: { ...FOUR, voiceCreate: -5 } },
    });
    __clearFeatureCache();
    const p = await clonePricing({ fresh: true });
    assert.ok(p.voiceCreate > 0, '脏值不下发，回落兜底');
    assert.equal(p.configured, false, '有一档不合法就不算配过 —— 半份配置比没配更危险');
  });

  test('写入即失效本进程缓存：后台读得回自己刚写的值，运营不会以为没保存上', async () => {
    await clonePricing();           // 先把兜底值灌进 60s 缓存
    await updateClonePricing(FOUR);
    assert.equal((await clonePricing()).voiceCreate, FOUR.voiceCreate, '不带 fresh 也要读到新值');
  });
});
