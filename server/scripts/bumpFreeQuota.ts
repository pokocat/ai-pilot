// 一次性：把「体验版」老用户的 token 钱包刷到该套餐的最新月度额度（seedConfig 为准）。
// 背景：钱包 quota 是首建/购买时的快照，跨月重置也复用快照、不回读 live plan（见 tokenQuota.ts），
//   所以后台调大套餐额度「只影响新用户」，已有用户须本脚本手动刷新。
//   npm run db:bump-free-quota            → 试运行（DRY，只统计不写库）
//   npm run db:bump-free-quota -- --apply → 实际写库
// 只动「体验版」在册用户的既有钱包：quota=balance=套餐新额度（当前 10,000,000）；无钱包的用户不建
//   （其首次用额度时 loadWallet 会自动按新套餐建号，无需预建）。付费套餐用户不受影响。
import { PrismaClient } from '@prisma/client';
import { PLANS } from '../src/data/seedConfig.js';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');
const FREE_PLAN_NAME = PLANS[0].name; // 体验版（sort=0，注册默认套餐）
const TARGET = PLANS[0].tokenQuotaPerMonth; // 目标额度（10,000,000）

async function main() {
  console.log(`${APPLY ? '🚀 APPLY' : '🔍 DRY-RUN'} 刷新「${FREE_PLAN_NAME}」用户钱包 → quota=balance=${TARGET.toLocaleString()}`);

  const plan = await prisma.plan.findFirst({ where: { name: FREE_PLAN_NAME } });
  if (!plan) { console.error(`✗ 未找到套餐「${FREE_PLAN_NAME}」，请先跑 npm run db:sync-plans`); process.exit(1); }

  // 命中范围：套餐=体验版 且 已有钱包 的用户（无钱包者留给惰性首建，自动拿新额度）。
  const wallets = await prisma.tokenWallet.findMany({
    where: { user: { planId: plan.id } },
    select: { userId: true, quota: true, balance: true },
  });
  const stale = wallets.filter((w) => w.quota !== TARGET || w.balance !== TARGET);
  console.log(`  体验版在册钱包 ${wallets.length} 个，其中需刷新 ${stale.length} 个（其余已是目标值）`);

  if (!APPLY) {
    for (const w of stale.slice(0, 10)) console.log(`    - ${w.userId}: quota ${w.quota} / balance ${w.balance} → ${TARGET} / ${TARGET}`);
    if (stale.length > 10) console.log(`    …以及另外 ${stale.length - 10} 个`);
    console.log('ℹ️  这是试运行，未写库。确认无误后加 --apply 执行。');
    return;
  }

  const res = await prisma.tokenWallet.updateMany({
    where: { user: { planId: plan.id } },
    data: { quota: TARGET, balance: TARGET },
  });
  console.log(`✅ 已刷新 ${res.count} 个钱包 → ${TARGET.toLocaleString()}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
