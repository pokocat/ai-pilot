// 建号（新 Tenant + 新 User [+ 测试期默认套餐]）—— 全仓**唯一**的建号实现。
//
// 原先这段代码长在 `routes/auth.ts` 里。统一账号中心接入（`identityProvisioning.ts`）也要走
// 同一条建号路径，而 auth.ts ← context.ts ← identityProvisioning.ts 会成环，所以把它抽到服务层：
// 建号口径只有一份，登录路由与账号中心首登建出来的账号完全同形（同样的租户、同样的测试期套餐、
// 同样的注册审计与埋点）。
import { prisma } from '../db.js';
import { registrationDefaultPlanName } from '../env.js';
import { applyPlanPurchase } from './purchase.js';
import { noteRegistration } from './metrics.js';

export interface CreateUserWithTenantOpts {
  phone: string;
  name: string;
  auditAction: string;
  auditPayload: object;
}

export async function createUserWithTenant(opts: CreateUserWithTenantOpts) {
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
    noteRegistration(opts.auditAction.replace(/^auth\./, '')); // register | wechat_register | identity_register
    return user;
  });
}
