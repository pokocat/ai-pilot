// D-8 军师收编 4+1：把「非保留」的冗余顾问科室下架（enabled=false），保留 general + strat/growth/ops/brand。
// 幂等：只把 enabled=true 的目标行翻成 false，可安全重复执行（重跑为 no-op）。禁止重跑 seed。
//
// 关键判断（处方白名单口径）：创作型 agent（type='creative'：ip/promo/poster/shortvideo/copy）**不下架**——
//   它们是处方 toolKey 白名单的供给方（services/prescription.ts:toolWhitelist = enabled agents），
//   且是 market 货架商品（/agents/:key/purchase 对 enabled=false 直接 404）。下架创作型会同时
//   ①清空处方可开工具白名单 ②使这些工具无法售卖。故本脚本只下架「非保留 且 非创作型」的顾问科室：
//   intel（竞争情报）/ fund（融资参谋）/ model（商业模式）/ org（组织人效）。
//
// 运行（本地）：DATABASE_URL=... npx tsx scripts/retireAgents.ts
// 生产：按 prod-deploy-method —— scp 本文件到服务器、用服务器 node/tsx 跑一次，不走 git migration、不重跑 seed。

import { prisma } from '../src/db.js';

// 保留科室（4 顾问 + 1 总军师）。
const KEEP = ['general', 'strat', 'growth', 'ops', 'brand'];

async function main() {
  const before = await prisma.agent.findMany({ select: { key: true, type: true, enabled: true }, orderBy: { sort: 'asc' } });
  const targets = before.filter((a) => !KEEP.includes(a.key) && a.type !== 'creative' && a.enabled);
  if (!targets.length) {
    console.log('无需下架：非保留顾问科室均已 enabled=false（幂等 no-op）。');
  } else {
    const res = await prisma.agent.updateMany({
      where: { key: { notIn: KEEP }, type: { not: 'creative' }, enabled: true },
      data: { enabled: false },
    });
    console.log(`已下架 ${res.count} 个冗余顾问科室：${targets.map((t) => t.key).join(', ')}`);
  }

  const after = await prisma.agent.findMany({ select: { key: true, type: true, enabled: true }, orderBy: { sort: 'asc' } });
  const enabled = after.filter((a) => a.enabled).map((a) => a.key);
  const disabled = after.filter((a) => !a.enabled).map((a) => a.key);
  console.log(`当前 enabled：${enabled.join(', ')}`);
  console.log(`当前 disabled：${disabled.join(', ') || '（无）'}`);
  console.log('提示：创作型 agent 保持 enabled（处方白名单 + market 货架供给方），已购用户对下架 agent 的访问由 assertAgentAccess 豁免（owned 忽略 enabled）。');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
