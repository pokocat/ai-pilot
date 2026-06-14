// 账号体系：微信小程序用 openid/unionid/本机号登录；手机号短信登录保留免码兼容兜底。
// 新账号自动建独立租户(Tenant)+用户(User)，业务数据按 tenantId/userId 行级隔离。
// 生产仍应把自有登录态替换为 JWT；此处 token 直接复用 userId。
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { code2Session, wechatAccountKey, getPhoneNumberByCode } from '../services/wechat.js';
import { issueSmsCode, verifySmsCode } from '../services/sms.js';
import { recordAudit } from '../services/audit.js';
import { suggestAliasName } from '../data/aliasNames.js';

const phoneRule = z.string().regex(/^1\d{10}$/, '请输入有效的手机号');
const loginSchema = z.object({
  phone: phoneRule,
  name: z.string().trim().min(1).max(20).optional(),
  code: z.string().trim().regex(/^\d{4,8}$/, '验证码格式不正确').optional(), // 短信验证码；按场景可选/必填
});
const smsSendSchema = z.object({ phone: phoneRule });
const wechatLoginSchema = z.object({
  code: z.string().trim().min(1, '缺少微信登录 code'),
  nickname: z.string().trim().min(1).max(40).optional(),
  avatarUrl: z.string().url().optional(),
});
const wechatPhoneSchema = z.object({
  phoneCode: z.string().trim().min(1, '缺少手机号 code'), // getPhoneNumber 返回的一次性 code
  loginCode: z.string().trim().min(1).optional(),         // wx.login 的 code，可选：用于顺带关联 openid
  name: z.string().trim().min(1).max(20).optional(),
});

/** 取客户端 IP（优先 X-Forwarded-For 首段）。 */
function clientIp(req: FastifyRequest): string {
  const xff = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim();
  return xff || req.ip;
}

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

/** 按手机号登录或注册（短信登录 / 微信一键登录 / 未来运营商一键登录共用）。 */
async function loginOrRegisterByPhone(phone: string, name?: string): Promise<{ user: AuthUser; isNew: boolean }> {
  const existing = await prisma.user.findUnique({ where: { phone } });
  if (existing) {
    await recordAudit({ tenantId: existing.tenantId, userId: existing.id, action: 'auth.login', payload: { phone } });
    return { user: existing, isNew: false };
  }
  // 不编造称呼/公司：未填留空，由首登建档采集。
  const user = await createUserWithTenant({ phone, name: name?.trim() || '', auditAction: 'auth.register', auditPayload: { phone } });
  return { user, isNew: true };
}

/** 尽力把 openid 关联到当前手机号账号；若该 openid 已被其他账号占用（唯一约束冲突）则跳过，不阻断登录。 */
async function linkWechatBestEffort(user: AuthUser, openid: string, unionid?: string): Promise<AuthUser> {
  if (user.wechatOpenId && (!unionid || user.wechatUnionId)) return user;
  try {
    return await prisma.user.update({
      where: { id: user.id },
      data: {
        wechatOpenId: user.wechatOpenId || openid,
        wechatUnionId: user.wechatUnionId || unionid,
        wechatLinkedAt: user.wechatLinkedAt || new Date(),
      },
    });
  } catch {
    return user; // 唯一约束冲突等 → 保持未关联，手机号登录已成功
  }
}

export async function authRoutes(app: FastifyInstance) {
  app.get('/auth/suggest-name', async () => ({
    name: suggestAliasName(),
    source: '古典武侠/军事花名',
  }));

  // 发送短信验证码：限频 + 落库（哈希）+ 发送。console 演示口径会把验证码随响应回传（devCode）。
  app.post('/auth/sms/send', async (req, reply) => {
    const parsed = smsSendSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? '参数错误' });
    try {
      return await issueSmsCode(parsed.data.phone, clientIp(req));
    } catch (e) {
      const err = e as { statusCode?: number; message?: string; code?: string };
      return reply.code(err.statusCode || 500).send({ error: err.message || '验证码发送失败', code: err.code || 'SMS_SEND_FAILED' });
    }
  });

  app.post('/auth/login', async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? '参数错误' });
    }
    const { phone, name, code } = parsed.data;

    // 验证码校验：传了 code 就校验；生产可置 SMS_REQUIRE_CODE=true 强制要求。
    // 默认不强制：保留演示/测试免码登录（与既有 login() 测试辅助兼容）。
    if (code !== undefined || env.smsRequireCode) {
      if (!code) return reply.code(400).send({ error: '请输入验证码', code: 'SMS_CODE_REQUIRED' });
      const ok = await verifySmsCode(phone, code);
      if (!ok) return reply.code(400).send({ error: '验证码错误或已过期', code: 'SMS_CODE_INVALID' });
    }

    const { user, isNew } = await loginOrRegisterByPhone(phone, name);
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

  // 本机号一键登录：getPhoneNumber 的 phoneCode 换手机号 → 统一登录建号；可选 loginCode 顺带关联 openid。
  app.post('/auth/wechat-phone', async (req, reply) => {
    const parsed = wechatPhoneSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? '参数错误' });
    try {
      const phone = await getPhoneNumberByCode(parsed.data.phoneCode);
      let openid: string | undefined, unionid: string | undefined;
      if (parsed.data.loginCode) {
        try { const wx = await code2Session(parsed.data.loginCode); openid = wx.openid; unionid = wx.unionid; } catch { /* 关联失败不阻断登录 */ }
      }
      const { user, isNew } = await loginOrRegisterByPhone(phone, parsed.data.name);
      const linked = openid ? await linkWechatBestEffort(user, openid, unionid) : user;
      await recordAudit({ tenantId: linked.tenantId, userId: linked.id, action: isNew ? 'auth.onetap_register' : 'auth.onetap_login', payload: { onetap: 'wechat', linked: !!openid } });
      return loginResult(linked, isNew, await onboardedOf(linked));
    } catch (e) {
      const err = e as { message?: string; statusCode?: number; code?: string };
      return reply.code(err.statusCode || 500).send({ error: err.message || '一键登录失败', code: err.code || 'WECHAT_PHONE_LOGIN_FAILED' });
    }
  });

  // ───────────────── 预留：原生 App 运营商「本机号码一键登录」 ─────────────────
  // 小程序沙箱接不了运营商 SDK，此入口供未来原生 App（iOS/Android）使用：
  //   App 端用「阿里云号码认证 / 极光认证」等 SDK 拿到一次性 token，POST 到这里；
  //   后端调对应运营商服务端「取号」接口换出手机号，再走 loginOrRegisterByPhone 统一建号。
  // 接好 SDK 后：把下面 501 替换为
  //   const phone = await verifyCarrierToken(parsed.data.provider, parsed.data.token);
  //   const { user, isNew } = await loginOrRegisterByPhone(phone, parsed.data.name);
  //   return loginResult(user, isNew, await onboardedOf(user));
  const carrierSchema = z.object({
    provider: z.enum(['cmcc', 'cucc', 'ctcc', 'aliyun', 'jiguang']).optional(),
    token: z.string().trim().min(1, '缺少运营商 token'),
    name: z.string().trim().min(1).max(20).optional(),
  });
  app.post('/auth/carrier-onetap', async (req, reply) => {
    const parsed = carrierSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? '参数错误' });
    return reply.code(501).send({ error: '运营商一键登录待原生 App 接入', code: 'CARRIER_ONETAP_NOT_IMPLEMENTED' });
  });
}
