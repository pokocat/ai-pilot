// 商业化禁写闸（2026-07-28 去免费档改版）：产品不再有免费体验档，「仅注册」用户
// （无套餐，或套餐已到期）只能读，不能有任何写操作。
//
// 与 assertPlanActive 的分工：assertPlanActive 只拦「有到期日且已过期」（付费用户到期只读），
// 而本闸拦的是「从未开通」——planId 为空的账号。两者叠加后语义完整：无套餐禁写 + 到期禁写。
//
// 测试期口径：TEST_DEFAULT_PLAN_NAME 配置后新注册用户自动开通默认套餐（见 routes/auth.ts），
// 正常情况下不会有用户真的撞上本闸；它的作用是兜住「测试期结束/配置关闭后」的裸注册账号。
import { prisma } from '../db.js';
import { isExpired } from './planTime.js';
import { now } from './clock.js';

export class PlanRequiredError extends Error {
  statusCode = 403;
  code = 'PLAN_REQUIRED';
  constructor(msg = '当前账号未开通套餐，开通后即可使用（未开通前内容只读）') {
    super(msg);
  }
}

/** 从未开通 → PLAN_REQUIRED（引导开通）；开通过但到期 → PLAN_EXPIRED（引导续费，前端已有只读态 UI）。 */
export type PlanGateState = 'active' | 'expired' | 'none';

// 30s 短缓存：写请求每次都查一遍 planId 太浪费（P1-6 刚把 context 链的 round-trip 压下去）。
// 开通套餐的路径必须调 bustPlanGate，否则用户付完款最长 30s 内写操作仍被拦。
const TTL = 30_000;
const cache = new Map<string, { state: PlanGateState; at: number }>();

export function bustPlanGate(userId: string): void {
  cache.delete(userId);
}

export function __resetPlanGate(): void {
  cache.clear();
}

export async function planGateState(userId: string): Promise<PlanGateState> {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < TTL) return hit.state;
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { planId: true, planExpiresAt: true },
  });
  const state: PlanGateState = !u?.planId ? 'none'
    : isExpired(u.planExpiresAt, now()) ? 'expired'
    : 'active';
  if (cache.size > 50_000) cache.clear(); // 极端防线：不让脏 token 撑爆内存
  cache.set(userId, { state, at: Date.now() });
  return state;
}

export async function hasActivePlan(userId: string): Promise<boolean> {
  return (await planGateState(userId)) === 'active';
}
