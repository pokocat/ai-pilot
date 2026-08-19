import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { ossDelete } from './ossUpload.js';
import { aidramaDeleteOwnerData } from './video/aidramaGateway.js';

/**
 * 注销数据政策的机器可读清单。新增含 userId/tenantId 的业务模型时，覆盖测试会强制要求在这里归类。
 * delete：保留期结束后删除账号专属内容；shared：多人租户保留、独占租户删除；retain：到期后仅留法务/安全所需的去标识记录。
 */
export const ACCOUNT_DELETION_POLICY = {
  delete: [
    'UserJourney', 'Prescription', 'BrandKit', 'BizMetricWeekly', 'UserAgent',
    'Session', 'GenerationJob', 'SessionContextSnapshot', 'Deliverable', 'Memory', 'UserFact',
    'Project', 'ReportDoc', 'KnowledgeItem', 'KnowledgeChunk',
    'PlanEntitlement', 'MonthlyCreditGrant', 'TokenQuotaAdjustment', 'SkuEntitlement',
    'CreditLedger', 'TokenWallet', 'WechatSubscription', 'WechatNotificationLog',
    'Casefile', 'CasefileOrder', 'CasefileMetric', 'NatalChart', 'StrategicProfile',
    'DecisionLog', 'ReviewLog', 'ProphecyLog', 'UserProgress', 'UserDataSource', 'UserModule',
    'ServiceAssignment', 'ActivationEvent', 'CreativeJob', 'CreativeAsset',
    'VideoCreditHold', 'VideoCloneHold', 'VideoStoragePack', 'ReportHtml',
  ],
  shared: ['Profile', 'GraphEntity', 'GraphRelation'],
  retain: ['ClientEvent', 'PaymentOrder', 'SubscriptionContract', 'TokenUsage', 'LlmTrace', 'AuditLog', 'ModerationLog'],
  identity: ['User', 'Tenant'],
} as const;

type Tx = Prisma.TransactionClient;
type Delegate = { deleteMany(args: { where: Record<string, unknown> }): Promise<unknown> };

const DELETE_ORDER = [
  'creativeAsset', 'creativeJob',
  'generationJob', 'sessionContextSnapshot', 'deliverable', 'memory', 'userFact',
  'session', 'reportDoc', 'knowledgeItem', 'project',
  'casefileOrder', 'casefileMetric', 'casefile',
  'userJourney', 'prescription', 'brandKit', 'bizMetricWeekly',
  'planEntitlement', 'monthlyCreditGrant', 'tokenQuotaAdjustment', 'skuEntitlement',
  'creditLedger', 'tokenWallet', 'wechatNotificationLog', 'wechatSubscription',
  'natalChart', 'strategicProfile', 'decisionLog', 'reviewLog', 'prophecyLog', 'userProgress',
  'userDataSource', 'userModule', 'serviceAssignment', 'activationEvent',
  'videoCreditHold', 'videoCloneHold', 'videoStoragePack',
] as const;

function subjectHash(userId: string): string {
  const pepper = process.env.APP_JWT_SECRET || 'local-account-erasure';
  return createHash('sha256').update(`${pepper}\0${userId}`).digest('hex');
}

function reportObjectKeys(id: string): string[] {
  const prefix = env.ossKeyPrefix ? `${env.ossKeyPrefix}/` : '';
  return [`${prefix}${id}.html`, `${prefix}pdf/${id}-long-m.pdf`];
}

function publicOssKey(url: string | null): string | null {
  if (!url || !env.ossBaseUrl) return null;
  try {
    const base = new URL(env.ossBaseUrl);
    const parsed = new URL(url);
    if (base.origin !== parsed.origin) return null;
    const basePath = base.pathname.replace(/\/$/, '');
    if (!parsed.pathname.startsWith(`${basePath}/`)) return null;
    return decodeURIComponent(parsed.pathname.slice(basePath.length + 1));
  } catch {
    return null;
  }
}

async function deleteOwned(tx: Tx, where: { userId: string } | { tenantId: string }): Promise<void> {
  for (const name of DELETE_ORDER) {
    await ((tx as unknown as Record<string, Delegate>)[name]).deleteMany({ where });
  }
}

