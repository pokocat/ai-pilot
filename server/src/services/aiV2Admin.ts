// 归一化接入配置的**写路径**（重设计三期收尾，2026-08-08）。
//
// ── 这个文件存在的意义 ────────────────────────────────────────────────────────
// 三期建了四张表，但此前后台仍写旧表、V2 靠 `syncV2FromLegacy` 投影出来。那样三笔债一笔都没收：
//   · `AiSetting` 那个拷贝还在，而且又多了一层 `ai_model → ai_endpoint` 的拷贝（净负）；
//   · 改一行的 key，投影会按新 key 另建一条凭证，另两行还挂在旧凭证上——轮换 key 照样改 N 行；
//   · 后台没有配 per-purpose 路由的界面，运营还是改不了辅助档。
// 本模块让后台**直接写四张表**，投影与拷贝随之删除。从此：
//   · 「生效」是 `AiRouteMember.primary` 一个指针，没有拷贝就没有漂移；
//   · key 挂在凭证上，一把 key 喂多个端点，换一次改一处；
//   · 每个用途一条路由，辅助档是后台里一个正常配置项。
//
// ── 凭证的隐式管理 ────────────────────────────────────────────────────────────
// 不让运营先建凭证再建端点——那是把内部结构强加给使用者。运营在端点表单里照常填 API Key，
// 这里按 key 去重：填了一把已存在的 key 就复用那条凭证，填新的就建一条。
// 于是「一把 key 喂多个端点」是自然发生的，而不是要求运营先理解「凭证」这个概念。
// 需要轮换 key 时改凭证（`updateCredential`），它下面所有端点一起生效。

import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { isRealKey } from '../env.js';
import { readAiCredential, storeAiCredential } from './aiCredentialStorage.js';
import { __resetAiRoutes, type AiPurpose, PURPOSES } from './aiRoutes.js';
import { inferDialect, dialectById, DIALECTS } from '../llm/dialects.js';
import { AI_PRESETS, VENDORS, vendorOf } from '../llm/vendors.js';
import { normalizeThinkingBudget, normalizeThinkingMode } from '../llm/thinking.js';
import { parseRouteBudget, readCaps } from '../llm/configSchemas.js';
import type { AiProvider, AiEndpointView, AiCredentialView, AiRouteView, AiV2View, AiRouteBudget } from '../llm/schema.js';

/** 写完必须让路由缓存与端点池缓存一起失效，否则「后台改完 5 秒内不生效」。 */
async function invalidate(): Promise<void> {
  __resetAiRoutes();
  // aiConfig 自己还缓存着「已解析配置」和费率（各 4 秒）。少清这一层，
  // 运营改完最多 4 秒不生效且无任何报错——旧结构里这是 setAiConfig 顺手做的，
  // 删掉那套 CRUD 后必须在这里接上。
  const { __resetAiConfigCache } = await import('./aiConfig.js');
  __resetAiConfigCache();
  await import('./llmPool.js').then((m) => m.__resetLlmPool()).catch(() => {});
}

const clampWeight = (v: number) => Math.max(1, Math.floor(v || 1));
const clampTier = (v: number) => Math.max(0, Math.floor(v || 0));
const clampConcurrency = (v: number) => Math.max(0, Math.floor(v || 0));

/** 按 key 找或建凭证。`vendor` 判不出时记 custom + 标黄，确认接入商前不能加入用途路由。 */
async function resolveCredential(apiKey: string, label: string, baseUrl: string): Promise<string> {
  const stored = storeAiCredential(apiKey);
  const existing = await prisma.aiCredential.findFirst({ where: { apiKey: stored } });
  if (existing) return existing.id;
  const v = vendorOf(baseUrl);
  const created = await prisma.aiCredential.create({
    data: {
      label: `${v?.label ?? label} · 凭证`,
      vendor: v?.id ?? 'custom',
      apiKey: stored,
      needsReview: !v,
    },
  });
  return created.id;
}

/* ────────────── 读：后台全景 ────────────── */

