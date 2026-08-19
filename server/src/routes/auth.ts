// 账号体系：**手机号是账号的唯一登录身份键**。登录身份解析只看手机号；openid/unionid 只是
// 附着在账号上的补充绑定（快捷登录关联 + 昵称头像场景），会随每次手机号快捷登录迁到当前账号。
// 纯 openid 登录不再建号：未关联过手机号账号的 openid 直接 404 PHONE_LOGIN_REQUIRED。
// 新账号自动建独立租户(Tenant)+用户(User)，业务数据按 tenantId/userId 行级隔离。
// 登录态 token 经 services/userToken.ts：配 APP_JWT_SECRET 后签发 HS256 JWT，
// 未配则回退历史口径 token=userId（校验侧同样兼容，平滑过渡）。
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db.js';
import { env, registrationDefaultPlanName } from '../env.js';
import { code2Session, getPhoneNumberByCode } from '../services/wechat.js';
import { issueSmsCode, verifySmsCode } from '../services/sms.js';
import { signUserToken } from '../services/userToken.js';
import { resolveUser } from '../services/context.js';
import { maskAuditPhone, recordAudit, requestMeta, summarizeForAudit } from '../services/audit.js';
import { noteRegistration } from '../services/metrics.js';
import { suggestAliasName } from '../data/aliasNames.js';
import { applyPlanPurchase } from '../services/purchase.js';
import { hasCompletedOnboarding } from '../services/onboarding.js';
import { smsLoginEnabled, wechatLoginEnabled } from '../services/authConfig.js';
import {
  bindOnRegister, ReferralAlreadyBound, traceOutsideTransaction,
  type ReferralOutcome, type ReferralSource,
} from '../services/referral.js';
import { issueReferralCapture, verifyReferralCapture } from '../services/referralCapture.js';
import type { LoginPhoneBinding, LoginResult } from '../../../shared/contracts';

const phoneRule = z.string().regex(/^1\d{10}$/, '请输入有效的手机号');
// 邀请归因入参（三条建号通道共用）：捕获时间与来源只能来自服务端签名 referralToken。
// inviteCode 仍原样收下：token 缺失/损坏时要留 no_timestamp 诊断，但绝不能信客户端自报时间。
// 脏归因参数不应把登录拦成 400，因此都由 attributionOf 宽容解析。
const attributionShape = {
  inviteCode: z.unknown().optional(),
  referralToken: z.unknown().optional(),
};

const referralCaptureSchema = z.object({
  inviteCode: z.string().trim(),
  source: z.enum(['share_friend', 'share_timeline', 'poster_qr']),
});

const loginSchema = z.object({
  phone: phoneRule,
  name: z.string().trim().min(1).max(20).optional(),
  code: z.string().trim().regex(/^\d{4,8}$/, '验证码格式不正确').optional(), // 短信验证码；按场景可选/必填
  ...attributionShape,
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
  ...attributionShape,
});

/** 只取 Fastify 在 trustProxy 配置下解析出的可信 IP；绝不直接信客户端可伪造的 X-Forwarded-For 首段。 */
function clientIp(req: FastifyRequest): string {
  return req.ip;
}

/** 邀请归因入参 + 风控原料（IP / UA）。形状不合法的码直接丢掉，返回 undefined = 本次不归因。 */
interface RegisterAttribution {
  inviteCode: string;
  /** 只来自 referralToken 验签结果；缺失会落 no_timestamp 并拒绝建边。 */
  capturedAt?: number;
  source: ReferralSource;
  clientIp: string;
  userAgent: string;
}

