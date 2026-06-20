// 一次性回填：给每个还没有已发布版本的 agent 冻结一个 v1（status=published）并把指针指向它。
// 幂等：已发布且草稿未变的 agent 自动跳过（publishDraft 内置去重）。
//
// 运行（本地）：  DATABASE_URL=... tsx scripts/backfillAgentVersions.ts
// 生产：按 prod-deploy-method —— scp 本文件到服务器、用服务器上的 node/tsx 跑一次，不走 git migration。
//
// 背景：版本化上线前，所有 agent 的 publishedVersionId 都是 null，运行时会优雅回退草稿；
// 回填后 C 端改读 v1 快照，行为完全一致（v1 = 当时草稿的精确快照），只是从此可发布/回滚。

import { prisma } from '../src/db.js';
import { publishDraft } from '../src/services/agentVersions.js';

async function main() {
  const agents = await prisma.agent.findMany({
    orderBy: { sort: 'asc' },
    select: { key: true, name: true, publishedVersionId: true },
  });
  if (!agents.length) {
    console.log('没有 agent，无需回填。');
    return;
  }

  let created = 0;
  let skipped = 0;
  console.log(`开始回填 ${agents.length} 个 agent 的初始版本 …`);
  for (const a of agents) {
    const firstTime = !a.publishedVersionId;
    const r = await publishDraft(a.key, { label: firstTime ? 'v1 · 初始版本（回填）' : undefined });
    if (r.changed) {
      created++;
      console.log(`  ✓ ${a.key}（${a.name}）→ 冻结为 v${r.version}`);
    } else {
      skipped++;
      console.log(`  - ${a.key}（${a.name}）已是最新版本 v${r.version}，跳过`);
    }
  }
  console.log(`\n回填完成：新建 ${created} 个版本，跳过 ${skipped} 个。`);
}

main()
  .then(async () => { await prisma.$disconnect(); process.exit(0); })
  .catch(async (e) => { console.error('回填失败：', e); await prisma.$disconnect(); process.exit(1); });
