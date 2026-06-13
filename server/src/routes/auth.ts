// 账号体系：微信小程序用 openid/unionid 登录；手机号 fake 登录保留为演示/兜底。
// 新账号自动建独立租户(Tenant)+用户(User)，业务数据按 tenantId/userId 行级隔离。
// 生产仍应把自有登录态替换为 JWT；此处 token 直接复用 userId。
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { code2Session, wechatAccountKey } from '../services/wechat.js';
import { recordAudit } from '../services/audit.js';
import { suggestAliasName } from '../data/aliasNames.js';

const loginSchema = z.object({
  phone: z.string().regex(/^1\d{10}$/, '请输入有效的手机号'),
  name: z.string().trim().min(1).max(20).optional(),
  code: z.string().optional(), // fake 验证码，暂不校验
});
const wechatLoginSchema = z.object({
  code: z.string().trim().min(1, '缺少微信登录 code'),
  nickname: z.string().trim().min(1).max(40).optional(),
  avatarUrl: z.string().url().optional(),
});

type AuthUser = {
  id: string;
  tenantId: string;
  phone: string;
  name: string;
  benmingColor: string;
  wechatOpenId?: string | null;
  wechatUnionId?: string | null;
  wechatLinkedAt?: Date | null;
};

async function createUserWithTenant(opts: {
  phone: string;
  name: string;
  auditAction: string;
  auditPayload: object;
  wechatOpenId?: string;
  wechatUnionId?: string;
}): Promise<AuthUser> {
  const plan = await prisma.plan.findFirst({ orderBy: { sort: 'asc' } });
  const tenant = await prisma.tenant.create({ data: { name: '' } });
  const user = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      phone: opts.phone,
      name: opts.name,
      role: 'owner',
      benmingColor: 'gold',
      planId: plan?.id ?? null,
      wechatOpenId: opts.wechatOpenId,
      wechatUnionId: opts.wechatUnionId,
      wechatLinkedAt: opts.wechatOpenId ? new Date() : undefined,
    },
  });
  if (plan) {
    await prisma.creditLedger.create({
      data: {
        tenantId: tenant.id,
        userId: user.id,
        delta: plan.creditsPerMonth,
        reason: `${plan.name} · 开通赠送`,
        balance: plan.creditsPerMonth,
      },
    });
  }
  await prisma.auditLog
    .create({ data: { tenantId: tenant.id, userId: user.id, action: opts.auditAction, payloadJson: opts.auditPayload } })
    .catch(() => {});
  return user;
}

async function onboardedOf(user: AuthUser): Promise<boolean> {
  return !!(await prisma.profile.findFirst({ where: { tenantId: user.tenantId } }));
}

function loginResult(user: AuthUser, isNew: boolean, onboarded: boolean) {
  return {
    token: user.id, // fake token = userId（演示用）
    isNew,
    onboarded,
    user: {
      id: user.id,
      name: user.name,
      phone: user.phone.startsWith('wx_') ? '' : user.phone,
      benmingColor: user.benmingColor,
      wechatLinked: !!user.wechatOpenId,
    },
  };
}

export async function authRoutes(app: FastifyInstance) {
  app.get('/auth/suggest-name', async () => ({
    name: suggestAliasName(),
    source: '古典武侠/军事花名',
  }));

  app.post('/auth/login', async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? '参数错误' });
    }
    const { phone, name } = parsed.data;

    let user: AuthUser | null = await prisma.user.findUnique({ where: { phone } });
    let isNew = false;
    if (!user) {
      isNew = true;
      // 不再编造「用户1234」这类随机名；称呼/公司在首登建档采集，未填则留空由前端走「完善资料」态。
      user = await createUserWithTenant({
        phone,
        name: name?.trim() || '',
        auditAction: 'auth.register',
        auditPayload: { phone },
      });
    } else {
      await recordAudit({ tenantId: user.tenantId, userId: user.id, action: 'auth.login', payload: { phone } });
    }

    return loginResult(user, isNew, await onboardedOf(user));
  });

  app.post('/auth/wechat-login', async (req, reply) => {
    const parsed = wechatLoginSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? '参数错误' });
    }

    try {
      const wx = await code2Session(parsed.data.code);
      const conditions = [{ wechatOpenId: wx.openid }, ...(wx.unionid ? [{ wechatUnionId: wx.unionid }] : [])];
      let user: AuthUser | null = await prisma.user.findFirst({ where: { OR: conditions } });
      let isNew = false;

      if (!user) {
        isNew = true;
        // 微信昵称多为匿名「微信用户」，不可靠；留空，首登建档采集真实称呼。
        const name = parsed.data.nickname?.trim() || '';
        user = await createUserWithTenant({
          phone: wechatAccountKey(wx.openid),
          name,
          auditAction: 'auth.wechat_register',
          auditPayload: { wechat: true, unionid: !!wx.unionid },
          wechatOpenId: wx.openid,
          wechatUnionId: wx.unionid,
        });
      } else if (!user.wechatOpenId || (wx.unionid && !user.wechatUnionId)) {
        user = await prisma.user.update({
          where: { id: user.id },
          data: {
            wechatOpenId: user.wechatOpenId || wx.openid,
            wechatUnionId: user.wechatUnionId || wx.unionid,
            wechatLinkedAt: user.wechatLinkedAt || new Date(),
          },
        });
      }
      if (!isNew) {
        await recordAudit({ tenantId: user.tenantId, userId: user.id, action: 'auth.wechat_login', payload: { wechat: true, unionid: !!wx.unionid } });
      }

      return loginResult(user, isNew, await onboardedOf(user));
    } catch (e) {
      const err = e as { message?: string; statusCode?: number; code?: string };
      return reply.code(err.statusCode || 500).send({ error: err.message || '微信登录失败', code: err.code || 'WECHAT_LOGIN_FAILED' });
    }
  });
}
