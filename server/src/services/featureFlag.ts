// WO-05 / P0-2：功能开关（命理等模块一键降级）。三层开关的「注入层」「路由层」「下发层」都读这里。
// isEnabled 默认带 60s 内存缓存（热路径）；setFeatureFlag 立即失效缓存。
// 合规类开关（COMPLIANCE_FLAGS，如命理）：审核事故时须一键全产品即时生效，不能容忍多实例 60s 缓存窗口
//   → 一律直读 DB（不走缓存、不写缓存）。单条主键 findUnique 极快，/me 与对话热路径可承受（review L4）。
import type { FastifyReply } from 'fastify';
import { prisma } from '../db.js';

const cache = new Map<string, { v: boolean; t: number }>();
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

/** 设开关（admin / 运营脚本用），立即清缓存。 */
export async function setFeatureFlag(key: string, enabled: boolean): Promise<void> {
  await prisma.featureFlag.upsert({ where: { id: key }, update: { enabled }, create: { id: key, enabled } });
  cache.delete(key);
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
export function __clearFeatureCache(): void { cache.clear(); }
