// 账号体系：微信小程序用 openid/unionid/本机号登录；手机号短信登录保留免码兼容兜底。
// 新账号自动建独立租户(Tenant)+用户(User)，业务数据按 tenantId/userId 行级隔离。
// 登录态 token 经 services/userToken.ts：配 APP_JWT_SECRET 后签发 HS256 JWT，
// 未配则回退历史口径 token=userId（校验侧同样兼容，平滑过渡）。
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { code2Session, wechatAccountKey, getPhoneNumberByCode } from '../services/wechat.js';
import { issueSmsCode, verifySmsCode } from '../services/sms.js';
import { signUserToken } from '../services/userToken.js';
import { resolveUser } from '../services/context.js';
import { maskAuditPhone, recordAudit, requestMeta, summarizeForAudit } from '../services/audit.js';
import { suggestAliasName } from '../data/aliasNames.js';

const phoneRule = z.string().regex(/^1\d{10}$/, '请输入有效的手机号');
const loginSchema = z.object({
  phone: phoneRule,
  name: z.string().trim().min(1).max(20).optional(),
  code: z.string().trim().regex(/^\d{4,8}$/, '验证码格式不正确').optional(), // 短信验证码；按场景可选/必填
});
const smsSendSchema = z.object({
  phone: phoneRule,
  scene: z.enum(['login', 'bind']).optional(), // login=登录验证码；bind=微信账号绑定手机号
});
const bindPhoneSchema = z.object({
  phoneCode: z.string().trim().min(1).optional(),                 // 微信一键：getPhoneNumber 返回的一次性 code
  phone: phoneRule.optional(),                                    // 短信兜底：手机号
  code: z.string().trim().regex(/^\d{4,8}$/, '验证码格式不正确').optional(), // 短信兜底：验证码
});
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
  avatarUrl?: string | null;
  benmingColor: string;
  wechatOpenId?: string | null;
  wechatUnionId?: string | null;
  wechatLinkedAt?: Date | null;
};

function authAttemptPayload(req: FastifyRequest, extra: Record<string, unknown>): Prisma.InputJsonValue {
  return summarizeForAudit({ ...extra, request: requestMeta(req) }) as Prisma.InputJsonValue;
}

async function recordAuthAttempt(
  req: FastifyRequest,
  action: string,
  extra: Record<string, unknown>,
  user?: Pick<AuthUser, 'id' | 'tenantId'> | null,
) {
  await recordAudit({
    tenantId: user?.tenantId,
    userId: user?.id,
    action,
    payload: authAttemptPayload(req, extra),
  });
}

function phoneAudit(phone?: string | null) {
  return {
    phoneMasked: maskAuditPhone(phone),
    phoneTail: phone && /^1\d{10}$/.test(phone) ? phone.slice(-4) : null,
  };
}

async function createUserWithTenant(opts: {
  phone: string;
  name: string;
  auditAction: string;
  auditPayload: object;
  avatarUrl?: string;
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
      avatarUrl: opts.avatarUrl,
      role: 'owner',
      benmingColor: 'green',
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
    token: signUserToken(user.id), // 配 APP_JWT_SECRET → 签发 JWT；未配 → 返回 userId（历史兼容）
    isNew,
    onboarded,
    user: {
      id: user.id,
      name: user.name,
      phone: user.phone.startsWith('wx_') ? '' : user.phone,
      avatarUrl: user.avatarUrl ?? null,
      benmingColor: user.benmingColor,
      wechatLinked: !!user.wechatOpenId,
    },
  };
}