async function redactRetained(tx: Tx, userId: string, tenantId: string, deleteTenant: boolean, hash: string): Promise<void> {
  const deletedId = `deleted:${hash}`;
  const tenantReplacement = deleteTenant ? `deleted:${createHash('sha256').update(`tenant\0${tenantId}`).digest('hex')}` : tenantId;
  await tx.paymentOrder.updateMany({
    where: { userId },
    data: {
      userId: deletedId, tenantId: tenantReplacement, rawNotifyJson: Prisma.DbNull,
      refundRawJson: Prisma.DbNull, attrRefId: null, clientRequestId: null,
    },
  });
  await tx.subscriptionContract.updateMany({
    where: { userId },
    data: {
      userId: deletedId, tenantId: tenantReplacement, openid: deletedId,
      status: 'cancel_pending', nextBillingAt: null, rawNotifyJson: Prisma.DbNull,
    },
  });
  await tx.tokenUsage.updateMany({ where: { userId }, data: { userId: null, sessionId: null, ...(deleteTenant ? { tenantId: null } : {}) } });
  await tx.llmTrace.updateMany({
    where: { userId },
    data: {
      userId: null, sessionId: null, promptText: null, responseText: null,
      contextJson: Prisma.DbNull, errorMessage: null, ...(deleteTenant ? { tenantId: null } : {}),
    },
  });
  await tx.clientEvent.updateMany({ where: { userId }, data: { userId: null, propsJson: Prisma.DbNull, ...(deleteTenant ? { tenantId: null } : {}) } });
  await tx.auditLog.updateMany({
    where: { userId },
    data: { userId: null, payloadJson: { retainedFor: 'security_audit', subjectHash: hash }, ...(deleteTenant ? { tenantId: null } : {}) },
  });
  await tx.moderationLog.updateMany({
    where: { userId },
    data: { userId: null, sessionId: null, detailJson: { retainedFor: 'content_safety' }, ...(deleteTenant ? { tenantId: null } : {}) },
  });
}

function retentionDays(): number {
  const raw = Number(process.env.ACCOUNT_DELETION_RETENTION_DAYS ?? 30);
  return Number.isFinite(raw) ? Math.min(365, Math.max(30, Math.floor(raw))) : 30;
}

export async function eraseAccount(userId: string): Promise<{ ok: true; erasureJobId: string; retentionUntil: string }> {
  const user = await prisma.user.findUnique({
    where: { id: userId }, select: { id: true, tenantId: true, avatarUrl: true, deletedAt: true, purgeAfter: true },
  });
  if (!user) throw Object.assign(new Error('用户不存在'), { statusCode: 401, code: 'UNAUTHORIZED' });
  const existing = await prisma.dataErasureJob.findUnique({ where: { subjectUserId: user.id } });
  if (user.deletedAt && user.purgeAfter && existing) {
    return { ok: true, erasureJobId: existing.id, retentionUntil: user.purgeAfter.toISOString() };
  }
  const others = await prisma.user.count({ where: { tenantId: user.tenantId, id: { not: user.id } } });
  const deleteTenant = others === 0;
  const hash = subjectHash(user.id);

  const [knowledge, assets, shares] = await Promise.all([
    prisma.knowledgeItem.findMany({
      where: deleteTenant ? { tenantId: user.tenantId } : { userId: user.id },
      select: { fileKey: true, inferenceFileKey: true },
    }),
    prisma.creativeAsset.findMany({ where: deleteTenant ? { tenantId: user.tenantId } : { userId: user.id }, select: { ossKey: true } }),
    prisma.reportHtml.findMany({ where: deleteTenant ? { tenantId: user.tenantId } : { userId: user.id }, select: { id: true } }),
  ]);
  const objectKeys = new Set<string>();
  const avatarKey = publicOssKey(user.avatarUrl);
  if (avatarKey) objectKeys.add(avatarKey);
  for (const row of knowledge) {
    if (row.fileKey) objectKeys.add(row.fileKey);
    if (row.inferenceFileKey) objectKeys.add(row.inferenceFileKey);
  }
  for (const row of assets) objectKeys.add(row.ossKey);
  for (const row of shares) for (const key of reportObjectKeys(row.id)) objectKeys.add(key);
  const externalConfigured = !!(process.env.AIDRAMA_CLIP_BASE_URL?.trim() && process.env.AIDRAMA_CLIP_SERVICE_TOKEN?.trim());
  const deletedAt = new Date();
  const purgeAfter = new Date(deletedAt.getTime() + retentionDays() * 86400_000);

  let job: { id: string };
  try {
    job = await prisma.$transaction(async (tx) => {
      const created = await tx.dataErasureJob.create({
        data: {
          subjectHash: hash,
          subjectUserId: user.id,
          objectKeys: [...objectKeys],
          externalOwnerId: externalConfigured ? user.id : null,
          status: 'retained',
          nextAttemptAt: purgeAfter,
        },
      });
      await tx.user.update({ where: { id: user.id }, data: { deletedAt, purgeAfter } });
      await tx.reportHtml.updateMany({
        where: deleteTenant ? { tenantId: user.tenantId } : { userId: user.id },
        data: { revokedAt: deletedAt },
      });
      await tx.subscriptionContract.updateMany({
        where: { userId: user.id, status: { in: ['pending', 'active'] } },
        data: { status: 'cancel_pending', nextBillingAt: null },
      });
      return created;
    });
  } catch (error) {
    // 同一旧 token 的并发注销可能都先读到未删除用户；唯一键冲突时返回首个事务的真值，而不是 500。
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const [duplicate, retainedUser] = await Promise.all([
        prisma.dataErasureJob.findUnique({ where: { subjectUserId: user.id } }),
        prisma.user.findUnique({ where: { id: user.id }, select: { purgeAfter: true } }),
      ]);
      if (duplicate && retainedUser?.purgeAfter) {
        return { ok: true, erasureJobId: duplicate.id, retentionUntil: retainedUser.purgeAfter.toISOString() };
      }
    }
    throw error;
  }
  return { ok: true, erasureJobId: job.id, retentionUntil: purgeAfter.toISOString() };
}

