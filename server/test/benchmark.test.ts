// WO-08 行业基准库：有 p50 数据 → 上下文含【行业基准】块（分位数）；p50 空 / 无行业 → 不注入。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, closeApp, seedBaseline, cleanBusiness, login, uniquePhone } from './helpers.ts';
import { prisma } from '../src/db.ts';
import { buildGenContext } from '../src/services/context.ts';

describe('WO-08 行业基准库', () => {
  before(async () => { await getApp(); await cleanBusiness(); await seedBaseline(); });
  after(async () => { await closeApp(); });

  test('有 p50 → 注入【行业基准】块（中位+分位）；p50 空的指标不注入', async () => {
    const token = await login(uniquePhone(), '基准用户');
    const user = (await prisma.user.findUnique({ where: { id: token } }))!;
    await prisma.profile.create({ data: { tenantId: user.tenantId, industry: '美业' } });
    await prisma.industryBenchmark.createMany({
      data: [
        { industry: '美业', metricKey: 'repurchase_rate', metricName: '复购率', unit: '%', p25: 30, p50: 45, p75: 60, note: '待运营核实' },
        { industry: '美业', metricKey: 'cac', metricName: '获客成本', unit: '元', p50: null }, // 空 p50 → 不注入
      ],
    });

    const { ctx } = await buildGenContext({ userId: user.id, tenantId: user.tenantId, agentKey: 'general', userMessage: '你好' });
    assert.match(ctx.benchmarkLine ?? '', /行业基准/);
    assert.match(ctx.benchmarkLine ?? '', /复购率：行业中位 45%/);
    assert.match(ctx.benchmarkLine ?? '', /P25 30% \/ P75 60%/);
    assert.doesNotMatch(ctx.benchmarkLine ?? '', /获客成本/, 'p50 空的指标不注入');
  });

  test('无行业档案 → 不注入基准块', async () => {
    const token = await login(uniquePhone(), '无行业用户');
    const user = (await prisma.user.findUnique({ where: { id: token } }))!;
    const { ctx } = await buildGenContext({ userId: user.id, tenantId: user.tenantId, agentKey: 'general', userMessage: '你好' });
    assert.equal(ctx.benchmarkLine ?? null, null);
  });
});
