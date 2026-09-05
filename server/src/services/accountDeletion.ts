import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { scrubUserReferralPii } from './referral.js';
import { env } from '../env.js';
import { ossDelete } from './ossUpload.js';
import { aidramaDeleteOwnerData } from './video/aidramaGateway.js';

/**
 * 注销数据政策的机器可读清单。新增含 userId/tenantId 的业务模型时，覆盖测试会强制要求在这里归类。
 * delete：保留期结束后删除账号专属内容；shared：多人租户保留、独占租户删除；retain：到期后仅留法务/安全所需的去标识记录。
 */
/**
 * 注销数据政策分类。`test/accountDeletion.test.ts` 遍历 DMMF 强制校验：任何带 userId/tenantId
 * 的新表都必须先在这里归类，漏登记就红——这条守卫很值钱，它正是这样抓到邀请关系三张表的。
 *
 * `Referral` / `ReferralAttribution` / `InviteActivationOutbox` 归 **retain**（去标识保留）：
 * 邀请关系是**邀请人的**账本，下级注销不该让上级业绩缩水、也不该截断三级路径；且这三张表里
 * 只有内部 cuid / 邀请码 / 时间戳，`user` 一删就天然去标识化。真正属个人数据的只有归因留痕的
 * clientIp / userAgent，由 `scrubUserReferralPii` 置 null（见其注释）。
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
  retain: [
    'ClientEvent', 'PaymentOrder', 'SubscriptionContract', 'TokenUsage', 'LlmTrace', 'AuditLog', 'ModerationLog',
    'Referral', 'ReferralAttribution', 'InviteActivationOutbox',
    // 代理分销（2026-09-02）：`Distributor` 是**签约档案**、`CommissionEntry` /
    // `CommissionSettlement` 是**财务账本**——都属「到期后只留法务/财务所需的去标识记录」。
    // 删行不行：一条已打款的结算单背后是真实的对外付款，账不能因为对方注销账号就消失；
    // 佣金流水删了，上级代理的结算净额也跟着变。所以 purge 时只抹 Distributor 上的
    // displayName / contactPhone / remark 三个 PII 字段（见 redactRetained），行与金额全留。
    'Distributor', 'CommissionEntry', 'CommissionSettlement',
  ],
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
  // 邀请关系与归因：**关系链整体保留、只抹个人可识别字段**（2026-08-19 口径）。
  // 邀请关系是**邀请人的**账本——下级注销不该让上级的直邀数/已开通数缩水，也不该截断三级路径；
  // 而 Referral 表里只有内部 cuid / 邀请码 / 时间戳，user 一删它天然就是去标识化的。
  // 真正属个人数据的只有归因留痕里的 clientIp / userAgent（网络与设备标识），置 null 但不删行
  // ——与上面 clientEvent / auditLog 同一套「账本去标识保留」的口径。
  await scrubUserReferralPii(tx, userId);
  // 代理档案：**保留行与佣金归属，只抹 PII**（同上面邀请关系那套「账本去标识保留」的口径）。
  // 为什么不改 userId：`CommissionEntry.beneficiaryUserId` / `distributorId` 都指着它，改了就
  // 再也说不清那些已结算的钱是给谁的；而档案上真正属个人数据的只有对外名称、联系手机与备注。
  // 状态也不动——终止代理关系是商务动作，注销账号不代表合同已解除，不该由这里替运营决定。
  await tx.distributor.updateMany({
    where: { userId },
    data: { displayName: null, contactPhone: null, remark: null },
  });
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