export async function v2View(): Promise<AiV2View> {
  const [creds, eps, routes] = await Promise.all([
    prisma.aiCredential.findMany({ orderBy: { createdAt: 'asc' }, include: { _count: { select: { endpoints: true } } } }),
    prisma.aiEndpoint.findMany({ orderBy: { createdAt: 'asc' }, include: { credential: true } }),
    prisma.aiRoute.findMany({ include: { members: true } }),
  ]);

  const credentials: AiCredentialView[] = creds.map((c) => ({
    id: c.id,
    label: c.label,
    vendor: c.vendor,
    hasKey: isRealKey(readAiCredential(c.apiKey)),
    needsReview: c.needsReview,
    endpointCount: c._count.endpoints,
  }));

  // 每个端点被哪些用途引用——运营删端点前必须看得见「删了会影响谁」。
  const usedBy = new Map<string, string[]>();
  for (const r of routes) {
    for (const m of r.members) usedBy.set(m.endpointId, [...(usedBy.get(m.endpointId) ?? []), r.purpose]);
  }

  const endpoints: AiEndpointView[] = eps.map((e) => {
    const resolved = dialectById(e.dialect)?.id
      ?? inferDialect((e.provider as AiProvider) ?? 'mock', e.baseUrl, e.model).id;
    return {
      id: e.id,
      label: e.label,
      credentialId: e.credentialId,
      credentialLabel: e.credential.label,
      provider: (e.provider as AiProvider) ?? 'mock',
      dialect: e.dialect,
      resolvedDialect: resolved,
      baseUrl: e.baseUrl,
      model: e.model,
      temperature: e.temperature,
      thinkingMode: normalizeThinkingMode(e.thinkingMode),
      thinkingBudget: normalizeThinkingBudget(e.thinkingBudget),
      caps: readCaps(e.capsJson),
      hasKey: isRealKey(readAiCredential(e.credential.apiKey)),
      priceInput: e.priceInput,
      priceOutput: e.priceOutput,
      priceCachedInput: e.priceCachedInput,
      priceCacheWrite: e.priceCacheWrite,
      lastProbeAt: e.lastProbeAt?.toISOString() ?? null,
      lastProbeOk: e.lastProbeOk ?? null,
      usedByPurposes: usedBy.get(e.id) ?? [],
    };
  });

  const routeViews: AiRouteView[] = PURPOSES.map((purpose) => {
    const r = routes.find((x) => x.purpose === purpose);
    return {
      purpose,
      exists: !!r,
      mode: r?.mode === 'pool' ? 'pool' : 'single',
      sticky: r?.sticky ?? true,
      enabled: r?.enabled ?? true,
      budget: parseRouteBudget(r?.budgetJson).value ?? {},
      members: (r?.members ?? []).map((m) => ({
        endpointId: m.endpointId,
        primary: m.primary,
        weight: m.weight,
        tier: m.tier,
        maxConcurrency: m.maxConcurrency,
        enabled: m.enabled,
      })),
    };
  });

  // 预设与方言是代码常量，随视图一起下发——前端建端点要用，分三次拉纯属折腾。
  return {
    credentials, endpoints, routes: routeViews, presets: AI_PRESETS, dialects: DIALECTS,
    vendors: [...VENDORS.map(({ id, label }) => ({ id, label })), { id: 'custom', label: '自定义 / 其它' }],
  };
}

/* ────────────── 写：端点 ────────────── */

export interface EndpointUpsert {
  label: string;
  provider: AiProvider;
  baseUrl?: string;
  model?: string;
  dialect?: string | null;
  apiKey?: string;          // 留空＝不改（编辑）/ 无凭证（新增 mock）
  credentialId?: string;    // 显式复用已有凭证（优先于 apiKey）
  temperature?: number;
  thinkingMode?: string;
  thinkingBudget?: number;
  priceInput?: number; priceOutput?: number; priceCachedInput?: number; priceCacheWrite?: number;
}

