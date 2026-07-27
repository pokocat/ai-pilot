import { PrismaClient, type Prisma } from '@prisma/client';

const prisma = new PrismaClient();

const userCount = Math.max(1, Number(process.env.LT_USERS || 1000));
const sessionsPerUser = Math.max(1, Number(process.env.LT_SESSIONS_PER_USER || 10));
const messagesPerSession = Math.max(1, Number(process.env.LT_MESSAGES_PER_SESSION || 30));
const projectsPerUser = Math.max(1, Number(process.env.LT_PROJECTS_PER_USER || 3));
const knowledgePerUser = Math.max(1, Number(process.env.LT_KNOWLEDGE_PER_USER || 10));
const reportsPerUser = Math.max(1, Number(process.env.LT_REPORTS_PER_USER || 5));
const batchSize = 5000;

function pad(n: number, width = 4): string {
  return String(n).padStart(width, '0');
}

async function insertBatches<T>(rows: T[], insert: (batch: T[]) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < rows.length; i += batchSize) {
    await insert(rows.slice(i, i + batchSize));
  }
}

async function cleanup(): Promise<void> {
  await prisma.auditLog.deleteMany({ where: { userId: { startsWith: 'lt-user-' } } });
  await prisma.message.deleteMany({ where: { id: { startsWith: 'lt-message-' } } });
  await prisma.deliverable.deleteMany({ where: { id: { startsWith: 'lt-deliverable-' } } });
  await prisma.session.deleteMany({ where: { id: { startsWith: 'lt-session-' } } });
  await prisma.reportVersion.deleteMany({ where: { id: { startsWith: 'lt-report-version-' } } });
  await prisma.reportDoc.deleteMany({ where: { id: { startsWith: 'lt-report-' } } });
  await prisma.knowledgeItem.deleteMany({ where: { id: { startsWith: 'lt-knowledge-' } } });
  await prisma.project.deleteMany({ where: { id: { startsWith: 'lt-project-' } } });
  await prisma.creditLedger.deleteMany({ where: { userId: { startsWith: 'lt-user-' } } });
  await prisma.tokenWallet.deleteMany({ where: { userId: { startsWith: 'lt-user-' } } });
  await prisma.profile.deleteMany({ where: { id: { startsWith: 'lt-profile-' } } });
  await prisma.user.deleteMany({ where: { id: { startsWith: 'lt-user-' } } });
  await prisma.tenant.deleteMany({ where: { id: { startsWith: 'lt-tenant-' } } });
}

