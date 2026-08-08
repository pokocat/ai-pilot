// 校验器的取数层（2026-08-07 · 重设计二期）。
//
// `llm/validate.ts` 是纯函数——它要能在保存前、探活前、单测里以同一种方式跑，所以不查库。
// 本文件负责把它需要的事实查出来喂进去，并给 admin 路由一个「一行就能用」的入口。
//
// 这样分层的实际收益：路由里那三段各写各的池协议校验（新增/编辑/切换各一份、判据还都是
// `AiSetting.provider` 这个拷贝值）合并成一处，且判据换成**成员自身的方言**——
// 拷贝值会漂移，而且它回答的是「当前生效模型是什么协议」，跟池自不自洽根本是两个问题。

import { prisma } from '../db.js';
import { isRealKey } from '../env.js';
import { readAiCredential } from './aiCredentialStorage.js';
import { CHAT_MAX_TOKENS } from '../llm/providers/completionGuard.js';
import { parseRouteBudget, readCaps } from '../llm/configSchemas.js';
import { resolveDialect } from '../llm/dialects.js';
import { vendorCapsOf, vendorOf } from '../llm/vendors.js';
import {
  validateEndpoint, validateRoute, hasBlocking, blockingMessage,
  type EndpointDraft, type EndpointFacts,
} from '../llm/validate.js';
import type {
  AiConfigIssue, AiProvider, AiThinkingMode, AiEndpointUpsert, AiRouteUpsert,
} from '../llm/schema.js';
import { normalizeThinkingBudget, normalizeThinkingMode } from '../llm/thinking.js';

export { hasBlocking, blockingMessage };

/** 查齐事实并校验单个端点。 */
export async function checkEndpoint(draft: EndpointDraft): Promise<AiConfigIssue[]> {
  const facts: EndpointFacts = { bodyMaxTokens: CHAT_MAX_TOKENS };
  try {
    // 同名模型在别的端点上的价格：单价是 model 级 SSOT，冲突会让整个模型退回未校准。
    if (draft.model) {
      const sibs = (await prisma.aiEndpoint.findMany({
        where: { model: draft.model, ...(draft.id ? { id: { not: draft.id } } : {}) },
        select: { priceInput: true, priceOutput: true, priceCachedInput: true, priceCacheWrite: true },
      })) as EndpointFacts['siblingPrices'];
      // 全 0 的兄弟端点是「没配价」，不是「配了个不一样的价」，不该报冲突。
      facts.siblingPrices = (sibs ?? []).filter((s) => s.priceInput > 0 || s.priceOutput > 0);
    }
    // 模型范围由 model_scope 探活回填进 caps；没探过就没有这条事实，对应规则自动跳过。
    const scope = readCaps(draft.capsJson).modelScope;
    if (scope?.models.length) facts.modelScope = scope.models;
  } catch {
    /* DB 不可达：少几条事实就少几条规则，绝不因此拦住保存 */
  }
  return validateEndpoint(draft, facts);
}

/* ────────────── 归一化表（三期收尾）的取数层 ────────────── */

/** 端点表单 + 库里已存的值 → 待校验草稿（PATCH 语义：未传的沿用库里的）。 */
export async function draftFromEndpointUpsert(patch: AiEndpointUpsert, id?: string): Promise<EndpointDraft> {
  const row = id ? await prisma.aiEndpoint.findUnique({ where: { id }, include: { credential: true } }) : null;
  const provider = (patch.provider ?? row?.provider ?? 'openai') as AiProvider;
  return {
    id,
    label: patch.label ?? row?.label ?? '',
    provider,
    baseUrl: patch.baseUrl ?? row?.baseUrl ?? '',
    model: patch.model ?? row?.model ?? '',
    dialect: patch.dialect !== undefined ? (patch.dialect || null) : (row?.dialect ?? null),
    capsJson: row?.capsJson ?? null,
    thinkingMode: normalizeThinkingMode(patch.thinkingMode ?? row?.thinkingMode) as AiThinkingMode,
    thinkingBudget: patch.thinkingBudget ?? row?.thinkingBudget ?? 1024,
    temperature: patch.temperature ?? row?.temperature,
    // key 留空＝不改，所以「有没有 key」看库里那条凭证；新增时看这次传没传。
    hasKey: patch.apiKey ? isRealKey(patch.apiKey) : isRealKey(readAiCredential(row?.credential.apiKey ?? '')),
    priceInput: patch.priceInput ?? row?.priceInput ?? 0,
    priceOutput: patch.priceOutput ?? row?.priceOutput ?? 0,
    priceCachedInput: patch.priceCachedInput ?? row?.priceCachedInput ?? 0,
    priceCacheWrite: patch.priceCacheWrite ?? row?.priceCacheWrite ?? 0,
  };
}

