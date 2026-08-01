// 把仓库里的内置内容（智能体、格言、建档问卷、SKU 目录）同步进数据库。
//
//   npm run admin:sync-content                 # 安全模式：不覆盖运营调教过的字段
//   npm run admin:sync-content -- --dry-run    # 只打印将要发生的变更，不写库
//   npm run admin:sync-content -- --dump-prompts <目录>   # 把库里的现行提示词导出到文件（回灌仓库用）
//   npm run admin:sync-content -- --force-prompts         # 确实要用仓库文件覆盖提示词（危险，带护栏）
//   npm run admin:sync-content -- --force-pricing         # 确实要用仓库常量覆盖线上定价（危险，默认不覆盖）
//
// 注：**套餐（Plan）不在本脚本范围内**，也没有任何「同步套餐到线上」的脚本了。
// 线上套餐的价格/额度/权益/上下架全部由运营后台维护（`/admin/plans`），见 src/data/seedConfig.ts 顶部。
//
// ── 为什么默认不覆盖提示词 ──
// 2026-07-27 登生产核对：`general` 的 systemPrompt 线上是 49,094 字符，仓库文件只有 17,230，
// 已漂 2.85 倍（v1 41,710 → v2 45,342 → v3 44,957 → v4 49,094，三周 +18%）；其余 agent
// 线上 1,650–1,764，本地 620–670。提示词是在运营后台逐版调教出来的资产，仓库文件是旧快照。
//
// 原实现的 update 分支无条件写 `systemPrompt: a.systemPrompt`，无 diff、无确认。运行时读的是
// AgentVersion 已发布快照，所以同步不会立刻生效——但草稿被换成旧版后，**之后任何一次「发布」
// 就把三个版本的调教推平，且不可恢复**。
//
// 因此改为：`systemPrompt` / `greet` 视为「运营所有」，create 时写入（新 agent 需要初值），
// update 时默认跳过。这与本文件里 survey/sku 已有的「不动 enabled，保留运营启停」是同一约定。
import { PrismaClient } from '@prisma/client';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AGENTS } from '../src/data/agents.js';
import { SAYINGS, SURVEY, SKUS } from '../src/data/seedConfig.js';

const prisma = new PrismaClient();

/** 运营在后台调教过的字段：create 写初值，update 默认不碰。 */
export const OPERATOR_OWNED = ['systemPrompt', 'greet'] as const;
export type OperatorOwnedField = (typeof OPERATOR_OWNED)[number];

/**
 * 计价字段（2026-08-01 加）：与提示词同一约定——**create 写初值，update 默认不碰**，
 * 确需用仓库值覆盖线上定价时显式加 `--force-pricing`。
 *
 * 为什么：这些字段全在运营后台的 PATCH 白名单里（`AdminAgentUpdate` / `PATCH /admin/skus/:key`），
 * 运营改完价，下一次 `admin:sync-content` 原本会无声打回仓库常量——和已删除的 `syncPlans.ts`
 * 把入门版 ¥99 打回 ¥68 是同一个缺陷。钱的字段以线上为准，仓库常量只是新建时的初值。
 */
export const AGENT_PRICING_FIELDS = ['gift', 'billing', 'price', 'billingRatio', 'meterUnit'] as const;
/** SKU 侧同理：这四个都能在后台改（kind/grantsModuleKey/metaJson 仍是仓库真相源，后台改不了）。 */
export const SKU_PRICING_FIELDS = ['name', 'desc', 'priceFen', 'sort'] as const;

/** 仓库版本比线上短这么多就判为「仓库是旧快照」，拒绝覆盖。 */
export const SHRINK_REFUSE_RATIO = 0.8;

export interface PromptDecision {
  field: OperatorOwnedField;
  action: 'skip' | 'write' | 'refuse';
  dbLen: number;
  repoLen: number;
  reason: string;
}

/**
 * 决定某个「运营所有」字段这次要不要写。纯函数，便于回归。
 *
 * - 库里没有值（新建或历史空值）→ 写，这不是覆盖
 * - 未开 force → 跳过
 * - 开了 force 但仓库明显更短 → 拒绝（这正是漂移的特征，多半是误操作）
 * - 开了 force 且长度合理 → 写
 */
