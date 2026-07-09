import { PrismaClient } from '@prisma/client';
import { AGENTS } from '../src/data/agents.js';
import { SAYINGS, SURVEY, SKUS } from '../src/data/seedConfig.js';

const prisma = new PrismaClient();

async function syncAgents() {
  let updated = 0;
  let created = 0;

  for (const a of AGENTS) {
    const existed = await prisma.agent.findUnique({ where: { key: a.key }, select: { key: true } });
    await prisma.agent.upsert({
      where: { key: a.key },
      update: {
        name: a.name,
        role: a.role,
        icon: a.icon,
        type: a.type,
        gift: a.gift,
        billing: a.billing,
        price: a.price,
        ...(a.billingRatio !== undefined && { billingRatio: a.billingRatio }),
        ...(a.meterUnit !== undefined && { meterUnit: a.meterUnit }),
        greet: a.greet,
        chipsJson: a.chips as object,
        memText: a.memText,
        learnText: a.learnText,
        systemPrompt: a.systemPrompt,
        deliverableKey: a.deliverableKey,
        memoryConfig: a.memoryConfig as object,
        sort: a.sort,
      },
      create: {
        key: a.key,
        name: a.name,
        role: a.role,
        icon: a.icon,
        type: a.type,
        gift: a.gift,
        billing: a.billing,
        price: a.price,
        ...(a.billingRatio !== undefined && { billingRatio: a.billingRatio }),
        ...(a.meterUnit !== undefined && { meterUnit: a.meterUnit }),
        enabled: a.enabled,
        greet: a.greet,
        chipsJson: a.chips as object,
        memText: a.memText,
        learnText: a.learnText,
        systemPrompt: a.systemPrompt,
        deliverableKey: a.deliverableKey,
        memoryConfig: a.memoryConfig as object,
        sort: a.sort,
      },
    });
    existed ? updated++ : created++;
  }

  return { updated, created };
}

async function syncSayings() {
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
    await prisma.saying.create({ data: { text: s.text, enabled: s.enabled, sort } });
    sort++;
    created++;
  }

  return { created, skipped };
}

// 建档问卷：按 key 非破坏 upsert（更新 title/options/sort，保留运营的 enabled 启停）。
// 行业题的 options 由 industryOptionLabels() 从行业包派生 → 新增行业包后跑本同步即可下发新选项，不丢数据。
async function syncSurvey() {
  let updated = 0;
  let created = 0;

  for (let i = 0; i < SURVEY.length; i++) {
    const q = SURVEY[i];
    const existed = await prisma.surveyQuestion.findUnique({ where: { key: q.key }, select: { key: true } });
    await prisma.surveyQuestion.upsert({
      where: { key: q.key },
      update: { title: q.title, optionsJson: q.options, sort: i }, // 不动 enabled，保留运营启停
      create: { key: q.key, title: q.title, optionsJson: q.options, sort: i },
    });
    existed ? updated++ : created++;
  }

  return { updated, created };
}

// V7-12：单次付费商品目录。按 key upsert（更新展示/定价，保留运营的 enabled 启停）。
async function syncSkus() {
  let updated = 0;
  let created = 0;
  for (let i = 0; i < SKUS.length; i++) {
    const s = SKUS[i];
    const existed = await prisma.sku.findUnique({ where: { key: s.key }, select: { key: true } });
    await prisma.sku.upsert({
      where: { key: s.key },
      update: { name: s.name, desc: s.desc, priceFen: s.priceFen, kind: s.kind, grantsModuleKey: s.grantsModuleKey ?? null, metaJson: s.metaBytes ? { bytes: s.metaBytes } : undefined, sort: i }, // 不动 enabled
      create: { key: s.key, name: s.name, desc: s.desc, priceFen: s.priceFen, kind: s.kind, grantsModuleKey: s.grantsModuleKey ?? null, metaJson: s.metaBytes ? { bytes: s.metaBytes } : undefined, sort: i },
    });
    existed ? updated++ : created++;
  }
  return { updated, created };
}

async function main() {
  const agents = await syncAgents();
  const sayings = await syncSayings();
  const survey = await syncSurvey();
  const skus = await syncSkus();
  console.log(JSON.stringify({ ok: true, agents, sayings, survey, skus }, null, 2));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
