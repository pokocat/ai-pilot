// 快出片存储额度：默认额度 + 用户用钻石买的扩容包。
//
// ★ 职责分界：**默认额度在 AIStar**（那边才知道实际占用），**扩容权益在军师**（钻石在这边）。
//   军师算出有效额度后随请求传给 AIStar，AIStar 据此判上传闸 —— 两边用同一个数，
//   避免出现「军师说还能传、AIStar 说满了」这种谁也解释不清的状态。
//
// ★ 定价同样归运营后台（FeatureFlag `video-storage-pricing`），代码只给保守兜底。
//   口径与克隆定价（pricing.ts）完全一致：对外定价数据不进代码常量。
import { prisma } from '../../db.js';
import { chargeCreditsOnce } from '../credits.js';
import { featureFlagPayload, setFeatureFlagPayload } from '../featureFlag.js';

export const STORAGE_PRICING_FLAG_ID = 'video-storage-pricing';

const MB = 1024 * 1024;

export type StoragePlan = {
  /** 一个扩容包给多少字节 */
  packBytes: number;
  /** 一个扩容包扣多少钻石 */
  packCredits: number;
  /** 单个用户最多能买多少个包。挡住误操作把额度买到天上去，也给存储成本一个上界 */
  maxPacks: number;
  /** 运营是否核定过。false = 用的是代码兜底价 */
  configured: boolean;
};

/**
 * 兜底档位 —— **只是运营没配时的保守默认，不是定价真源**，也绝不写回数据库。
 *
 * TODO(定价待运营核定)：100MB / 50 钻石是 2026-08-14 为内测临时给的，没有商务结论。
 */
const FALLBACK: Omit<StoragePlan, 'configured'> = {
  packBytes: 100 * MB,
  packCredits: 50,
  maxPacks: 20,
};

export class StoragePlanInvalidError extends Error {
  statusCode = 422;
  code = 'STORAGE_PLAN_INVALID';
}

export class StoragePackLimitError extends Error {
  statusCode = 409;
  code = 'STORAGE_PACK_LIMIT';
}

const LIMITS = {
  packBytes: { min: MB, max: 100 * 1024 * MB },
  packCredits: { min: 0, max: 1_000_000 },
  maxPacks: { min: 1, max: 1000 },
} as const;

function read(value: unknown, key: keyof typeof LIMITS, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < LIMITS[key].min || n > LIMITS[key].max) return fallback;
  return Math.round(n);
}

export async function storagePlan(opts: { fresh?: boolean } = {}): Promise<StoragePlan> {
  const raw = (await featureFlagPayload(STORAGE_PRICING_FLAG_ID, opts)) as Record<string, unknown> | null;
  const payload = raw ?? {};
  // 「配过」的判据是三项都合法：半份配置比没配更危险 —— 运营以为配好了，实际另外几项还是兜底。
  const configured = (Object.keys(LIMITS) as (keyof typeof LIMITS)[]).every((key) => {
    const n = typeof payload[key] === 'number' ? (payload[key] as number) : Number(payload[key]);
    return Number.isFinite(n) && n >= LIMITS[key].min && n <= LIMITS[key].max;
  });
  return {
    packBytes: read(payload.packBytes, 'packBytes', FALLBACK.packBytes),
    packCredits: read(payload.packCredits, 'packCredits', FALLBACK.packCredits),
    maxPacks: read(payload.maxPacks, 'maxPacks', FALLBACK.maxPacks),
    configured,
  };
}

/** 后台写入。非法值抛 422 而不是静默夹回旧值 —— 同 pricing.ts 的理由：改价是营收动作。 */
export async function updateStoragePlan(patch: Partial<Omit<StoragePlan, 'configured'>>): Promise<StoragePlan> {
  const current = await storagePlan({ fresh: true });
  const next = {} as Omit<StoragePlan, 'configured'>;
  for (const key of Object.keys(LIMITS) as (keyof typeof LIMITS)[]) {
    if (patch[key] === undefined) { next[key] = current[key]; continue; }
    const n = typeof patch[key] === 'number' ? (patch[key] as number) : Number(patch[key]);
    if (!Number.isFinite(n) || n < LIMITS[key].min || n > LIMITS[key].max) {
      throw new StoragePlanInvalidError(`${key} 必须在 ${LIMITS[key].min} 到 ${LIMITS[key].max} 之间`);
    }
    next[key] = Math.round(n);
  }
  await setFeatureFlagPayload(STORAGE_PRICING_FLAG_ID, next);
  return { ...next, configured: true };
}

/** 用户已买到的扩容字节总数。 */
export async function purchasedStorageBytes(userId: string): Promise<number> {
  const rows = await prisma.videoStoragePack.findMany({ where: { userId }, select: { bytes: true } });
  return rows.reduce((sum, row) => sum + Number(row.bytes), 0);
}

export async function purchasedPackCount(userId: string): Promise<number> {
  return prisma.videoStoragePack.count({ where: { userId } });
}

/**
 * 买一个扩容包。
 *
 * 与出片/克隆不同，这里**不需要预扣 + 退回**：扩容是即时生效的权益，没有异步任务会失败。
 * 扣费与入账在同一个事务里，失败整体回滚 —— 不会出现「扣了钱没给空间」。
 */
export async function buyStoragePack(input: {
  tenantId: string; userId: string; clientRequestId: string;
}): Promise<{ pack: { bytes: number; credits: number }; reused: boolean }> {
  const plan = await storagePlan();
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`video-storage:${input.userId}:${input.clientRequestId}`}))`;
    const existing = await tx.videoStoragePack.findUnique({
      where: { userId_clientRequestId: { userId: input.userId, clientRequestId: input.clientRequestId } },
    });
    // 重复提交（网络重试、连点两下）返回原单，不再扣一次钱。
    if (existing) return { pack: { bytes: Number(existing.bytes), credits: existing.credits }, reused: true };

    const owned = await tx.videoStoragePack.count({ where: { userId: input.userId } });
    if (owned >= plan.maxPacks) {
      throw new StoragePackLimitError(`最多只能扩容 ${plan.maxPacks} 次，需要更大空间请联系我们`);
    }
    // 余额不足由 chargeCreditsOnce 抛 402，发生在写入之前，不会出现「没扣到钱却给了空间」。
    await chargeCreditsOnce(
      input.tenantId, input.userId, plan.packCredits,
      '快出片 · 存储扩容',
      `video-storage:charge:${input.userId}:${input.clientRequestId}`,
      tx,
    );
    await tx.videoStoragePack.create({
      data: {
        tenantId: input.tenantId, userId: input.userId,
        // 快照下单时的档位：之后运营改价改容量，都不影响已经成交的这一单。
        bytes: BigInt(plan.packBytes), credits: plan.packCredits,
        clientRequestId: input.clientRequestId,
      },
    });
    return { pack: { bytes: plan.packBytes, credits: plan.packCredits }, reused: false };
  });
}
