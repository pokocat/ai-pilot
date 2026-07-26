import { prisma } from '../db.js';

// 全屏「入局仪式」于 2026-07-21 上线。此前创建的账号均属于存量用户，
// 即使历史数据没有 Profile 行，也不能在升级/换机后被重新当成首次登录。
export const ONBOARDING_ROLLOUT_AT = new Date('2026-07-21T00:00:00.000Z');

type OnboardingUser = {
  id: string;
  tenantId: string;
  createdAt: Date;
};

/**
 * 是否已完成/无需再走首次入局。
 *
 * Profile 是新流程的正常完成锚点；上线前账号直接兼容为已完成。
 * 对上线后曾因旧客户端吞掉建档失败、但已经产生真实业务资产的账号，也按老用户兜底，
 * 避免每次登录重复弹择色/行业问卷。
 */
export async function hasCompletedOnboarding(user: OnboardingUser): Promise<boolean> {
  if (user.createdAt < ONBOARDING_ROLLOUT_AT) return true;

  const [profile, tenant, session, project, deliverable, knowledge, casefile] = await prisma.$transaction([
    prisma.profile.findFirst({ where: { tenantId: user.tenantId }, select: { id: true } }),
    prisma.tenant.findUnique({ where: { id: user.tenantId }, select: { name: true, industry: true, stage: true } }),
    prisma.session.findFirst({ where: { userId: user.id }, select: { id: true } }),
    prisma.project.findFirst({ where: { userId: user.id }, select: { id: true } }),
    prisma.deliverable.findFirst({ where: { userId: user.id }, select: { id: true } }),
    prisma.knowledgeItem.findFirst({ where: { userId: user.id }, select: { id: true } }),
    prisma.casefile.findFirst({ where: { userId: user.id }, select: { id: true } }),
  ]);

  return !!(
    profile
    || tenant?.name?.trim()
    || tenant?.industry?.trim()
    || tenant?.stage?.trim()
    || session
    || project
    || deliverable
    || knowledge
    || casefile
  );
}