export async function createEndpoint(input: EndpointUpsert): Promise<string> {
  const provider = input.provider ?? 'openai';
  const baseUrl = input.baseUrl?.trim() ?? '';
  const credentialId = input.credentialId
    ?? await resolveCredential(input.apiKey ?? '', input.label, baseUrl);
  const ep = await prisma.aiEndpoint.create({
    data: {
      label: input.label.trim() || '未命名接入点',
      credentialId,
      // 方言三期起必填：新建时若运营没显式选，就用全仓唯一的 inferDialect 定下来并落库，
      // 而不是留空让运行时每次去猜。
      dialect: dialectById(input.dialect)?.id ?? inferDialect(provider, baseUrl, input.model ?? '').id,
      provider,
      baseUrl,
      model: input.model?.trim() ?? '',
      temperature: typeof input.temperature === 'number' ? input.temperature : 0.7,
      thinkingMode: normalizeThinkingMode(input.thinkingMode),
      thinkingBudget: normalizeThinkingBudget(input.thinkingBudget),
      priceInput: Math.max(0, input.priceInput ?? 0),
      priceOutput: Math.max(0, input.priceOutput ?? 0),
      priceCachedInput: Math.max(0, input.priceCachedInput ?? 0),
      priceCacheWrite: Math.max(0, input.priceCacheWrite ?? 0),
    },
  });
  await invalidate();
  return ep.id;
}

export async function updateEndpoint(id: string, patch: Partial<EndpointUpsert>): Promise<boolean> {
  const existing = await prisma.aiEndpoint.findUnique({ where: { id } });
  if (!existing) return false;
  const data: Record<string, unknown> = {};
  if (patch.label !== undefined) data.label = patch.label.trim() || existing.label;
  if (patch.provider !== undefined) data.provider = patch.provider;
  if (patch.baseUrl !== undefined) data.baseUrl = patch.baseUrl.trim();
  if (patch.model !== undefined) data.model = patch.model.trim();
  if (patch.dialect !== undefined) {
    const provider = (patch.provider ?? existing.provider) as AiProvider;
    const baseUrl = patch.baseUrl ?? existing.baseUrl;
    data.dialect = dialectById(patch.dialect)?.id ?? inferDialect(provider, baseUrl, patch.model ?? existing.model).id;
  }
  if (patch.temperature !== undefined) data.temperature = patch.temperature;
  if (patch.thinkingMode !== undefined) data.thinkingMode = normalizeThinkingMode(patch.thinkingMode);
  if (patch.thinkingBudget !== undefined) data.thinkingBudget = normalizeThinkingBudget(patch.thinkingBudget);
  for (const k of ['priceInput', 'priceOutput', 'priceCachedInput', 'priceCacheWrite'] as const) {
    if (patch[k] !== undefined) data[k] = Math.max(0, patch[k]!);
  }
  // 显式换凭证优先；否则填了新 key 就找或建一条（这就是「一把 key 喂多个端点」的入口）。
  if (patch.credentialId) data.credentialId = patch.credentialId;
  else if (patch.apiKey) data.credentialId = await resolveCredential(patch.apiKey, patch.label ?? existing.label, patch.baseUrl ?? existing.baseUrl);

  await prisma.aiEndpoint.update({ where: { id }, data });
  await invalidate();
  return true;
}

/** 删端点。被任何路由引用时拒绝——静默从路由里消失比报错难查得多。 */
export async function deleteEndpoint(id: string): Promise<{ ok: boolean; reason?: string }> {
  const result = await prisma.$transaction(async (tx) => {
    const members = await tx.aiRouteMember.findMany({ where: { endpointId: id }, include: { route: true } });
    if (members.length) {
      return { ok: false, reason: `该接入点仍被「${members.map((m) => m.route.purpose).join('、')}」用途引用，请先从路由里移出` };
    }
    const removed = await tx.aiEndpoint.deleteMany({ where: { id } });
    if (!removed.count) return { ok: false, reason: '接入点不存在' };
    // 顺手清掉没有任何端点的孤儿凭证——凭证是端点的附属，不该留一堆空壳。
    await tx.aiCredential.deleteMany({ where: { endpoints: { none: {} } } });
    return { ok: true };
  });
  if (!result.ok) return result;
  await invalidate();
  return result;
}

