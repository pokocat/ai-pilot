// 上游端点池：多路分流 + 故障转移（分布式安全）。
//
// 解决的问题：后台原来只能让**一个** AiModel 生效（`AiSetting.activeModelId`），该端点一被上游限流，
// 全站的 AI 能力就一起停摆——`llmGate` 的整窗冷却只能让请求排队等它恢复，没有第二条路可走。
//
// ── 为什么不用轮询 ─────────────────────────────────────────────────────────────
// 2026-07 生产实测：提示词缓存已经只有 12% 命中（580 次 chat 里 509 次 cachedInput=0），
// 而系统提示词占单次输入约 95%。**轮询会把同一个会话的相邻请求打到不同端点，把本就残存的
// 缓存命中彻底归零**——上游的提示词缓存是按账号/端点隔离的。
// 所以这里用「加权 Rendezvous 哈希（HRW）+ 会话粘性」，不是轮询：
//
//   1. **无状态、无需协调**：每个实例用同样的输入（affinityKey + 健康端点集）独立算出同样的结果，
//      多实例天然一致，不需要共享计数器、不需要选主。这是它比轮询更适合分布式的根本原因。
//   2. **会话粘性**：key 取 sessionId → 同一会话永远落同一端点 → 上游缓存保得住。
//   3. **成员变化只重映射 1/N**：某端点冷却下线，只有它承载的那部分会话迁走，其余不受影响
//      （一致性哈希环的性质；轮询在成员变化时会整体错位，缓存全丢）。
//   4. **支持权重**：标准加权 HRW —— score = weight / -ln(h)，h∈(0,1) 由 hash 归一化而来。
//
// ── 分布式健康状态 ─────────────────────────────────────────────────────────────
// 429 冷却**必须跨实例共享**：否则实例 A 撞了 429 把端点标冷却，实例 B 毫不知情继续打，
// 上游的滚动窗口惩罚会被持续续期，谁都恢复不了。
//   - 配了 REDIS_URL → 冷却写 Redis（`llm:pool:cool:<id>`，TTL=冷却秒数），所有实例可见。
//   - 没配 → 退化为进程内（单实例完全正确；多实例各自为政，但不会崩，只是恢复慢一点）。
// 读取加 1 秒本地缓存，避免热路径每次都打 Redis。
//
// ── 明确不做的：跨实例精确并发计数 ───────────────────────────────────────────────
// `maxConcurrency` 是**每实例**上限，不是全局。要做全局精确信号量得引入 Redis INCR/DECR +
// 过期兜底 + 进程崩溃后的泄漏回收，复杂度和失败模式都显著上升；而端点的真实约束是上游配额，
// 上游配额本来就只能「撞了才知道」——429 整窗冷却已经在兜这一层。多实例部署时按实例数分摊配置即可。

import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { prisma } from '../db.js';
import { getRedis } from './redis.js';
import { readAiCredential } from './aiCredentialStorage.js';
import { isRealKey } from '../env.js';
import { endpointLane, setLaneMaxConcurrency, withLlmSlot, is429, retryAfterSecOf, type LlmLaneClass } from './llmGate.js';
import type { ResolvedAiConfig } from './aiConfig.js';
import type { AiProvider, AiThinkingMode } from '../llm/schema.js';
import { normalizeThinkingBudget, normalizeThinkingMode } from '../llm/thinking.js';

const CONFIG_TTL_MS = 5_000;   // 端点列表缓存（后台改配置后最多 5s 生效）
const HEALTH_TTL_MS = 1_000;   // 冷却状态本地缓存，避免热路径每次打 Redis

export interface PoolEndpoint {
  id: string;
  label: string;
  provider: AiProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  thinkingMode: AiThinkingMode;
  thinkingBudget: number;
  // 方言/能力按端点走：池里可以同时有「七牛 Anthropic 网关」和「Anthropic 官方直连」，
  // 两者关闭思考的写法不同（显式 disabled vs 整体省略），用全局方言组装另一个端点的请求必错。
  dialect: string | null;
  capsJson: unknown;
  weight: number;
  tier: number;
  maxConcurrency: number;
}

interface PoolSettings { mode: 'single' | 'pool'; sticky: boolean }

