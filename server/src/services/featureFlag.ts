// WO-05 / P0-2：功能开关（命理等模块一键降级）。三层开关的「注入层」「路由层」「下发层」都读这里。
// isEnabled 默认带 60s 内存缓存（热路径）；setFeatureFlag 立即失效缓存。
// 合规类开关（COMPLIANCE_FLAGS，如命理）：审核事故时须一键全产品即时生效，不能容忍多实例 60s 缓存窗口
//   → 一律直读 DB（不走缓存、不写缓存）。单条主键 findUnique 极快，/me 与对话热路径可承受（review L4）。
import type { FastifyReply } from 'fastify';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';

const cache = new Map<string, { v: boolean; t: number }>();
const payloadCache = new Map<string, { v: unknown; t: number }>();
const TTL_MS = 60_000;

// 合规开关：始终直读 DB（TTL=0），绕过缓存。命理开关是合规硬需求。
const COMPLIANCE_FLAGS = new Set<string>(['fortune']);

/** 某开关是否合规类（直读 DB）。 */
export function isComplianceFlag(key: string): boolean {
  return COMPLIANCE_FLAGS.has(key);
}

/**
 * 读功能开关（默认开）。
 * - 普通开关：60s 内存缓存。
 * - 合规开关或显式 opts.fresh：绕过缓存，直读 DB（多实例即时一致）。
 */
export async function isFeatureEnabled(key: string, def = true, opts: { fresh?: boolean } = {}): Promise<boolean> {
  const fresh = opts.fresh || COMPLIANCE_FLAGS.has(key);
  if (!fresh) {
    const c = cache.get(key);
    const nowMs = Date.now();
    if (c && nowMs - c.t < TTL_MS) return c.v;
  }
  const row = await prisma.featureFlag.findUnique({ where: { id: key }, select: { enabled: true } });
  const v = row ? row.enabled : def;
  if (!fresh) cache.set(key, { v, t: Date.now() });
  return v;
}

/**
 * 读功能开关的 payload（分级/数值配置，D-10：复盘保底 perDay 等）。
 * - 普通开关：60s 内存缓存（多实例下最多 60s 收敛，非合规硬需求，可接受此取舍）。
 * - 合规开关或显式 opts.fresh：绕过缓存直读。
 * 未落库/无 payload 返回 null。
 */
export async function featureFlagPayload(key: string, opts: { fresh?: boolean } = {}): Promise<unknown> {
  const fresh = opts.fresh || COMPLIANCE_FLAGS.has(key);
  if (!fresh) {
    const c = payloadCache.get(key);
    if (c && Date.now() - c.t < TTL_MS) return c.v;
  }
  const row = await prisma.featureFlag.findUnique({ where: { id: key }, select: { payload: true } });
  const v = row?.payload ?? null;
  if (!fresh) payloadCache.set(key, { v, t: Date.now() });
  return v;
}

/** 设开关（admin / 运营脚本用），立即清缓存。 */
export async function setFeatureFlag(key: string, enabled: boolean): Promise<void> {
  await prisma.featureFlag.upsert({ where: { id: key }, update: { enabled }, create: { id: key, enabled } });
  cache.delete(key);
}

/**
 * 设开关的 payload（分级/数值配置），立即清 payload 缓存。enabled 保持既有（新建默认开）。
 *
 * **整块覆盖写**：payload 里没出现的键会被删掉。只有「调用方手里是整块配置」时才用它——
 * 典型是 artifactPricing.updateArtifactPrices / creative config / video pricing：它们自己先读全量、
 * 合并 patch、再整块落库，并且**靠不写某个键来表达「删掉它、回退默认」**（见 delete entry[variant]）。
 * 只拿着「一个键的新值」就写的调用方一律走 {@link mergeFeatureFlagPayload}，否则会静默抹掉同一
 * payload 上别人的键。
 */
export async function setFeatureFlagPayload(key: string, payload: Prisma.InputJsonValue): Promise<void> {
  await prisma.featureFlag.upsert({ where: { id: key }, update: { payload }, create: { id: key, payload } });
  payloadCache.delete(key);
}

/**
 * 合并写开关 payload：只覆盖 patch 带的顶层键，payload 上其余键原样保留。立即清 payload 缓存。
 *
 * 存在理由：运营后台「功能开关」页的 number / arms 分支只知道自己那一个键的新值。若走整块覆盖写，
 * 同一 flag payload 上的其他键（如 referral 的奖励配置 rewardInviter/dailyCap/ladder）会在运营改完
 * 一个数值后被静默清空——今天那些键还是 null，等奖励机制真上线就是一次查不出来的配置丢失。
 *
 * 用单条 jsonb `||` 的 upsert 做，不走「先读后写」：两个运营同时保存不同键也不会互相覆盖。
 * 旧值不是 JSON 对象时（历史上写过标量/数组）按空对象起算，避免 `||` 退化成数组拼接。
 * 与 setFeatureFlagPayload 一样：行不存在时新建，enabled 取库默认（true）——需要控制 enabled 的
 * 调用方要自己显式再写一次（见 creative/config.ts 里那条注释记的事故）。
 */
export async function mergeFeatureFlagPayload(key: string, patch: Prisma.InputJsonObject): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO feature_flag (id, payload, "updatedAt")
    VALUES (${key}, ${JSON.stringify(patch)}::jsonb, now() AT TIME ZONE 'UTC')
    ON CONFLICT (id) DO UPDATE SET
      payload = CASE WHEN jsonb_typeof(feature_flag.payload) = 'object' THEN feature_flag.payload ELSE '{}'::jsonb END
                || excluded.payload,
      "updatedAt" = now() AT TIME ZONE 'UTC'
  `;
  payloadCache.delete(key);
}

/**
 * 命理端点闸门：fortune 关闭 → 回 403 {code:'FEATURE_DISABLED'} 并返回 true（调用方 return reply）。
 * 放行返回 false。合规读取（直读 DB）。
 */
export async function fortuneDisabledGuard(reply: FastifyReply): Promise<boolean> {
  if (await isFeatureEnabled('fortune')) return false;
  reply.code(403).send({ error: '命理能力已按合规要求下线', code: 'FEATURE_DISABLED' });
  return true;
}

/** 清缓存（测试用）。 */
export function __clearFeatureCache(): void { cache.clear(); payloadCache.clear(); }
