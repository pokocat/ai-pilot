// 定价以线上为准：**代码不再改真实环境的价**（2026-08-01）。
//
// 起因（生产实况）：运营把入门版从 ¥68 在后台改成 ¥99，而 `seedConfig.PLANS` 里还写着 6800，
// `scripts/syncPlans.ts` 按 name 做全字段 upsert —— dry-run 实测会打印「更新 入门版」，
// 也就是说任何一次全量同步都会把线上价**静默打回 ¥68**。同类footgun 还有两处：
//   - `scripts/bumpFreeQuota.ts` 写死 `PLANS[0]`，免费档下架后 PLANS[0] 变成付费入门版，
//     跑一次就把付费用户的 token 钱包 quota/balance 重置成夹具值；
//   - `admin:sync-content` 的 update 分支无条件回写 sku.priceFen 与 agent.price。
//
// 收口后的规则，本文件逐条钉住：
//   1. 套餐目录只有运营后台一个入口（建档 / 改档 / 停售 / 删除），代码侧无同步脚本；
//   2. 破坏性 seed 认出非本地库就拒绝执行；
//   3. sync-content 把计价字段当「运营所有」：create 写初值、update 默认不碰，--force-pricing 才回写。
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, uniquePhone } from './helpers.js';
import { createOperator, createSession } from '../src/services/adminAccount.js';
import { assertNotProduction } from '../prisma/seed.js';
import { AGENT_PRICING_FIELDS, SKU_PRICING_FIELDS, main as syncContent } from '../scripts/syncAdminContent.js';
import { SKUS } from '../src/data/seedConfig.js';

process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'test-admin-token';

before(async () => { await getApp(); await seedBaseline(); });
after(async () => { await closeApp(); });

