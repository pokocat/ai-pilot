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
import { readCaps } from '../llm/configSchemas.js';
import {
  validateEndpoint, validateRoute, validateAuxEndpoint, hasBlocking, blockingMessage,
  type EndpointDraft, type EndpointFacts,
} from '../llm/validate.js';
import type { AiConfigIssue, AiProvider, AiModelUpsert, AiThinkingMode } from '../llm/schema.js';
import { normalizeThinkingBudget, normalizeThinkingMode } from '../llm/thinking.js';

export { hasBlocking, blockingMessage };

type Row = {
  id: string; label: string; provider: string; baseUrl: string; model: string;
  apiKey: string; dialect: string | null; capsJson: unknown;
  thinkingMode: string; thinkingBudget: number; temperature: number;
  priceInput: number; priceOutput: number; priceCachedInput: number; priceCacheWrite: number;
  poolEnabled: boolean;
};

function toDraft(r: Row): EndpointDraft {
  return {
    id: r.id, label: r.label, provider: (r.provider as AiProvider) ?? 'mock',
    baseUrl: r.baseUrl, model: r.model, dialect: r.dialect, capsJson: r.capsJson,
    thinkingMode: normalizeThinkingMode(r.thinkingMode),
    thinkingBudget: normalizeThinkingBudget(r.thinkingBudget),
    temperature: r.temperature,
    hasKey: isRealKey(readAiCredential(r.apiKey)),
    priceInput: r.priceInput, priceOutput: r.priceOutput,
    priceCachedInput: r.priceCachedInput, priceCacheWrite: r.priceCacheWrite,
    poolEnabled: r.poolEnabled,
  };
}

/** 把「新增/编辑表单 + 库里已存的值」合成待校验草稿。编辑时未传的字段沿用库里的（PATCH 语义）。 */
export async function draftFromUpsert(patch: AiModelUpsert, id?: string): Promise<EndpointDraft> {
  const existing = id ? ((await prisma.aiModel.findUnique({ where: { id } })) as Row | null) : null;
  const base = existing ? toDraft(existing) : null;
  const provider = (patch.provider ?? base?.provider ?? 'openai') as AiProvider;
  return {
    id,
    label: patch.label ?? base?.label ?? '',
    provider,
    baseUrl: patch.baseUrl ?? base?.baseUrl ?? '',
    model: patch.model ?? base?.model ?? '',
    dialect: patch.dialect !== undefined ? (patch.dialect || null) : (base?.dialect ?? null),
    capsJson: base?.capsJson ?? null,
    thinkingMode: normalizeThinkingMode(patch.thinkingMode ?? base?.thinkingMode) as AiThinkingMode,
    thinkingBudget: patch.thinkingBudget ?? base?.thinkingBudget ?? 1024,
    temperature: patch.temperature ?? base?.temperature,
    // key 留空＝不改，所以「有没有 key」要看库里；新增时看这次传没传。
    hasKey: patch.apiKey ? isRealKey(patch.apiKey) : (base?.hasKey ?? false),
    priceInput: patch.priceInput ?? base?.priceInput ?? 0,
    priceOutput: patch.priceOutput ?? base?.priceOutput ?? 0,
    priceCachedInput: patch.priceCachedInput ?? base?.priceCachedInput ?? 0,
    priceCacheWrite: patch.priceCacheWrite ?? base?.priceCacheWrite ?? 0,
    poolEnabled: patch.poolEnabled ?? base?.poolEnabled ?? false,
  };
}

/** 查齐事实并校验单个端点。 */
export async function checkEndpoint(draft: EndpointDraft): Promise<AiConfigIssue[]> {
  const facts: EndpointFacts = { bodyMaxTokens: CHAT_MAX_TOKENS };
  try {
    // 同名模型在别的端点上的价格：单价是 model 级 SSOT，冲突会让整个模型退回未校准。
    if (draft.model) {
      const sibs = (await prisma.aiModel.findMany({
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

/**
 * 端点池成员一致性。`override` 用于「保存前预判」——把这次要改的那个端点的新值代入，
 * 而不是拿库里的旧值算，否则运营改完保存才发现冲突。
 */
export async function checkPool(
  opts: { mode?: 'single' | 'pool'; override?: EndpointDraft; excludeId?: string } = {},
): Promise<AiConfigIssue[]> {
  const setting = await prisma.aiSetting.findUnique({ where: { id: 'default' }, select: { routingMode: true } });
  const mode = opts.mode ?? (setting?.routingMode === 'pool' ? 'pool' : 'single');
  if (mode !== 'pool') return [];

  const rows = (await prisma.aiModel.findMany({ where: { poolEnabled: true } })) as Row[];
  const members = rows
    .filter((r) => r.id !== opts.excludeId && r.id !== opts.override?.id)
    .map((r) => {
      const d = toDraft(r);
      return { id: d.id!, label: d.label, provider: d.provider, baseUrl: d.baseUrl, model: d.model, dialect: d.dialect, hasKey: d.hasKey };
    });
  const ov = opts.override;
  if (ov?.poolEnabled) {
    members.push({ id: ov.id ?? 'new', label: ov.label, provider: ov.provider, baseUrl: ov.baseUrl, model: ov.model, dialect: ov.dialect, hasKey: ov.hasKey });
  }
  return validateRoute({ mode: 'pool' }, members);
}

/** 嵌入 / 重排配置：协议与厂商两条都判。 */
export async function checkAux(patch: {
  embeddingEnabled?: boolean; embeddingModel?: string; embeddingBaseUrl?: string; embeddingApiKey?: string;
  rerankEnabled?: boolean; rerankModel?: string; rerankBaseUrl?: string; rerankApiKey?: string;
}): Promise<AiConfigIssue[]> {
  const row = await prisma.aiSetting.findUnique({ where: { id: 'default' } });
  if (!row) return [];
  const chat = {
    provider: (row.provider as AiProvider) ?? 'mock',
    baseUrl: row.baseUrl,
    model: row.model,
    dialect: row.dialect,
    hasKey: isRealKey(readAiCredential(row.apiKey)),
  };
  const pick = <T>(next: T | undefined, cur: T): T => (next !== undefined ? next : cur);
  return [
    ...validateAuxEndpoint('embedding', {
      enabled: pick(patch.embeddingEnabled, row.embeddingEnabled),
      model: pick(patch.embeddingModel, row.embeddingModel),
      baseUrl: pick(patch.embeddingBaseUrl, row.embeddingBaseUrl),
      hasKey: patch.embeddingApiKey ? isRealKey(patch.embeddingApiKey) : isRealKey(readAiCredential(row.embeddingApiKey)),
    }, chat),
    ...validateAuxEndpoint('rerank', {
      enabled: pick(patch.rerankEnabled, row.rerankEnabled),
      model: pick(patch.rerankModel, row.rerankModel),
      baseUrl: pick(patch.rerankBaseUrl, row.rerankBaseUrl),
      hasKey: patch.rerankApiKey ? isRealKey(patch.rerankApiKey) : isRealKey(readAiCredential(row.rerankApiKey)),
    }, chat),
  ];
}
