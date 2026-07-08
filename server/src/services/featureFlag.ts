// WO-05：功能开关（命理等模块一键降级）。三层开关的「注入层」与「路由层」都读这里。
// isEnabled 带 60s 内存缓存（热路径）；setFeatureFlag 立即失效缓存。
import { prisma } from '../db.js';

const cache = new Map<string, { v: boolean; t: number }>();
const TTL_MS = 60_000;

/** 读功能开关（默认开）。60s 内存缓存。 */
export async function isFeatureEnabled(key: string, def = true): Promise<boolean> {
  const c = cache.get(key);
  const nowMs = Date.now();
  if (c && nowMs - c.t < TTL_MS) return c.v;
  const row = await prisma.featureFlag.findUnique({ where: { id: key }, select: { enabled: true } });
  const v = row ? row.enabled : def;
  cache.set(key, { v, t: nowMs });
  return v;
}

/** 设开关（admin / 运营脚本用），立即清缓存。 */
export async function setFeatureFlag(key: string, enabled: boolean): Promise<void> {
  await prisma.featureFlag.upsert({ where: { id: key }, update: { enabled }, create: { id: key, enabled } });
  cache.delete(key);
}

/** 清缓存（测试用）。 */
export function __clearFeatureCache(): void { cache.clear(); }
