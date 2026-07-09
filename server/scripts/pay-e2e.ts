// 支付 + 有效期 端到端冒烟（无微信、无网络）：用沙箱三件套离线验证全链路。
//   PAY_SANDBOX=true 起 app(inject) → mock 下单 → 仿真回调入账 → 断言 /me 套餐/额度/到期 →
//   月→年折算 → x-test-now 快进过期 → 断言降级(额度归0) + 只读锁定(403) → 重复回调验幂等。
// 运行：npm run pay:e2e（本地/CI 可跑；不触达微信）。结束打印 PASS/FAIL，失败退出码非 0。
process.env.PAY_SANDBOX = 'true';
process.env.NODE_ENV = 'test'; // mock 模型/短信，杜绝任何真实外呼
process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'e2e-admin-token';

import { buildApp } from '../src/app.js';
import { prisma } from '../src/db.js';

const ADMIN = process.env.ADMIN_TOKEN!;
let pass = 0, fail = 0;
function check(name: string, ok: boolean, extra?: unknown) {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra) : ''); }
}

async function main() {
  const app = await buildApp();
  const inj = async (method: 'GET' | 'POST', url: string, opts: { user?: string; admin?: boolean; body?: unknown; testNow?: string } = {}) => {
    const headers: Record<string, string> = {};
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (opts.user) headers['x-user-id'] = opts.user;
    if (opts.admin) headers['x-admin-token'] = ADMIN;
    if (opts.testNow) headers['x-test-now'] = opts.testNow;
    const res = await app.inject({ method, url, headers, payload: opts.body !== undefined ? (opts.body as object) : undefined });
    let body: any = null; try { body = res.json(); } catch { body = res.body; }
    return { status: res.statusCode, body };
  };

  // —— 准备：测试租户/用户 + 取月付/年付套餐 ——
  const tenant = await prisma.tenant.create({ data: { name: 'E2E支付' } });
  const user = await prisma.user.create({ data: { tenantId: tenant.id, phone: '1' + String(9_000_000_000 + Math.floor(Math.random() * 1_000_000_00)).slice(0, 10), name: 'E2E', role: 'owner', wechatOpenId: `o_e2e_${Date.now()}` } });
  const cleanup = async () => {
    await prisma.paymentOrder.deleteMany({ where: { userId: user.id } });
    await prisma.userModule.deleteMany({ where: { userId: user.id } }); // V7-12 SKU 段发放
    await prisma.tokenWallet.deleteMany({ where: { userId: user.id } });
    await prisma.creditLedger.deleteMany({ where: { userId: user.id } });
    await prisma.auditLog.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
    await prisma.tenant.delete({ where: { id: tenant.id } }).catch(() => {});
  };

  try {
    const plansRes = await inj('GET', '/api/plans');
    const monthly = (plansRes.body as any[]).find((p) => p.period === 'month' && p.price > 0);
    const yearly = (plansRes.body as any[]).find((p) => p.period === 'year' && p.price > 0);
    check('套餐目录含 付费月付 + 付费年付', !!monthly && !!yearly, { monthly: monthly?.name, yearly: yearly?.name });
    if (!monthly || !yearly) throw new Error('缺少付费套餐，请先 npm run db:sync-plans');

    // 1) mock 下单（沙箱）
    const order = await inj('POST', `/api/plans/${monthly.id}/order`, { user: user.id, body: { openid: user.wechatOpenId } });
    check('沙箱下单成功（provider=mock）', order.status === 200 && order.body.ok === true && order.body.amount === monthly.price, order.body);
    const outTradeNo = order.body.outTradeNo;
    const dbOrder = await prisma.paymentOrder.findUnique({ where: { outTradeNo } });
    check('订单落库 provider=mock/status=created', dbOrder?.provider === 'mock' && dbOrder?.status === 'created');

    // 2) 仿真回调入账
    const notify = await inj('POST', '/api/pay/sandbox/notify', { admin: true, body: { outTradeNo } });
    check('仿真回调入账 applied=true', notify.status === 200 && notify.body.applied === true, notify.body);

    // 3) /me 断言：套餐生效 + 额度满 + 到期时间
    const me1 = await inj('GET', '/api/me', { user: user.id });
    check('/me 套餐 = 月付', me1.body.plan?.name === monthly.name, me1.body.plan);
    check('/me planStatus.active=true 且有 expiresAt', me1.body.planStatus?.active === true && !!me1.body.planStatus?.expiresAt, me1.body.planStatus);
    check('/me 月度额度 = 100 万', me1.body.tokenQuota?.limit === 1_000_000, me1.body.tokenQuota);
    const expiresAt = new Date(me1.body.planStatus.expiresAt);

    // 4) 仿真回调幂等：重复投递不二次发放
    const notify2 = await inj('POST', '/api/pay/sandbox/notify', { admin: true, body: { outTradeNo } });
    check('重复回调 applied=false / already_applied', notify2.body.applied === false && notify2.body.reason === 'already_applied', notify2.body);
    const ledgerCount = await prisma.creditLedger.count({ where: { userId: user.id } });
    check('钻石流水仅 1 条（幂等）', ledgerCount === 1, { ledgerCount });

    // 5) 月→年折算：在月付有效期内下年付单 → applies + 折后实付 < 原价
    const upOrder = await inj('POST', `/api/plans/${yearly.id}/order`, { user: user.id, body: { openid: user.wechatOpenId } });
    const pr = upOrder.body.proration;
    check('月→年折算触发 + 实付 < 原价 且 >0', upOrder.body.amount < yearly.price && upOrder.body.amount > 0 && pr?.applies === true, { amount: upOrder.body.amount, full: yearly.price, pr });
    // 不支付该升级单（保持用户仍在月付，便于验证过期降级）

    // 6) 快进过期：x-test-now = 到期 + 1 天 → 降级（额度归 0 + 只读）
    const future = new Date(expiresAt.getTime() + 86_400_000).toISOString();
    const meExp = await inj('GET', '/api/me', { user: user.id, testNow: future });
    check('过期后 /me planStatus.expired=true', meExp.body.planStatus?.expired === true, meExp.body.planStatus);
    check('过期后 /me 月度额度归 0（冻结）', meExp.body.tokenQuota?.limit === 0, meExp.body.tokenQuota);

    // 7) 只读锁定：过期后 AI 交互被拦 403 PLAN_EXPIRED
    const gen = await inj('POST', '/api/generate-sync', { user: user.id, body: { text: '帮我做个战略诊断' }, testNow: future });
    check('过期后 /generate-sync → 403 PLAN_EXPIRED', gen.status === 403 && gen.body.code === 'PLAN_EXPIRED', gen.body);

    // 8) 续费恢复：过期态再支付一单月付（仿真回调） → 即时恢复有效 + 额度满
    const reOrder = await inj('POST', `/api/plans/${monthly.id}/order`, { user: user.id, body: { openid: user.wechatOpenId }, testNow: future });
    await inj('POST', '/api/pay/sandbox/notify', { admin: true, body: { outTradeNo: reOrder.body.outTradeNo }, testNow: future });
    const meRe = await inj('GET', '/api/me', { user: user.id, testNow: future });
    check('续费后即时恢复有效 + 额度满', meRe.body.planStatus?.active === true && meRe.body.tokenQuota?.limit === 1_000_000, meRe.body.planStatus);

    // —— V7-12：SKU 单次付费段（下单 → 仿真回调 → 权益发放 → 幂等）——
    // 自带 SKU 目录（不依赖 admin:sync-content 先跑）。
    const { SKUS } = await import('../src/data/seedConfig.js');
    for (let i = 0; i < SKUS.length; i++) {
      const sk = SKUS[i];
      await prisma.sku.upsert({
        where: { key: sk.key },
        update: { name: sk.name, desc: sk.desc, priceFen: sk.priceFen, kind: sk.kind, grantsModuleKey: sk.grantsModuleKey ?? null, metaJson: sk.metaBytes ? { bytes: sk.metaBytes } : undefined, sort: i },
        create: { key: sk.key, name: sk.name, desc: sk.desc, priceFen: sk.priceFen, kind: sk.kind, grantsModuleKey: sk.grantsModuleKey ?? null, metaJson: sk.metaBytes ? { bytes: sk.metaBytes } : undefined, sort: i },
      });
    }
    const skusRes = await inj('GET', '/api/skus');
    check('SKU 目录 ≥ 6 条', (skusRes.body as any[]).length >= 6, { count: (skusRes.body as any[]).length });

    // 9) module SKU：下单 → 沙箱回调 → 发放 UserModule
    const skuOrder = await inj('POST', '/api/skus/deep-contradiction/order', { user: user.id, body: { openid: user.wechatOpenId } });
    check('SKU 沙箱下单成功（返回 orderId）', skuOrder.status === 200 && !!skuOrder.body.orderId, skuOrder.body);
    const skuOut = skuOrder.body.orderId;
    const skuDbOrder = await prisma.paymentOrder.findUnique({ where: { outTradeNo: skuOut } });
    check('SKU 订单落库 skuKey=deep-contradiction/status=created', skuDbOrder?.skuKey === 'deep-contradiction' && skuDbOrder?.status === 'created', { skuKey: skuDbOrder?.skuKey });
    const skuNotify = await inj('POST', '/api/pay/sandbox/notify', { admin: true, body: { outTradeNo: skuOut } });
    check('SKU 回调入账 applied=true', skuNotify.body.applied === true, skuNotify.body);
    const um = await prisma.userModule.findUnique({ where: { userId_moduleKey: { userId: user.id, moduleKey: 'deep-contradiction' } } });
    check('SKU 发放：UserModule(deep-contradiction, purchase)', !!um && um.enabled && um.source === 'purchase', um);

    // 10) SKU 回调幂等：重复投递不二次发放
    const skuNotify2 = await inj('POST', '/api/pay/sandbox/notify', { admin: true, body: { outTradeNo: skuOut } });
    check('SKU 重复回调 already_applied（幂等）', skuNotify2.body.applied === false && skuNotify2.body.reason === 'already_applied', skuNotify2.body);
    const umCount = await prisma.userModule.count({ where: { userId: user.id, moduleKey: 'deep-contradiction' } });
    check('SKU 模块启用行仅 1 条（幂等）', umCount === 1, { umCount });

    // 11) service SKU（深度整理）：下单 → 回调 → 一次性服务凭据 sku:<key>
    const svcOrder = await inj('POST', '/api/skus/deep-organize/order', { user: user.id, body: { openid: user.wechatOpenId } });
    await inj('POST', '/api/pay/sandbox/notify', { admin: true, body: { outTradeNo: svcOrder.body.orderId } });
    const cred = await prisma.userModule.findUnique({ where: { userId_moduleKey: { userId: user.id, moduleKey: 'sku:deep-organize' } } });
    check('service SKU 发放：一次性凭据 sku:deep-organize', !!cred && cred.source === 'purchase', cred);
  } finally {
    await cleanup();
    await app.close();
    await prisma.$disconnect();
  }

  console.log(`\n${fail === 0 ? '✅ PASS' : '❌ FAIL'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