function attributionOf(req: FastifyRequest, data: { inviteCode?: unknown; referralToken?: unknown }): RegisterAttribution | undefined {
  const rawCode = data.inviteCode;
  const capture = verifyReferralCapture(data.referralToken);
  // token 本身携带邀请码；新客户端即使请求拼装时漏了冗余 inviteCode，也能按已验签事实归因。
  if ((rawCode === undefined || rawCode === null || rawCode === '') && !capture) return undefined;
  // ② 带了但不是字符串（例如 inviteCode: 123）→ 也要往下走留一条 unknown_code，
  //    不能悄悄当成没带。转成字符串并截断，防止超长串把归因表撑大。
  const inviteCode = rawCode === undefined || rawCode === null || rawCode === ''
    ? capture!.code
    : (typeof rawCode === 'string' ? rawCode.trim() : String(rawCode)).slice(0, 64);
  // 只有 token 与请求中的码一致才采用签名事实；客户端自报 inviteCodeAt 即便仍在旧请求里也会被 zod 丢弃。
  const trustedCapture = capture?.code === inviteCode ? capture : null;
  return {
    inviteCode,
    capturedAt: trustedCapture?.capturedAt,
    source: trustedCapture?.source ?? 'share_friend',
    clientIp: clientIp(req),
    userAgent: String(req.headers['user-agent'] ?? '').slice(0, 500),
  };
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
  deletedAt?: Date | null;
  purgeAfter?: Date | null;
  createdAt: Date;
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
}): Promise<AuthUser> {
  // 2026-07-28 去免费档改版：产品不再有免费档，注册默认**不送任何套餐**（裸注册账号只读，
  // 见 app.ts 禁写闸）。唯一例外是测试期——TEST_DEFAULT_PLAN_NAME 配置后按正式购买链路
  // 开通该套餐（带激活锚点与到期日，到期由运营用 plan-extend 续或用户付费转正）。
  // 原「取排序第一的套餐白送」的回退已删：第一档现在是付费入门版，回退等于把它免费送出。
  const configuredPlanName = registrationDefaultPlanName();
  const plan = configuredPlanName
    ? await prisma.plan.findFirst({ where: { name: configuredPlanName } })
    : null;
  if (configuredPlanName && !plan) {
    throw Object.assign(new Error(`测试期默认套餐「${configuredPlanName}」不存在`), {
      statusCode: 503,
      code: 'DEFAULT_PLAN_NOT_FOUND',
    });
  }

  return prisma.$transaction(async (tx) => {
    const tenant = await tx.tenant.create({ data: { name: '' } });
    const user = await tx.user.create({
      data: {
        tenantId: tenant.id,
        phone: opts.phone,
        name: opts.name,
        role: 'owner',
        benmingColor: 'green',
      },
    });
    if (plan) {
      // 测试期开通走正式购买链路：激活锚点 + 到期日 + 钻石/额度发放与付费同源，
      // 测试期结束后这批账号自然过期转只读，不留「永久白嫖」的特殊态。
      await applyPlanPurchase(user, plan, {
        reason: `${plan.name} · 测试期开通`,
        source: 'test_default_grant',
      }, tx);
    }
    await tx.auditLog.create({
      data: { tenantId: tenant.id, userId: user.id, action: opts.auditAction, payloadJson: opts.auditPayload },
    }).catch(() => {});
    return user;
  }).then((user) => {
    noteRegistration(opts.auditAction.replace(/^auth\./, '')); // register | wechat_register
    return user;
  });
}

async function onboardedOf(user: AuthUser): Promise<boolean> {
  return hasCompletedOnboarding(user);
}

function loginResult(
  user: AuthUser,
  isNew: boolean,
  onboarded: boolean,
  phoneBinding?: LoginPhoneBinding,
  referralOutcome?: ReferralOutcome,
): LoginResult {
  assertAccountActive(user);
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
    ...(phoneBinding ? { phoneBinding } : {}),
    ...(referralOutcome ? { referralOutcome } : {}),
  };
}

function assertAccountActive(user: AuthUser): void {
  if (!user.deletedAt) return;
  throw Object.assign(new Error('账号已进入注销保留期，如需恢复请联系客服'), {
    statusCode: 423,
    code: 'ACCOUNT_DELETION_PENDING',
  });
}

