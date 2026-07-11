// WO-10 结构化经营周报：模板按行业 + 填报 + 序列 + 注入【经营序列】（与基准算差）；非法 weekStart 400。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, login, uniquePhone } from './helpers.ts';
import { prisma } from '../src/db.ts';
import { buildGenContext } from '../src/services/context.ts';

describe('WO-10 结构化经营周报', () => {
  before(async () => { await getApp(); await cleanBusiness(); await seedBaseline(); });
  after(async () => { await closeApp(); });

  test('模板按行业 + 填报 + 序列 + 注入经营序列（与基准算差）', async () => {
    const token = await login(uniquePhone(), '周报用户');
    const user = (await prisma.user.findUnique({ where: { id: token } }))!;
    await prisma.profile.create({ data: { tenantId: user.tenantId, industry: '美业' } });
    await prisma.industryBenchmark.create({ data: { industry: '美业', metricKey: 'repurchase_rate', metricName: '复购率', unit: '%', p50: 45 } });

    const tmpl = await api('GET', '/api/biz-metrics/template', { token });
    assert.equal(tmpl.status, 200);
    assert.ok(tmpl.body.items.some((i: { metricKey: string }) => i.metricKey === 'repurchase_rate'), '模板含行业指标');

    assert.equal((await api('PUT', '/api/biz-metrics/2026-07-06', { token, body: { metrics: { repurchase_rate: 31 } } })).status, 200);
    const s = await api('GET', '/api/biz-metrics?weeks=8', { token });
    assert.equal(s.body.items.length, 1);
    assert.equal(s.body.items[0].metrics.repurchase_rate, 31);

    const { ctx } = await buildGenContext({ userId: user.id, tenantId: user.tenantId, agentKey: 'general', userMessage: '你好' });
    assert.match(ctx.bizMetricLine ?? '', /经营序列/);
    assert.match(ctx.bizMetricLine ?? '', /复购率 31%，低于行业中位 14%/);
  });

  test('weekStart 非法 → 400', async () => {
    const token = await login(uniquePhone(), '周报用户2');
    assert.equal((await api('PUT', '/api/biz-metrics/notadate', { token, body: { metrics: {} } })).status, 400);
  });

  test('填报校验：weekStart 非周一 → 400；指标 key 不在行业模板 → 400', async () => {
    const token = await login(uniquePhone(), '周报校验用户');
    const user = (await prisma.user.findUnique({ where: { id: token } }))!;
    await prisma.profile.create({ data: { tenantId: user.tenantId, industry: '餐饮' } });
    await prisma.industryBenchmark.create({ data: { industry: '餐饮', metricKey: 'table_turnover', metricName: '翻台率', unit: '次', p50: 3 } });

    // 2026-07-07 是周二 → 非周一拒绝（即便格式合法）
    assert.equal((await api('PUT', '/api/biz-metrics/2026-07-07', { token, body: { metrics: { table_turnover: 4 } } })).status, 400);
    // 周一 + 表外 key（repurchase_rate 不在餐饮模板）→ 拒绝
    assert.equal((await api('PUT', '/api/biz-metrics/2026-07-06', { token, body: { metrics: { repurchase_rate: 30 } } })).status, 400);
    // 周一 + 表内 key → 通过
    assert.equal((await api('PUT', '/api/biz-metrics/2026-07-06', { token, body: { metrics: { table_turnover: 4 } } })).status, 200);
  });
});
