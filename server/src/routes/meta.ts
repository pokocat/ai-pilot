import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { providerInfo } from '../llm/gateway.js';
import { resolveUser } from '../services/context.js';
import { recordAudit } from '../services/audit.js';
import { buildClientUnderstanding } from '../services/understanding.js';
import { getQuotaState, getPlanStatus } from '../services/tokenQuota.js';
import { ossConfigured, ossPutPublic } from '../services/ossUpload.js';

const AVATAR_MIME: Record<string, string> = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

export async function metaRoutes(app: FastifyInstance) {
  app.get('/health', async () => ({ ok: true }));

  // 当前用户 + AI 提供方信息（前端启动时拉取）
  app.get('/me', async (req) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const plan = user.planId ? await prisma.plan.findUnique({ where: { id: user.planId } }) : null;
    const credit = await prisma.creditLedger.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
    });
    const onboarded = !!(await prisma.profile.findFirst({ where: { tenantId: user.tenantId } }));
    const understanding = await buildClientUnderstanding(user);
    const quota = await getQuotaState(user.id); // 本月 token 额度（客户端只看进度 %）
    const planStatus = await getPlanStatus(user.id); // 套餐状态：驱动前端只读模式 + 到期日/剩余天数/下次额度重置日
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
      plan: plan ? { name: plan.name, creditsPerMonth: plan.creditsPerMonth, tokenQuotaPerMonth: plan.tokenQuotaPerMonth } : null,
      creditBalance: credit?.balance ?? 0,
      tokenQuota: { limit: quota.quota, used: quota.used, remaining: quota.balance, unlimited: quota.unlimited },
      planStatus, // { active, expired, expiresAt, daysRemaining, nextResetAt } —— 前端据此切只读态、展示到期/重置日
      onboarded,
      ai: await providerInfo(),
      understanding,
    };
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
        await tx.creditLedger.deleteMany({ where: { tenantId } });
        await tx.tokenUsage.deleteMany({ where: { tenantId } });
        await tx.tokenWallet.deleteMany({ where: { tenantId } });
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
        await tx.deliverable.deleteMany({ where: { userId: user.id } });
        await tx.session.deleteMany({ where: { userId: user.id } });
        await tx.memory.deleteMany({ where: { userId: user.id } });
        await tx.user.delete({ where: { id: user.id } });
      }
    });
    return { ok: true };
  });
}
