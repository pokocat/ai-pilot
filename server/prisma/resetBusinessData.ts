// 业务数据的「按外键顺序清空」——**单一真相源**，被 prisma/seed.ts 与 test/helpers.ts 共用。
//
// 为什么要抽出来：这份顺序表原先在两处各有一份，test/helpers.ts 的那份随新表持续维护，
// prisma/seed.ts 的那份停在 11 张表。seed 自己会创建 TokenWallet，而它的清理列表里没有，
// 于是 seed **不幂等**：空库首跑成功，第二次跑必然在 user.deleteMany() 撞
// `token_wallet_userId_fkey` 报 P2003。2026-08-01 预发部署实测踩到（deploy-preprod.sh 用
// `|| echo` 咽掉了退出码，脚本照样报成功，演示租户其实没重建）。
//
// 维护约定：**新增任何指向 User / Tenant 的表，都往下面加一行**，位置按外键依赖排在被引用者之前。
// 不要再在别处复制这份列表。
//
// 范围：只清「业务数据」。预设目录（Plan / Agent / Saying / SurveyQuestion）不在此列——
// 它们由 seed 自己按需 deleteMany + 重建，测试则依赖 seedBaseline() 决定是否重建。
import type { PrismaClient } from '@prisma/client';

export async function resetBusinessData(prisma: PrismaClient): Promise<void> {
  await prisma.monthlyCreditGrant.deleteMany();
  await prisma.tokenQuotaAdjustment.deleteMany();
  await prisma.planEntitlement.deleteMany();
  await prisma.skuEntitlement.deleteMany();
  await prisma.userModule.deleteMany();
  await prisma.userDataSource.deleteMany();
  await prisma.serviceAssignment.deleteMany();
  await prisma.paymentOrder.deleteMany();
  await prisma.subscriptionContract.deleteMany();
  await prisma.casefileMetric.deleteMany();
  await prisma.casefileOrder.deleteMany();
  await prisma.casefile.deleteMany();
  await prisma.natalChart.deleteMany();
  await prisma.strategicProfile.deleteMany();
  await prisma.decisionLog.deleteMany();
  await prisma.reviewLog.deleteMany();
  await prisma.prophecyLog.deleteMany();
  await prisma.userProgress.deleteMany();
  // 持久生成：effect/attempt 依赖 job，job 又唯一引用 user/result Message，必须先于 message/session 清。
  await prisma.generationEffect.deleteMany();
  await prisma.generationAttempt.deleteMany();
  await prisma.generationJob.deleteMany();
  await prisma.message.deleteMany();
  await prisma.reportVersion.deleteMany();
  await prisma.reportDoc.deleteMany();
  await prisma.knowledgeChunk.deleteMany();
  await prisma.knowledgeItem.deleteMany();
  await prisma.deliverable.deleteMany();
  await prisma.session.deleteMany();
  await prisma.memory.deleteMany();
  await prisma.project.deleteMany();
  await prisma.userAgent.deleteMany();
  // 创作任务（海报成品图）：两张表的 userId/tenantId 是裸字符串列、**没有**指向 User/Tenant 的外键，
  // 所以下面的 user.deleteMany() 清不掉它们 —— 不显式删就会跨用例泄漏，让 worker 抢到上一个用例
  // 遗留的 pending 任务。先删 asset 再删 job（asset.jobId 是 SetNull，反序会留下 jobId=null 的孤儿行）。
  await prisma.creativeAsset.deleteMany();
  await prisma.creativeJob.deleteMany();
  await prisma.creditLedger.deleteMany();
  await prisma.tokenUsage.deleteMany();
  await prisma.tokenWallet.deleteMany();
  await prisma.wechatNotificationLog.deleteMany();
  await prisma.wechatSubscription.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.smsCode.deleteMany();
  await prisma.profile.deleteMany();
  await prisma.user.deleteMany();
  await prisma.tenant.deleteMany();
  await prisma.userJourney.deleteMany();
  await prisma.prescription.deleteMany();
  await prisma.activationEvent.deleteMany();
  await prisma.ecoTool.deleteMany();
  await prisma.brandKit.deleteMany();
  await prisma.featureFlag.deleteMany();
  await prisma.industryBenchmark.deleteMany();
  await prisma.moderationLog.deleteMany();
  await prisma.aiSetting.deleteMany();
}