export function decidePromptWrite(
  field: OperatorOwnedField,
  dbValue: string | null | undefined,
  repoValue: string | null | undefined,
  opts: { forcePrompts?: boolean; allowShrink?: boolean } = {},
): PromptDecision {
  const dbLen = (dbValue ?? '').length;
  const repoLen = (repoValue ?? '').length;
  const base = { field, dbLen, repoLen };

  if (!repoLen) return { ...base, action: 'skip', reason: '仓库侧为空，不写' };
  if (!dbLen) return { ...base, action: 'write', reason: '库里为空，写入初值（非覆盖）' };
  if (dbValue === repoValue) return { ...base, action: 'skip', reason: '内容一致，无需写' };

  if (!opts.forcePrompts) {
    return { ...base, action: 'skip', reason: `运营所有字段，默认不覆盖（库 ${dbLen} 字符 / 仓库 ${repoLen} 字符）。确需覆盖加 --force-prompts` };
  }
  if (!opts.allowShrink && repoLen < dbLen * SHRINK_REFUSE_RATIO) {
    return {
      ...base,
      action: 'refuse',
      reason: `拒绝：仓库版本比线上短 ${Math.round((1 - repoLen / dbLen) * 100)}%（${repoLen} vs ${dbLen}），`
        + '这是「仓库是旧快照」的典型特征。先把线上版本回灌进仓库（--dump-prompts），确认后再加 --allow-shrink',
    };
  }
  return { ...base, action: 'write', reason: `覆盖（库 ${dbLen} → 仓库 ${repoLen} 字符）` };
}

interface SyncOpts { dryRun?: boolean; forcePrompts?: boolean; allowShrink?: boolean; forcePricing?: boolean }

async function syncAgents(opts: SyncOpts) {
  let updated = 0;
  let created = 0;
  const decisions: (PromptDecision & { agent: string })[] = [];
  let refused = 0;

  for (const a of AGENTS) {
    const existed = await prisma.agent.findUnique({
      where: { key: a.key },
      select: { key: true, systemPrompt: true, greet: true },
    });

    // 结构性字段：仓库是真相源，照常同步。
    const structural = {
      name: a.name,
      role: a.role,
      icon: a.icon,
      type: a.type,
      chipsJson: a.chips as object,
      memText: a.memText,
      learnText: a.learnText,
      deliverableKey: a.deliverableKey,
      memoryConfig: a.memoryConfig as object,
      sort: a.sort,
    };
    // 计价字段：新建写初值；已存在的默认不碰（运营所有），--force-pricing 才回写。
    const pricing = {
      gift: a.gift,
      billing: a.billing,
      price: a.price,
      ...(a.billingRatio !== undefined && { billingRatio: a.billingRatio }),
      ...(a.meterUnit !== undefined && { meterUnit: a.meterUnit }),
    };

    if (!existed) {
      // 新建：运营所有字段也要写初值，否则新 agent 没有提示词/没有计价。
      if (!opts.dryRun) {
        await prisma.agent.create({
          data: { key: a.key, enabled: a.enabled, systemPrompt: a.systemPrompt, greet: a.greet, ...structural, ...pricing },
        });
      }
      created++;
      continue;
    }

    const update: Record<string, unknown> = { ...structural, ...(opts.forcePricing ? pricing : {}) };
    for (const field of OPERATOR_OWNED) {
      const d = decidePromptWrite(field, existed[field], a[field], opts);
      decisions.push({ ...d, agent: a.key });
      if (d.action === 'write') update[field] = a[field];
      if (d.action === 'refuse') refused++;
    }

    if (!opts.dryRun) await prisma.agent.update({ where: { key: a.key }, data: update });
    updated++;
  }

  return { updated, created, decisions, refused };
}

async function syncSayings(opts: SyncOpts) {
  const max = await prisma.saying.aggregate({ _max: { sort: true } });
  let sort = (max._max.sort ?? -1) + 1;
  let created = 0;
  let skipped = 0;

  for (const s of SAYINGS) {
    const existed = await prisma.saying.findFirst({ where: { text: s.text }, select: { id: true } });
    if (existed) {
      skipped++;
      continue;
    }
    if (!opts.dryRun) await prisma.saying.create({ data: { text: s.text, enabled: s.enabled, sort } });
    sort++;
    created++;
  }

  return { created, skipped };
}

// 建档问卷：按 key 非破坏 upsert（更新 title/options/sort，保留运营的 enabled 启停）。
// 行业题的 options 由 industryOptionLabels() 从行业包派生 → 新增行业包后跑本同步即可下发新选项，不丢数据。
async function syncSurvey(opts: SyncOpts) {
  let updated = 0;
  let created = 0;

  for (let i = 0; i < SURVEY.length; i++) {
    const q = SURVEY[i];
    const existed = await prisma.surveyQuestion.findUnique({ where: { key: q.key }, select: { key: true } });
    if (!opts.dryRun) {
      await prisma.surveyQuestion.upsert({
        where: { key: q.key },
        update: { title: q.title, optionsJson: q.options, sort: i }, // 不动 enabled，保留运营启停
        create: { key: q.key, title: q.title, optionsJson: q.options, sort: i },
      });
    }
    existed ? updated++ : created++;
  }

  return { updated, created };
}

