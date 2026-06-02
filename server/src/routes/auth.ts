// 账号体系（演示版 fake 登录）：以手机号为账号主键。
// 手机号不存在则建号——每个手机号独立租户(Tenant)+用户(User)，业务数据按 tenantId/userId 行级隔离。
// 生产应替换为：短信验证码校验 + JWT 签发；此处 token 直接复用 userId。
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';

const loginSchema = z.object({
  phone: z.string().regex(/^1\d{10}$/, '请输入有效的手机号'),
  name: z.string().trim().min(1).max(20).optional(),
  code: z.string().optional(), // fake 验证码，暂不校验
});

export async function authRoutes(app: FastifyInstance) {
  app.post('/auth/login', async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? '参数错误' });
    }
    const { phone, name } = parsed.data;

    let user = await prisma.user.findUnique({ where: { phone } });
    let isNew = false;
    if (!user) {
      isNew = true;
      const plan = await prisma.plan.findFirst({ orderBy: { sort: 'asc' } });
      const tenant = await prisma.tenant.create({ data: { name: name?.trim() || `企业${phone.slice(-4)}` } });
      user = await prisma.user.create({
        data: {
          tenantId: tenant.id,
          phone,
          name: name?.trim() || `用户${phone.slice(-4)}`,
          role: 'owner',
          benmingColor: 'gold',
          planId: plan?.id ?? null,
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
        .create({ data: { tenantId: tenant.id, userId: user.id, action: 'auth.register', payloadJson: { phone } } })
        .catch(() => {});
    }

    const onboarded = !!(await prisma.profile.findFirst({ where: { tenantId: user.tenantId } }));
    return {
      token: user.id, // fake token = userId（演示用）
      isNew,
      onboarded,
      user: { id: user.id, name: user.name, phone: user.phone, benmingColor: user.benmingColor },
    };
  });
}
