// 幂等同步套餐目录（按 name upsert）：把 seedConfig.PLANS 写入现有库，不动用户/订单/钱包。
// 用途：往已有数据的环境（本地 dev / 生产）安全「预设/更新」套餐，不必跑破坏性 db:reset。
//   npm run db:sync-plans
//   npx tsx scripts/syncPlans.ts --dry-run   # 只打印将要发生的变更，不写库
// 既存同名套餐 → 原地更新（保留 id，user.planId 引用不失效）；不存在 → 新建。
// 代码里已移除的套餐（2026-07-28 去免费档：体验版）：仅当**没有任何用户引用**时删除，
// 有引用则保留并告警——外键安全交给引用计数，不靠人肉记忆。
import { PrismaClient } from '@prisma/client';
import { PLANS } from '../src/data/seedConfig.js';

const prisma = new PrismaClient();
const dryRun = process.argv.includes('--dry-run');

async function main() {
  console.log(`🔄 同步套餐目录（幂等，按 name upsert）${dryRun ? ' [dry-run，不写库]' : ''}…`);
  for (let i = 0; i < PLANS.length; i++) {
    const p = PLANS[i];
    const data = {
      price: p.price, period: p.period, creditsPerMonth: p.creditsPerMonth,
      tokenQuotaPerMonth: p.tokenQuotaPerMonth, agentCount: p.agentCount,
      featuresJson: p.features, highlighted: p.highlighted, hidden: p.hidden ?? false, sort: i,
    };
    const existing = await prisma.plan.findFirst({ where: { name: p.name } });
    if (existing) {
      const same = existing.price === data.price && existing.period === data.period
        && existing.creditsPerMonth === data.creditsPerMonth
        && existing.tokenQuotaPerMonth === data.tokenQuotaPerMonth
        && existing.agentCount === data.agentCount
        && existing.highlighted === data.highlighted && existing.hidden === data.hidden && existing.sort === data.sort
        && JSON.stringify(existing.featuresJson) === JSON.stringify(data.featuresJson);
      if (same) {
        console.log(`  = 不变 ${p.name}（id=${existing.id}）`);
      } else {
        if (!dryRun) await prisma.plan.update({ where: { id: existing.id }, data });
        console.log(`  ✓ 更新 ${p.name}（id=${existing.id}）`);
      }
    } else {
      if (dryRun) {
        console.log(`  + 新建 ${p.name}`);
      } else {
        const created = await prisma.plan.create({ data: { name: p.name, ...data } });
        console.log(`  + 新建 ${p.name}（id=${created.id}）`);
      }
    }
  }

  // 代码外孤儿套餐：无人引用才删，有引用保留告警（运营先迁移用户再手动删）。
  const codeNames = new Set(PLANS.map((p) => p.name));
  const orphans = (await prisma.plan.findMany()).filter((p) => !codeNames.has(p.name));
  for (const o of orphans) {
    const refs = await prisma.user.count({ where: { planId: o.id } });
    if (refs === 0) {
      if (!dryRun) await prisma.plan.delete({ where: { id: o.id } });
      console.log(`  - 删除已下架且无人引用的套餐 ${o.name}（id=${o.id}）`);
    } else {
      console.log(`  ⚠ 保留 ${o.name}：仍有 ${refs} 个用户引用，先迁移再删`);
    }
  }

  const all = await prisma.plan.findMany({ orderBy: { sort: 'asc' }, select: { name: true, price: true, period: true, highlighted: true } });
  console.log('📋 当前套餐目录：', all.map((x) => `${x.name}=${x.price < 0 ? '面议' : '¥' + x.price / 100}/${x.period}${x.highlighted ? '★' : ''}`).join('  |  '));
  console.log(dryRun ? '✅ dry-run 完成（未写库）' : '✅ 同步完成');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
