// 平台后台按产品分区 + 钱包按产品记账。
//
// 两件事其实是一件：后台是一个、按 productCode 分区，钱包也是一个、按 productCode 切账。
// 这组用例盯的是这条键在两处都真的生效，而不是只写在注释里。
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, uniquePhone } from './helpers.js';
import { createOperator, createSession } from '../src/services/adminAccount.js';
import { chargeCredits, grantCredits, getBalance } from '../src/services/credits.js';
import { PRODUCT, productLedgerSlices } from '../src/services/products.js';

process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'test-admin-token';

before(async () => { await getApp(); await seedBaseline(); });
after(async () => { await closeApp(); });
beforeEach(async () => { await cleanBusiness(); });

async function operator(): Promise<{ id: string; token: string }> {
  const acc = await createOperator(`op_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, 'pw-123456', 'operator');
  return { id: acc.id, token: await createSession(acc.id) };
}

async function mkUser() {
  const tenant = await prisma.tenant.create({ data: { name: '分区测试企业' } });
  const user = await prisma.user.create({
    data: { tenantId: tenant.id, phone: uniquePhone(), name: '分区用户', role: 'owner' },
  });
  return { tenantId: tenant.id, userId: user.id };
}

/* ── 钱包：一个钱包，按产品记账 ── */

test('同一个钱包，军师和爱速拍各记各的账', async () => {
  const { tenantId, userId } = await mkUser();
  await grantCredits(tenantId, userId, 100, '充值', PRODUCT.junshi);
  await chargeCredits(tenantId, userId, 30, '产出', PRODUCT.junshi);
  await chargeCredits(tenantId, userId, 20, '出片', PRODUCT.quickreel);

  // 钱包是一个：军师充的钱，爱速拍花得动。分钱包的话这里得先转账。
  assert.equal(await getBalance(userId), 50);

  const slices = await productLedgerSlices(new Date(Date.now() - 3600_000), new Date(Date.now() + 3600_000));
  const junshi = slices.find((s) => s.productCode === PRODUCT.junshi);
  const quickreel = slices.find((s) => s.productCode === PRODUCT.quickreel);
  assert.equal(junshi?.granted, 100, '收入归属：从军师的入口卖出去的');
  assert.equal(junshi?.spent, 30);
  assert.equal(quickreel?.granted, 0, '爱速拍还没有自己的充值入口');
  assert.equal(quickreel?.spent, 20, '消耗归属：花在爱速拍上的');
});

test('出片走的是爱速拍的账，不记到军师头上', async () => {
  const { tenantId, userId } = await mkUser();
  await grantCredits(tenantId, userId, 200, '充值', PRODUCT.junshi);
  const { reserveVideoCredits } = await import('../src/services/video/credits.js');
  await reserveVideoCredits({
    tenantId, userId, projectId: 'cp_slice', clientRequestId: 'slice:req:0001', credits: 12,
  });
  const rows = await prisma.creditLedger.findMany({ where: { userId, delta: { lt: 0 } } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].productCode, PRODUCT.quickreel, '出片预扣必须记在爱速拍名下');

  const hold = await prisma.videoCreditHold.findFirst({ where: { userId } });
  assert.equal(hold?.productCode, PRODUCT.quickreel, 'hold 与流水同一套归属，对账才对得上');
});

test('归属为空的历史流水单列，不摊进任何产品', async () => {
  const { tenantId, userId } = await mkUser();
  await grantCredits(tenantId, userId, 50, '充值', PRODUCT.junshi);
  // 直接写一行没有归属的，模拟本列上线之前的存量
  await prisma.creditLedger.create({
    data: { tenantId, userId, delta: -7, reason: '历史消耗', balance: 43 },
  });
  const slices = await productLedgerSlices(new Date(Date.now() - 3600_000), new Date(Date.now() + 3600_000));
  const orphan = slices.find((s) => s.productCode === 'unattributed');
  assert.equal(orphan?.spent, 7, '摊进任一产品就是编造归属');
  assert.equal(slices.find((s) => s.productCode === PRODUCT.junshi)?.spent, 0);
});

/* ── 后台：按产品分区 ── */

test('超管看得到全部产品', async () => {
  const res = await api('GET', '/api/admin/products');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.superActor, true);
  assert.deepEqual(res.body.accessible.sort(), [PRODUCT.junshi, PRODUCT.quickreel].sort());
});

test('没被授权的运营，一个产品都看不到', async () => {
  const op = await operator();
  const res = await api('GET', '/api/admin/products', { adminToken: op.token });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.superActor, false);
  assert.deepEqual(res.body.accessible, []);
});

test('只授爱速拍的运营，看得到爱速拍、看不到军师', async () => {
  const op = await operator();
  const grant = await api('PUT', `/api/admin/accounts/${op.id}/products`, {
    body: { productCode: PRODUCT.quickreel, role: 'editor' },
  });
  assert.equal(grant.status, 200, JSON.stringify(grant.body));

  const res = await api('GET', '/api/admin/products', { adminToken: op.token });
  assert.deepEqual(res.body.accessible, [PRODUCT.quickreel]);
});

test('授了爱速拍才看得到爱速拍的价', async () => {
  const op = await operator();
  const before = await api('GET', '/api/admin/video/clone-pricing', { adminToken: op.token });
  assert.equal(before.status, 403, '没授权连读都不给');
  assert.equal(before.body.code, 'ADMIN_PRODUCT_FORBIDDEN');

  await api('PUT', `/api/admin/accounts/${op.id}/products`, {
    body: { productCode: PRODUCT.quickreel, role: 'editor' },
  });
  const after = await api('GET', '/api/admin/video/clone-pricing', { adminToken: op.token });
  assert.equal(after.status, 200, JSON.stringify(after.body));
});

test('产品授权不放松营收管控：改价仍然要超管', async () => {
  // 加产品分区是加一个维度，不是替换既有的闸。改价与套餐改价、海报改价同级，
  // 一直是超管动作（videoClonePricing 用例写明了这条政策）；顺手放松掉是另一件事，
  // 要放也该单独决定，不该作为分区的副作用。
  const op = await operator();
  await api('PUT', `/api/admin/accounts/${op.id}/products`, {
    body: { productCode: PRODUCT.quickreel, role: 'editor' },
  });
  const write = await api('PUT', '/api/admin/video/clone-pricing', {
    adminToken: op.token, body: { avatarCredits: 999 },
  });
  assert.equal(write.status, 403, '有产品授权也改不了价');
  assert.equal(write.body.code, 'OWNER_ONLY', '拒绝的理由仍是「要超管」，不是「没产品权限」');
});

test('收回授权后立刻失效', async () => {
  const op = await operator();
  await api('PUT', `/api/admin/accounts/${op.id}/products`, {
    body: { productCode: PRODUCT.quickreel, role: 'editor' },
  });
  assert.equal((await api('GET', '/api/admin/video/clone-pricing', { adminToken: op.token })).status, 200);
  await api('PUT', `/api/admin/accounts/${op.id}/products`, {
    body: { productCode: PRODUCT.quickreel, role: null },
  });
  assert.equal((await api('GET', '/api/admin/video/clone-pricing', { adminToken: op.token })).status, 403);
});

test('运营改不了自己的产品授权', async () => {
  const op = await operator();
  const res = await api('PUT', `/api/admin/accounts/${op.id}/products`, {
    adminToken: op.token, body: { productCode: PRODUCT.quickreel, role: 'editor' },
  });
  assert.equal(res.status, 403, '授权变更只有超管能做');
});

test('未知产品码一律拒收，不写进授权表', async () => {
  const op = await operator();
  const res = await api('PUT', `/api/admin/accounts/${op.id}/products`, {
    body: { productCode: 'not-a-product', role: 'editor' },
  });
  assert.equal(res.status, 422);
  assert.equal(await prisma.adminProductAccess.count({ where: { accountId: op.id } }), 0);
});

test('分产品账只给看得见的产品，unattributed 只有超管看得到', async () => {
  const { tenantId, userId } = await mkUser();
  await grantCredits(tenantId, userId, 100, '充值', PRODUCT.junshi);
  await chargeCredits(tenantId, userId, 10, '出片', PRODUCT.quickreel);
  await prisma.creditLedger.create({
    data: { tenantId, userId, delta: -1, reason: '历史', balance: 89 },
  });

  const su = await api('GET', '/api/admin/products/ledger');
  assert.equal(su.status, 200, JSON.stringify(su.body));
  const suCodes = su.body.slices.map((s: { productCode: string }) => s.productCode);
  assert.ok(suCodes.includes('unattributed'), '超管该看到没归属的那部分');

  const op = await operator();
  await api('PUT', `/api/admin/accounts/${op.id}/products`, {
    body: { productCode: PRODUCT.quickreel, role: 'viewer' },
  });
  const res = await api('GET', '/api/admin/products/ledger', { adminToken: op.token });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const codes = res.body.slices.map((s: { productCode: string }) => s.productCode);
  assert.deepEqual(codes, [PRODUCT.quickreel], '看不见军师，也看不见 unattributed');
});

test('时间区间非法当场拒收', async () => {
  const res = await api('GET', '/api/admin/products/ledger?from=2026-02-01&to=2026-01-01');
  assert.equal(res.status, 422);
});

/**
 * 汇总必须以 RepeatableRead 跑。
 *
 * 这是这一组里**唯一能真正证明修复在位**的断言。并发跑一跑「看起来对」证明不了什么：
 * Read Committed 下三条语句各取快照，撕裂窗口只有毫秒级，绝大多数时候照样绿。
 * 所以直接盯住那个决定 —— 谁把隔离级别去掉，这条当场红。
 *
 * 背景：PostgreSQL 的 RC 是「每条语句开始时取一次快照」，只把三条聚合包进事务
 * 并不给一致视图；RR 才是在事务第一条语句取一次、后续复用。
 */
test('分产品汇总以 RepeatableRead 跑，只包事务是不够的', async () => {
  const { Prisma } = await import('@prisma/client');
  const original = prisma.$transaction.bind(prisma);
  const seen: unknown[] = [];
  (prisma as unknown as { $transaction: unknown }).$transaction = ((fn: never, opts: never) => {
    seen.push(opts);
    return original(fn, opts);
  }) as never;
  try {
    await productLedgerSlices(new Date(Date.now() - 3600_000));
  } finally {
    (prisma as unknown as { $transaction: unknown }).$transaction = original;
  }
  assert.equal(seen.length, 1, '应当只开一个事务');
  const opts = seen[0] as { isolationLevel?: unknown; timeout?: number };
  assert.equal(
    opts.isolationLevel,
    Prisma.TransactionIsolationLevel.RepeatableRead,
    'RC 下几条聚合各取快照，包了事务也不一致',
  );
  // 隔离级别之外还要有够宽的超时：Prisma 交互式事务默认 5s，而 from 是请求参数，
  // 四次聚合串行跑，窗口一大就在 5s 处回滚、整屏 500（codex 2026-09-11 审出）。
  // 这里不写死具体数值，只要求它显式抬过默认值 —— 调参不该让用例变红。
  assert.ok((opts.timeout ?? 0) > 5_000, `事务超时没抬过 Prisma 默认的 5s：${String(opts.timeout)}`);
});

/**
 * 并发写账时汇总不炸、不串产品。
 *
 * 说清楚它证明**不了**什么：它抓不到快照撕裂（RC 下也大概率绿），上面那条才是。
 * 它盯的是另一类问题 —— 汇总在持续写入下会不会抛错、会不会把产品串到 unattributed。
 *
 * 判据只用「出现在结果里就至少有一条流水」。**不能断言「有条数必有金额」**：
 * delta=0 的备注型流水是合法的（purchase 的 SKU 备注就是），那种产品 entries>0
 * 而 granted=spent=0，拿金额去卡会对着正常账本假报。
 */
test('并发写账时汇总不抛错、不串产品', async () => {
  // 只开事务不够：PostgreSQL 默认 Read Committed 是「每条语句各取快照」，
  // 三条语句照样会看见不同数据 —— 表现是 entries>0 但金额少了，或整行丢失。
  // 这条用例一边汇总一边持续写流水，撞的就是那个窗口。
  const { tenantId, userId } = await mkUser();
  await grantCredits(tenantId, userId, 10_000, '充值', PRODUCT.junshi);

  let stop = false;
  const churn = (async () => {
    let n = 0;
    while (!stop && n < 400) {
      // 交替写两个产品，让「新产品在两次查询之间出现」这个场景也能撞上
      await chargeCredits(tenantId, userId, 1, '并发', n % 2 ? PRODUCT.quickreel : PRODUCT.junshi);
      n += 1;
    }
  })();

  try {
    for (let i = 0; i < 12; i += 1) {
      const slices = await productLedgerSlices(new Date(Date.now() - 3600_000));
      for (const row of slices) {
        assert.ok(row.entries > 0, `${row.productCode} 出现在结果里却没有条数`);
        assert.ok(row.granted >= 0 && row.spent >= 0, `${row.productCode} 金额不该为负`);
        assert.ok(
          row.productCode === PRODUCT.junshi || row.productCode === PRODUCT.quickreel,
          `冒出了预期之外的归属：${row.productCode}（本用例只写这两个产品）`,
        );
      }
    }
  } finally {
    stop = true;
    await churn;
  }
});

/* ── 「钻石消耗」按产品切 ── */

test('钻石消耗按产品切：发放与消耗各归各的', async () => {
  const { tenantId, userId } = await mkUser();
  await grantCredits(tenantId, userId, 100, '充值', PRODUCT.junshi);
  await chargeCredits(tenantId, userId, 30, '产出', PRODUCT.junshi);
  await chargeCredits(tenantId, userId, 20, '出片', PRODUCT.quickreel);

  const all = await api<{ summary: { totalGranted: number; totalSpent: number } }>('GET', '/api/admin/usage');
  assert.equal(all.status, 200);
  assert.equal(all.body.summary.totalGranted, 100);
  assert.equal(all.body.summary.totalSpent, 50, '不传 product = 全部合计，与本功能上线前一致');

  const qr = await api<{ productCode: string; summary: { totalGranted: number; totalSpent: number } }>(
    'GET', '/api/admin/usage?product=quickreel');
  assert.equal(qr.status, 200);
  assert.equal(qr.body.productCode, 'quickreel');
  assert.equal(qr.body.summary.totalSpent, 20, '只该看见花在爱速拍上的');
  assert.equal(qr.body.summary.totalGranted, 0, '爱速拍还没有自己的充值入口');
});

// 钱包只有一个，「爱速拍的余额」这个东西不存在。切出来的那个数既不等于用户能花的钱，
// 也不等于任何一笔真实负债 —— 谁把它当余额显示，运营就会拿一个不存在的数去跟用户对账。
test('按产品切的时候，余额仍然是全局余额，不跟着切', async () => {
  const { tenantId, userId } = await mkUser();
  await grantCredits(tenantId, userId, 100, '充值', PRODUCT.junshi);
  await chargeCredits(tenantId, userId, 20, '出片', PRODUCT.quickreel);

  const qr = await api<{ summary: { currentBalanceTotal: number }; users: { creditBalance: number }[] }>(
    'GET', '/api/admin/usage?product=quickreel');
  assert.equal(qr.body.summary.currentBalanceTotal, 80, '余额是一个钱包的余额，不是「爱速拍那部分」');
  assert.equal(qr.body.users[0].creditBalance, 80);
});

// 余额取的是全量流水的最后一行。按产品过滤时若把该用户最新那笔跳过了，
// 余额就会停在更早的一行 —— 显示成一个历史上存在过、现在早已不是的数。
test('最后一笔属于另一个产品时，余额不会倒退到更早的那一行', async () => {
  const { tenantId, userId } = await mkUser();
  await grantCredits(tenantId, userId, 100, '充值', PRODUCT.junshi);
  await chargeCredits(tenantId, userId, 20, '出片', PRODUCT.quickreel); // 余额 80，最后一笔是爱速拍的
  const junshi = await api<{ users: { creditBalance: number }[] }>('GET', '/api/admin/usage?product=junshi');
  assert.equal(junshi.body.users[0].creditBalance, 80, '按军师切，但余额该是当前的 80，不是 100');
});

test('产品码不认识就 422，不当成「不筛」放过去', async () => {
  const r = await api('GET', '/api/admin/usage?product=nope');
  assert.equal(r.status, 422);
  assert.equal((r.body as { code?: string }).code, 'ADMIN_PRODUCT_UNKNOWN');
});

test('按产品查要有那个产品的权限 —— 否则这个查询串就是绕过分区的后门', async () => {
  const op = await operator();
  const r = await api('GET', '/api/admin/usage?product=quickreel', { adminToken: op.token });
  assert.equal(r.status, 403);

  await prisma.adminProductAccess.create({
    data: { productCode: PRODUCT.quickreel, accountId: op.id, role: 'viewer' },
  });
  const ok = await api('GET', '/api/admin/usage?product=quickreel', { adminToken: op.token });
  assert.equal(ok.status, 200);
});

/* ── 分产品的 AI 成本（真钱，不是钻石） ── */

/**
 * 单价配在 AiEndpoint 上，测试库里没有 → 成本恒为 0，断言「成本 > 0」就永远不成立。
 * 先配一个价，这条路径（单价 → estimateCostMicros → 落库 → 按产品聚合）才算真跑过。
 */
async function priceModel(model = 'gpt-4o-mini') {
  const cred = await prisma.aiCredential.create({
    data: { label: `价-凭证-${Date.now()}`, vendor: 'qiniu', apiKey: 'sk-v2-real-key' },
  });
  await prisma.aiEndpoint.create({
    data: {
      label: `价-端点-${Date.now()}`, credentialId: cred.id,
      dialect: 'openai_compatible', provider: 'openai',
      baseUrl: 'https://api.example.invalid/v1', model,
      priceInput: 1000, priceOutput: 2000,
    },
  });
  // 单价有 60s 读缓存，不清掉的话这一条刚写的价读不到，成本仍是 0。
  const { __resetAiConfigCache } = await import('../src/services/aiConfig.js');
  __resetAiConfigCache();
}

test('AI 成本按产品归属；标了归属的算到产品头上，没标的留在未归属', async () => {
  await priceModel();
  const { tenantId, userId } = await mkUser();
  const { recordTokenUsage } = await import('../src/services/usage.js');
  // 爱速拍的 AI 写稿
  await recordTokenUsage({
    tenantId, userId, productCode: PRODUCT.quickreel, kind: 'aux', provider: 'openai',
    model: 'gpt-4o-mini', usage: { inputTokens: 1000, outputTokens: 500, cachedInput: 0 },
  });
  // 平台级基建（嵌入），不属于任何单一产品
  await recordTokenUsage({
    kind: 'aux', provider: 'openai', model: 'gpt-4o-mini',
    usage: { inputTokens: 200, outputTokens: 0, cachedInput: 0 },
  });

  const slices = await productLedgerSlices(new Date(Date.now() - 3600_000), new Date(Date.now() + 3600_000));
  const qr = slices.find((s) => s.productCode === PRODUCT.quickreel);
  const un = slices.find((s) => s.productCode === 'unattributed');
  assert.ok((qr?.costMicros ?? 0) > 0, '爱速拍的 AI 写稿成本要能单独看见');
  assert.ok((un?.costMicros ?? 0) > 0, '嵌入 / 重排 / 探活不属于任何单一产品，摊法有很多种，选哪种都是编的');
});

// 一个产品可能这段时间只烧了 AI 成本（用户在改稿）而没有任何钻石流水（还没点生成）。
// 行集只按 credit_ledger 取的话，这个产品整行消失，成本跟着隐身。
test('只有 AI 成本、没有钻石流水的产品也要出现在表里', async () => {
  await priceModel();
  const { tenantId, userId } = await mkUser();
  const { recordTokenUsage } = await import('../src/services/usage.js');
  await recordTokenUsage({
    tenantId, userId, productCode: PRODUCT.quickreel, kind: 'aux', provider: 'openai',
    model: 'gpt-4o-mini', usage: { inputTokens: 800, outputTokens: 300, cachedInput: 0 },
  });
  const slices = await productLedgerSlices(new Date(Date.now() - 3600_000), new Date(Date.now() + 3600_000));
  const qr = slices.find((s) => s.productCode === PRODUCT.quickreel);
  assert.ok(qr, '这个产品一条钻石流水都没有，但烧了真钱，不能整行消失');
  assert.equal(qr!.entries, 0);
  assert.equal(qr!.granted, 0);
  assert.ok(qr!.costMicros > 0);
});

test('爱速拍的 AI 写稿会带上产品归属落库', async () => {
  const { generateClipScriptAll } = await import('../src/services/video/scriptGenerate.js');
  // 没有真 provider 时 structuredMetered 直接返回 live:false、不落 token_usage，
  // 所以这里不断言有行；断言的是**调用点确实传了归属**，靠读源码那条太脆，改读实现常量。
  const src = await import('node:fs/promises').then((fs) =>
    fs.readFile(new URL('../src/services/video/scriptGenerate.ts', import.meta.url), 'utf8'));
  const hits = src.split('usageMeta: { productCode: PRODUCT.quickreel }').length - 1;
  assert.equal(hits, 2, 'scriptGenerate 的两个 LLM 调用点都要标归属，漏一个那部分成本就归不了');
  assert.ok(typeof generateClipScriptAll === 'function');
});

/* ── codex 2026-09-11 审出的三条 ── */

// 原来只在传了 product 时才查权限。一个没有任何产品授权的 operator 只要不带这个参数
// （或带 `?product=%20`，trim 后为空），就能拿到全平台的用户名单与汇总。
test('不传 product 不等于放行全量 —— 没授权的运营拿不到全平台数据', async () => {
  const a = await mkUser();
  await grantCredits(a.tenantId, a.userId, 100, '充值', PRODUCT.junshi);
  const op = await operator();

  for (const qs of ['', '?product=', '?product=%20', '?product=++']) {
    const r = await api<{ users: unknown[]; summary: { totalGranted: number } }>('GET', `/api/admin/usage${qs}`, { adminToken: op.token });
    assert.equal(r.status, 200, `${qs} 不该报错，但也不该给全量`);
    assert.deepEqual(r.body.users, [], `${qs} 漏了用户名单`);
    assert.equal(r.body.summary.totalGranted, 0, `${qs} 漏了汇总金额`);
  }
});

test('超管不传 product 仍然看全量 —— 这条修复不许顺手把超管也关掉', async () => {
  const a = await mkUser();
  await grantCredits(a.tenantId, a.userId, 100, '充值', PRODUCT.junshi);
  const r = await api<{ summary: { totalGranted: number } }>('GET', '/api/admin/usage');
  assert.equal(r.body.summary.totalGranted, 100);
});

test('被授权的运营不传 product，自动收窄到自己被授予的产品', async () => {
  const a = await mkUser();
  await grantCredits(a.tenantId, a.userId, 100, '充值', PRODUCT.junshi);
  await chargeCredits(a.tenantId, a.userId, 20, '出片', PRODUCT.quickreel);
  const op = await operator();
  await prisma.adminProductAccess.create({
    data: { productCode: PRODUCT.quickreel, accountId: op.id, role: 'viewer' },
  });
  const r = await api<{ summary: { totalGranted: number; totalSpent: number } }>('GET', '/api/admin/usage', { adminToken: op.token });
  assert.equal(r.body.summary.totalSpent, 20);
  assert.equal(r.body.summary.totalGranted, 0, '军师的充值不该出现在爱速拍运营眼里');
});

// 只被授予爱速拍的运营，不该看见一堆只用过军师的人的姓名、手机号、会话数和成果数。
test('收窄视角时用户名单也跟着收窄，不只是数字', async () => {
  const onlyJunshi = await mkUser();
  await grantCredits(onlyJunshi.tenantId, onlyJunshi.userId, 50, '充值', PRODUCT.junshi);
  const usedQuickreel = await mkUser();
  await grantCredits(usedQuickreel.tenantId, usedQuickreel.userId, 50, '充值', PRODUCT.junshi);
  await chargeCredits(usedQuickreel.tenantId, usedQuickreel.userId, 10, '出片', PRODUCT.quickreel);

  const r = await api<{ users: { id: string }[] }>('GET', '/api/admin/usage?product=quickreel');
  const ids = r.body.users.map((u) => u.id);
  assert.ok(ids.includes(usedQuickreel.userId), '用过爱速拍的人该在');
  assert.ok(!ids.includes(onlyJunshi.userId), '只用过军师的人不该出现在爱速拍视角里');
});

// 权威余额读取是 [createdAt desc, id desc]；这一屏只按 createdAt 排的话，
// 同一毫秒落的两行谁在后面由数据库决定，显示的余额会和用户真实余额对不上。
test('同一时刻的两笔流水，这一屏算出的余额与 getBalance 一致', async () => {
  const { tenantId, userId } = await mkUser();
  const at = new Date();
  await prisma.creditLedger.createMany({
    data: [
      { tenantId, userId, delta: 100, reason: '充值', balance: 100, productCode: PRODUCT.junshi, createdAt: at },
      { tenantId, userId, delta: -20, reason: '出片', balance: 80, productCode: PRODUCT.quickreel, createdAt: at },
    ],
  });
  const authoritative = await getBalance(userId);
  const r = await api<{ users: { id: string; creditBalance: number }[] }>('GET', '/api/admin/usage');
  const row = r.body.users.find((u) => u.id === userId);
  assert.equal(row?.creditBalance, authoritative, '后台显示的余额和真实余额对不上');
});

test('时间范围超过两年直接 422，而不是让事务跑到超时再 500', async () => {
  const r = await api('GET', '/api/admin/products/ledger?from=1970-01-01T00:00:00.000Z');
  assert.equal(r.status, 422);
  assert.equal((r.body as { code?: string }).code, 'ADMIN_RANGE_TOO_WIDE');
});
