// 测试期一次性批量开通高级套餐：
//   npm run db:grant-test-plan -- --plan=决策版          -> 试运行
//   npm run db:grant-test-plan -- --plan=决策版 --apply -> 实际发放
// 只升级无套餐、低档套餐或已过期套餐；同档有效套餐与企业私有化套餐不会被降级或重复发放。
import { PrismaClient } from '@prisma/client';
import { applyPlanPurchase } from '../src/services/purchase.js';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');
const planArg = process.argv.find((arg) => arg.startsWith('--plan='));
const PLAN_NAME = planArg?.slice('--plan='.length).trim()
  || (process.env.TEST_DEFAULT_PLAN_NAME ?? '').trim();

async function main() {
  if (!PLAN_NAME) {
    throw new Error('缺少目标套餐：请传 --plan=套餐名，或配置 TEST_DEFAULT_PLAN_NAME');
  }
  const plan = await prisma.plan.findFirst({ where: { name: PLAN_NAME } });
  if (!plan) throw new Error(`未找到套餐「${PLAN_NAME}」，请先运行 npm run db:sync-plans`);

  const users = await prisma.user.findMany({
    select: {
      id: true,
      tenantId: true,
      phone: true,
      planExpiresAt: true,
      plan: { select: { id: true, name: true, price: true, agentCount: true } },
    },
    orderBy: { createdAt: 'asc' },
  });
  const at = Date.now();
  const higher = users.filter((user) => (user.plan?.price ?? 0) < 0 || (user.plan?.agentCount ?? 0) > plan.agentCount);
  const activeSameTier = users.filter((user) => {
    if (!user.plan || higher.includes(user)) return false;
    const active = !user.planExpiresAt || user.planExpiresAt.getTime() > at;
    return active && user.plan.agentCount >= plan.agentCount;
  });
  const targets = users.filter((user) => !higher.includes(user) && !activeSameTier.includes(user));

  console.log(`${APPLY ? 'APPLY' : 'DRY-RUN'} 测试期批量开通「${plan.name}」`);
  console.log(`  用户总数 ${users.length}；待升级 ${targets.length}；已是同档 ${activeSameTier.length}；更高套餐保留 ${higher.length}`);
  for (const user of targets.slice(0, 20)) {
    console.log(`  - ${user.id} ${user.phone}: ${user.plan?.name ?? '无套餐'} -> ${plan.name}`);
  }
  if (targets.length > 20) console.log(`  ...以及另外 ${targets.length - 20} 个`);
  if (!APPLY) {
    console.log('这是试运行，未写库。确认后加 --apply 执行。');
    return;
  }

  let applied = 0;
  for (const user of targets) {
    await applyPlanPurchase(user, plan, {
      reason: `${plan.name} · 测试期批量开通`,
      source: 'test_bulk_grant',
    });
    applied += 1;
  }
  console.log(`已为 ${applied} 个用户开通「${plan.name}」，更高套餐未变更。`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