/** 本轮真实尝试的端点快照；由 gateway 落进 LlmTrace。 */
export interface EndpointHit {
  endpointId: string | null;
  endpointLabel: string | null;
  provider: string;
  model: string;
}
export interface EndpointCapture { hit: EndpointHit | null }

// 一次 gateway 调用可能穿过 provider → tool loop → withEndpoint 多层异步边界。
// AsyncLocalStorage 只承载排障元数据，不参与路由决策；并发请求各自隔离。
const endpointCaptureStore = new AsyncLocalStorage<EndpointCapture>();

export function createEndpointCapture(): EndpointCapture {
  return { hit: null };
}

export function runWithEndpointCapture<T>(capture: EndpointCapture, run: () => Promise<T>): Promise<T> {
  return endpointCaptureStore.run(capture, run);
}

/** provider 手动管理候选（流式路径）时也调用；普通 withEndpoint 会自动调用。 */
export function noteEndpointAttempt(cfg: ResolvedAiConfig): void {
  const capture = endpointCaptureStore.getStore();
  if (!capture) return;
  capture.hit = {
    endpointId: cfg.endpointId ?? cfg.traceEndpointId ?? null,
    endpointLabel: cfg.traceEndpointLabel ?? cfg.label ?? null,
    provider: cfg.provider,
    model: cfg.model,
  };
}

let cfgCache: { at: number; endpoints: PoolEndpoint[]; settings: PoolSettings } | null = null;
/** 进程内冷却表（无 Redis 时的唯一来源；有 Redis 时作为读缓存）。 */
const localCool = new Map<string, { until: number; reason: string }>();
let healthCacheAt = 0;

function coolKey(id: string): string { return `llm:pool:cool:${id}`; }

/** 读端点池配置（5s 缓存）。routingMode!=pool 或池内无可用端点 → endpoints 为空，调用方回退单端点。 */
export async function loadPool(force = false): Promise<{ endpoints: PoolEndpoint[]; settings: PoolSettings }> {
  if (!force && cfgCache && Date.now() - cfgCache.at < CONFIG_TTL_MS) {
    return { endpoints: cfgCache.endpoints, settings: cfgCache.settings };
  }
  let endpoints: PoolEndpoint[] = [];
  let settings: PoolSettings = { mode: 'single', sticky: true };

  // 三期：切到归一化表后，池成员来自 purpose='chat' 路由，而不是 ai_model.poolEnabled。
  // 没有可用路由（迁移没跑 / 路由被清空）就静默回落旧表——池的定位是「一个端点挂了还有别的」，
  // 它自己绝不能因为读不到新表而把 AI 停掉。
  const v2 = await routeForPool();
  if (v2) {
    for (const e of v2.endpoints) {
      for (const cls of ['main', 'aux'] as LlmLaneClass[]) setLaneMaxConcurrency(endpointLane(cls, e.id), e.maxConcurrency);
    }
    cfgCache = { at: Date.now(), endpoints: v2.endpoints, settings: v2.settings };
    return { endpoints: v2.endpoints, settings: v2.settings };
  }

  try {
    const row = (await prisma.aiSetting.findUnique({ where: { id: 'default' } })) as Record<string, unknown> | null;
    settings = {
      mode: (row?.routingMode as string) === 'pool' ? 'pool' : 'single',
      sticky: (row?.stickyRouting as boolean | undefined) ?? true,
    };
    if (settings.mode === 'pool') {
      const rows = (await prisma.aiModel.findMany({ orderBy: { createdAt: 'asc' } })) as Record<string, unknown>[];
      endpoints = rows
        .filter((m) => m.poolEnabled === true)
        .map((m) => ({
          id: String(m.id),
          label: String(m.label ?? ''),
          provider: (m.provider as AiProvider) ?? 'openai',
          baseUrl: String(m.baseUrl ?? ''),
          apiKey: readAiCredential(String(m.apiKey ?? '')),
          model: String(m.model ?? ''),
          // 保留端点的运营配置温度；只有实际启用 Thinking 的请求才在 provider 层临时锁为 1。
          temperature: typeof m.temperature === 'number' ? m.temperature : 0.7,
          thinkingMode: normalizeThinkingMode(m.thinkingMode),
          thinkingBudget: normalizeThinkingBudget(m.thinkingBudget),
          dialect: (m.dialect as string | null) ?? null,
          capsJson: m.capsJson ?? null,
          weight: Math.max(1, Number(m.weight ?? 1) || 1),
          tier: Math.max(0, Number(m.tier ?? 0) || 0),
          maxConcurrency: Math.max(0, Number(m.maxConcurrency ?? 0) || 0),
        }))
        // key 解不开或没配 key 的端点直接排除——放进池里只会稳定失败，白白消耗一次转移配额。
        .filter((e) => e.provider === 'mock' || isRealKey(e.apiKey));
      // 把每个端点的并发上限同步给闸门（车道级覆盖）。
      for (const e of endpoints) {
        for (const cls of ['main', 'aux'] as LlmLaneClass[]) {
          setLaneMaxConcurrency(endpointLane(cls, e.id), e.maxConcurrency);
        }
      }
    }
  } catch (err) {
    console.error('[llmPool] 读取端点池失败，回退单端点：', (err as Error).message);
    endpoints = [];
  }
  cfgCache = { at: Date.now(), endpoints, settings };
  return { endpoints, settings };
}

