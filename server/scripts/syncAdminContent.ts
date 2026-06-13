import { PrismaClient } from '@prisma/client';
import { AGENTS } from '../src/data/agents.js';
import { SAYINGS } from '../src/data/seedConfig.js';

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

async function main() {
  const agents = await syncAgents();
  const sayings = await syncSayings();
  console.log(JSON.stringify({ ok: true, agents, sayings }, null, 2));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
