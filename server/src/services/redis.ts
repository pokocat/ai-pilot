// 共享 Redis 客户端（可选依赖，懒加载）。
//
// 从 services/cache.ts 抽出来独立成模块，是因为压测后要接的三个用途需要**同一个连接**：
//   ① 缓存（cache.ts）② 全站限流的跨实例 store（app.ts）③ 后续的 LLM 队列 / 调度选主。
// 各自建连接会把连接数按用途翻倍，且 REDIS_URL 未配时三处都要各写一遍回退逻辑。
//
// 契约与 cache.ts 原有口径一致：未配 REDIS_URL → 返回 null（调用方回退进程内实现）；
// 配了但 ioredis 未安装 / 连接失败 → 告警后同样返回 null，绝不因为缓存层让进程起不来。

/** ioredis 客户端的最小结构类型（避免对可选依赖的硬类型依赖）。 */
export type RedisLike = {
  get(key: string): Promise<string | null>;
  set(key: string, val: string, mode: string, ttl: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
  on?(event: string, cb: (err: unknown) => void): void;
};

let redisPromise: Promise<RedisLike | null> | null = null;

/** 取共享客户端；未配置 / 不可用返回 null。多次调用复用同一个连接。 */
export async function getRedis(): Promise<RedisLike | null> {
  const url = (process.env.REDIS_URL ?? '').trim();
  if (!url) return null;
  if (!redisPromise) {
    redisPromise = (async () => {
      try {
        // 动态 import：用变量 specifier 规避 tsc 静态解析（ioredis 为可选依赖，未装时落 catch 回退内存）。
        const spec = 'ioredis';
        const mod: any = await import(spec).catch(() => null);
        if (!mod) {
          console.warn('[redis] 已配 REDIS_URL 但未安装 ioredis，相关能力回退进程内实现（生产请 `npm i ioredis`）');
          return null;
        }
        const Redis = mod.default ?? mod;
        const client: RedisLike = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 2 });
        client.on?.('error', (err) => {
          console.error('[redis] error:', (err as Error)?.message);
        });
        return client;
      } catch (err) {
        console.error('[redis] 初始化失败，回退进程内实现：', (err as Error).message);
        return null;
      }
    })();
  }
  return redisPromise;
}

/** 当前后端标识（诊断用）。 */
export async function redisAvailable(): Promise<boolean> {
  return (await getRedis()) !== null;
}
