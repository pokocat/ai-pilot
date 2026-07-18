// 品牌资产包（WO-13）：生成 / 读取 / 确认。生成门槛与生成逻辑在 services/brandKit。
// P0-1：生成路径补计费与门禁——assertPlanActive（到期 403）+ reserveQuota 预留→settle/refund（低配 ratio 0.3，
//        对齐 quickscan 口径）+ 每日 3 次限流（进程内存 cache，与 quickscan 同实现；多实例落 DB 是另一工单）。
import type { FastifyInstance } from 'fastify';
import { resolveUser } from '../services/context.js';
import { cacheGet, cacheSet } from '../services/cache.js';
import { reserveQuota, assertPlanActive, type QuotaReservation } from '../services/tokenQuota.js';
import { structuredBillTokens } from '../llm/gateway.js';
import { dateKey } from '../services/clock.js';
import { generateBrandKit, getBrandKit, approveBrandKit } from '../services/brandKit.js';

const DAILY_LIMIT = 3; // 每用户每日生成次数（真实模型调用，防资损）
const RATIO = 0.3; // token 轴计费 ratio 低配（对齐 quickscan）
const EST_TOKENS = 1200; // 生成调用估算 token（structured() 暂不回传真实用量，走保守估算；精确计量待「计量中间件」重构）
const DAY_MS = 24 * 60 * 60 * 1000;

function dayKey(): string {
  return dateKey(); // 上海时区日历日（P1-4）
}

export async function brandKitRoutes(app: FastifyInstance) {
  app.get('/brand-kit', async (req) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    return getBrandKit(user.id);
  });

  app.post('/brand-kit/generate', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);

    // 1) 限流 3/日（先于额度：超限的请求不应消耗额度/触发真实调用）
    const rlKey = `brandkit:rl:${user.id}:${dayKey()}`;
    const used = (await cacheGet<number>(rlKey)) ?? 0;
    if (used >= DAILY_LIMIT) {
      return reply.code(429).send({ code: 'RATE_LIMITED', error: '今天的品牌资产包生成次数已用完，明天再来' });
    }

    // 2) 到期门禁 + 额度预留（无 grace：品牌资产包是执行阶段付费能力，额度耗尽 → 402）
    await assertPlanActive(user.id); // 套餐过期 → PLAN_EXPIRED(403)
    let reservation: QuotaReservation | undefined;
    try {
      reservation = await reserveQuota(user.id, RATIO);
      const { view, ok, attempts } = await generateBrandKit(user.id, user.tenantId); // 未到执行阶段 → BrandKitLockedError(403)
      // P1-3：校验失败但已真实调用（attempts>0）时按轮次保守结算，不再因 mock 兜底而全额退。
      await reservation.settle(structuredBillTokens({ ok, attempts, estTokens: EST_TOKENS }), RATIO);
      // 3) 计一次限流（仅成功后）
      await cacheSet(rlKey, used + 1, DAY_MS);
      return view;
    } catch (err) {
      if (reservation) await reservation.refund().catch(() => {});
      throw err;
    }
  });

  app.post('/brand-kit/approve', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const ok = await approveBrandKit(user.id);
    if (!ok) return reply.code(404).send({ code: 'NOT_FOUND', error: '还没有品牌资产包可确认' });
    return { ok: true };
  });
}