/**
 * 保存某个用途的路由前校验。
 * 判据一律是**成员自身的方言**——归一化之后再没有任何全局拷贝值可依赖，这也正是想要的。
 */
export async function checkRoutePurpose(
  purpose: string, patch: AiRouteUpsert, override?: EndpointDraft,
): Promise<AiConfigIssue[]> {
  const route = await prisma.aiRoute.findUnique({ where: { purpose }, include: { members: true } });
  const wanted = patch.members ?? route?.members.map((m) => ({
    endpointId: m.endpointId, primary: m.primary, weight: m.weight, tier: m.tier,
    maxConcurrency: m.maxConcurrency, enabled: m.enabled,
  })) ?? [];
  const ids = wanted.filter((m) => m.enabled !== false).map((m) => m.endpointId);
  const uniqueIds = [...new Set(ids)];
  const eps = ids.length
    ? await prisma.aiEndpoint.findMany({ where: { id: { in: uniqueIds } }, include: { credential: true } })
    : [];
  const endpointDrafts = eps.map((e): EndpointDraft => e.id === override?.id ? override : ({
    id: e.id, label: e.label, provider: (e.provider as AiProvider) ?? 'mock',
    baseUrl: e.baseUrl, model: e.model, dialect: e.dialect, capsJson: e.capsJson,
    thinkingMode: normalizeThinkingMode(e.thinkingMode), thinkingBudget: e.thinkingBudget,
    temperature: e.temperature, hasKey: isRealKey(readAiCredential(e.credential.apiKey)),
    priceInput: e.priceInput, priceOutput: e.priceOutput,
    priceCachedInput: e.priceCachedInput, priceCacheWrite: e.priceCacheWrite,
  }));
  const members = endpointDrafts.map((e) => ({
    id: e.id!, label: e.label, provider: e.provider, baseUrl: e.baseUrl,
    model: e.model, dialect: e.dialect, hasKey: e.hasKey,
  }));
  const mode = patch.mode ?? (route?.mode === 'pool' ? 'pool' : 'single');
  const out = validateRoute({ mode }, members);
  if (patch.budget !== undefined && patch.budget !== null) {
    const parsed = parseRouteBudget(patch.budget);
    if (!parsed.value) out.push({ level: 'error', code: 'ROUTE_BUDGET_INVALID', message: parsed.issue });
  }
  if (uniqueIds.length !== ids.length) {
    out.push({ level: 'error', code: 'ROUTE_DUPLICATE_MEMBER', message: `「${purpose}」用途里有重复接入点，请每个端点只保留一项` });
  }
  const found = new Set(eps.map((e) => e.id));
  const missing = uniqueIds.filter((id) => !found.has(id));
  if (missing.length) {
    out.push({ level: 'error', code: 'ROUTE_ENDPOINT_NOT_FOUND', message: `「${purpose}」用途引用了不存在的接入点：${missing.join('、')}` });
  }
  if (wanted.filter((m) => m.enabled !== false && m.primary).length > 1) {
    out.push({ level: 'error', code: 'ROUTE_MULTIPLE_PRIMARY', message: `「${purpose}」用途只能有一个生效接入点` });
  }
  for (const e of eps) {
    if (e.credential.needsReview) {
      out.push({
        level: 'error', code: 'CREDENTIAL_VENDOR_UNCONFIRMED',
        message: `「${e.label}」的接入商尚未确认；请先在凭证区确认厂商或选择“自定义 / 其它”`,
      });
    }
  }
  if (purpose === 'embedding' || purpose === 'rerank') {
    const name = purpose === 'embedding' ? '向量嵌入' : '重排';
    for (const endpoint of endpointDrafts) {
      const dialect = resolveDialect(endpoint).dialect;
      if (dialect.protocol !== 'openai_chat') {
        out.push({
          level: 'error', code: 'AUX_ORIGIN_PROTOCOL_MISMATCH',
          message: `「${endpoint.label}」走 ${dialect.label}，没有标准 /${purpose === 'embedding' ? 'embeddings' : 'rerank'} 请求形状；${name}请改用 OpenAI 兼容端点`,
        });
        continue;
      }
      const caps = vendorCapsOf(endpoint.baseUrl);
      const supported = purpose === 'embedding' ? caps.embedding : caps.rerank;
      if (!supported) {
        out.push({
          level: 'error', code: 'AUX_VENDOR_UNSUPPORTED',
          message: `${vendorOf(endpoint.baseUrl)?.label ?? '当前接入商'}不提供${name}模型，不能用于「${purpose}」用途`,
        });
      }
    }
  }
  // single 模式也要有端点：一条没有可用成员的路由 = 把这个用途关掉了，且不会报错。
  if (mode === 'single' && members.length === 0 && (patch.members || route)) {
    out.push({ level: 'error', code: 'ROUTE_EMPTY', message: `「${purpose}」用途没有可用接入点，保存后该用途会停摆` });
  }
  return out;
}

