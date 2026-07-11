// 批次三·第一波（S1）：D-1 开通来源归因 + D-3-7 生态工具 + WO-14 处方追踪闭环 + WO-11 异议回显。
// 全程 mock 模型；admin 路由带测试 ADMIN_TOKEN。
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, login, uniquePhone } from './helpers.js';
import { markPaidAndApply } from '../src/services/wechatPay.js';
import { scanPrescriptionFollowups, pendingFollowupTools, prescriptionEffectBlock, toolMenu } from '../src/services/prescription.js';

process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'test-admin-token';

const deliverableWith = (prescriptions: unknown) => ({
  title: '增长方案', icon: 'spark', meta: '', trust: '', actions: [],
  sections: [{ h: '打法', b: '聚焦影响力获客', list: ['每周 3 条口播'] }],
  prescriptions,
});

async function createUserWithCredits(balance: number): Promise<{ tenantId: string; userId: string }> {
  const tenant = await prisma.tenant.create({ data: { name: 'S1 测试企业' } });
  const user = await prisma.user.create({ data: { tenantId: tenant.id, phone: uniquePhone(), name: 'S1 用户', role: 'owner' } });
  await prisma.creditLedger.create({ data: { tenantId: tenant.id, userId: user.id, delta: balance, reason: '测试初始余额', balance } });
  return { tenantId: tenant.id, userId: user.id };
}

before(async () => { await getApp(); });
after(async () => { await closeApp(); });