/** 按手机号登录或注册（短信登录 / 微信一键登录 / 未来运营商一键登录共用）。 */
async function loginOrRegisterByPhone(
  phone: string,
  name?: string,
  attribution?: RegisterAttribution,
): Promise<{ user: AuthUser; isNew: boolean; referralOutcome?: ReferralOutcome }> {
  const existing = await prisma.user.findUnique({ where: { phone } });
  if (existing) {
    assertAccountActive(existing);
    await recordAudit({ tenantId: existing.tenantId, userId: existing.id, action: 'auth.login', payload: phoneAudit(phone) });
    return { user: existing, isNew: false, referralOutcome: await retryReferralIfEligible(existing, attribution) };
  }
  // 不编造称呼/公司：未填留空，由首登建档采集。
  const user = await createUserWithTenant({ phone, name: name?.trim() || '', auditAction: 'auth.register', auditPayload: phoneAudit(phone) });
  const referralOutcome = await bindReferralAfterRegister(user, attribution);
  return { user, isNew: true, referralOutcome };
}

/**
 * 老用户仍不允许事后填码；唯一例外是「这个账号首次注册时已带同一码，但因捕获凭证/配置暂不可用而失败」。
 * 这条留痕是恢复资格，避免第一次建号成功后后续登录永远跳过绑定，同时不开放存量账号补绑口子。
 */
async function retryReferralIfEligible(user: AuthUser, attribution?: RegisterAttribution): Promise<ReferralOutcome | undefined> {
  if (!attribution) return undefined;
  if (await prisma.referral.findUnique({ where: { userId: user.id }, select: { userId: true } })) return 'already_bound';
  const recoverable = await prisma.referralAttribution.findFirst({
    where: {
      newUserId: user.id,
      inviteCode: attribution.inviteCode,
      outcome: { in: ['no_timestamp', 'config_unavailable'] },
    },
    select: { id: true },
    orderBy: { createdAt: 'desc' },
  });
  if (!recoverable) return undefined;
  return bindReferralAfterRegister(user, attribution);
}

/**
 * 注册成功后绑定推荐人。
 *
 * **为什么不放进 createUserWithTenant 的事务里**：Postgres 事务中任何一条语句失败就把整个事务
 * 置为 aborted，之后的语句一律报错。那样「绑定失败绝不能影响注册」就是做不到的——
 * try/catch 只能抓到 JS 异常，事务本身已经废了，租户与用户会一起回滚。
 * 所以这里放在注册**之后**单独跑，失败只落一行日志：账号一定建成，关系可以事后按
 * referral_attribution 的留痕人工补绑。这是刻意的取舍，别为了「原子」把它挪回事务里。
 */
async function bindReferralAfterRegister(user: AuthUser, attribution?: RegisterAttribution): Promise<ReferralOutcome | undefined> {
  if (!attribution) return undefined;
  try {
    // 关系与归因两次写**必须同事务**：否则会出现「建了边但归因行写失败」——
    // 关系在、留痕不在，运营查不出这条边是怎么来的。
    // 这个事务**不含建号**（见上方注释：Postgres 事务一旦有语句失败即 aborted，
    // 把建号裹进来就无法做到「绑定失败不影响注册」）。
    return await prisma.$transaction((tx) => bindOnRegister({
      db: tx,
      userId: user.id,
      tenantId: user.tenantId,
      inviteCode: attribution.inviteCode,
      capturedAt: attribution.capturedAt,
      source: attribution.source,
      clientIp: attribution.clientIp,
      userAgent: attribution.userAgent,
    }));
  } catch (err) {
    // 并发主键冲突：事务已失败，留痕只能在事务外补（见 referral.ts 的注释）。
    if (err instanceof ReferralAlreadyBound) {
      await traceOutsideTransaction({
        tenantId: user.tenantId,
        userId: user.id,
        inviteCode: attribution.inviteCode,
        source: attribution.source,
        outcome: 'already_bound',
        referrerId: err.referrerId,
        clientIp: attribution.clientIp,
        userAgent: attribution.userAgent,
      });
      return 'already_bound';
    }
    console.error('[referral] 绑定推荐人失败（注册已成功，不回滚）:', (err as Error).message);
    // 绑定整体失败时也补一条留痕：至少让「有人带着这个码进来过」这件事可查，
    // 否则账号建成了、关系没有、日志只在服务器上，运营侧完全是个黑洞。
    await traceOutsideTransaction({
      tenantId: user.tenantId,
      userId: user.id,
      inviteCode: attribution.inviteCode,
      source: attribution.source,
      outcome: 'config_unavailable',
      clientIp: attribution.clientIp,
      userAgent: attribution.userAgent,
    });
    return 'config_unavailable';
  }
}

function isUniqueConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/**
 * 把本次微信凭证**强制**绑定到手机号账号上——微信身份跟随手机号，不再反过来。
 *
 * 手机号是唯一身份键，所以这里不存在「身份冲突」这种业务结果：openid 若原本挂在别的账号上，
 * 先解绑（留审计）再绑到当前账号；当前账号原有的不同 openid 被本次覆盖（同样留审计）。
 * 全程一个事务，避免解绑成功、改绑失败留下双方都没绑的中间态。
 * 数据库故障继续抛出，不把 DB 故障伪装成登录成功。
 */
async function forceLinkWechatIdentity(
  user: AuthUser,
  openid: string,
  unionid?: string,
): Promise<{ user: AuthUser; moved: boolean }> {
  const sameOpenid = user.wechatOpenId === openid;
  const overwritten = !!user.wechatOpenId && !sameOpenid; // 本账号原有的另一个微信身份被顶掉
  return prisma.$transaction(async (tx) => {
    // 1) 该 openid/unionid 若挂在别的账号上，先解绑（审计只落布尔与掩码，不落凭证明文）。
    const others = await tx.user.findMany({
      where: {
        id: { not: user.id },
        OR: [{ wechatOpenId: openid }, ...(unionid ? [{ wechatUnionId: unionid }] : [])],
      },
      select: { id: true, tenantId: true, phone: true },
    });
    for (const other of others) {
      await tx.user.update({
        where: { id: other.id },
        data: { wechatOpenId: null, wechatUnionId: null, wechatLinkedAt: null },
      });
      await tx.auditLog.create({
        data: {
          tenantId: other.tenantId,
          userId: other.id,
          action: 'auth.wechat_identity_detached',
          payloadJson: { toUserId: user.id, phoneMasked: maskAuditPhone(other.phone), wechat: true, unionid: !!unionid },
        },
      });
    }

    // 2) 绑到目标账号。openid 相同 → 只补缺失的 unionid；openid 变了 → unionid 以本次为准，
    //    本次没返回就置 null（旧 unionid 属于旧微信身份，不能残留在新身份上）。
    const linked = sameOpenid
      ? unionid && !user.wechatUnionId
        ? await tx.user.update({
            where: { id: user.id },
            data: { wechatUnionId: unionid, wechatLinkedAt: user.wechatLinkedAt ?? new Date() },
          })
        : user
      : await tx.user.update({
          where: { id: user.id },
          data: { wechatOpenId: openid, wechatUnionId: unionid ?? null, wechatLinkedAt: new Date() },
        });

    const moved = others.length > 0 || overwritten;
    if (moved) {
      await tx.auditLog.create({
        data: {
          tenantId: user.tenantId,
          userId: user.id,
          action: 'auth.wechat_relinked',
          payloadJson: {
            ...(others[0] ? { fromUserId: others[0].id } : {}),
            overwritten,
            detached: others.length,
            wechat: true,
            unionid: !!unionid,
          },
        },
      });
    }
    return { user: linked, moved };
  });
}

function phoneBinding(status: LoginPhoneBinding['status'], accountPhone: string, observedPhone: string): LoginPhoneBinding {
  return {
    status,
    accountPhoneMasked: maskAuditPhone(accountPhone) ?? '',
    observedPhoneMasked: maskAuditPhone(observedPhone) ?? '',
  };
}