/** operator（非 owner/master）会话 token —— 用来验证 requireSuper 把改价挡在门外。 */
async function operatorToken(): Promise<string> {
  const acc = await createOperator(`op_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, 'pw-123456', 'operator');
  return createSession(acc.id);
}

const NEW_PLAN = {
  name: '运营自建档', price: 9900, period: 'month',
  planFamilyKey: 'operator-created', tierRank: 1, usageLevel: 'standard', usageLabel: '标准用量',
  creditsPerMonth: 20, tokenQuotaPerMonth: 400_000, agentCount: 4,
  featuresJson: ['每月约 13 次深度咨询'], highlighted: false,
};

describe('套餐目录：运营后台是唯一入口', () => {
  // 清业务数据：uniquePhone() 的序号每个进程从 0 重来，不清用户表会跨轮撞 phone 唯一键。
  beforeEach(async () => {
    await cleanBusiness();
    await prisma.plan.deleteMany({ where: { name: { contains: '运营自建档' } } });
  });

  test('代码仓库里不存在「把套餐同步到线上」的脚本或 npm script', async () => {
    // 这不是形式主义：syncPlans 复活就等于线上价随时会被打回代码常量。
    const { readdir, readFile } = await import('node:fs/promises');
    const scripts = await readdir(new URL('../scripts/', import.meta.url));
    assert.ok(!scripts.includes('syncPlans.ts'), 'syncPlans.ts 应已删除（它会把线上价打回 seedConfig 常量）');
    assert.ok(!scripts.includes('bumpFreeQuota.ts'), 'bumpFreeQuota.ts 应已删除（写死 PLANS[0]，会重置付费用户钱包）');
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> };
    assert.ok(!pkg.scripts['db:sync-plans'], 'db:sync-plans 应已移除');
    assert.ok(!pkg.scripts['db:bump-free-quota'], 'db:bump-free-quota 应已移除');
  });

  test('seedConfig 只导出夹具名 DEV_PLANS，不再导出会被误当真相源的 PLANS', async () => {
    const mod = await import('../src/data/seedConfig.js') as Record<string, unknown>;
    assert.ok(Array.isArray(mod.DEV_PLANS), 'DEV_PLANS 应存在（本地/测试夹具）');
    assert.equal(mod.PLANS, undefined, 'PLANS 这个名字应消失——它被当成过生产真相源');
  });

  test('POST /admin/plans 建档：201 + 落库 + 审计', async () => {
    const r = await api('POST', '/api/admin/plans', { body: NEW_PLAN });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.price, 9900);
    assert.equal(r.body.period, 'month');
    assert.equal(r.body.hidden, false);
    const row = await prisma.plan.findUnique({ where: { id: r.body.id } });
    assert.equal(row!.price, 9900, '价格以运营填的为准');
    const audit = await prisma.auditLog.findFirst({ where: { action: 'admin.plan.create' }, orderBy: { createdAt: 'desc' } });
    assert.ok(audit, '建档必须留痕（改价同级风险：新档立刻对外可售）');
    assert.equal((audit!.payloadJson as { price?: number }).price, 9900);
  });

  test('GET /admin/plans：存量 nullable 商业字段按 AdminPlan 契约补齐，回填后可保存', async () => {
    const created = await api('POST', '/api/admin/plans', { body: NEW_PLAN });
    await prisma.plan.update({
      where: { id: created.body.id },
      data: {
        planFamilyKey: null, tierRank: null, usageLevel: null, usageLabel: null,
      },
    });

    const listed = await api('GET', '/api/admin/plans');
    assert.equal(listed.status, 200);
    const legacy = listed.body.find((p: { id: string }) => p.id === created.body.id);
    assert.ok(legacy);
    assert.equal(legacy.planFamilyKey, created.body.id);
    assert.equal(legacy.tierRank, NEW_PLAN.price);
    assert.equal(legacy.usageLevel, 'custom');
    assert.equal(legacy.usageLabel, '方案用量');
    assert.equal(legacy.usageNormalPercent, 50);
    assert.equal(legacy.usageNearPercent, 80);

    const saved = await api('PATCH', `/api/admin/plans/${created.body.id}`, { body: {
      planFamilyKey: legacy.planFamilyKey,
      tierRank: legacy.tierRank,
      usageLevel: legacy.usageLevel,
      usageLabel: legacy.usageLabel,
      usageNormalPercent: legacy.usageNormalPercent,
      usageNearPercent: legacy.usageNearPercent,
    } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.planFamilyKey, created.body.id);
  });

  test('建档：operator 无权（requireSuper），套餐一点不动', async () => {
    const r = await api('POST', '/api/admin/plans', { body: { ...NEW_PLAN, name: '运营自建档-越权' }, adminToken: await operatorToken() });
    assert.equal(r.status, 403);
    assert.equal(await prisma.plan.count({ where: { name: '运营自建档-越权' } }), 0);
  });

  test('建档：缺名称 400、同名 409、价格非法 400', async () => {
    assert.equal((await api('POST', '/api/admin/plans', { body: { ...NEW_PLAN, name: '  ' } })).status, 400);

    const ok = await api('POST', '/api/admin/plans', { body: NEW_PLAN });
    assert.equal(ok.status, 201);
    const dup = await api('POST', '/api/admin/plans', { body: NEW_PLAN });
    assert.equal(dup.status, 409, '同名会让「按 name 找档」的存量逻辑（TEST_DEFAULT_PLAN_NAME）撞车');
    assert.equal(dup.body.code, 'PLAN_NAME_EXISTS');

    const bad = await api('POST', '/api/admin/plans', { body: { ...NEW_PLAN, name: '运营自建档-负价', price: -5 } });
    assert.equal(bad.status, 400, '只有 -1（面议）能是负数');
    assert.equal(bad.body.code, 'PLAN_PRICE_INVALID');
  });

  test('建档：price=-1 面议档可建；period 非法回落 month；sort 缺省排到末尾', async () => {
    const maxBefore = (await prisma.plan.aggregate({ _max: { sort: true } }))._max.sort ?? -1;
    const r = await api('POST', '/api/admin/plans', { body: {
      ...NEW_PLAN,
      name: '运营自建档-面议', price: -1, period: 'forever',
      planFamilyKey: 'operator-enterprise', tierRank: 999, usageLevel: 'custom', usageLabel: '专属用量',
    } });
    assert.equal(r.status, 201);
    assert.equal(r.body.price, -1, '面议档（自助购买会 402 CONTACT_SALES）');
    assert.equal(r.body.period, 'month', 'period 只认 month/year，非法值回落 month 而不是写进库');
    assert.equal(r.body.sort, maxBefore + 1, '新档默认排末尾，不抢第一档位置');
    await prisma.plan.delete({ where: { id: r.body.id } });
  });

  test('公开用量倍率：不足 5x 硬拒绝，达到标准基线 5 倍才允许建档', async () => {
    const base = {
      ...NEW_PLAN,
      name: '运营自建档-5x', planFamilyKey: 'operator-5x', tierRank: 3,
      usageLevel: '5x', usageLabel: '5x 用量', tokenQuotaPerMonth: 1_999_999,
    };
    const rejected = await api('POST', '/api/admin/plans', { body: base });
    assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
    assert.equal(rejected.body.code, 'PLAN_USAGE_MULTIPLIER_MISMATCH');
    assert.match(rejected.body.error, /5x/);
    assert.equal(await prisma.plan.count({ where: { name: base.name } }), 0);

    const accepted = await api('POST', '/api/admin/plans', {
      body: { ...base, tokenQuotaPerMonth: 2_000_000 },
    });
    assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
    assert.equal(accepted.body.usageLevel, '5x');
    await prisma.plan.delete({ where: { id: accepted.body.id } });
  });

  test('PATCH 现在能改 period / hidden / sort（此前只有脚本能改）', async () => {
    const created = await api('POST', '/api/admin/plans', { body: NEW_PLAN });
    const r = await api('PATCH', `/api/admin/plans/${created.body.id}`, { body: { period: 'year', hidden: true, sort: 7, price: 198000 } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.period, 'year');
    assert.equal(r.body.hidden, true, '停售靠 hidden，不必删档');
    assert.equal(r.body.sort, 7);
    assert.equal(r.body.price, 198000);
    const audit = await prisma.auditLog.findFirst({ where: { action: 'admin.plan.update' }, orderBy: { createdAt: 'desc' } });
    const p = audit!.payloadJson as { before?: { price?: number; period?: string }; after?: { price?: number; period?: string } };
    assert.equal(p.before?.price, 9900, '审计要能回答「谁把价从多少改成多少」');
    assert.equal(p.after?.price, 198000);
    assert.equal(p.before?.period, 'month');
    assert.equal(p.after?.period, 'year');
  });

  test('PATCH：非法 period 被忽略，不会把库写成野值', async () => {
    const created = await api('POST', '/api/admin/plans', { body: NEW_PLAN });
    const r = await api('PATCH', `/api/admin/plans/${created.body.id}`, { body: { period: 'week' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.period, 'month', 'period 参与到期日推算与升级折算，野值会让两边同时算错');
  });

  test('DELETE：无人在册才删得掉，删完留痕', async () => {
    const created = await api('POST', '/api/admin/plans', { body: NEW_PLAN });
    const r = await api('DELETE', `/api/admin/plans/${created.body.id}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(await prisma.plan.count({ where: { id: created.body.id } }), 0);
    const audit = await prisma.auditLog.findFirst({ where: { action: 'admin.plan.delete' }, orderBy: { createdAt: 'desc' } });
    assert.ok(audit, '删档必须留痕');
  });

  test('DELETE：有用户在册 → 409 PLAN_IN_USE 且套餐一点不动（外键 + 权益锚点都要它）', async () => {
    const created = await api('POST', '/api/admin/plans', { body: NEW_PLAN });
    const tenant = await prisma.tenant.create({ data: { name: '在册用户企业' } });
    const u = await prisma.user.create({ data: { tenantId: tenant.id, phone: uniquePhone(), name: '在册用户', role: 'owner', planId: created.body.id } });

    const r = await api('DELETE', `/api/admin/plans/${created.body.id}`);
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'PLAN_IN_USE');
    assert.equal(r.body.refs, 1, '文案要带确切在册人数，运营才知道要迁移几个人');
    assert.match(r.body.error, /隐藏/, '要指路「改为隐藏停售」这条正解');
    assert.equal(await prisma.plan.count({ where: { id: created.body.id } }), 1, '被拦下的删除不得动库');

    await prisma.user.delete({ where: { id: u.id } });
    assert.equal((await api('DELETE', `/api/admin/plans/${created.body.id}`)).status, 200, '迁走用户后即可删');
  });

  test('DELETE：不存在 404；operator 无权 403', async () => {
    assert.equal((await api('DELETE', '/api/admin/plans/nope')).status, 404);
    const created = await api('POST', '/api/admin/plans', { body: NEW_PLAN });
    const r = await api('DELETE', `/api/admin/plans/${created.body.id}`, { adminToken: await operatorToken() });
    assert.equal(r.status, 403);
    assert.equal(await prisma.plan.count({ where: { id: created.body.id } }), 1);
  });
});

