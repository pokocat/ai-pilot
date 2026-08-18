import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { providerInfo } from '../llm/gateway.js';
import { resolveUser } from '../services/context.js';
import { recordAudit } from '../services/audit.js';
import { buildClientUnderstanding } from '../services/understanding.js';
import { buildMemoryLibrary } from '../services/memoryLibrary.js';
import { loadDossier, generateDossier } from '../services/dossier.js';
import { getQuotaState, getPlanStatus } from '../services/tokenQuota.js';
import { ossConfigured, ossPutPublic } from '../services/ossUpload.js';
import { resolveIndustryPack, hasIndustryIdentity } from '../data/industryPacks.js';
import { ensureInviteCode, buildServiceView } from '../services/community.js';
import { referralSummary } from '../services/referral.js';
import { isFeatureEnabled } from '../services/featureFlag.js';
import { resolveWenceForm } from '../services/wence.js';
import { ATTACHMENT_CAPABILITIES } from '../services/chatImage.js';
import { hasCompletedOnboarding } from '../services/onboarding.js';
import { planFamilyKey, planTierRank, publicUsageLabel, publicUsageLevel, usageView } from '../services/planRules.js';

const AVATAR_MIME: Record<string, string> = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

export async function metaRoutes(app: FastifyInstance) {
  // 健康检查须真正探 DB：否则 DB 挂了进程还活着时仍返回 ok，部署门禁/探活会误判为健康。
  // 2s 超时保护，避免 DB 慢时把健康检查自己拖死；DB 不可达 → 503。
  //
  // 压测后补充（P0-4）：结果做 1 秒短缓存。ALB / k8s 探活频率高（常见 1–5s，且多副本各探各的），
  // 原实现是**每次探活都打一条真实 SQL**；压测里 /api/health 就占了 5% 的流量，这部分开销会直接
  // 计进容量。1s 窗口既不影响故障发现速度（探活本身还要连续失败若干次才判死），又能把 DB 压降下来。
  let dbProbe: { at: number; up: boolean } | null = null;
  async function dbUp(): Promise<boolean> {
    const now = Date.now();
    if (dbProbe && now - dbProbe.at < 1000) return dbProbe.up;
    let up = true;
    try {
      await Promise.race([
        prisma.$queryRaw`SELECT 1`,
        new Promise((_, rej) => setTimeout(() => rej(new Error('db ping timeout')), 2000)),
      ]);
    } catch (err) {
      console.error('[health] db ping failed:', (err as Error).message);
      up = false;
    }
    dbProbe = { at: now, up };
    return up;
  }

  // 存量路径：含 DB 探测，语义不变（既有 docker healthcheck / 监控都打这个）。
  app.get('/health', async (_req, reply) => {
    if (await dbUp()) return { ok: true, db: 'up' };
    return reply.code(503).send({ ok: false, db: 'down' });
  });

  // 存活探针：只回答「进程还在不在」，不碰 DB。给 ALB/k8s 的 liveness 用——
  // DB 抖动时不该把好好的进程判死重启（那只会让恢复更慢）。
  app.get('/health/live', async () => ({ ok: true }));

  // 就绪探针：含 DB，决定「要不要往这个实例发流量」。给 ALB/k8s 的 readiness 与滚动发布用。
  app.get('/health/ready', async (_req, reply) => {
    if (await dbUp()) return { ok: true, db: 'up' };
    return reply.code(503).send({ ok: false, db: 'down' });
  });

  // 当前用户 + AI 提供方信息（前端启动时拉取）
  app.get('/me', async (req) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const plan = user.planId ? await prisma.plan.findUnique({ where: { id: user.planId } }) : null;
    const credit = await prisma.creditLedger.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
    });
    const onboarded = await hasCompletedOnboarding(user);
    const understanding = await buildClientUnderstanding(user);
    const quota = await getQuotaState(user.id); // 本月 token 额度（客户端只看进度 %）
    const planStatus = await getPlanStatus(user.id); // 套餐状态：驱动前端只读模式 + 到期日/剩余天数/下次额度重置日
    const inviteCode = await ensureInviteCode(user.id).catch(() => undefined); // V7-13：邀请码（惰性生成）
    // 我的邀请读数（直邀数 / 已开通数 / 我的上级）。
    // 读失败一律回 null 而不是零值对象：前端据此显示「—」，与「真的还没邀到人（0）」区分开——
    // 把读失败画成 0 会让人以为自己邀的人没被记上（allSettled 静默兜底踩过这个坑）。
    const referral = inviteCode
      ? await referralSummary(user.id, inviteCode).catch((err) => {
          req.log?.warn?.(`[referral] summary 读取失败: ${(err as Error).message}`);
          return null;
        })
      : null;
    const service = await buildServiceView(user.id).catch(() => null); // V7-13：社群服务分配
    // P0-2：命理总开关下发前端（合规开关直读 DB，不吃 60s 缓存窗口）——前端据此隐藏全部命理入口
    const fortune = await isFeatureEnabled('fortune');
    // 连续主线逃生开关：默认开；关闭后客户端跨 24h 创建新 Session，服务端仍用 handoff 继承上下文。
    const conversationContinuity = await isFeatureEnabled('conversation-continuity', true);
    // 问策入口 WP1：A/B 分组由服务端稳定分桶后下发，客户端不猜（开关关闭 → control = 现状）。
    const wenceForm = await resolveWenceForm(user.id);
    return {
      user: {
        id: user.id,
        name: user.name,
        role: user.role,
        benmingColor: user.benmingColor,
        avatarUrl: user.avatarUrl,
        phone: user.phone.startsWith('wx_') ? '' : user.phone, // wx_ 占位号不外露：空串表示尚未绑定手机
        wechatLinked: !!user.wechatOpenId,
      },
      tenant: { id: user.tenant.id, name: user.tenant.name, industry: user.tenant.industry, stage: user.tenant.stage },
      // 已解析的行业身份（命中行业包才返回，「其他」/无/不可识别 → null）：供前端展示「· SaaS」行业徽标。
      // 注：此段 2026-06-25 曾直接改在生产上（行业身份 L1 上线），2026-07-03 移植回仓库对齐。
      industry: hasIndustryIdentity(user.tenant.industry)
        ? { code: resolveIndustryPack(user.tenant.industry).key, label: resolveIndustryPack(user.tenant.industry).label }
        : null,
      plan: plan ? {
        id: plan.id, name: plan.name, creditsPerMonth: plan.creditsPerMonth, tokenQuotaPerMonth: plan.tokenQuotaPerMonth,
        planFamilyKey: planFamilyKey(plan), tierRank: planTierRank(plan), period: plan.period,
        usageLevel: publicUsageLevel(plan), usageLabel: publicUsageLabel(plan), purchaseMode: 'manual' as const,
      } : null,
      creditBalance: credit?.balance ?? 0,
      // packRemaining：增购算力包剩余（永久有效直到用完）；used 只算月度部分，remaining 含 pack。
      tokenQuota: { limit: quota.quota, used: quota.used, remaining: quota.balance, unlimited: quota.unlimited, packRemaining: quota.packBalance },
      usage: usageView(quota, planStatus.nextResetAt, plan),
      planStatus, // { active, expired, expiresAt, daysRemaining, nextResetAt } —— 前端据此切只读态、展示到期/重置日
      onboarded,
      ai: await providerInfo(),
      understanding,
      inviteCode,
      referral,
      service,
      features: { fortune, wenceForm, conversationContinuity },
      capabilities: { attachments: ATTACHMENT_CAPABILITIES },
    };
  });

  // 军师记忆库（P2）：主公档案页「军师记事」六类结构化呈现
  app.get('/me/memory-library', async (req) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    return buildMemoryLibrary(user.id);
  });

  // 完整履历（P3）：读缓存
  app.get('/me/dossier', async (req) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    return loadDossier(user.id);
  });
  // 完整履历（P3）：生成并缓存（LLM 优先、确定性兜底）
  app.post('/me/dossier/generate', async (req) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const report = await generateDossier(user.id, user.tenantId);
    return { report, generatedAt: report.generatedAt };
  });

  // 钻石(点)消耗明细：解锁 / 图片按张 / 充值 / 赠送 流水（客户端「钻石管理」展示）
  app.get('/me/credits', async (req) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const rows = await prisma.creditLedger.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return {
      items: rows.map((r) => ({ at: r.createdAt.toISOString(), reason: r.reason, delta: r.delta, balance: r.balance })),
    };
  });

  // 更新本命色
  app.put<{ Body: { color: string } }>('/me/color', async (req) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    await prisma.user.update({ where: { id: user.id }, data: { benmingColor: req.body.color } });
    await recordAudit({ tenantId: user.tenantId, userId: user.id, action: 'user.color.update', payload: { color: req.body.color } });
    return { ok: true, color: req.body.color };
  });

  // 更新身份：称呼(name) + 公司/品牌(company=租户名) + 头像(avatarUrl)。首登建档 / 完善资料 / 「设置」都走这里。
  app.put<{ Body: { name?: string; company?: string; avatarUrl?: string } }>('/me', async (req) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const name = typeof req.body.name === 'string' ? req.body.name.trim().slice(0, 20) : undefined;
    const company = typeof req.body.company === 'string' ? req.body.company.trim().slice(0, 40) : undefined;
    const avatarUrl = typeof req.body.avatarUrl === 'string' ? req.body.avatarUrl.trim().slice(0, 500) : undefined;
    const userData: { name?: string; avatarUrl?: string } = {};
    if (name !== undefined) userData.name = name;
    if (avatarUrl !== undefined) userData.avatarUrl = avatarUrl;
    if (Object.keys(userData).length) await prisma.user.update({ where: { id: user.id }, data: userData });
    if (company !== undefined) await prisma.tenant.update({ where: { id: user.tenantId }, data: { name: company } });
    await recordAudit({
      tenantId: user.tenantId, userId: user.id, action: 'user.identity.update',
      payload: { nameSet: name !== undefined, companySet: company !== undefined, avatarSet: avatarUrl !== undefined },
    });
    return { ok: true, name, company, avatarUrl };
  });

  // 上传头像（multipart 单文件）→ OSS public-read → 落库 user.avatarUrl，返回公网链接。
  // 微信「头像昵称填写能力」chooseAvatar 拿到的是临时文件，需上传到自有存储才能长期展示。
  app.post('/me/avatar', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    if (!ossConfigured()) return reply.code(503).send({ error: '头像存储未配置', code: 'OSS_NOT_CONFIGURED' });
    let data;
    try { data = await req.file(); } catch { return reply.code(413).send({ error: '图片过大（上限 5MB）' }); }
    if (!data) return reply.code(400).send({ error: '未收到图片' });
    const ext = AVATAR_MIME[data.mimetype];
    if (!ext) return reply.code(400).send({ error: '仅支持 JPG / PNG / WebP 图片', code: 'AVATAR_BAD_TYPE' });
    let buf: Buffer;
    try { buf = await data.toBuffer(); } catch { return reply.code(413).send({ error: '图片过大（上限 5MB）' }); }
    if (data.file.truncated || buf.length > 5 * 1024 * 1024) return reply.code(413).send({ error: '图片过大（上限 5MB）' });
    if (!buf.length) return reply.code(400).send({ error: '空文件' });
    // 文件名带 user 维度，覆盖式存储（key 含 createdAt 时间戳避免 CDN 缓存旧图）。
    const key = `avatars/${user.id}/${Date.now()}.${ext}`;
    let avatarUrl: string;
    try {
      avatarUrl = await ossPutPublic(key, buf, data.mimetype);
    } catch {
      return reply.code(502).send({ error: '头像上传失败，请稍后再试', code: 'AVATAR_UPLOAD_FAILED' });
    }
    await prisma.user.update({ where: { id: user.id }, data: { avatarUrl } });
    await recordAudit({ tenantId: user.tenantId, userId: user.id, action: 'user.avatar.update', payload: { ok: true } });
    return { ok: true, avatarUrl };
  });

  // 注销账号（合规：彻底删除账号及其数据）。本应用 1 用户 ≈ 1 租户，独占租户时连同租户数据一并清除。
  app.delete('/me', async (req) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const tenantId = user.tenantId;
    // 删除前先记一条 null-租户审计（不会被下面按租户清除）
    await recordAudit({ userId: user.id, action: 'user.account.delete', payload: { tenantId } }).catch(() => {});
    const others = await prisma.user.count({ where: { tenantId, id: { not: user.id } } });
    await prisma.$transaction(async (tx) => {
      if (others === 0) {
        // 独占租户：按外键顺序清空该租户全部业务数据
        await tx.deliverable.deleteMany({ where: { tenantId } });
        await tx.message.deleteMany({ where: { session: { tenantId } } });
        await tx.reportDoc.deleteMany({ where: { tenantId } }); // 级联 reportVersion
        await tx.knowledgeItem.deleteMany({ where: { tenantId } }); // 级联 knowledgeChunk
        await tx.session.deleteMany({ where: { tenantId } });
        await tx.memory.deleteMany({ where: { tenantId } });
        await tx.project.deleteMany({ where: { tenantId } });
        // 邀请关系与归因：凡涉及本人的行全部删掉——不只是「我的上级」，也包括
        // 「我作为别人上级」的那些边（它们的 referrerId / lv1~lv3 里写着我的 userId）。
        // 留着会有两个后果：① 带 IP·UA 的归因记录在注销后仍永久留库，违反注销口径；
        // ② 别人的 directCount 会继续把已注销账号数进去，读数与事实不符。
        await tx.referral.deleteMany({ where: { OR: [{ userId: user.id }, { referrerId: user.id }, { lv1: user.id }, { lv2: user.id }, { lv3: user.id }] } });
        await tx.referralAttribution.deleteMany({ where: { OR: [{ newUserId: user.id }, { referrerId: user.id }] } });
        await tx.creditLedger.deleteMany({ where: { tenantId } });
        await tx.tokenUsage.deleteMany({ where: { tenantId } });
        await tx.tokenWallet.deleteMany({ where: { tenantId } });
        await tx.monthlyCreditGrant.deleteMany({ where: { tenantId } });
        await tx.tokenQuotaAdjustment.deleteMany({ where: { tenantId } });
        await tx.planEntitlement.deleteMany({ where: { tenantId } });
        await tx.skuEntitlement.deleteMany({ where: { tenantId } });
        await tx.profile.deleteMany({ where: { tenantId } });
        await tx.auditLog.deleteMany({ where: { tenantId } });
        await tx.userAgent.deleteMany({ where: { userId: user.id } });
        await tx.user.delete({ where: { id: user.id } });
        await tx.tenant.delete({ where: { id: tenantId } });
      } else {
        // 多人租户：仅删除该用户自身相关数据
        await tx.userAgent.deleteMany({ where: { userId: user.id } });
        await tx.creditLedger.deleteMany({ where: { userId: user.id } });
        await tx.tokenUsage.deleteMany({ where: { userId: user.id } });
        await tx.tokenWallet.deleteMany({ where: { userId: user.id } });
        await tx.monthlyCreditGrant.deleteMany({ where: { userId: user.id } });
        await tx.tokenQuotaAdjustment.deleteMany({ where: { userId: user.id } });
        await tx.planEntitlement.deleteMany({ where: { userId: user.id } });
        await tx.skuEntitlement.deleteMany({ where: { userId: user.id } });
        await tx.deliverable.deleteMany({ where: { userId: user.id } });
        await tx.session.deleteMany({ where: { userId: user.id } });
        await tx.memory.deleteMany({ where: { userId: user.id } });
        await tx.user.delete({ where: { id: user.id } });
      }
    });
    return { ok: true };
  });
}
