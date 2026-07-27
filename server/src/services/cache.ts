// 统一缓存抽象：默认进程内内存（零依赖、演示/本地即用）；配 REDIS_URL 且安装了 ioredis 时切 Redis。
//
// 「配置开关式脚手架」：ioredis 为可选依赖，按需动态 import；未安装 / 连接失败 → 自动回退内存，不崩。
// 生产：`npm i ioredis` + 设 REDIS_URL=redis://... 即接真实 Redis（多实例共享缓存、可横向扩展）。
//
// 接口面向 LLM 结果缓存等「可丢失、有 TTL」的场景；值统一 JSON 序列化。
//
// 客户端本身已抽到 services/redis.ts（限流 store、后续的 LLM 队列/选主要复用同一个连接）。

import { getRedis } from './redis.js';

type Entry = { v: string; exp: number };

const mem = new Map<string, Entry>();

function memGet(key: string): string | null {
  const e = mem.get(key);
  if (!e) return null;
  if (e.exp <= Date.now()) { mem.delete(key); return null; }
  return e.v;
}
function memSet(key: string, val: string, ttlMs: number): void {
  mem.set(key, { v: val, exp: Date.now() + ttlMs });
  // 轻量清理：超过 1000 键时清掉过期项，避免无界增长。
  if (mem.size > 1000) {
    const now = Date.now();
    for (const [k, e] of mem) if (e.exp <= now) mem.delete(k);
  }
}

/** 读缓存，反序列化为 T；未命中/出错返回 null。 */
export async function cacheGet<T>(key: string): Promise<T | null> {
  let raw: string | null = null;
  const redis = await getRedis();
  if (redis) {
    try { raw = await redis.get(key); } catch { raw = memGet(key); }
  } else {
    raw = memGet(key);
  }
  if (raw == null) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
}

/** 写缓存（JSON 序列化 + TTL 毫秒）。失败静默（缓存非关键路径）。 */
export async function cacheSet(key: string, value: unknown, ttlMs: number): Promise<void> {
  const raw = JSON.stringify(value);
  const redis = await getRedis();
  if (redis) {
    try { await redis.set(key, raw, 'PX', ttlMs); return; } catch { /* 回退内存 */ }
  }
  memSet(key, raw, ttlMs);
}

/** 删除缓存键。 */
export async function cacheDel(key: string): Promise<void> {
  const redis = await getRedis();
  if (redis) {
    try { await redis.del(key); return; } catch { /* 回退内存 */ }
  }
  mem.delete(key);
}

/** 当前缓存后端标识（诊断用）。 */
export async function cacheBackend(): Promise<'redis' | 'memory'> {
  return (await getRedis()) ? 'redis' : 'memory';
}

/** 仅供测试：清空内存缓存。 */
export function __clearMemoryCache(): void {
  mem.clear();
}
