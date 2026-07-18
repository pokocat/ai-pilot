// WO-08 行业基准库占位种子：美业/大健康、餐饮、电商三行业 × 每行业 5-6 指标。
// 铁律「宁缺勿假」：p50 一律留空（null），note 写「待运营核实」——注入层遇 p50 空即不引用（services/benchmark.ts），
// 所以这批种子只建「指标骨架 + 展示名 + 单位」，让运营在后台按真实数据回填分位数后才对客户生效。
// 幂等：按 (industry,revenueBand,metricKey) upsert，重复执行不产生重复行、也不覆盖运营已回填的真数
//（本脚本只在「行不存在」时创建；已存在的行保持不动，避免把运营核实过的 p50 冲回空）。
//
// 运行：cd server && tsx prisma/seedBenchmarks.ts
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const TODO_NOTE = '待运营核实';

// 每行占位：p25/p50/p75 全空，注入层因 p50 空而不引用，直到运营回填真数。
type Row = { metricKey: string; metricName: string; unit: string };

const SEED: { industry: string; metrics: Row[] }[] = [
  {
    industry: '美业/大健康',
    metrics: [
      { metricKey: 'repurchase_rate', metricName: '复购率', unit: '%' },
      { metricKey: 'cac', metricName: '获客成本', unit: '元' },
      { metricKey: 'avg_order_value', metricName: '客单价', unit: '元' },
      { metricKey: 'member_rate', metricName: '会员转化率', unit: '%' },
      { metricKey: 'consult_deal_rate', metricName: '到店成交率', unit: '%' },
      { metricKey: 'refund_rate', metricName: '退卡率', unit: '%' },
    ],
  },
  {
    industry: '餐饮',
    metrics: [
      { metricKey: 'table_turnover', metricName: '翻台率', unit: '次' },
      { metricKey: 'avg_order_value', metricName: '客单价', unit: '元' },
      { metricKey: 'gross_margin', metricName: '毛利率', unit: '%' },
      { metricKey: 'repurchase_rate', metricName: '复购率', unit: '%' },
      { metricKey: 'takeout_ratio', metricName: '外卖占比', unit: '%' },
    ],
  },
  {
    industry: '电商',
    metrics: [
      { metricKey: 'conversion_rate', metricName: '转化率', unit: '%' },
      { metricKey: 'roi', metricName: '投产比(ROI)', unit: '倍' },
      { metricKey: 'avg_order_value', metricName: '客单价', unit: '元' },
      { metricKey: 'repurchase_rate', metricName: '复购率', unit: '%' },
      { metricKey: 'refund_rate', metricName: '退货率', unit: '%' },
      { metricKey: 'cac', metricName: '获客成本', unit: '元' },
    ],
  },
];

async function main() {
  console.log('🌱 seeding 行业基准占位（p50 留空，宁缺勿假）…');
  let created = 0, kept = 0;
  for (const { industry, metrics } of SEED) {
    for (const m of metrics) {
      const existing = await prisma.industryBenchmark.findUnique({
        where: { industry_revenueBand_metricKey: { industry, revenueBand: '*', metricKey: m.metricKey } },
      });
      if (existing) { kept++; continue; } // 已存在（可能运营已回填真数）→ 不动
      await prisma.industryBenchmark.create({
        data: {
          industry, revenueBand: '*', metricKey: m.metricKey, metricName: m.metricName, unit: m.unit,
          p25: null, p50: null, p75: null, // 分位空 → 注入层不引用
          note: TODO_NOTE, source: null, enabled: true,
        },
      });
      created++;
    }
  }
  console.log(`  ✓ 基准占位：新增 ${created} 行，保留既有 ${kept} 行（p50 空的行不会注入，需运营回填）`);
  console.log('✅ seedBenchmarks done');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
