// 演示用：往本地 dev 队列里塞 N 个阻塞生成单，配合演示 server 的
// GENERATION_WORKER_CONCURRENCY=1 + AI_MOCK_LATENCY_MS 制造「排队中·前面还有 N 位」。
// 只在本地演示用，跑完用 --drain 清场。绝不要对预发/生产库执行。
import { prisma } from '../src/db.js';
import { enqueueDurableGeneration } from '../src/services/generationRequest.js';

const COUNT = Number(process.argv.find((a) => a.startsWith('--count='))?.split('=')[1] ?? 2);
const DRAIN = process.argv.includes('--drain');

async function main(): Promise<void> {
  if (DRAIN) {
    const cancelled = await prisma.generationJob.updateMany({
      where: { status: { in: ['queued', 'running'] }, requestJson: { path: ['demoBlocker'], equals: true } },
      data: { status: 'cancelled', completedAt: new Date(), terminationReason: 'demo_drained' },
    });
    await prisma.session.updateMany({
      where: { NOT: { activeGenerationId: null }, title: { startsWith: '演示阻塞' } },
      data: { activeGenerationId: null },
    });
    console.log(`drained ${cancelled.count} demo blockers`);
    return;
  }

  // 阻塞用户挂企业版（tierRank=999 → priority 封顶 9）：让手机上的演示账号（决策版，priority 2）
  // 排在它们后面，位次才看得见。用户不存在就地创建（本地 dev 库演示专用）。
  const plan = await prisma.plan.findFirstOrThrow({ where: { name: { contains: '企业' } } });
  const candidates: { id: string; tenantId: string; phone: string | null; planExpiresAt: Date | null }[] = [];
  for (let i = 0; i < COUNT; i++) {
    const phone = `199000000${String(i + 1).padStart(2, '0')}`;
    let user = await prisma.user.findUnique({ where: { phone } });
    if (!user) {
      const tenant = await prisma.tenant.create({ data: { name: '' } });
      user = await prisma.user.create({
        data: {
          tenantId: tenant.id,
          phone,
          name: `演示阻塞${i + 1}号`,
          planId: plan.id,
          planActivatedAt: new Date(),
          planExpiresAt: new Date(Date.now() + 30 * 86_400_000),
        },
      });
    }
    candidates.push(user);
  }
  let made = 0;
  for (const user of candidates) {
    if (made >= COUNT) break;
    if (user.planExpiresAt && user.planExpiresAt < new Date()) continue;
    try {
      const created = await enqueueDurableGeneration(
        { id: user.id, tenantId: user.tenantId },
        {
          text: `演示阻塞单 ${made + 1}：请生成一份很长的分析（mock 会睡满延迟）`,
          agentKey: 'general',
          clientRequestId: `demo-blocker-${Date.now()}-${made}`,
          // 标记进 requestMeta，drain 时按它清场，不误伤真实数据
        },
      );
      await prisma.generationJob.update({
        where: { id: created.job.id },
        data: { requestJson: { ...(created.job.requestJson as object), demoBlocker: true } },
      });
      console.log(`blocker ${made + 1}: job=${created.job.id} user=${user.phone} priority=${created.job.priority}`);
      made++;
    } catch (error) {
      console.log(`skip user ${user.phone}: ${(error as Error).message}`);
    }
  }
  if (made < COUNT) throw new Error(`只造出 ${made}/${COUNT} 个阻塞单，候选用户不足或都被挡`);
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