/** purpose='chat' 路由 → 池成员。返回 null 表示没切 V2 或该路由不可用，调用方回落旧表。 */
async function routeForPool(): Promise<{ endpoints: PoolEndpoint[]; settings: PoolSettings } | null> {
  const { resolveRoute } = await import('./aiRoutes.js');
  const route = await resolveRoute('chat');
  if (!route) return null;
  if (route.mode !== 'pool') return { endpoints: [], settings: { mode: 'single', sticky: route.sticky } };
  return {
    settings: { mode: 'pool', sticky: route.sticky },
    endpoints: route.endpoints.map((e) => ({
      id: e.id, label: e.label, provider: e.provider, baseUrl: e.baseUrl, apiKey: e.apiKey,
      model: e.model, temperature: e.temperature,
      thinkingMode: e.thinkingMode as PoolEndpoint['thinkingMode'],
      thinkingBudget: e.thinkingBudget,
      dialect: e.dialect, capsJson: e.capsJson,
      weight: e.weight, tier: e.tier, maxConcurrency: e.maxConcurrency,
    })),
  };
}

/** 刷新冷却视图（Redis → 本地缓存）。无 Redis 时只清理本地过期项。 */
async function refreshHealth(ids: string[]): Promise<void> {
  const now = Date.now();
  if (now - healthCacheAt < HEALTH_TTL_MS) return;
  healthCacheAt = now;
  for (const [k, v] of localCool) if (v.until <= now) localCool.delete(k);

  const redis = await getRedis();
  if (!redis || !ids.length) return;
  try {
    await Promise.all(ids.map(async (id) => {
      const raw = await redis.get(coolKey(id));
      if (raw == null) { localCool.delete(id); return; }
      // 值形如 "<untilMs>|<reason>"；解析失败按「还在冷却，给个保守剩余时长」处理。
      const [untilStr, ...rest] = raw.split('|');
      const until = Number(untilStr);
      localCool.set(id, {
        until: Number.isFinite(until) ? until : now + 5_000,
        reason: rest.join('|') || 'cooling',
      });
    }));
  } catch (err) {
    console.error('[llmPool] 读取冷却状态失败，用本地视图：', (err as Error).message);
  }
}

function isCooling(id: string, now = Date.now()): boolean {
  const c = localCool.get(id);
  return !!c && c.until > now;
}

/** 标记端点冷却。写 Redis（跨实例可见）+ 本地；同时让闸门对该端点车道停发槽位。 */
export async function coolEndpoint(id: string, ms: number, reason: string): Promise<void> {
  const until = Date.now() + ms;
  const prev = localCool.get(id);
  if (!prev || prev.until < until) localCool.set(id, { until, reason });
  const redis = await getRedis();
  if (!redis) return;
  try {
    // 'PX' + 毫秒 TTL，与 cache.ts 的 set 签名一致。
    await redis.set(coolKey(id), `${until}|${reason}`, 'PX', ms);
  } catch (err) {
    console.error('[llmPool] 写冷却状态失败（仅本进程生效）：', (err as Error).message);
  }
}