/* ────────────── 写：凭证（换 key 的唯一入口） ────────────── */

export async function updateCredential(
  id: string, patch: { label?: string; vendor?: string; apiKey?: string },
): Promise<{ ok: boolean; reason?: string }> {
  const existing = await prisma.aiCredential.findUnique({ where: { id } });
  if (!existing) return { ok: false, reason: '凭证不存在' };
  const data: Record<string, unknown> = {};
  if (patch.label !== undefined) data.label = patch.label.trim() || existing.label;
  // 运营确认了接入商 → 摘掉黄标。迁移期标黄的那些就是靠这一步转正的。
  if (patch.vendor !== undefined) {
    if (patch.vendor !== 'custom' && !VENDORS.some((v) => v.id === patch.vendor)) {
      return { ok: false, reason: `未知接入商 ${patch.vendor}` };
    }
    data.vendor = patch.vendor;
    data.needsReview = false;
  }
  // 轮换 key：改这一处，它下面所有端点一起生效——这正是三期要买的东西。
  if (patch.apiKey) { data.apiKey = storeAiCredential(patch.apiKey); data.modelScope = null; data.scopeCheckedAt = null; }
  await prisma.aiCredential.update({ where: { id }, data });
  await invalidate();
  return { ok: true };
}

/* ────────────── 写：路由 ────────────── */

export interface RouteUpsert {
  mode?: 'single' | 'pool';
  sticky?: boolean;
  enabled?: boolean;
  budget?: AiRouteBudget | null;
  members?: { endpointId: string; primary?: boolean; weight?: number; tier?: number; maxConcurrency?: number; enabled?: boolean }[];
}

export async function saveRoute(purpose: AiPurpose, patch: RouteUpsert): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const budgetData = patch.budget === null
      ? Prisma.DbNull
      : patch.budget === undefined ? undefined : patch.budget as object;
    const route = await tx.aiRoute.upsert({
      where: { purpose },
      update: {
        ...(patch.mode !== undefined ? { mode: patch.mode } : {}),
        ...(patch.sticky !== undefined ? { sticky: patch.sticky } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(budgetData !== undefined ? { budgetJson: budgetData } : {}),
      },
      create: {
        purpose,
        mode: patch.mode ?? 'single',
        sticky: patch.sticky ?? true,
        enabled: patch.enabled ?? true,
        ...(budgetData !== undefined ? { budgetJson: budgetData } : {}),
      },
    });

    if (patch.members) {
      // 删除与重建必须在同一事务里：任一外键/重复成员失败都完整回滚，不能先把线上路由清空。
      await tx.aiRouteMember.deleteMany({ where: { routeId: route.id } });
      const firstPrimary = patch.members.findIndex((m) => m.primary && m.enabled !== false);
      const fallbackPrimary = firstPrimary >= 0 ? firstPrimary : patch.members.findIndex((m) => m.enabled !== false);
      for (const [i, m] of patch.members.entries()) {
        await tx.aiRouteMember.create({
          data: {
            routeId: route.id,
            endpointId: m.endpointId,
            primary: i === fallbackPrimary,
            weight: clampWeight(m.weight ?? 1),
            tier: clampTier(m.tier ?? 0),
            maxConcurrency: clampConcurrency(m.maxConcurrency ?? 0),
            enabled: m.enabled ?? true,
          },
        });
      }
    }
  });
  await invalidate();
}

