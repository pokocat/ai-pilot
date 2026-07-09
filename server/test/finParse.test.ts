// WO-09 经营体检·财务解析（纯逻辑，无 DB / 无网络）：schema 容错 + 派生指标 + 5 段成果。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { coerceJson } from '../src/llm/gateway.ts';
import { FinancialsSchema, deriveMetrics, finReportSections } from '../src/services/finParse.ts';

const FIN = { periods: ['1月', '2月'], revenue: [100, 120], cogs: [60, 66], expenses: [{ name: '营销', values: [20, 30] }], cash: [10, -5] };

describe('WO-09 财务解析（纯逻辑）', () => {
  test('deriveMetrics：毛利率/费用率/现金净流由输入算出', () => {
    const m = deriveMetrics(FinancialsSchema.parse(FIN));
    assert.deepEqual(m.grossMargin, [40, 45]); // (100-60)/100=40%，(120-66)/120=45%
    assert.deepEqual(m.expenseRatio, [20, 25]); // 20/100=20%，30/120=25%
    assert.deepEqual(m.cashNet, [10, -5]);
  });

  test('finReportSections：5 段固定骨架 + 现金为负告警 + 三条行动', () => {
    const f = FinancialsSchema.parse(FIN);
    const secs = finReportSections(f, deriveMetrics(f));
    assert.deepEqual(secs.map((s) => s.h), ['收入结构', '成本与毛利', '费用异动', '现金流信号', '三个最该动手的地方']);
    assert.match(secs[3].b ?? '', /现金为负/);
    assert.equal(secs[4].list?.length, 3);
  });

  test('coerceJson × FinancialsSchema：缺失字段容错为空数组（不崩）', () => {
    const r = coerceJson(FinancialsSchema, JSON.stringify({ periods: ['1月'], revenue: [100] }));
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.deepEqual(r.data.cogs, []);
      assert.deepEqual(r.data.expenses, []);
      assert.deepEqual(r.data.cash, []);
    }
  });
});
