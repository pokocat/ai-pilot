// 按「用途」解析接入配置（重设计三期，2026-08-07）。
//
// ── 三期解决的是什么 ──────────────────────────────────────────────────────────
// 旧结构里「生效」＝把某一行 `AiModel` 的 8 个字段**拷进** `AiSetting` 单例。于是：
//   · 双真相源：直接改 AiSetting 的编辑，会在下次「切换」时被静默还原；
//     端点池的协议校验读的还是这个拷贝值，而不是池自身；
//   · 一把 key 被复制 N 份（每个 AiModel 各存一份），换 key 要改 N 行；
//   · **只有一个全局配置**：对话、成果、辅助抽取、嵌入、重排全挤在它身上。
//     辅助档因此只能用 `AI_AUX_*` 环境变量配——运营在后台根本看不见它。
//
// 归一化之后：「生效」是一个指针（`AiRouteMember.primary`），不再有拷贝；
// key 提到凭证上；**每个用途一条路由**，各有各的端点、权重与预算。
//
// ── 切换与应急逃生 ────────────────────────────────────────────────────────────
// 三期写路径收尾后 `AI_CONFIG_V2` 默认开：后台只写四张归一化表。只有该用途真有可用路由时
// 才走新表，否则静默回落旧路径，避免迁移没跑完或数据库刚恢复时直接停摆。
// 显式 `AI_CONFIG_V2=false` 会读不再更新的旧表历史快照，只能短时救急，不能当长期回滚方案。

import { prisma } from '../db.js';
import { env, isRealKey } from '../env.js';
import { readAiCredential } from './aiCredentialStorage.js';
import type { ResolvedAiConfig } from './aiConfig.js';
import { parseRouteBudget } from '../llm/configSchemas.js';
import { normalizeThinkingBudget, normalizeThinkingMode } from '../llm/thinking.js';
import type { AiProvider } from '../llm/schema.js';

/** 用途。三期的主要功能收益就是这一层——旧结构只有「一个全局配置」。 */
export type AiPurpose = 'chat' | 'deliverable' | 'aux' | 'embedding' | 'rerank' | 'moderation';

export const PURPOSES: AiPurpose[] = ['chat', 'deliverable', 'aux', 'embedding', 'rerank', 'moderation'];

export interface RouteEndpoint {
  id: string;
  label: string;
  provider: AiProvider;
  dialect: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  thinkingMode: string;
  thinkingBudget: number;
  capsJson: unknown;
  primary: boolean;
  weight: number;
  tier: number;
  maxConcurrency: number;
}

export interface ResolvedRoute {
  purpose: AiPurpose;
  mode: 'single' | 'pool';
  sticky: boolean;
  endpoints: RouteEndpoint[];
  budget: { timeoutMs?: number; bodyMaxTokens?: number; temperature?: number };
}

/**
 * 读路径是否走归一化表。**三期收尾后默认开**——后台已经只写这四张表，旧表不再被写入。
 *
 * 留 `AI_CONFIG_V2=false` 这个逃生口是给「切换当天发现问题」用的：关掉它会退回读
 * `AiSetting` 的**历史快照**。注意那是快照不是真相——旧表自本次上线起不再更新，
 * 关掉开关只能救急，不能长期跑，救完必须查清楚再切回来。
 */
export function v2Enabled(): boolean {
  return (process.env.AI_CONFIG_V2 ?? 'true').trim() !== 'false';
}

const TTL = 4_000;
let cache: { at: number; routes: Map<AiPurpose, ResolvedRoute> } | null = null;

export function __resetAiRoutes(): void { cache = null; }

async function loadRoutes(force = false): Promise<Map<AiPurpose, ResolvedRoute>> {
  if (!force && cache && Date.now() - cache.at < TTL) return cache.routes;
  const out = new Map<AiPurpose, ResolvedRoute>();
  try {
    const rows = await prisma.aiRoute.findMany({
      where: { enabled: true },
      include: { members: { where: { enabled: true }, include: { endpoint: { include: { credential: true } } } } },
    });
    for (const r of rows) {
      const endpoints: RouteEndpoint[] = r.members
        .map((mem) => {
          const e = mem.endpoint;
          return {
            id: e.id,
            label: e.label,
            provider: (e.provider as AiProvider) ?? 'mock',
            dialect: e.dialect,
            baseUrl: e.baseUrl,
            apiKey: readAiCredential(e.credential.apiKey),
            model: e.model,
            temperature: e.temperature,
            thinkingMode: normalizeThinkingMode(e.thinkingMode),
            thinkingBudget: normalizeThinkingBudget(e.thinkingBudget),
            capsJson: e.capsJson,
            primary: mem.primary,
            weight: Math.max(1, mem.weight),
            tier: Math.max(0, mem.tier),
            maxConcurrency: Math.max(0, mem.maxConcurrency),
          };
        })
        // 没配 key 的端点放进路由只会稳定失败，还白耗一次故障转移配额（与 llmPool 同口径）。
        .filter((e) => e.provider === 'mock' || isRealKey(e.apiKey));
      if (!endpoints.length) continue;
      out.set(r.purpose as AiPurpose, {
        purpose: r.purpose as AiPurpose,
        mode: r.mode === 'pool' ? 'pool' : 'single',
        sticky: r.sticky,
        endpoints,
        budget: parseRouteBudget(r.budgetJson).value ?? {},
      });
    }
  } catch (err) {
    // 新表还没建（迁移没跑）→ 读失败是预期的，静默回落旧路径，绝不让 AI 停摆。
    console.error('[aiRoutes] 读取归一化路由失败，回落旧配置：', (err as Error).message);
  }
  cache = { at: Date.now(), routes: out };
  return out;
}

