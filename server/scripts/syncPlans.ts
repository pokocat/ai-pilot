// 幂等同步套餐目录（按 name upsert）：把 seedConfig.PLANS 写入现有库，不动用户/订单/钱包。
// 用途：往已有数据的环境（本地 dev / 生产）安全「预设/更新」套餐，不必跑破坏性 db:reset。
//   npm run db:sync-plans
// 既存同名套餐 → 原地更新（保留 id，user.planId 引用不失效）；不存在 → 新建。多余的旧套餐保留（手动清理）。
import { PrismaClient } from '@prisma/client';
import { PLANS } from '../src/data/seedConfig.js';

const prisma = new PrismaClient();

async function main() {
  console.log('🔄 同步套餐目录（幂等，按 name upsert）…');
  for (let i = 0; i < PLANS.length; i++) {
    const p = PLANS[i];
    const data = {
      price: p.price, period: p.period, creditsPerMonth: p.creditsPerMonth,
      tokenQuotaPerMonth: p.tokenQuotaPerMonth, agentCount: p.agentCount,
      featuresJson: p.features, highlighted: p.highlighted, sort: i,
    };
    const existing = await prisma.plan.findFirst({ where: { name: p.name } });
    if (existing) {
      await prisma.plan.update({ where: { id: existing.id }, data });
      console.log(`  ✓ 更新 ${p.name}（id=${existing.id}）`);
    } else {
      const created = await prisma.plan.create({ data: { name: p.name, ...data } });
      console.log(`  + 新建 ${p.name}（id=${created.id}）`);
    }
  }
  const all = await prisma.plan.findMany({ orderBy: { sort: 'asc' }, select: { name: true, price: true, period: true, highlighted: true } });
  console.log('📋 当前套餐目录：', all.map((x) => `${x.name}=${x.price < 0 ? '面议' : '¥' + x.price / 100}/${x.period}${x.highlighted ? '★' : ''}`).join('  |  '));
  console.log('✅ 同步完成');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