async function main(): Promise<void> {
  console.log(`[loadtest-seed] users=${userCount} sessions/user=${sessionsPerUser} messages/session=${messagesPerSession}`);
  await cleanup();

  const plan = await prisma.plan.findFirst({ orderBy: { sort: 'asc' } });
  const agent = await prisma.agent.findUnique({ where: { key: 'general' } });
  if (!plan || !agent) throw new Error('run npm run db:seed before loadtestSeed');

  const tenants: Prisma.TenantCreateManyInput[] = [];
  const users: Prisma.UserCreateManyInput[] = [];
  const profiles: Prisma.ProfileCreateManyInput[] = [];
  const credits: Prisma.CreditLedgerCreateManyInput[] = [];
  const wallets: Prisma.TokenWalletCreateManyInput[] = [];
  const projects: Prisma.ProjectCreateManyInput[] = [];
  const sessions: Prisma.SessionCreateManyInput[] = [];
  const knowledge: Prisma.KnowledgeItemCreateManyInput[] = [];
  const reports: Prisma.ReportDocCreateManyInput[] = [];
  const deliverables: Prisma.DeliverableCreateManyInput[] = [];

  for (let u = 1; u <= userCount; u++) {
    const suffix = pad(u);
    const tenantId = `lt-tenant-${suffix}`;
    const userId = `lt-user-${suffix}`;
    const firstProjectId = `lt-project-${suffix}-01`;
    const firstSessionId = `lt-session-${suffix}-01`;
    tenants.push({
      id: tenantId,
      name: `压测企业 ${suffix}`,
      industry: 'SaaS / 软件',
      stage: '成长期',
    });
    users.push({
      id: userId,
      tenantId,
      phone: `199${pad(u, 8)}`,
      name: `压测用户 ${suffix}`,
      role: 'owner',
      benmingColor: 'green',
      planId: plan.id,
      inviteCode: `JSLT${pad(u, 6)}`,
    });
    profiles.push({
      id: `lt-profile-${suffix}`,
      tenantId,
      industry: 'SaaS / 软件',
      stage: '成长期',
      pain: '获客成本上升，需要提升转化效率',
    });
    credits.push({
      tenantId,
      userId,
      delta: 1000,
      reason: '隔离压测数据',
      balance: 1000,
    });
    wallets.push({
      tenantId,
      userId,
      quota: 1000000,
      balance: 1000000,
      periodKey: '2026-07',
    });

    for (let p = 1; p <= projectsPerUser; p++) {
      projects.push({
        id: `lt-project-${suffix}-${pad(p, 2)}`,
        tenantId,
        userId,
        name: `增长项目 ${p}`,
        slug: `growth-${p}`,
        icon: 'layers',
        summary: `压测项目 ${p}：验证增长、转化和组织效率。`,
        status: 'active',
      });
    }

    for (let s = 1; s <= sessionsPerUser; s++) {
      sessions.push({
        id: `lt-session-${suffix}-${pad(s, 2)}`,
        tenantId,
        userId,
        agentKey: agent.key,
        projectId: s <= projectsPerUser ? `lt-project-${suffix}-${pad(s, 2)}` : null,
        title: `经营问策 ${s}`,
      });
    }

    for (let k = 1; k <= knowledgePerUser; k++) {
      knowledge.push({
        id: `lt-knowledge-${suffix}-${pad(k, 2)}`,
        tenantId,
        userId,
        projectId: firstProjectId,
        kind: k % 2 === 0 ? 'insight' : 'document',
        title: `经营资料 ${k}`,
        text: `这是用户 ${suffix} 的第 ${k} 条确定性压测资料，用于验证知识列表查询与索引性能。`,
        sourceType: 'manual',
        tagsJson: ['loadtest', 'readonly'],
        stage: 'confirmed',
        status: 'ready',
      });
    }

    for (let r = 1; r <= reportsPerUser; r++) {
      const reportId = `lt-report-${suffix}-${pad(r, 2)}`;
      reports.push({
        id: reportId,
        tenantId,
        userId,
        projectId: firstProjectId,
        title: `经营方案 ${r}`,
        slug: `report-${r}`,
        type: '经营诊断',
        agentKey: agent.key,
        currentVersion: 1,
      });
      deliverables.push({
        id: `lt-deliverable-${suffix}-${pad(r, 2)}`,
        tenantId,
        userId,
        sessionId: firstSessionId,
        projectId: firstProjectId,
        reportId,
        agentKey: agent.key,
        title: `经营方案 ${r}`,
        type: '经营诊断',
        contentJson: {
          title: `经营方案 ${r}`,
          sections: [{ h: '主要判断', b: '这是一份确定性压测方案，不包含真实业务数据。' }],
        },
        status: 'ready',
      });
    }
  }

  await insertBatches(tenants, (data) => prisma.tenant.createMany({ data }));
  await insertBatches(users, (data) => prisma.user.createMany({ data }));
  await insertBatches(profiles, (data) => prisma.profile.createMany({ data }));
  await insertBatches(credits, (data) => prisma.creditLedger.createMany({ data }));
  await insertBatches(wallets, (data) => prisma.tokenWallet.createMany({ data }));
  await insertBatches(projects, (data) => prisma.project.createMany({ data }));
  await insertBatches(sessions, (data) => prisma.session.createMany({ data }));
  await insertBatches(knowledge, (data) => prisma.knowledgeItem.createMany({ data }));
  await insertBatches(reports, (data) => prisma.reportDoc.createMany({ data }));
  await insertBatches(deliverables, (data) => prisma.deliverable.createMany({ data }));

  let messageBatch: Prisma.MessageCreateManyInput[] = [];
  let insertedMessages = 0;
  for (let u = 1; u <= userCount; u++) {
    const suffix = pad(u);
    for (let s = 1; s <= sessionsPerUser; s++) {
      const sessionId = `lt-session-${suffix}-${pad(s, 2)}`;
      for (let m = 1; m <= messagesPerSession; m++) {
        messageBatch.push({
          id: `lt-message-${suffix}-${pad(s, 2)}-${pad(m, 3)}`,
          sessionId,
          role: m % 2 === 0 ? 'assistant' : 'user',
          contentJson: { text: `压测消息 ${m}：围绕增长、转化、组织效率进行确定性讨论。` },
        });
        if (messageBatch.length >= batchSize) {
          await prisma.message.createMany({ data: messageBatch });
          insertedMessages += messageBatch.length;
          messageBatch = [];
        }
      }
    }
  }
  if (messageBatch.length) {
    await prisma.message.createMany({ data: messageBatch });
    insertedMessages += messageBatch.length;
  }

  console.log(JSON.stringify({
    users: users.length,
    sessions: sessions.length,
    messages: insertedMessages,
    projects: projects.length,
    knowledge: knowledge.length,
    reports: reports.length,
    deliverables: deliverables.length,
  }));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
