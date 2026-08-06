import type { User } from '@prisma/client';
import type { MessageRef } from '../llm/schema.js';
import { KEY2AGENT } from '../data/agents.js';
import { prisma } from '../db.js';
import { resolveEffectiveAgent } from './agentVersions.js';
import { assertAgentAccess } from './entitlements.js';
import {
  assertPlanActive,
  generationQuotaReserveTokens,
  type GraceKind,
} from './tokenQuota.js';
import { createGenerationJob, type CreatedGenerationJob } from './generationJobs.js';

export interface DurableGenerationBody {
  agentKey?: string;
  sessionId?: string;
  text: string;
  projectId?: string;
  refs?: MessageRef[];
  clientRequestId: string;
  parentGenerationId?: string;
}

export interface DurableGenerationCreated extends CreatedGenerationJob {
  agentKey: string;
  kind: 'chat' | 'report';
  refNotices: string[];
}

function wantsDeliverable(text: string): boolean {
  return /(生成|输出|整理|做一份|出一份|给我一份|形成).{0,8}(方案|报告|成果|卡片|纪要|计划|军令|文案|脚本|海报)|(?:重新)?出.{0,4}(方案|报告|成果|卡片|纪要|计划|军令|文案|脚本|海报)|战略体检|转成军令|生成纪要/.test(text);
}

async function resolveProjectId(tenantId: string, bodyProjectId?: string, sessionProjectId?: string | null): Promise<string | null> {
  if (sessionProjectId) return sessionProjectId;
  if (!bodyProjectId) return null;
  const project = await prisma.project.findFirst({ where: { id: bodyProjectId, tenantId }, select: { id: true } });
  return project?.id ?? null;
}

/**
 * 新生成链路的唯一建单入口：所有业务校验发生在 provider 外呼前，随后由一个数据库事务
 * 原子落 user message、GenerationJob、会话占位以及 Token/钻石预留。
 */
export async function enqueueDurableGeneration(
  user: Pick<User, 'id' | 'tenantId'>,
  body: DurableGenerationBody,
): Promise<DurableGenerationCreated> {
  const text = (body.text || '').trim();
  if (!text) throw Object.assign(new Error('empty text'), { statusCode: 400, code: 'EMPTY_TEXT' });
  if (!body.clientRequestId?.trim()) {
    throw Object.assign(new Error('clientRequestId required'), { statusCode: 400, code: 'CLIENT_REQUEST_ID_REQUIRED' });
  }
  const session = body.sessionId
    ? await prisma.session.findFirst({ where: { id: body.sessionId, userId: user.id } })
    : null;
  if (body.sessionId && !session) throw Object.assign(new Error('session not found'), { statusCode: 404, code: 'SESSION_NOT_FOUND' });
  const agentKey = session?.agentKey ?? body.agentKey ?? KEY2AGENT[text] ?? 'general';
  const projectId = await resolveProjectId(user.tenantId, body.projectId, session?.projectId);
  const effective = await resolveEffectiveAgent(agentKey);
  if (!effective) throw Object.assign(new Error('agent not found'), { statusCode: 404, code: 'AGENT_NOT_FOUND' });

  await assertPlanActive(user.id);
  await assertAgentAccess(user.id, { key: effective.key, billing: effective.billing });
  const isImage = effective.meterUnit === 'image';
  const ratio = effective.billingRatio || 1;
  const creditCost = isImage ? effective.price : 0;
  const reviewIntent = /^帮我做 \d{4}-\d{2}-\d{2} 的执行复盘/.test(text);
  const grace: GraceKind | undefined = reviewIntent ? 'review' : undefined;
  const reserveTokens = !isImage
    ? await generationQuotaReserveTokens({
      forceLive: effective.providerMode === 'openai',
      model: effective.providerMode === 'openai' ? effective.apiModel : null,
    })
    : undefined;
  const isDeliverable = !!effective.deliverableKey;
  const onDemand = isDeliverable
    && (effective.skillsConfig as { deliverableMode?: string } | null)?.deliverableMode === 'on-demand';
  const kind: 'chat' | 'report' = isDeliverable && (!onDemand || wantsDeliverable(text)) ? 'report' : 'chat';

  const created = await createGenerationJob({
    tenantId: user.tenantId,
    userId: user.id,
    agentKey,
    text,
    clientRequestId: body.clientRequestId.trim(),
    sessionId: session?.id ?? null,
    parentGenerationId: body.parentGenerationId ?? null,
    projectId,
    refs: body.refs,
    kind,
    billingRatio: ratio,
    quotaReserveTokens: reserveTokens,
    grace,
    creditCost,
    requestMeta: {
      effectiveVersionId: effective.versionId,
      effectiveVersionNumber: effective.versionNumber,
    },
  });
  return { ...created, agentKey, kind, refNotices: [] };
}