/** 某个用途的路由。没有可用路由 → null，调用方回落旧路径。 */
export async function resolveRoute(purpose: AiPurpose, force = false): Promise<ResolvedRoute | null> {
  if (!v2Enabled()) return null;
  const routes = await loadRoutes(force);
  return routes.get(purpose) ?? null;
}

/**
 * 路由的「主端点」→ ResolvedAiConfig。
 *
 * single 模式取 primary；pool 模式也取 primary 作为基准配置，具体分流仍由 services/llmPool 做
 * ——路由只回答「用哪一组端点」，不回答「这次落哪一个」，那是 HRW + 会话粘性的职责。
 */
export function routeToConfig(route: ResolvedRoute, base: ResolvedAiConfig): ResolvedAiConfig {
  const ep = route.endpoints.find((e) => e.primary) ?? route.endpoints[0];
  return {
    ...base,
    provider: ep.provider,
    label: ep.label,
    baseUrl: ep.baseUrl,
    apiKey: ep.apiKey,
    model: ep.model,
    temperature: route.budget.temperature ?? ep.temperature,
    thinkingMode: normalizeThinkingMode(ep.thinkingMode),
    thinkingBudget: normalizeThinkingBudget(ep.thinkingBudget),
    dialect: ep.dialect,
    capsJson: ep.capsJson,
    timeoutMs: route.budget.timeoutMs ?? base.timeoutMs,
    keyDecryptFailed: false, // loadRoutes 已滤掉解不开 key 的端点
    endpointId: ep.id,
    traceEndpointId: ep.id,
    traceEndpointLabel: ep.label,
    // 非对话用途走独立车道：它们有自己的上游配额，不该和用户可见的生成抢槽位。
    lane: route.purpose === 'aux' ? 'aux' : base.lane,
    // aux / embedding / rerank 已显式选定端点，不得再被主端点池覆盖。
    poolBypass: route.purpose !== 'chat' && route.purpose !== 'deliverable',
  };
}

/** 某用途的解析结果（没配该用途 → null，调用方沿用旧行为）。 */
export async function configForPurpose(purpose: AiPurpose, base: ResolvedAiConfig): Promise<ResolvedAiConfig | null> {
  const route = await resolveRoute(purpose);
  return route ? routeToConfig(route, base) : null;
}

/** 迁移是否已就绪（后台展示 + 切换前自检）。 */
export async function v2Status(): Promise<{
  enabled: boolean;
  ready: boolean;
  routes: { purpose: string; mode: string; members: number; primary: string | null }[];
  credentialsNeedingReview: { id: string; label: string }[];
}> {
  const routes = await loadRoutes(true);
  let needReview: { id: string; label: string }[] = [];
  try {
    needReview = (await prisma.aiCredential.findMany({
      where: { needsReview: true }, select: { id: true, label: true },
    }));
  } catch { /* 表还没建 */ }
  return {
    enabled: v2Enabled(),
    // 「就绪」的最低门槛就是 chat 路由有可用端点——没有它，切过去就是把 AI 关掉。
    ready: !!routes.get('chat')?.endpoints.length,
    routes: [...routes.values()].map((r) => ({
      purpose: r.purpose,
      mode: r.mode,
      members: r.endpoints.length,
      primary: (r.endpoints.find((e) => e.primary) ?? r.endpoints[0])?.label ?? null,
    })),
    credentialsNeedingReview: needReview,
  };
}

/** env 兜底口径（供 aiConfig 在两条路径间保持同一个 timeoutMs 基准）。 */
export function defaultTimeoutMs(): number {
  return env.openaiTimeoutMs;
}
