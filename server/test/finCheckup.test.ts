// WO-09 经营体检 · 端到端接线测试（决策 A）：
//   ① 服务层 runFinCheckup：CSV → analysisJson 落库 + 5 段报告成版；重复 analyze 内容不变 → 版本去重；
//   ② 路由层 /knowledge/:id/analyze：canAnalyze 判定、门禁（未购 SKU 402）、成功产出、每日限流、非财务 422；
//   ③ 数字铁律：报告数字来自 analysisJson 的派生指标（纯代码算，mock 下确定性）。
// 全程 mock 模型（structured() 无 live provider → attempts=0 → 行动建议走纯代码兜底，不实扣）。
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, login, uniquePhone } from './helpers.ts';
import { prisma } from '../src/db.ts';
import { runFinCheckup } from '../src/services/finCheckup.ts';

const CSV = readFileSync(new URL('./fixtures/financials-sample.csv', import.meta.url), 'utf8');
const NON_FIN = '这是一份普通的会议纪要，讨论了下周的团建安排和文案风格，没有任何财务数字。';

before(async () => {
  await getApp();
  await cleanBusiness();
  await seedBaseline();
});
after(async () => {
  await closeApp();
});

async function tenantOf(userId: string): Promise<string> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { tenantId: true } });
  return u!.tenantId;
}

async function mkItem(userId: string, text: string, status = 'ready'): Promise<string> {
  const tenantId = await tenantOf(userId);
  const item = await prisma.knowledgeItem.create({
    data: { tenantId, userId, kind: 'document', title: '经营数据', text, sourceType: 'upload', status },
  });
  return item.id;
}

async function grantFinCheckup(userId: string): Promise<void> {
  const tenantId = await tenantOf(userId);
  await prisma.userModule.upsert({
    where: { userId_moduleKey: { userId, moduleKey: 'fin-checkup' } },
    update: { enabled: true, source: 'purchase' },
    create: { tenantId, userId, moduleKey: 'fin-checkup', enabled: true, source: 'purchase' },
  });
}

describe('WO-09 经营体检 · 服务层', () => {
  test('runFinCheckup：CSV → analysisJson 落库 + 5 段报告；数字来自派生指标', async () => {
    const token = await login(uniquePhone(), '体检服务客');
    const tenantId = await tenantOf(token);
    const itemId = await mkItem(token, CSV);

    const r = await runFinCheckup({ tenantId, userId: token, itemId, title: '经营体检 · 单测', text: CSV, industry: '餐饮' });
    assert.equal(r.version, 1);
    assert.equal(r.ok, false, 'mock 无 live provider → 行动建议走纯代码');
    assert.equal(r.attempts, 0);

    // analysisJson 落库：派生指标全部由输入算出（数字铁律）。
    const item = await prisma.knowledgeItem.findUnique({ where: { id: itemId }, select: { analysisJson: true } });
    const aj = item!.analysisJson as { financials: { periods: string[]; revenue: number[] }; metrics: { grossMargin: (number | null)[]; expenseRatio: (number | null)[]; cashNet: number[] } };
    assert.deepEqual(aj.financials.periods, ['1月', '2月', '3月']);
    assert.deepEqual(aj.financials.revenue, [100, 120, 150]);
    assert.deepEqual(aj.metrics.grossMargin, [40, 45, 40]);
    assert.deepEqual(aj.metrics.expenseRatio, [30, 35, 24.7]);
    assert.deepEqual(aj.metrics.cashNet, [10, -5, 8]);

    // 报告 5 段齐全。
    const ver = await prisma.reportVersion.findFirst({ where: { reportId: r.reportId, version: 1 } });
    const content = ver!.contentJson as { sections: { h: string }[] };
    assert.deepEqual(content.sections.map((s) => s.h), ['收入结构', '成本与毛利', '费用异动', '现金流信号', '三个最该动手的地方']);
  });

  test('重复 analyze 同一份数据 → 内容哈希去重，不重复成版', async () => {
    const token = await login(uniquePhone(), '体检去重客');
    const tenantId = await tenantOf(token);
    const itemId = await mkItem(token, CSV);
    const a = await runFinCheckup({ tenantId, userId: token, itemId, title: '经营体检 · 去重', text: CSV, industry: '餐饮' });
    const b = await runFinCheckup({ tenantId, userId: token, itemId, title: '经营体检 · 去重', text: CSV, industry: '餐饮' });
    assert.equal(a.version, 1);
    assert.equal(b.version, 1, '内容不变 → 版本不递增');
    const count = await prisma.reportVersion.count({ where: { reportId: a.reportId } });
    assert.equal(count, 1);
  });
});

describe('WO-09 经营体检 · 路由层', () => {
  test('canAnalyze：财务表 ready → true；普通文本 → false', async () => {
    const token = await login(uniquePhone(), '判定客');
    const finId = await mkItem(token, CSV);
    const noteId = await mkItem(token, NON_FIN);
    const fin = await api('GET', `/api/knowledge/${finId}`, { token });
    const note = await api('GET', `/api/knowledge/${noteId}`, { token });
    assert.equal(fin.body.canAnalyze, true);
    assert.equal(note.body.canAnalyze, false);
  });

  test('未购 fin-checkup → 402 SKU_REQUIRED；购买后 → 200 出报告', async () => {
    const token = await login(uniquePhone(), '门禁客');
    const itemId = await mkItem(token, CSV);

    const denied = await api('POST', `/api/knowledge/${itemId}/analyze`, { token, body: {} });
    assert.equal(denied.status, 402, JSON.stringify(denied.body));
    assert.equal(denied.body.code, 'SKU_REQUIRED');
    assert.equal(denied.body.skuKey, 'fin-checkup');

    await grantFinCheckup(token);
    const ok = await api('POST', `/api/knowledge/${itemId}/analyze`, { token, body: {} });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.ok(ok.body.reportId);
    assert.equal(ok.body.version, 1);
  });

  test('非财务资料 analyze → 422 NOT_ANALYZABLE', async () => {
    const token = await login(uniquePhone(), '非财务客');
    await grantFinCheckup(token);
    const itemId = await mkItem(token, NON_FIN);
    const r = await api('POST', `/api/knowledge/${itemId}/analyze`, { token, body: {} });
    assert.equal(r.status, 422);
    assert.equal(r.body.code, 'NOT_ANALYZABLE');
  });

  test('每日限流 3 次：第 4 次 429', async () => {
    const token = await login(uniquePhone(), '限流客');
    await grantFinCheckup(token);
    const itemId = await mkItem(token, CSV);
    for (let i = 0; i < 3; i++) {
      const r = await api('POST', `/api/knowledge/${itemId}/analyze`, { token, body: {} });
      assert.equal(r.status, 200, `第 ${i + 1} 次应放行`);
    }
    const over = await api('POST', `/api/knowledge/${itemId}/analyze`, { token, body: {} });
    assert.equal(over.status, 429);
    assert.equal(over.body.code, 'RATE_LIMITED');
  });
});