export async function authRoutes(app: FastifyInstance) {
  app.get('/auth/suggest-name', async () => ({
    name: suggestAliasName(),
    source: '古典武侠/军事花名',
  }));

  // 游客落地即换取服务端时钟签名凭证。接口不要求账号态，故单独限频；只签形状合法的邀请码，
  // 不在这里查询归属人，避免公开接口泄露邀请码是否存在（真正绑定仍由 bindOnRegister 判定）。
  app.post('/auth/referral-capture', { config: { rateLimit: { max: 60, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const parsed = referralCaptureSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: '邀请参数不正确', code: 'BAD_REFERRAL_CAPTURE' });
    try {
      const captured = issueReferralCapture(parsed.data.inviteCode, parsed.data.source);
      return { token: captured.token, capturedAt: captured.capturedAt.toISOString() };
    } catch (error) {
      const err = error as { statusCode?: number; code?: string; message?: string };
      return reply.code(err.statusCode ?? 400).send({ error: err.message ?? '邀请参数不正确', code: err.code ?? 'BAD_REFERRAL_CAPTURE' });
    }
  });

  // 发送短信验证码：限频 + 落库（哈希）+ 发送。console 演示口径会把验证码随响应回传（devCode）。
  // 按 IP 收紧：SMS 发送是成本+轰炸型接口。既有 sms.ts 已按手机号限频（60s 冷却 + 5 条/小时），
  // 这里再叠一层按 IP 的频控，挡「换号池、同 IP 批量轰炸」。（rate-limit 未注册的测试环境此 config 被忽略。）
  app.post('/auth/sms/send', { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } }, async (req, reply) => {
    if (!smsLoginEnabled()) {
      return reply.code(503).send({ error: '短信登录暂不可用，请使用手机号快捷登录', code: 'SMS_LOGIN_DISABLED' });
    }
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
    if (!smsLoginEnabled()) {
      return reply.code(503).send({ error: '短信登录暂不可用，请使用手机号快捷登录', code: 'SMS_LOGIN_DISABLED' });
    }
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

    const { user, isNew, referralOutcome } = await loginOrRegisterByPhone(phone, name, attributionOf(req, parsed.data));
    await recordAuthAttempt(req, 'auth.login.attempt', {
      ok: true,
      statusCode: 200,
      ...phoneAudit(phone),
      hasCode: code !== undefined,
      smsRequired: env.smsRequireCode,
      isNew,
    }, user);
    return loginResult(user, isNew, await onboardedOf(user), undefined, referralOutcome);
  });

  app.post('/auth/wechat-login', async (req, reply) => {
    if (!wechatLoginEnabled()) {
      return reply.code(503).send({ error: '手机号快捷登录暂不可用，请使用短信验证码登录', code: 'WECHAT_LOGIN_DISABLED' });
    }
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

      // 手机号是唯一身份键：纯 openid 不再建号。没关联过任何账号的微信身份必须先走手机号登录，
      // 由 /auth/wechat-phone 把这次 openid 绑到手机号账号上，之后才能用它快捷复登。
      if (!user) {
        await recordAuthAttempt(req, 'auth.wechat_login.attempt', {
          ok: false,
          statusCode: 404,
          wechat: true,
          unionid: !!wx.unionid,
          errorCode: 'PHONE_LOGIN_REQUIRED',
        });
        return reply.code(404).send({ error: '当前快捷登录尚未关联账号，请先用手机号登录', code: 'PHONE_LOGIN_REQUIRED' });
      }
      assertAccountActive(user);

      if (!user.wechatOpenId || (wx.unionid && !user.wechatUnionId)) {
        user = await prisma.user.update({
          where: { id: user.id },
          data: {
            wechatOpenId: user.wechatOpenId || wx.openid,
            wechatUnionId: user.wechatUnionId || wx.unionid,
            wechatLinkedAt: user.wechatLinkedAt || new Date(),
          },
        });
      }
      await recordAudit({ tenantId: user.tenantId, userId: user.id, action: 'auth.wechat_login', payload: { wechat: true, unionid: !!wx.unionid } });
      await recordAuthAttempt(req, 'auth.wechat_login.attempt', {
        ok: true,
        statusCode: 200,
        wechat: true,
        unionid: !!wx.unionid,
        nicknameProvided: !!parsed.data.nickname,
        isNew: false,
      }, user);

      return loginResult(user, false, await onboardedOf(user));
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

  // 本机号一键登录（手机号唯一身份键的正门）：phoneCode 换手机号 → 按手机号定位/新建账号；
  // 可选 loginCode 换到的 openid/unionid 一律强制绑到该账号（原挂别处先解绑，留审计）。
  app.post('/auth/wechat-phone', async (req, reply) => {
    if (!wechatLoginEnabled()) {
      return reply.code(503).send({ error: '手机号快捷登录暂不可用，请使用短信验证码登录', code: 'WECHAT_LOGIN_DISABLED' });
    }
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

      // 身份解析只看手机号：手机号找到账号 = 就是这个人，不存在 PHONE_TAKEN / 微信身份冲突。
      // 微信身份反过来跟随手机号账号走（forceLinkWechatIdentity 负责强制迁绑 + 审计）。
      let user: AuthUser;
      let isNew: boolean;
      let binding: LoginPhoneBinding;
      let referralOutcome: ReferralOutcome | undefined;
      const attribution = attributionOf(req, parsed.data);

      /** 手机号已定位到账号：登录它，并把本次微信身份强制绑上来。 */
      const loginAndLink = async (target: AuthUser): Promise<{ user: AuthUser; binding: LoginPhoneBinding }> => {
        assertAccountActive(target);
        if (!openid) return { user: target, binding: phoneBinding('matched', target.phone, phone) };
        const linked = await forceLinkWechatIdentity(target, openid, unionid);
        return { user: linked.user, binding: phoneBinding(linked.moved ? 'wechat_relinked' : 'matched', linked.user.phone, phone) };
      };

      const byPhone = await prisma.user.findUnique({ where: { phone } });
      if (byPhone) {
        assertAccountActive(byPhone);
        isNew = false;
        ({ user, binding } = await loginAndLink(byPhone));
        referralOutcome = await retryReferralIfEligible(user, attribution);
      } else {
        const byWechat = openid
          ? await prisma.user.findFirst({ where: { OR: [{ wechatOpenId: openid }, ...(unionid ? [{ wechatUnionId: unionid }] : [])] } })
          : null;
        if (byWechat && byWechat.phone.startsWith('wx_')) {
          assertAccountActive(byWechat);
          // 历史纯微信占位账号（wx_<openid>）首次补上真实手机号：保留老数据，不新建账号。
          // 这是「登录动作里改 phone」的唯一例外，其余换号一律走 /auth/bind-phone 显式验证。
          isNew = false;
          try {
            user = await prisma.user.update({ where: { id: byWechat.id }, data: { phone } });
            binding = phoneBinding('placeholder_upgraded', phone, phone);
          } catch (error) {
            if (!isUniqueConflict(error)) throw error;
            // 竞态：这一瞬另一路请求已用该手机号建了号 → 退回「手机号定位账号」口径。
            const raced = await prisma.user.findUnique({ where: { phone } });
            if (!raced) throw error;
            ({ user, binding } = await loginAndLink(raced));
          }
          referralOutcome = await retryReferralIfEligible(user, attribution);
        } else {
          // 手机号没账号 → 以手机号建号。即便本次 openid 原挂在别的真实号账号上，
          // 也是建这个手机号的新账号、把微信身份迁过来（手机号才是身份键）。
          ({ user, isNew, referralOutcome } = await loginOrRegisterByPhone(phone, parsed.data.name, attribution));
          ({ user, binding } = await loginAndLink(user));
        }
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
        phoneBindingStatus: binding.status,
        accountPhoneMasked: binding.accountPhoneMasked,
      }, user);
      return loginResult(user, isNew, await onboardedOf(user), binding, referralOutcome);
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
    } catch (error) {
      if (!isUniqueConflict(error)) throw error;
      return reply.code(409).send({ error: '该手机号已被其他账号使用', code: 'PHONE_TAKEN' });
    }
    await recordAuthAttempt(req, 'auth.bind_phone.attempt', {
      ok: true,
      statusCode: 200,
      ...phoneAudit(phone),
      previousPhoneMasked: maskAuditPhone(user.phone),
    }, updated);
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
  // 归因字段现在就收下（契约与另两条通道一致），但本入口仍返回 501：
  //   接通 SDK 时把上面注释里的那行改成
  //   `await loginOrRegisterByPhone(phone, parsed.data.name, attributionOf(req, parsed.data))`
  //   即可获得与短信 / 微信一键完全相同的归因行为，不需要再动 referral 那一层。
  const carrierSchema = z.object({
    provider: z.enum(['cmcc', 'cucc', 'ctcc', 'aliyun', 'jiguang']).optional(),
    token: z.string().trim().min(1, '缺少运营商 token'),
    name: z.string().trim().min(1).max(20).optional(),
    ...attributionShape,
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
