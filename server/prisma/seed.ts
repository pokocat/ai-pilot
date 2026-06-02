import { PrismaClient } from '@prisma/client';
import { AGENTS } from '../src/data/agents.js';
import { SAYINGS, SURVEY, PLANS } from '../src/data/seedConfig.js';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 seeding 军师 数据库 …');

  // 先清理有外键依赖的业务数据，避免重复 seed 时报 FK 约束
  await prisma.message.deleteMany();
  await prisma.deliverable.deleteMany();
  await prisma.session.deleteMany();
  await prisma.memory.deleteMany();
  await prisma.creditLedger.deleteMany();

  // —— 套餐 ——
  await prisma.plan.deleteMany();
  const plans = [];
  for (let i = 0; i < PLANS.length; i++) {
    const p = PLANS[i];
    plans.push(
      await prisma.plan.create({
        data: {
          name: p.name,
          price: p.price,
          period: p.period,
          creditsPerMonth: p.creditsPerMonth,
          agentCount: p.agentCount,
          featuresJson: p.features,
          highlighted: p.highlighted,
          sort: i,
        },
      }),
    );
  }
  console.log(`  ✓ ${plans.length} plans`);

  // —— 智能体 ——
  await prisma.agent.deleteMany();
  for (const a of AGENTS) {
    await prisma.agent.create({
      data: {
        key: a.key,
        name: a.name,
        role: a.role,
        icon: a.icon,
        type: a.type,
        gift: a.gift,
        enabled: a.enabled,
        greet: a.greet,
        chipsJson: a.chips,
        memText: a.memText,
        learnText: a.learnText,
        systemPrompt: a.systemPrompt,
        deliverableKey: a.deliverableKey,
        memoryConfig: a.memoryConfig as object,
        sort: a.sort,
      },
    });
  }
  console.log(`  ✓ ${AGENTS.length} agents`);

  // —— 每日献策 ——
  await prisma.saying.deleteMany();
  for (let i = 0; i < SAYINGS.length; i++) {
    await prisma.saying.create({ data: { text: SAYINGS[i].text, enabled: SAYINGS[i].enabled, sort: i } });
  }
  console.log(`  ✓ ${SAYINGS.length} sayings`);

  // —— 建档问卷 ——
  await prisma.surveyQuestion.deleteMany();
  for (let i = 0; i < SURVEY.length; i++) {
    const q = SURVEY[i];
    await prisma.surveyQuestion.create({ data: { key: q.key, title: q.title, optionsJson: q.options, sort: i } });
  }
  console.log(`  ✓ ${SURVEY.length} survey questions`);

  // —— 演示租户与用户（云栖科技 / 王总） ——
  await prisma.auditLog.deleteMany();
  await prisma.profile.deleteMany();
  await prisma.user.deleteMany();
  await prisma.tenant.deleteMany();
  const decisionPlan = plans.find((p) => p.name === '决策版') ?? plans[0];
  const tenant = await prisma.tenant.create({
    data: { name: '云栖科技', industry: 'SaaS / 软件', stage: 'A 轮前后' },
  });
  const user = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      phone: '13800000000',
      name: '王总',
      role: 'owner',
      benmingColor: 'gold',
      planId: decisionPlan.id,
    },
  });
  await prisma.profile.create({
    data: { tenantId: tenant.id, industry: 'SaaS / 软件', stage: 'A 轮前后', pain: '增长乏力' },
  });
  await prisma.creditLedger.create({
    data: { tenantId: tenant.id, userId: user.id, delta: 68, reason: '决策版 · 月度充值', balance: 68 },
  });
  console.log(`  ✓ demo tenant=${tenant.id} user=${user.id}`);

  console.log('✅ seed done');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
