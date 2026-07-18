// D-3-3 健康度估测框架：空输入全 na（不触达 LLM）、月度幂等、注入块【健康度·军师估测】回显。
// 测试环境无 live provider（structured 返回 null）→ 有输入的维度也回落 na（宁缺勿假），符合「调用后强制 na」实现。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, closeApp, seedBaseline, cleanBusiness, login, uniquePhone } from './helpers.ts';
import { prisma } from '../src/db.ts';
import { estimateHealth, maybeEstimateMonthlyHealth, healthBlock, HEALTH_DIMS, type HealthEstimate } from '../src/services/health.ts';
import { buildGenContext } from '../src/services/context.ts';

describe('D-3-3 健康度估测框架', () => {
  before(async () => { await getApp(); await cleanBusiness(); await seedBaseline(); });
  after(async () => { await closeApp(); });

  test('空输入 → 全维 na（不触达 LLM），落库 StrategicProfile.kpiJson.health', async () => {
    const token = await login(uniquePhone(), '健康空用户');
    const user = (await prisma.user.findUnique({ where: { id: token } }))!;

    const est = await estimateHealth(user.id, user.tenantId);
    assert.equal(est.dims.length, HEALTH_DIMS.length, '五维齐全');
    assert.ok(est.dims.every((d) => d.level === 'na'), '无任何输入 → 全 na');
    assert.equal(est.source, 'estimate');

    await maybeEstimateMonthlyHealth(user.id, user.tenantId);
    const sp = await prisma.strategicProfile.findUnique({ where: { userId: user.id }, select: { kpiJson: true } });
    const health = (sp?.kpiJson as { health?: HealthEstimate } | null)?.health;
    assert.ok(health, '已落库 kpiJson.health');
    assert.ok(health!.dims.every((d) => d.level === 'na'), '落库值全 na');
  });

  test('有输入但无 live provider（测试环境）→ 该维仍落 na（不伪造水位）', async () => {
    const token = await login(uniquePhone(), '健康有数据用户');
    const user = (await prisma.user.findUnique({ where: { id: token } }))!;
    const cf = await prisma.casefile.create({ data: { tenantId: user.tenantId, userId: user.id, title: '案卷', risksJson: [] } });
    await prisma.casefileMetric.create({ data: { tenantId: user.tenantId, userId: user.id, casefileId: cf.id, date: '2026-07-10', leads: 20, consults: 8, deals: 5 } });

    const est = await estimateHealth(user.id, user.tenantId);
    const revenue = est.dims.find((d) => d.key === 'revenue')!;
    const customer = est.dims.find((d) => d.key === 'customer')!;
    // 有证据但测试环境 structured() 返回 null → 回落 na（符合「宁缺勿假」，绝不脑补水位）。
    assert.equal(revenue.level, 'na');
    assert.equal(customer.level, 'na');
  });

  test('月度幂等：同月二次估测跳过（at 不变）', async () => {
    const token = await login(uniquePhone(), '健康幂等用户');
    const user = (await prisma.user.findUnique({ where: { id: token } }))!;

    await maybeEstimateMonthlyHealth(user.id, user.tenantId);
    const first = (await prisma.strategicProfile.findUnique({ where: { userId: user.id }, select: { kpiJson: true } }))!;
    const at1 = (first.kpiJson as { health?: HealthEstimate }).health!.at;

    await maybeEstimateMonthlyHealth(user.id, user.tenantId);
    const second = (await prisma.strategicProfile.findUnique({ where: { userId: user.id }, select: { kpiJson: true } }))!;
    const at2 = (second.kpiJson as { health?: HealthEstimate }).health!.at;
    assert.equal(at2, at1, '同月不重复估测');
  });

  test('注入块【健康度·军师估测】只读落库值：高/中/低水位文案 + na 缺数据占位 + 块尾禁算', async () => {
    const token = await login(uniquePhone(), '健康注入用户');
    const user = (await prisma.user.findUnique({ where: { id: token } }))!;
    const health: HealthEstimate = {
      at: new Date().toISOString(), source: 'estimate',
      dims: [
        { key: 'revenue', level: 'mid', rationale: '成交平稳' },
        { key: 'customer', level: 'high', rationale: '线索充足' },
        { key: 'product', level: 'na', rationale: '' },
        { key: 'team', level: 'low', rationale: '复盘断档' },
        { key: 'brand', level: 'na', rationale: '' },
      ],
    };
    await prisma.strategicProfile.upsert({
      where: { userId: user.id },
      update: { kpiJson: { health } as object },
      create: { tenantId: user.tenantId, userId: user.id, kpiJson: { health } as object },
    });

    const block = await healthBlock(user.id);
    assert.ok(block, '有落库估测 → 注入块非空');
    assert.match(block!, /健康度·军师估测/);
    assert.match(block!, /营收：中水位/);
    assert.match(block!, /客户：高水位/);
    assert.match(block!, /团队：低水位/);
    assert.match(block!, /产品：暂无法评估（缺产品数据）/);
    assert.match(block!, /不要另算分数或百分比/, '块尾禁算口径');
    assert.doesNotMatch(block!, /%/, '水位文案不含百分比');

    // 端到端：进上下文装配 → ctx.healthLine 回显同一落库值。
    const { ctx } = await buildGenContext({ userId: user.id, tenantId: user.tenantId, agentKey: 'general', userMessage: '你好' });
    assert.match(ctx.healthLine ?? '', /客户：高水位/);
  });
});