/** 按手机号登录或注册（短信登录 / 微信一键登录 / 未来运营商一键登录共用）。 */
async function loginOrRegisterByPhone(phone: string, name?: string): Promise<{ user: AuthUser; isNew: boolean }> {
  const existing = await prisma.user.findUnique({ where: { phone } });
  if (existing) {
    await recordAudit({ tenantId: existing.tenantId, userId: existing.id, action: 'auth.login', payload: phoneAudit(phone) });
    return { user: existing, isNew: false };
  }
  // 不编造称呼/公司：未填留空，由首登建档采集。
  const user = await createUserWithTenant({ phone, name: name?.trim() || '', auditAction: 'auth.register', auditPayload: phoneAudit(phone) });
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
  // 按 IP 收紧：SMS 发送是成本+轰炸型接口。既有 sms.ts 已按手机号限频（60s 冷却 + 5 条/小时），
  // 这里再叠一层按 IP 的频控，挡「换号池、同 IP 批量轰炸」。（rate-limit 未注册的测试环境此 config 被忽略。）
  app.post('/auth/sms/send', { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } }, async (req, reply) => {
    const parsed = smsSendSchema.safeParse(req.body);
    if (!parsed.success) {
      await recordAuthAttempt(req, 'auth.sms.send_attempt', {
        ok: false,
        statusCode: 400,
        reason: 'validation',
        error: parsed.error.issues[0]?.message ?? '参数错误',
        body: summarizeForAudit(req.body),
      });
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? '参数错误' });
    }
    const scene = parsed.data.scene ?? 'login';
    try {
      const out = await issueSmsCode(parsed.data.phone, clientIp(req), scene);
      await recordAuthAttempt(req, 'auth.sms.send_attempt', {
        ok: true,
        statusCode: 200,
        ...phoneAudit(parsed.data.phone),
        scene,
        provider: process.env.SMS_PROVIDER || 'console',
        devCodeReturned: typeof out === 'object' && out !== null && 'devCode' in out,
      });
      return out;
    } catch (e) {
      const err = e as { statusCode?: number; message?: string; code?: string };
      await recordAuthAttempt(req, 'auth.sms.send_attempt', {
        ok: false,
        statusCode: err.statusCode || 500,
        ...phoneAudit(parsed.data.phone),
        errorCode: err.code || 'SMS_SEND_FAILED',
        error: err.message || '验证码发送失败',
      });
      return reply.code(err.statusCode || 500).send({ error: err.message || '验证码发送失败', code: err.code || 'SMS_SEND_FAILED' });
    }
  });

  // 免费注册防薅：登录/注册按 IP 频控（唯一门槛此前只有「一手机号一账号」，无 IP/设备频控 → 号池可批量薅
  // 免费钻石+额度，见售卖前体检 P1）。20 次/10 分钟对 NAT 后正常多用户仍宽松，但挡住脚本化批量建号。
  app.post('/auth/login', { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      await recordAuthAttempt(req, 'auth.login.attempt', {
        ok: false,
        statusCode: 400,
        reason: 'validation',
        error: parsed.error.issues[0]?.message ?? '参数错误',
        body: summarizeForAudit(req.body),
      });
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? '参数错误' });
    }
    const { phone, name, code } = parsed.data;

    // 验证码校验：传了 code 就校验；生产可置 SMS_REQUIRE_CODE=true 强制要求。
    // 默认不强制：保留演示/测试免码登录（与既有 login() 测试辅助兼容）。
    if (code !== undefined || env.smsRequireCode) {
      if (!code) {
        await recordAuthAttempt(req, 'auth.login.attempt', {
          ok: false,
          statusCode: 400,
          ...phoneAudit(phone),
          hasCode: false,
          smsRequired: true,
          errorCode: 'SMS_CODE_REQUIRED',
        });
        return reply.code(400).send({ error: '请输入验证码', code: 'SMS_CODE_REQUIRED' });
      }
      const ok = await verifySmsCode(phone, code);
      if (!ok) {
        await recordAuthAttempt(req, 'auth.login.attempt', {
          ok: false,
          statusCode: 400,
          ...phoneAudit(phone),
          hasCode: true,
          smsRequired: env.smsRequireCode,
          errorCode: 'SMS_CODE_INVALID',
        });
        return reply.code(400).send({ error: '验证码错误或已过期', code: 'SMS_CODE_INVALID' });
      }
    }

    const { user, isNew } = await loginOrRegisterByPhone(phone, name);
    await recordAuthAttempt(req, 'auth.login.attempt', {
      ok: true,
      statusCode: 200,
      ...phoneAudit(phone),
      hasCode: code !== undefined,
      smsRequired: env.smsRequireCode,
      isNew,
    }, user);
    return loginResult(user, isNew, await onboardedOf(user));
  });

  app.post('/auth/wechat-login', async (req, reply) => {
    const parsed = wechatLoginSchema.safeParse(req.body);
    if (!parsed.success) {
      await recordAuthAttempt(req, 'auth.wechat_login.attempt', {
        ok: false,
        statusCode: 400,
        reason: 'validation',
        error: parsed.error.issues[0]?.message ?? '参数错误',
        body: summarizeForAudit(req.body),
      });
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
          avatarUrl: parsed.data.avatarUrl, // 客户端「头像昵称填写能力」选取并上传后回传的公网链接（可选）
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
      await recordAuthAttempt(req, 'auth.wechat_login.attempt', {
        ok: true,
        statusCode: 200,
        wechat: true,
        unionid: !!wx.unionid,
        nicknameProvided: !!parsed.data.nickname,
        isNew,
      }, user);

      return loginResult(user, isNew, await onboardedOf(user));
    } catch (e) {
      const err = e as { message?: string; statusCode?: number; code?: string };
      await recordAuthAttempt(req, 'auth.wechat_login.attempt', {
        ok: false,
        statusCode: err.statusCode || 500,
        hasCode: !!parsed.data.code,
        errorCode: err.code || 'WECHAT_LOGIN_FAILED',
        error: err.message || '微信登录失败',
      });
      return reply.code(err.statusCode || 500).send({ error: err.message || '微信登录失败', code: err.code || 'WECHAT_LOGIN_FAILED' });
    }
  });

  // 本机号一键登录：getPhoneNumber 的 phoneCode 换手机号 → 统一登录建号；可选 loginCode 顺带关联 openid。
  app.post('/auth/wechat-phone', async (req, reply) => {
    const parsed = wechatPhoneSchema.safeParse(req.body);
    if (!parsed.success) {
      await recordAuthAttempt(req, 'auth.wechat_phone.attempt', {
        ok: false,
        statusCode: 400,
        reason: 'validation',
        error: parsed.error.issues[0]?.message ?? '参数错误',
        body: summarizeForAudit(req.body),
      });
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? '参数错误' });
    }
    try {
      const phone = await getPhoneNumberByCode(parsed.data.phoneCode);
      let openid: string | undefined, unionid: string | undefined;
      if (parsed.data.loginCode) {
        try { const wx = await code2Session(parsed.data.loginCode); openid = wx.openid; unionid = wx.unionid; } catch { /* 关联失败不阻断登录 */ }
      }

      // 先按 openid/unionid 找已有微信账号（与 /auth/wechat-login 同一套识别口径）——
      // 避免同一个人先用「微信一键登录」建号（phone=wx_<openid> 占位）、
      // 后用本机号一键登录时按手机号查不到旧号从而另建新号，导致身份永久分裂。
      const byWechat = openid
        ? await prisma.user.findFirst({ where: { OR: [{ wechatOpenId: openid }, ...(unionid ? [{ wechatUnionId: unionid }] : [])] } })
        : null;

      let user: AuthUser;
      let isNew: boolean;
      if (byWechat) {
        isNew = false;
        if (byWechat.phone === phone) {
          user = byWechat;
        } else {
          const taken = await prisma.user.findUnique({ where: { phone } });
          if (taken && taken.id !== byWechat.id) {
            await recordAuthAttempt(req, 'auth.wechat_phone.attempt', { ok: false, statusCode: 409, ...phoneAudit(phone), onetap: 'wechat', errorCode: 'PHONE_TAKEN' });
            return reply.code(409).send({ error: '该手机号已被其他账号使用', code: 'PHONE_TAKEN' });
          }
          try {
            user = await prisma.user.update({ where: { id: byWechat.id }, data: { phone } });
          } catch {
            await recordAuthAttempt(req, 'auth.wechat_phone.attempt', { ok: false, statusCode: 409, ...phoneAudit(phone), onetap: 'wechat', errorCode: 'PHONE_TAKEN' });
            return reply.code(409).send({ error: '该手机号已被其他账号使用', code: 'PHONE_TAKEN' });
          }
        }
      } else {
        ({ user, isNew } = await loginOrRegisterByPhone(phone, parsed.data.name));
        user = openid ? await linkWechatBestEffort(user, openid, unionid) : user;
      }

      await recordAudit({ tenantId: user.tenantId, userId: user.id, action: isNew ? 'auth.onetap_register' : 'auth.onetap_login', payload: { onetap: 'wechat', linked: !!openid } });
      await recordAuthAttempt(req, 'auth.wechat_phone.attempt', {
        ok: true,
        statusCode: 200,
        ...phoneAudit(phone),
        onetap: 'wechat',
        linked: !!openid,
        unionid: !!unionid,
        isNew,
      }, user);
      return loginResult(user, isNew, await onboardedOf(user));
    } catch (e) {
      const err = e as { message?: string; statusCode?: number; code?: string };
      await recordAuthAttempt(req, 'auth.wechat_phone.attempt', {
        ok: false,
        statusCode: err.statusCode || 500,
        hasPhoneCode: !!parsed.data.phoneCode,
        hasLoginCode: !!parsed.data.loginCode,
        errorCode: err.code || 'WECHAT_PHONE_LOGIN_FAILED',
        error: err.message || '一键登录失败',
      });
      return reply.code(err.statusCode || 500).send({ error: err.message || '一键登录失败', code: err.code || 'WECHAT_PHONE_LOGIN_FAILED' });
    }
  });

  // 绑定手机号（微信登录后强制）：微信账号补绑真实手机号。需登录态。
  // 两种取号：①微信一键 phoneCode（getPhoneNumber）②短信 scene=bind 的 phone+code。
  // 该手机号若已被其他账号占用 → 409，不允许跨账号顶号。
  app.post('/auth/bind-phone', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined); // 未登录 → 401
    const parsed = bindPhoneSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? '参数错误' });
    }

    let phone: string;
    if (parsed.data.phoneCode) {
      // ① 微信一键：用 getPhoneNumber 的 code 换微信绑定的手机号
      try {
        phone = await getPhoneNumberByCode(parsed.data.phoneCode);
      } catch (e) {
        const err = e as { message?: string; statusCode?: number; code?: string };
        await recordAuthAttempt(req, 'auth.bind_phone.attempt', { ok: false, statusCode: err.statusCode || 502, onetap: 'wechat', errorCode: err.code || 'WECHAT_PHONE_FAILED' }, user);
        return reply.code(err.statusCode || 502).send({ error: err.message || '获取手机号失败', code: err.code || 'WECHAT_PHONE_FAILED' });
      }
    } else {
      // ② 短信兜底：必须 phone + code 且 scene=bind 校验通过
      if (!parsed.data.phone || !parsed.data.code) {
        return reply.code(400).send({ error: '请提供手机号与验证码', code: 'BIND_PARAMS_MISSING' });
      }
      const ok = await verifySmsCode(parsed.data.phone, parsed.data.code, 'bind');
      if (!ok) {
        await recordAuthAttempt(req, 'auth.bind_phone.attempt', { ok: false, statusCode: 400, ...phoneAudit(parsed.data.phone), errorCode: 'SMS_CODE_INVALID' }, user);
        return reply.code(400).send({ error: '验证码错误或已过期', code: 'SMS_CODE_INVALID' });
      }
      phone = parsed.data.phone;
    }

    const taken = await prisma.user.findUnique({ where: { phone } });
    if (taken && taken.id !== user.id) {
      await recordAuthAttempt(req, 'auth.bind_phone.attempt', { ok: false, statusCode: 409, ...phoneAudit(phone), errorCode: 'PHONE_TAKEN' }, user);
      return reply.code(409).send({ error: '该手机号已被其他账号使用', code: 'PHONE_TAKEN' });
    }
    let updated: AuthUser;
    try {
      updated = await prisma.user.update({ where: { id: user.id }, data: { phone } });
    } catch {
      return reply.code(409).send({ error: '该手机号已被其他账号使用', code: 'PHONE_TAKEN' });
    }
    await recordAuthAttempt(req, 'auth.bind_phone.attempt', { ok: true, statusCode: 200, ...phoneAudit(phone) }, updated);
    return { ok: true, phone, wechatLinked: !!updated.wechatOpenId };
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
    if (!parsed.success) {
      await recordAuthAttempt(req, 'auth.carrier_onetap.attempt', {
        ok: false,
        statusCode: 400,
        reason: 'validation',
        error: parsed.error.issues[0]?.message ?? '参数错误',
        body: summarizeForAudit(req.body),
      });
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? '参数错误' });
    }
    await recordAuthAttempt(req, 'auth.carrier_onetap.attempt', {
      ok: false,
      statusCode: 501,
      provider: parsed.data.provider ?? null,
      errorCode: 'CARRIER_ONETAP_NOT_IMPLEMENTED',
    });
    return reply.code(501).send({ error: '运营商一键登录待原生 App 接入', code: 'CARRIER_ONETAP_NOT_IMPLEMENTED' });
  });
}