/** 32 位 hash → (0,1) 开区间，供 HRW 打分用。 */
function unitHash(s: string): number {
  const h = createHash('sha256').update(s).digest();
  // 取 4 字节；+1 / +2 保证严格落在 (0,1)，避免 ln(0) 与 ln(1)=0 除零。
  const v = h.readUInt32BE(0);
  return (v + 1) / 4294967297;
}

/**
 * 加权 Rendezvous（HRW）排序：score = weight / -ln(h(key,id))，取最大者。
 * 这是加权 HRW 的标准形式，选中概率严格正比于 weight，且对成员增删只重映射 1/N。
 */
function hrwSort(endpoints: PoolEndpoint[], key: string): PoolEndpoint[] {
  return [...endpoints]
    .map((e) => ({ e, score: e.weight / -Math.log(unitHash(`${key}\u0000${e.id}`)) }))
    .sort((a, b) => (b.score - a.score) || a.e.id.localeCompare(b.e.id))
    .map((x) => x.e);
}

/**
 * 解析本次调用的候选端点（有序，第一个是首选）。
 *
 * 排序规则：先按 tier 升序分组（tier 0 是同质对等的正常池；tier≥1 是降级备份，
 * 只有当所有更低 tier 全部冷却时才会被排到前面），组内按加权 HRW 排。
 * 冷却中的端点排到最后而不是直接剔除——全部冷却时仍要有东西可试，由闸门决定排队还是降级。
 */
export async function resolveCandidates(
  base: ResolvedAiConfig,
  opts?: { affinityKey?: string },
): Promise<ResolvedAiConfig[]> {
  // 辅助档已经显式选择模型/账号，不参与主模型端点池，否则 AI_AUX_* 会被池内模型覆盖。
  if (base.poolBypass) return [base];
  const { endpoints, settings } = await loadPool();
  if (settings.mode !== 'pool' || endpoints.length === 0) return [base];

  // provider 模块在进入端点池之前已选定；这里只能选择相同协议的端点。
  // 混用会把 Anthropic messages 请求发到 OpenAI chat/completions 端点（反之亦然）。
  const compatible = endpoints.filter((e) => e.provider === base.provider);
  if (compatible.length === 0) return [base];

  await refreshHealth(compatible.map((e) => e.id));
  const now = Date.now();
  // sticky 关闭时用随机 key → 退化为按权重随机分散（缓存命中会掉，仅在明确要均散时用）。
  const key = settings.sticky ? (opts?.affinityKey || 'anon') : `${now}:${Math.random()}`;

  const healthy = compatible.filter((e) => !isCooling(e.id, now));
  const cooling = compatible.filter((e) => isCooling(e.id, now));
  const byTier = (list: PoolEndpoint[]) => {
    const tiers = [...new Set(list.map((e) => e.tier))].sort((a, b) => a - b);
    return tiers.flatMap((t) => hrwSort(list.filter((e) => e.tier === t), key));
  };

  return [...byTier(healthy), ...byTier(cooling)].map((e) => toCfg(base, e));
}

function toCfg(base: ResolvedAiConfig, e: PoolEndpoint): ResolvedAiConfig {
  return {
    ...base,
    endpointId: e.id,
    provider: e.provider,
    label: e.label || base.label,
    baseUrl: e.baseUrl || base.baseUrl,
    apiKey: e.apiKey || base.apiKey,
    model: e.model || base.model,
    temperature: e.temperature,
    thinkingMode: e.thinkingMode,
    thinkingBudget: e.thinkingBudget,
    dialect: e.dialect,
    capsJson: e.capsJson,
    keyDecryptFailed: false, // loadPool 已滤掉解不开 key 的端点
    traceEndpointId: e.id,
    traceEndpointLabel: e.label || undefined,
  };
}

/** 这次失败该不该换个端点重试。 */
export function isTransferable(err: unknown): boolean {
  const e = err as { status?: number; statusCode?: number; code?: string; name?: string; message?: string } | null;
  if (!e) return false;
  // 我方主动降级 / 内容问题 / 输出截断：换端点也一样，不转移。
  if (e.code === 'AI_BUSY' || e.code === 'MODERATION_BLOCK' || e.code === 'AI_OUTPUT_TRUNCATED') return false;
  if (is429(err)) return true;
  const status = e.status ?? e.statusCode;
  if (typeof status === 'number') return status >= 500; // 5xx 转移；其余 4xx 是请求本身的问题
  // 超时 / 连接类：换端点有意义。
  return e.code === 'AI_TIMEOUT' || e.name === 'AbortError'
    || /timeout|abort|socket|ECONN|ETIMEDOUT|fetch failed|network/i.test(e.message ?? '');
}