describe('破坏性 seed 的生产护栏', () => {
  const LOCAL = { DATABASE_URL: 'postgresql://junshi:pw@localhost:5432/junshi' } as NodeJS.ProcessEnv;
  const REMOTE = { DATABASE_URL: 'postgresql://junshi:pw@47.98.162.120:5432/junshi' } as NodeJS.ProcessEnv;

  test('NODE_ENV=production 一律拒绝，--i-know 也救不回来', () => {
    assert.throws(() => assertNotProduction({ ...LOCAL, NODE_ENV: 'production' }, []), /NODE_ENV=production/);
    assert.throws(() => assertNotProduction({ ...LOCAL, NODE_ENV: 'production' }, ['--i-know']), /NODE_ENV=production/);
  });

  test('DATABASE_URL 指向非本地库 → 拒绝（seed 会 deleteMany 套餐/智能体）', () => {
    assert.throws(() => assertNotProduction(REMOTE, []), /非本地库/);
  });

  test('本地库放行；远程库带 --i-know 放行（连测试库的正当场景）', () => {
    assertNotProduction(LOCAL, []);
    assertNotProduction({ DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/db' }, []);
    assertNotProduction(REMOTE, ['--i-know']);
  });
});

describe('admin:sync-content 不再打回运营改过的价', () => {
  const SKU_KEY = SKUS[0].key;
  const CODE_PRICE = SKUS[0].priceFen;
  const AGENT_KEY = 'intel'; // AGENTS 里 price=12 的付费档
  const OPERATOR_SKU_PRICE = CODE_PRICE + 1000; // 运营在后台改的价
  const OPERATOR_AGENT_PRICE = 99;

  // sync-content 会打一堆日志，测试输出里没意义 —— 静音后再跑。
  async function runSync(argv: string[]) {
    const log = console.log;
    console.log = () => {};
    try { await syncContent(argv); } finally { console.log = log; }
  }

  beforeEach(async () => {
    await seedBaseline();
    await prisma.sku.update({ where: { key: SKU_KEY }, data: { priceFen: OPERATOR_SKU_PRICE, name: '运营改过的名字' } });
    await prisma.agent.update({ where: { key: AGENT_KEY }, data: { price: OPERATOR_AGENT_PRICE } });
  });

  test('默认同步：SKU 的 priceFen / name 保持运营值（这正是原来被打回的地方）', async () => {
    await runSync([]);
    const sku = await prisma.sku.findUnique({ where: { key: SKU_KEY } });
    assert.equal(sku!.priceFen, OPERATOR_SKU_PRICE, `priceFen 必须仍是运营改的 ${OPERATOR_SKU_PRICE}，不是仓库常量 ${CODE_PRICE}`);
    assert.equal(sku!.name, '运营改过的名字');
  });

  test('默认同步：agent 的 price 保持运营值', async () => {
    await runSync([]);
    const agent = await prisma.agent.findUnique({ where: { key: AGENT_KEY } });
    assert.equal(agent!.price, OPERATOR_AGENT_PRICE);
  });

  test('结构性字段仍以仓库为真相源（kind/grantsModuleKey 必须与 data/modules.ts 对齐）', async () => {
    await prisma.sku.update({ where: { key: SKU_KEY }, data: { kind: 'storage' } });
    await runSync([]);
    const sku = await prisma.sku.findUnique({ where: { key: SKU_KEY } });
    assert.equal(sku!.kind, SKUS[0].kind, '漂移会让支付后发不出权益，这类字段照常同步');
  });

  test('--force-pricing 才用仓库常量覆盖线上定价（留给确实要代码改价的场景）', async () => {
    await runSync(['--force-pricing']);
    const sku = await prisma.sku.findUnique({ where: { key: SKU_KEY } });
    const agent = await prisma.agent.findUnique({ where: { key: AGENT_KEY } });
    assert.equal(sku!.priceFen, CODE_PRICE);
    assert.equal(sku!.name, SKUS[0].name);
    assert.equal(agent!.price, 12);
  });

  test('--dry-run 不写库', async () => {
    await runSync(['--dry-run', '--force-pricing']);
    const sku = await prisma.sku.findUnique({ where: { key: SKU_KEY } });
    assert.equal(sku!.priceFen, OPERATOR_SKU_PRICE, 'dry-run 连 force 都不该落库');
  });

  test('计价字段清单里包含所有能在后台改的钱字段', () => {
    // 漏一个就等于留一条静默打回的路。后台白名单见 AdminAgentUpdate / PATCH /admin/skus/:key。
    for (const f of ['gift', 'billing', 'price', 'billingRatio', 'meterUnit']) {
      assert.ok((AGENT_PRICING_FIELDS as readonly string[]).includes(f), `agent 计价字段应含 ${f}`);
    }
    for (const f of ['name', 'desc', 'priceFen', 'sort']) {
      assert.ok((SKU_PRICING_FIELDS as readonly string[]).includes(f), `sku 计价字段应含 ${f}`);
    }
  });
});

after(async () => { await cleanBusiness(); });