/** 编辑一个已被路由引用的端点时，用新值重算所有受影响路由，避免保存后才把池改成混协议。 */
export async function checkEndpointRoutes(id: string, override: EndpointDraft): Promise<AiConfigIssue[]> {
  const routes = await prisma.aiRoute.findMany({ where: { members: { some: { endpointId: id } } } });
  const issues: AiConfigIssue[] = [];
  for (const route of routes) issues.push(...await checkRoutePurpose(route.purpose, {}, override));
  return issues;
}

/** 「设为生效」也属于保存路由，必须先过同一套用途校验。 */
export async function checkPrimaryPurpose(purpose: string, endpointId: string): Promise<AiConfigIssue[]> {
  const route = await prisma.aiRoute.findUnique({ where: { purpose }, include: { members: true } });
  const poolable = purpose === 'chat' || purpose === 'deliverable';
  const members = poolable
    ? [
        ...(route?.members ?? []).filter((m) => m.endpointId !== endpointId).map((m) => ({
          endpointId: m.endpointId, primary: false, weight: m.weight, tier: m.tier,
          maxConcurrency: m.maxConcurrency, enabled: m.enabled,
        })),
        { endpointId, primary: true, enabled: true },
      ]
    : [{ endpointId, primary: true, enabled: true }];
  return checkRoutePurpose(purpose, { mode: poolable && route?.mode === 'pool' ? 'pool' : 'single', members });
}

/** 对话端点入池 / 出池前先验证变更后的完整成员集合；入池按 pool 语义检查，不能等切模式才报。 */
export async function checkPoolMembershipPurpose(endpointId: string, inPool: boolean): Promise<AiConfigIssue[]> {
  const route = await prisma.aiRoute.findUnique({ where: { purpose: 'chat' }, include: { members: true } });
  if (!route) return [];
  const existing = route.members.filter((m) => m.endpointId !== endpointId).map((m) => ({
    endpointId: m.endpointId, primary: m.primary, weight: m.weight, tier: m.tier,
    maxConcurrency: m.maxConcurrency, enabled: m.enabled,
  }));
  const members = inPool ? [...existing, { endpointId, primary: false, enabled: true }] : existing;
  return checkRoutePurpose('chat', { mode: inPool ? 'pool' : (route.mode === 'pool' ? 'pool' : 'single'), members });
}