async function hardDeleteAccount(userId: string, hash: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, tenantId: true } });
  if (!user) return; // 上次重试已完成本地物理清理。
  const others = await prisma.user.count({ where: { tenantId: user.tenantId, id: { not: user.id } } });
  const deleteTenant = others === 0;
  const sessions = await prisma.session.findMany({ where: { userId: user.id }, select: { id: true } });
  const sessionIds = sessions.map((row) => row.id);
  await prisma.$transaction(async (tx) => {
    await redactRetained(tx, user.id, user.tenantId, deleteTenant, hash);
    if (sessionIds.length) {
      await tx.graphRelation.updateMany({ where: { tenantId: user.tenantId, sourceId: { in: sessionIds } }, data: { sourceId: null } });
    }
    await tx.reportHtml.deleteMany({ where: deleteTenant ? { tenantId: user.tenantId } : { userId: user.id } });
    await tx.userAgent.deleteMany({ where: { userId: user.id } });
    await deleteOwned(tx, deleteTenant ? { tenantId: user.tenantId } : { userId: user.id });
    if (deleteTenant) {
      await tx.graphRelation.deleteMany({ where: { tenantId: user.tenantId } });
      await tx.graphEntity.deleteMany({ where: { tenantId: user.tenantId } });
      await tx.profile.deleteMany({ where: { tenantId: user.tenantId } });
    }
    await tx.user.delete({ where: { id: user.id } });
    if (deleteTenant) await tx.tenant.delete({ where: { id: user.tenantId } });
  });
}

export async function processDataErasureJob(id: string): Promise<boolean> {
  const claimed = await prisma.dataErasureJob.updateMany({
    where: { id, status: 'pending', nextAttemptAt: { lte: new Date() } },
    data: { status: 'processing', attempts: { increment: 1 } },
  });
  if (!claimed.count) return false;
  const job = await prisma.dataErasureJob.findUniqueOrThrow({ where: { id } });
  try {
    if (job.subjectUserId) await hardDeleteAccount(job.subjectUserId, job.subjectHash);
    const keys = Array.isArray(job.objectKeys) ? job.objectKeys.filter((v): v is string => typeof v === 'string') : [];
    for (const key of keys) await ossDelete(key);
    if (job.externalOwnerId) await aidramaDeleteOwnerData({ userId: job.externalOwnerId, tenantId: job.subjectHash });
    await prisma.dataErasureJob.update({
      where: { id },
      data: { status: 'completed', objectKeys: [], subjectUserId: null, externalOwnerId: null, lastError: null, completedAt: new Date() },
    });
    return true;
  } catch (error) {
    const delayMs = Math.min(24 * 3600_000, 60_000 * (2 ** Math.min(job.attempts, 10)));
    await prisma.dataErasureJob.update({
      where: { id },
      data: {
        status: 'pending', lastError: (error as Error).message.slice(0, 1000),
        nextAttemptAt: new Date(Date.now() + delayMs),
      },
    });
    throw error;
  }
}

export async function scanDataErasureJobs(limit = 20): Promise<number> {
  await prisma.dataErasureJob.updateMany({
    where: { status: 'retained', nextAttemptAt: { lte: new Date() } },
    data: { status: 'pending' },
  });
  const rows = await prisma.dataErasureJob.findMany({
    where: { status: 'pending', nextAttemptAt: { lte: new Date() } },
    orderBy: { createdAt: 'asc' }, take: limit, select: { id: true },
  });
  let completed = 0;
  for (const row of rows) if (await processDataErasureJob(row.id).catch(() => false)) completed += 1;
  return completed;
}