/** 把某个用途的主端点切成指定端点（后台「设为生效」）。不在成员里就先加进去。 */
export async function setPrimary(purpose: AiPurpose, endpointId: string): Promise<boolean> {
  const ep = await prisma.aiEndpoint.findUnique({ where: { id: endpointId } });
  if (!ep) return false;
  await prisma.$transaction(async (tx) => {
    const poolable = purpose === 'chat' || purpose === 'deliverable';
    const route = await tx.aiRoute.upsert({
      where: { purpose },
      update: poolable ? {} : { mode: 'single' },
      create: { purpose, mode: 'single', sticky: true },
    });
    await tx.aiRouteMember.upsert({
      where: { routeId_endpointId: { routeId: route.id, endpointId } },
      update: { primary: true, enabled: true },
      create: { routeId: route.id, endpointId, primary: true },
    });
    if (poolable) {
      await tx.aiRouteMember.updateMany({
        where: { routeId: route.id, endpointId: { not: endpointId } }, data: { primary: false },
      });
    } else {
      // 辅助/嵌入/重排/审核是单端点用途；换主端点就替换成员，避免旧端点仍被“引用”而删不掉。
      await tx.aiRouteMember.deleteMany({ where: { routeId: route.id, endpointId: { not: endpointId } } });
    }
  });
  await invalidate();
  return true;
}

/** 端点入池 / 出池（= chat 路由的成员增删）。 */
export async function setPoolMembership(endpointId: string, inPool: boolean): Promise<{ ok: boolean; reason?: string }> {
  const endpoint = await prisma.aiEndpoint.findUnique({ where: { id: endpointId }, select: { id: true } });
  if (!endpoint) return { ok: false, reason: '接入点不存在' };
  const route = await prisma.aiRoute.findUnique({ where: { purpose: 'chat' }, include: { members: true } });
  if (!route) return { ok: false, reason: '还没有对话路由，请先给某个接入点「设为对话生效」' };
  if (inPool) {
    await prisma.aiRouteMember.upsert({
      where: { routeId_endpointId: { routeId: route.id, endpointId } },
      update: { enabled: true },
      create: { routeId: route.id, endpointId },
    });
  } else {
    const m = route.members.find((x) => x.endpointId === endpointId);
    // 主端点不能移出：移了这个用途就没有生效端点了。
    if (m?.primary) return { ok: false, reason: '主端点不能移出，请先把别的接入点设为对话生效' };
    await prisma.aiRouteMember.deleteMany({ where: { routeId: route.id, endpointId } });
  }
  await invalidate();
  return { ok: true };
}

/* ────────────── 测试与引导用 ────────────── */

/**
 * 一步配好「某用途用某个上游」：建/复用凭证 → 建端点 → 指为该用途的 primary。
 *
 * 存在的理由：旧结构里测试和引导脚本一句 `setAiConfig({...})` 就能把 AI 配好，
 * 归一化之后那句话对应「三张表三步写入」。不给个等价的一句话，每个测试都要自己拼三步，
 * 拼法还各不相同——那种重复迟早分叉成「测试里配的和后台配出来的不是一回事」。
 */
export async function configurePurpose(purpose: AiPurpose, input: {
  label: string; provider: AiProvider; baseUrl?: string; model?: string; apiKey?: string;
  dialect?: string | null; temperature?: number;
  thinkingMode?: string; thinkingBudget?: number;
  priceInput?: number; priceOutput?: number; priceCachedInput?: number; priceCacheWrite?: number;
}): Promise<string> {
  const id = await createEndpoint({
    label: input.label, provider: input.provider,
    baseUrl: input.baseUrl ?? '', model: input.model ?? '',
    apiKey: input.apiKey ?? '', dialect: input.dialect ?? null,
    temperature: input.temperature, thinkingMode: input.thinkingMode as never,
    thinkingBudget: input.thinkingBudget,
    priceInput: input.priceInput, priceOutput: input.priceOutput,
    priceCachedInput: input.priceCachedInput, priceCacheWrite: input.priceCacheWrite,
  });
  await setPrimary(purpose, id);
  return id;
}

/** 清空全部归一化接入配置（仅测试用）。 */
export async function __wipeAiV2(): Promise<void> {
  await prisma.aiRouteMember.deleteMany({});
  await prisma.aiRoute.deleteMany({});
  await prisma.aiEndpoint.deleteMany({});
  await prisma.aiCredential.deleteMany({});
  await invalidate();
}