describe('D-1 开通来源归因（ActivationEvent）', () => {
  beforeEach(async () => { await cleanBusiness(); await seedBaseline(); });

  test('agent 解锁购买：source/refId 从请求体读，落一条 ActivationEvent', async () => {
    const { userId } = await createUserWithCredits(100);
    const r = await api('POST', '/api/agents/brand/purchase', { token: userId, body: { source: 'prescription', refId: 'rx_abc' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.alreadyOwned, false);
    const ev = await prisma.activationEvent.findFirst({ where: { userId, itemType: 'agent', itemKey: 'brand' } });
    assert.ok(ev, '落了开通事件');
    assert.equal(ev!.source, 'prescription');
    assert.equal(ev!.refId, 'rx_abc');
  });

  test('缺省 source=catalog；表外 source 回落 catalog；refId 仅 prescription 保留', async () => {
    const { userId } = await createUserWithCredits(100);
    await api('POST', '/api/agents/brand/purchase', { token: userId, body: {} }); // 缺省
    await api('POST', '/api/agents/poster/purchase', { token: userId, body: { source: 'bogus', refId: 'x' } }); // 表外
    const brand = await prisma.activationEvent.findFirst({ where: { userId, itemKey: 'brand' } });
    const poster = await prisma.activationEvent.findFirst({ where: { userId, itemKey: 'poster' } });
    assert.equal(brand!.source, 'catalog');
    assert.equal(poster!.source, 'catalog', '未知 source 回落 catalog');
    assert.equal(poster!.refId, null, 'catalog 来源不带 refId');
  });

  test('幂等重复购买：alreadyOwned 时不重复落事件', async () => {
    const { userId } = await createUserWithCredits(100);
    await api('POST', '/api/agents/brand/purchase', { token: userId, body: { source: 'market' } });
    const again = await api('POST', '/api/agents/brand/purchase', { token: userId, body: { source: 'market' } });
    assert.equal(again.body.alreadyOwned, true);
    assert.equal(await prisma.activationEvent.count({ where: { userId, itemKey: 'brand' } }), 1, '开通事件只落一次');
  });

  test('SKU 支付发放：从订单 attrSource 落 ActivationEvent（itemType=sku）', async () => {
    const { userId, tenantId } = await createUserWithCredits(0);
    const sku = await prisma.sku.findUnique({ where: { key: 'deep-contradiction' } });
    await prisma.paymentOrder.create({
      data: { outTradeNo: 'ot_attr_1', tenantId, userId, planId: '', skuKey: 'deep-contradiction', amount: sku!.priceFen, provider: 'mock', status: 'created', attrSource: 'market', attrRefId: null },
    });
    const r = await markPaidAndApply({ outTradeNo: 'ot_attr_1', tradeState: 'SUCCESS', rawJson: {} });
    assert.equal(r.applied, true);
    const ev = await prisma.activationEvent.findFirst({ where: { userId, itemType: 'sku', itemKey: 'deep-contradiction' } });
    assert.ok(ev, 'SKU 发放落了开通事件');
    assert.equal(ev!.source, 'market');
  });
});

describe('D-3-7 生态工具注册表 + 白名单并入', () => {
  beforeEach(async () => { await cleanBusiness(); await seedBaseline(); });

  test('CRUD：enabled 前必须有 appId；启用后进入白名单，处方落 external 且回 appId/path', async () => {
    // 启用但无 appId → 拒绝
    const bad = await api('POST', '/api/admin/eco-tools', { body: { id: 'digital-human', name: '数字人代播', desc: '帮客户做直播代播', enabled: true } });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'ECO_APPID_REQUIRED');
    // 正常创建（带 appId + path）
    const ok = await api('POST', '/api/admin/eco-tools', { body: { id: 'digital-human', name: '数字人代播', desc: '帮客户做直播代播', appId: 'wx_target', path: 'pages/live/index', enabled: true } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.enabled, true);

    // 认可含 external toolKey 的方案 → 落库 toolType=external
    const token = await login(uniquePhone(), '生态用户');
    const acc = await api('POST', '/api/casefile/accept', { token, body: { deliverable: deliverableWith([{ problem: '直播没人看', playbook: '上数字人代播', toolKey: 'digital-human' }]) } });
    assert.equal(acc.status, 200, JSON.stringify(acc.body));
    const list = await api('GET', '/api/prescriptions', { token });
    const it = list.body.items.find((i: { toolKey: string }) => i.toolKey === 'digital-human');
    assert.ok(it, '生态 toolKey 入白名单、落库成功');
    assert.equal(it.toolType, 'external');
    assert.equal(it.appId, 'wx_target');
    assert.equal(it.path, 'pages/live/index');
  });

  test('未启用的 EcoTool 不在白名单：表外 toolKey 丢弃', async () => {
    await api('POST', '/api/admin/eco-tools', { body: { id: 'short-drama', name: '短剧工厂', desc: '拍短剧', appId: 'wx_sd', enabled: false } });
    const token = await login(uniquePhone(), '生态用户2');
    await api('POST', '/api/casefile/accept', { token, body: { deliverable: deliverableWith([{ problem: 'x', playbook: 'y', toolKey: 'short-drama' }]) } });
    const list = await api('GET', '/api/prescriptions', { token });
    assert.equal(list.body.items.length, 0, '未启用生态工具的方不落库');
  });

  test('toolMenu 注入含 enabled agent + enabled EcoTool，含开方指令', async () => {
    await api('POST', '/api/admin/eco-tools', { body: { id: 'digital-human', name: '数字人代播', desc: '帮客户做直播代播', appId: 'wx_target', enabled: true } });
    const menu = await toolMenu();
    assert.ok(menu && menu.includes('可开方工具表'), '带表头');
    assert.ok(menu!.includes('digital-human'), '含启用的生态工具 key');
    assert.ok(menu!.includes('growth'), '含启用的内部 agent key');
    assert.ok(menu!.includes('最多 3 条'), '含开方上限指令');
  });

  test('未知 EcoTool PATCH/DELETE → 404', async () => {
    assert.equal((await api('PATCH', '/api/admin/eco-tools/nope', { body: { name: 'x' } })).status, 404);
    assert.equal((await api('DELETE', '/api/admin/eco-tools/nope', {})).status, 404);
  });
});

describe('D-1/WO-12 多来源漏斗报表', () => {
  beforeEach(async () => { await cleanBusiness(); await seedBaseline(); });

  test('GET /admin/prescriptions/funnel 返回处方六态 + 开通来源两块', async () => {
    const { userId } = await createUserWithCredits(100);
    await api('POST', '/api/agents/brand/purchase', { token: userId, body: { source: 'catalog' } });
    const token = await login(uniquePhone(), '漏斗用户');
    await api('POST', '/api/casefile/accept', { token, body: { deliverable: deliverableWith([{ problem: '获客', playbook: '短视频', toolKey: 'growth' }]) } });
    const id = (await api('GET', '/api/prescriptions', { token })).body.items[0].id;
    await api('POST', `/api/prescriptions/${id}/clicked`, { token });

    const r = await api('GET', '/api/admin/prescriptions/funnel?days=30', {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.days, 30);
    const growthRow = r.body.prescriptions.find((p: { toolKey: string }) => p.toolKey === 'growth');
    assert.ok(growthRow, '含 growth 行');
    assert.equal(growthRow.proposed, 1);
    assert.equal(growthRow.clicked, 1);
    assert.ok(r.body.activations.some((a: { source: string; count: number }) => a.source === 'catalog' && a.count >= 1), '开通侧按来源计数');
  });

  test('days 参数夹逼在 1..365', async () => {
    const r = await api('GET', '/api/admin/prescriptions/funnel?days=99999', {});
    assert.equal(r.body.days, 365);
  });
});

describe('WO-14 处方追踪闭环', () => {
  beforeEach(async () => { await cleanBusiness(); await seedBaseline(); });

  test('followup 扫描：activated 满 7 天行级打标一次（幂等）', async () => {
    const token = await login(uniquePhone(), '追踪用户');
    await api('POST', '/api/casefile/accept', { token, body: { deliverable: deliverableWith([{ problem: '获客', playbook: '短视频', toolKey: 'growth' }]) } });
    const id = (await api('GET', '/api/prescriptions', { token })).body.items[0].id;
    // 手工置为 8 天前开通
    await prisma.prescription.update({ where: { id }, data: { status: 'activated', activatedAt: new Date(Date.now() - 8 * 86400_000) } });
    const n = await scanPrescriptionFollowups();
    assert.ok(n >= 1, '至少打标一条');
    const row1 = await prisma.prescription.findUnique({ where: { id } });
    assert.ok(row1!.followupAt, 'followupAt 已打标');
    // 幂等：再扫不重复打标（followupAt 不变）
    await scanPrescriptionFollowups();
    const row2 = await prisma.prescription.findUnique({ where: { id } });
    assert.equal(row2!.followupAt!.getTime(), row1!.followupAt!.getTime(), '重复扫描不改 followupAt');
  });

  test('activated 不足 7 天不打标', async () => {
    const token = await login(uniquePhone(), '追踪用户2');
    await api('POST', '/api/casefile/accept', { token, body: { deliverable: deliverableWith([{ problem: '获客', playbook: '短视频', toolKey: 'growth' }]) } });
    const id = (await api('GET', '/api/prescriptions', { token })).body.items[0].id;
    await prisma.prescription.update({ where: { id }, data: { status: 'activated', activatedAt: new Date(Date.now() - 3 * 86400_000) } });
    await scanPrescriptionFollowups();
    const row = await prisma.prescription.findUnique({ where: { id } });
    assert.equal(row!.followupAt, null, '未满 7 天不打标');
  });

  test('pendingFollowupTools 点名已打标待追踪的工具名', async () => {
    const token = await login(uniquePhone(), '追踪用户3');
    await api('POST', '/api/casefile/accept', { token, body: { deliverable: deliverableWith([{ problem: '获客', playbook: '短视频', toolKey: 'growth' }]) } });
    const id = (await api('GET', '/api/prescriptions', { token })).body.items[0].id;
    await prisma.prescription.update({ where: { id }, data: { status: 'activated', activatedAt: new Date(Date.now() - 8 * 86400_000) } });
    await scanPrescriptionFollowups();
    const names = await pendingFollowupTools(token);
    assert.deepEqual(names, ['增长操盘手'], '点名 growth 的展示名');
  });

  test('月战报【处方效果】块：有 outcome 才注入，无 outcome 返回 null', async () => {
    const token = await login(uniquePhone(), '效果用户');
    // 无 outcome → null
    assert.equal(await prescriptionEffectBlock(token), null);
    await api('POST', '/api/casefile/accept', { token, body: { deliverable: deliverableWith([{ problem: '获客', playbook: '短视频', toolKey: 'growth' }]) } });
    const id = (await api('GET', '/api/prescriptions', { token })).body.items[0].id;
    await api('POST', `/api/prescriptions/${id}/outcome`, { token, body: { period: 'week', metrics: { posts: 4, leads: 6 } } });
    const block = await prescriptionEffectBlock(token);
    assert.ok(block && block.includes('处方效果'), '有 outcome 后注入块');
    assert.ok(block!.includes('线索 6'), '累计线索由系统算');
  });
});

describe('WO-11 异议回显（列表接口带 disputeNote）', () => {
  beforeEach(async () => { await cleanBusiness(); await seedBaseline(); });

  test('决策异议：PATCH 后列表回显 disputeNote/disputedAt', async () => {
    const token = await login(uniquePhone(), '异议用户');
    const d = await api('POST', '/api/decisions', { token, body: { decision: '砍掉线下门店' } });
    const id = d.body.decision.id;
    assert.equal((await api('PATCH', `/api/decisions/${id}`, { token, body: { dispute: '我觉得判早了' } })).status, 200);
    const item = (await api('GET', '/api/decisions', { token })).body.items.find((i: { id: string }) => i.id === id);
    assert.equal(item.disputeNote, '我觉得判早了');
    assert.ok(item.disputedAt, '带 disputedAt 时间戳');
  });

  test('预言异议：PATCH 后列表回显 disputeNote', async () => {
    const token = await login(uniquePhone(), '异议用户2');
    const p = await api('POST', '/api/prophecies', { token, body: { prophecy: '三个月内复购率回升' } });
    const id = p.body.prophecy.id;
    assert.equal((await api('PATCH', `/api/prophecies/${id}`, { token, body: { dispute: '这个判定我不认' } })).status, 200);
    const item = (await api('GET', '/api/prophecies', { token })).body.items.find((i: { id: string }) => i.id === id);
    assert.equal(item.disputeNote, '这个判定我不认');
    assert.ok(item.disputedAt);
  });
});