function coolMsFor(err: unknown): number {
  if (is429(err)) {
    const ra = retryAfterSecOf(err);
    return ra && ra > 0 ? ra * 1000 : 30_000; // 限流：默认冷却 30s，有 Retry-After 就听它的
  }
  return 10_000; // 5xx / 超时：短冷却，给它快点回来的机会
}

/**
 * 包一次真实外呼：按候选顺序尝试，每次都过对应端点的并发闸；
 * 可转移的失败（429 / 5xx / 超时）→ 标记该端点冷却 → 换下一个。
 *
 * 未启用端点池时只有一个候选，行为与直接 `withLlmSlot` 完全一致。
 */
export async function withEndpoint<T>(
  base: ResolvedAiConfig,
  fn: (cfg: ResolvedAiConfig) => Promise<T>,
  opts?: { affinityKey?: string; laneClass?: LlmLaneClass },
): Promise<T> {
  const cls: LlmLaneClass = opts?.laneClass ?? (base.lane === 'aux' ? 'aux' : 'main');
  const candidates = await resolveCandidates(base, { affinityKey: opts?.affinityKey });
  const maxAttempts = Math.max(1, Math.min(candidates.length, Number(process.env.LLM_POOL_MAX_ATTEMPTS ?? 3) || 3));

  let lastErr: unknown;
  for (let i = 0; i < maxAttempts; i++) {
    const cfg = candidates[i];
    const lane = cfg.endpointId ? endpointLane(cls, cfg.endpointId) : cls;
    try {
      return await withLlmSlot(() => {
        noteEndpointAttempt(cfg);
        return fn(cfg);
      }, lane);
    } catch (err) {
      lastErr = err;
      const last = i === maxAttempts - 1;
      if (!cfg.endpointId || !isTransferable(err)) throw err;
      const ms = coolMsFor(err);
      // 即便已经没有下一个候选，也必须写入本地/Redis 冷却；否则其它实例会继续撞同一端点。
      await coolEndpoint(cfg.endpointId, ms, is429(err) ? 'rate_limited' : 'error');
      if (last) throw err;
      console.warn(`[llmPool] 端点 ${cfg.label || cfg.endpointId} 失败并冷却 ${Math.round(ms / 1000)}s，转移到下一个：${(err as Error).message}`);
    }
  }
  throw lastErr;
}

/** 端点池实时状态（供 /metrics 与运营后台）。 */
export async function poolStatus() {
  const { endpoints, settings } = await loadPool();
  await refreshHealth(endpoints.map((e) => e.id));
  const now = Date.now();
  return {
    mode: settings.mode,
    sticky: settings.sticky,
    endpoints: endpoints.map((e) => {
      const c = localCool.get(e.id);
      const cooling = !!c && c.until > now;
      return {
        id: e.id, label: e.label, model: e.model, weight: e.weight, tier: e.tier,
        maxConcurrency: e.maxConcurrency,
        cooling,
        coolingUntil: cooling ? new Date(c!.until).toISOString() : null,
        coolingReason: cooling ? c!.reason : null,
      };
    }),
  };
}

/** 仅供测试：清空缓存与冷却表。 */
export function __resetLlmPool(): void {
  cfgCache = null;
  localCool.clear();
  healthCacheAt = 0;
  // 池成员在 V2 下来自路由表，两层缓存必须一起失效，否则「后台改完立刻生效」只对旧表成立。
  void import('./aiRoutes.js').then((m) => m.__resetAiRoutes()).catch(() => {});
}

/** 仅供测试：注入端点池，跳过 DB。 */
export function __setPoolForTest(endpoints: PoolEndpoint[], settings: PoolSettings): void {
  cfgCache = { at: Date.now(), endpoints, settings };
  healthCacheAt = Date.now(); // 阻止 refreshHealth 打 Redis
}
