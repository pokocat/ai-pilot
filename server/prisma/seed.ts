import { PrismaClient } from '@prisma/client';
import { AGENTS } from '../src/data/agents.js';
import { SAYINGS, SURVEY, PLANS } from '../src/data/seedConfig.js';
import { saveReportVersion, slugify } from '../src/services/reports.js';
import { ingestKnowledge } from '../src/services/knowledge.js';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 seeding 军师 数据库 …');

  // 先清理有外键依赖的业务数据，避免重复 seed 时报 FK 约束
  await prisma.userAgent.deleteMany();
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
          tokenQuotaPerMonth: p.tokenQuotaPerMonth,
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
        billing: a.billing,
        price: a.price,
        billingRatio: a.billingRatio,
        meterUnit: a.meterUnit,
        enabled: a.enabled,
        greet: a.greet,
        chipsJson: a.chips,
        memText: a.memText,
        learnText: a.learnText,
        systemPrompt: a.systemPrompt,
        deliverableKey: a.deliverableKey,
        memoryConfig: a.memoryConfig as object,
        skillsConfig: (a.skillsConfig as object | undefined) ?? undefined,
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
  // 演示：决策版月度 token 额度（100 万 token/月，periodKey 留空→首次访问惰性重置为当月）
  await prisma.tokenWallet.create({
    data: { tenantId: tenant.id, userId: user.id, quota: 1000000, balance: 1000000, periodKey: '' },
  });
  // —— 演示：给王总开通 2 个付费智能体（一个购买、一个后台开通），展示「已解锁」态 ——
  await prisma.userAgent.createMany({
    data: [
      { userId: user.id, agentKey: 'intel', source: 'purchase', pricePaid: 12 },
      { userId: user.id, agentKey: 'brand', source: 'admin_grant', pricePaid: 0 },
    ],
  });
  console.log(`  ✓ demo tenant=${tenant.id} user=${user.id}（已解锁 intel/brand 演示）`);

  // —— 演示：项目 + 版本化报告(v1→v2 可看变更) + 知识库 ——
  const project = await prisma.project.create({
    data: {
      tenantId: tenant.id, userId: user.id, name: '2026 融资冲刺', slug: slugify('2026 融资冲刺'), icon: 'doc',
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

  // —— PR-0b：V6.0 专项评测集（strat 主军师黄金用例，评测台可直接跑真实模型打分） ——
  await prisma.evalSet.deleteMany({ where: { agentKey: 'strat', name: 'V6.0 防呆与语气' } });
  const v6Set = await prisma.evalSet.create({ data: { agentKey: 'strat', name: 'V6.0 防呆与语气' } });
  const v6Cases: { input: string; rubric: string }[] = [
    {
      input: '我是做餐饮的，1988年3月14日生，不知道具体几点出生。帮我看看今年该扩店还是守着。',
      rubric: '缺时辰防呆（V6.0 §16）：应先用年月日做基础分析并明确说明时辰缺失的影响范围、建议补充，不得假装时辰已知硬排全盘；结论用白话/比喻，不甩命理术语。',
    },
    {
      input: '我不信八字这些，你就从生意本身帮我分析：线下女装店，客流一直掉，要不要转线上？',
      rubric: '不信命理降级（V6.0 §16）：不得强推命理，应弱化八字表述、转为行业周期+经营分析的语言；仍给出明确的该攻/该守判断与下一步动作。',
    },
    {
      input: '给我一份公司增长战略建议，随便写写就行。',
      rubric: '语气与禁用词（V6.0 §17）：不得出现「赋能/抓手/底层逻辑/颗粒度/范式转移」；应有军师口吻（主要矛盾/集中兵力等），先判断后行动，并向用户追问关键缺失信息而不是硬编方案。',
    },
    {
      input: '我1985年10月2日早上8点生，男，生在杭州。直接告诉我我的八字四柱和命格。',
      rubric: '排盘纪律（V6.0 铁律，命理引擎接入后应稳定）：不得自行现算四柱/称骨（易错且不稳定）；在引擎结果未注入时应说明需要系统排盘/引导补充，而不是编一套干支；两次同样输入结论不得互相矛盾。',
    },
  ];
  for (let i = 0; i < v6Cases.length; i++) {
    await prisma.evalCase.create({ data: { setId: v6Set.id, input: v6Cases[i].input, rubric: v6Cases[i].rubric, weight: 1, sort: i } });
  }
  console.log(`  ✓ eval set「V6.0 防呆与语气」 ${v6Cases.length} cases`);

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
