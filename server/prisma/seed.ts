import { PrismaClient } from '@prisma/client';
import { AGENTS } from '../src/data/agents.js';
import { SAYINGS, SURVEY, PLANS } from '../src/data/seedConfig.js';
import { saveReportVersion } from '../src/services/reports.js';
import { ingestKnowledge } from '../src/services/knowledge.js';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 seeding 军师 数据库 …');

  // 先清理有外键依赖的业务数据，避免重复 seed 时报 FK 约束
  await prisma.message.deleteMany();
  await prisma.deliverable.deleteMany();
  await prisma.session.deleteMany();
  await prisma.memory.deleteMany();
  await prisma.reportVersion.deleteMany();
  await prisma.reportDoc.deleteMany();
  await prisma.knowledgeChunk.deleteMany();
  await prisma.knowledgeItem.deleteMany();
  await prisma.project.deleteMany();
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

  // —— 大模型配置（默认 Agnes 2.0 Flash；key 留空时安全降级 mock，后台填入即切真实） ——
  await prisma.aiSetting.upsert({
    where: { id: 'default' },
    update: { provider: 'openai', label: 'Agnes 2.0 Flash', baseUrl: 'https://apihub.agnes-ai.com/v1', model: 'agnes-2.0-flash' },
    create: { id: 'default', provider: 'openai', label: 'Agnes 2.0 Flash', baseUrl: 'https://apihub.agnes-ai.com/v1', model: 'agnes-2.0-flash', apiKey: '', embeddingModel: '', temperature: 0.7 },
  });
  console.log('  ✓ ai-setting=Agnes 2.0 Flash（填 key 后即切真实模型）');

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

  // —— 演示：项目 + 版本化报告(v1→v2 可看变更) + 知识库 ——
  const project = await prisma.project.create({
    data: {
      tenantId: tenant.id, userId: user.id, name: '2026 融资冲刺', icon: 'doc',
      summary: '目标 A+ 轮 6000 万，Q3 启动；当前重点：把增长逻辑与单位经济讲清楚，对齐故事与数据。',
    },
  });
  // 战略诊断报告 v1
  await saveReportVersion({
    tenantId: tenant.id, userId: user.id, projectId: project.id, agentKey: 'strat',
    title: '战略诊断报告', type: '战略体检', authorKind: 'agent',
    content: {
      title: '战略诊断报告', icon: 'target', meta: '云栖科技 · SaaS / 软件 · A 轮前后',
      sections: [
        { h: '现状判断', b: '增长进入平台期，获客成本上升，续费率尚可但扩张乏力。' },
        { h: '关键卡点', list: ['新客获取成本偏高', '产品价值未对齐高价值客群', '定价缺乏分层'] },
        { h: '30 天行动建议', list: ['锁定 2 个高价值行业做样板', '重做定价分层', '建立增长看板'] },
      ],
      trust: '本结论由 AI 生成，重大决策请结合专业意见。', actions: ['save_to_library', 'export_pdf'],
    },
  });
  // 战略诊断报告 v2（修改「关键卡点」+ 新增「风险提示」→ 与 v1 形成可视 diff）
  await saveReportVersion({
    tenantId: tenant.id, userId: user.id, projectId: project.id, agentKey: 'strat',
    title: '战略诊断报告', type: '战略体检', authorKind: 'user',
    content: {
      title: '战略诊断报告', icon: 'target', meta: '云栖科技 · SaaS / 软件 · A 轮前后',
      sections: [
        { h: '现状判断', b: '增长进入平台期，获客成本上升，续费率尚可但扩张乏力。' },
        { h: '关键卡点', list: ['新客获取成本偏高（环比 +18%）', '产品价值未对齐高价值客群', '定价缺乏分层', '销售团队人效偏低'] },
        { h: '30 天行动建议', list: ['锁定 2 个高价值行业做样板', '重做定价分层', '建立增长看板'] },
        { h: '风险提示', b: '现金流可支撑 9 个月，融资窗口需在 Q3 前打开，避免被动。' },
      ],
      trust: '本结论由 AI 生成，重大决策请结合专业意见。', actions: ['save_to_library', 'export_pdf'],
    },
  });
  // 知识库：一条决策、一条洞察（挂到项目）
  await ingestKnowledge({
    tenantId: tenant.id, userId: user.id, projectId: project.id, kind: 'decision',
    title: '定价分层决策', sourceType: 'manual', tags: ['定价', '增长'],
    text: '决定将产品定价分为 标准版 / 专业版 / 旗舰版 三层，专业版主打高价值行业客群，旗舰版含专属顾问与 SLA。',
  });
  await ingestKnowledge({
    tenantId: tenant.id, userId: user.id, projectId: project.id, kind: 'insight',
    title: '高价值客群特征', sourceType: 'manual', tags: ['客群', '行业'],
    text: '高价值客群集中在制造与医疗 SaaS，决策链长但续费率高、客单价高，适合做样板与转介绍。',
  });
  console.log(`  ✓ demo project=${project.id}（含战略诊断报告 v1→v2 + 2 条知识）`);

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