// V7-12：单次付费商品目录。按 key upsert，**但只有结构性字段是仓库真相源**。
//
// 2026-08-01 收口：`priceFen` / `name` / `desc` / `sort` 全都能在运营后台改（`PATCH /admin/skus/:key`），
// 原实现的 update 分支无条件回写这四个字段 → 运营调过价，下一次 `admin:sync-content` 就静默打回仓库值。
// 这与套餐那边被删掉的 syncPlans.ts 是同一个缺陷（运营把入门版改 ¥99，全量同步打回 ¥68）。
// 现在定价/文案/排序按 OPERATOR_OWNED 同一约定处理：**create 写初值，update 不碰**。
// 仓库仍拥有 `kind` / `grantsModuleKey` / `metaJson`——它们必须与 data/modules.ts 的 moduleKey 对齐，
// 运营后台也改不了（不在 PATCH 白名单里），发生漂移只会让支付后发不出权益。
async function syncSkus(opts: SyncOpts) {
  let updated = 0;
  let created = 0;
  for (let i = 0; i < SKUS.length; i++) {
    const s = SKUS[i];
    const existed = await prisma.sku.findUnique({ where: { key: s.key }, select: { key: true } });
    const structural = {
      kind: s.kind,
      grantsModuleKey: s.grantsModuleKey ?? null,
      metaJson: s.metaBytes ? { bytes: s.metaBytes } : undefined,
    };
    const pricing = { name: s.name, desc: s.desc, priceFen: s.priceFen, sort: i };
    if (!opts.dryRun) {
      await prisma.sku.upsert({
        where: { key: s.key },
        // update 不动 priceFen/name/desc/sort/enabled —— 运营所有；--force-pricing 才回写。
        update: { ...structural, ...(opts.forcePricing ? pricing : {}) },
        create: { key: s.key, ...pricing, ...structural },
      });
    }
    existed ? updated++ : created++;
  }
  return { updated, created };
}

/** 把库里的现行提示词导出到文件，供回灌仓库时人工比对。只读。 */
async function dumpPrompts(dir: string) {
  const rows = await prisma.agent.findMany({
    select: { key: true, systemPrompt: true, greet: true },
    orderBy: { key: 'asc' },
  });
  await mkdir(dir, { recursive: true });
  const index: Record<string, { systemPrompt: number; greet: number }> = {};
  for (const r of rows) {
    await writeFile(path.join(dir, `${r.key}.systemPrompt.md`), r.systemPrompt ?? '', 'utf8');
    await writeFile(path.join(dir, `${r.key}.greet.md`), r.greet ?? '', 'utf8');
    index[r.key] = { systemPrompt: (r.systemPrompt ?? '').length, greet: (r.greet ?? '').length };
  }
  await writeFile(path.join(dir, 'index.json'), JSON.stringify(index, null, 2), 'utf8');
  console.log(`已导出 ${rows.length} 个 agent 的提示词 → ${dir}`);
  console.table(index);
}

export async function main(argv: string[] = process.argv.slice(2)) {
  const has = (f: string) => argv.includes(f);
  const valueOf = (f: string) => {
    const i = argv.indexOf(f);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const dumpDir = valueOf('--dump-prompts');
  if (dumpDir) {
    await dumpPrompts(dumpDir);
    return;
  }

  const opts: SyncOpts = {
    dryRun: has('--dry-run'),
    forcePrompts: has('--force-prompts'),
    allowShrink: has('--allow-shrink'),
    forcePricing: has('--force-pricing'),
  };

  if (opts.dryRun) console.log('== DRY RUN：只打印，不写库 ==\n');

  const agents = await syncAgents(opts);
  const sayings = await syncSayings(opts);
  const survey = await syncSurvey(opts);
  const skus = await syncSkus(opts);

  // 提示词决策逐条打印——这是本脚本最危险的部分，必须可见。
  const notable = agents.decisions.filter((d) => d.reason !== '内容一致，无需写');
  if (notable.length) {
    console.log('\n== 提示词字段处置 ==');
    for (const d of notable) {
      const mark = d.action === 'write' ? '写入' : d.action === 'refuse' ? '拒绝' : '跳过';
      console.log(`  [${mark}] ${d.agent}.${d.field}  ${d.reason}`);
    }
  }
  if (agents.refused > 0) {
    console.error(`\n有 ${agents.refused} 个字段因护栏被拒绝写入，本次未同步它们。`);
    process.exitCode = 1;
  }
  if (!opts.forcePrompts) {
    console.log('\n提示：systemPrompt / greet 默认不覆盖（运营调教资产）。'
      + '要回灌线上版本到仓库，先跑 --dump-prompts <目录>。');
  }
  if (!opts.forcePricing) {
    console.log(`提示：计价字段默认不覆盖（运营所有）——agent ${AGENT_PRICING_FIELDS.join('/')}、`
      + `sku ${SKU_PRICING_FIELDS.join('/')}。确需用仓库常量改线上定价才加 --force-pricing。`);
  }

  console.log(`\n${JSON.stringify({
    ok: agents.refused === 0,
    dryRun: !!opts.dryRun,
    agents: { updated: agents.updated, created: agents.created, refused: agents.refused },
    sayings, survey, skus,
  }, null, 2)}`);
}

// 只在直接执行时跑，import 进测试时不触发。
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main()
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
