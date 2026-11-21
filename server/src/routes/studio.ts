import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import type { StudioApproveRequest, StudioIntentRequest, StudioIntentResult, StudioOpenRequest, StudioOpenResult, StudioResumeDraftRequest, StudioResumeDraftResult, StudioVerifyPhoneRequest } from '../../../shared/contracts';
import { prisma } from '../db.js';
import { enqueueDurableGeneration } from '../services/generationRequest.js';
import { resolveEffectiveAgent } from '../services/agentVersions.js';
import { hasStudioDraftSkill, studioIntent } from '../services/studioIntent.js';
import { recallStudioIntent, studioPlanSchema } from '../services/studioAiRecall.js';
import { assertAgentAccess } from '../services/entitlements.js';
import { moderate } from '../services/moderation.js';
import { resolveUser } from '../services/context.js';
import { decryptSecret, encryptSecret, isEncrypted } from '../services/secretBox.js';
import {
  approveStudioOpen, assertPersonalStudioUser, assertStudioUser, cancelStudioOpen, registerStudioOpen, StudioBridgeError, StudioDraftCardSchema,
  studioBridgeReady, studioDelegation, studioId, studioPublicId, studioSubjectToken, verifyStudioPhone,
} from '../services/studioBridge.js';

const guard = { config: { rateLimit: { max: 15, timeWindow: '1 minute' } } };
const openSchema = z.object({ sessionId: studioId, messageId: studioId, studioLoginCode: z.string() });
const recoverySchema = openSchema.extend({ phoneCode: z.string().min(1) });
const recoveryReply = z.object({ text: z.string(), studioPhoneVerification: z.enum(['required', 'completed']) });
const sourceRefs = z.array(z.object({
  kind: z.enum(['project', 'report', 'knowledge', 'memory', 'image']), id: studioId, label: z.string(),
  versionId: z.string().optional(), version: z.number().optional(),
}));
const intentSchema = z.object({
  sessionId: studioId.optional(), agentKey: studioId.optional(),
  text: z.string().trim().min(1).max(24_000), clientRequestId: z.string().trim().min(1).max(256),
  refs: sourceRefs.max(25).optional(),
});
const approveSchema = z.object({ openId: studioPublicId, transactionId: studioPublicId });
const cancelSchema = z.object({ openId: studioPublicId });
const sessionDigest = (token: string | undefined) => createHash('sha256').update(token ?? '').digest('hex');

function expired() {
  return new StudioBridgeError('这次打开已失效，请回对话重新打开草稿', 404, 'STUDIO_OPEN_EXPIRED');
}

async function recoverableStudioSource(user: { id: string; tenantId: string }, sessionId: string, messageId: string) {
  const source = await prisma.generationJob.findFirst({
    where: { userId: user.id, tenantId: user.tenantId, sessionId, resultMessageId: messageId, status: 'completed' },
    select: { id: true, agentKey: true, requestJson: true, replyJson: true, userMessage: { select: { id: true, contentJson: true, refsJson: true } } },
  });
  const response = recoveryReply.safeParse(source?.replyJson);
  if (!source || !response.success) throw expired();
  return { source, response: response.data };
}

export async function studioRoutes(app: FastifyInstance) {
  app.post<{ Body: StudioIntentRequest }>('/studio/intent', { config: { rateLimit: { max: 40, timeWindow: '1 minute' } } }, async (req, reply): Promise<StudioIntentResult | void> => {
    if (!studioBridgeReady()) return { action: 'chat' };
    const token = req.headers.authorization ? undefined : req.headers['x-user-id'] as string | undefined;
    const user = await resolveUser(token);
    assertPersonalStudioUser(user, token);
    const parsed = intentSchema.safeParse(req.body);
    if (!parsed.success) return { action: 'chat' };
    const input = parsed.data;
    const session = input.sessionId ? await prisma.session.findFirst({
      where: { id: input.sessionId, userId: user.id, tenantId: user.tenantId }, select: { agentKey: true },
    }) : null;
    if (input.sessionId && !session) return reply.code(404).send({ code: 'SESSION_NOT_FOUND', error: '找不到这条对话。' });
    const agent = await resolveEffectiveAgent(session?.agentKey ?? input.agentKey ?? 'general');
    if (!agent || !hasStudioDraftSkill(agent.key, agent.skillsConfig)) return { action: 'chat' };
    await assertAgentAccess(user.id, { key: agent.key, billing: agent.billing });
    if (!await moderate('input', input.text, { userId: user.id, tenantId: user.tenantId, sessionId: input.sessionId, failClosed: true })) {
      return { action: 'chat' };
    }
    return recallStudioIntent(user, token!, input);
  });

  app.post<{ Body: StudioOpenRequest }>('/studio/open', guard, async (req, reply): Promise<StudioOpenResult> => {
    if (!studioBridgeReady()) throw new StudioBridgeError('声量AI草稿暂不可用');
    const token = req.headers.authorization ? undefined : req.headers['x-user-id'] as string | undefined;
    const user = await resolveUser(token);
    assertStudioUser(user, token);
    const parsed = openSchema.safeParse(req.body);
    if (!parsed.success) throw expired();
    const { sessionId, messageId, studioLoginCode } = parsed.data;
    const message = await prisma.message.findFirst({
      where: { id: messageId, sessionId, role: 'assistant', session: { userId: user.id, tenantId: user.tenantId } },
      select: { contentJson: true },
    });
    const card = StudioDraftCardSchema.safeParse((message?.contentJson as { studioDraft?: unknown } | undefined)?.studioDraft);
    if (!card.success) throw expired();
    const subject = (await studioSubjectToken(user, token, studioLoginCode)).token;
    const opened = await registerStudioOpen(subject, card.data.draftId);
    await prisma.studioOpenIntent.create({
      data: {
        id: opened.openId, userId: user.id, tenantId: user.tenantId, sessionId, messageId,
        identityUid: user.identityUid, identityTokenVersion: user.identityTokenVersion, sessionDigest: sessionDigest(token),
        expiresAt: opened.expiresAt, subjectToken: encryptSecret(subject),
      },
    });
    reply.header('cache-control', 'no-store');
    return { ...opened, expiresAt: opened.expiresAt.toISOString() };
  });

  app.post<{ Body: StudioApproveRequest }>('/studio/approve', guard, async (req, reply) => {
    if (!studioBridgeReady()) throw new StudioBridgeError('声量AI草稿暂不可用');
    const token = req.headers.authorization ? undefined : req.headers['x-user-id'] as string | undefined;
    const user = await resolveUser(token);
    assertStudioUser(user, token);
    const parsed = approveSchema.safeParse(req.body);
    if (!parsed.success) throw expired();
    const { openId, transactionId } = parsed.data;
    const where = { id: openId, userId: user.id, tenantId: user.tenantId,
      identityUid: user.identityUid, identityTokenVersion: user.identityTokenVersion, sessionDigest: sessionDigest(token), expiresAt: { gt: new Date() } };
    const intent = await prisma.studioOpenIntent.findFirst({ where });
    if (!intent || (intent.transactionId && intent.transactionId !== transactionId)) throw expired();
    if (intent.transactionId === transactionId) return reply.code(204).send();
    if (!intent.subjectToken || !isEncrypted(intent.subjectToken)) throw expired();
    const stillOwned = await prisma.message.findFirst({
      where: { id: intent.messageId, sessionId: intent.sessionId, role: 'assistant',
        session: { userId: user.id, tenantId: user.tenantId } },
      select: { id: true },
    });
    if (!stillOwned) throw expired();
    // 中心原子核验 openId 与 transactionId 的配对；错误事务无法占住军师本地记录。
    await approveStudioOpen(decryptSecret(intent.subjectToken), openId, transactionId);
    await prisma.studioOpenIntent.updateMany({
      where: { ...where, subjectToken: intent.subjectToken },
      data: { transactionId },
    });
    return reply.code(204).send();
  });

  app.post<{ Body: StudioVerifyPhoneRequest }>('/studio/verify-phone', guard, async (req, reply) => {
    if (!studioBridgeReady()) throw new StudioBridgeError('声量AI草稿暂不可用');
    const token = req.headers.authorization ? undefined : req.headers['x-user-id'] as string | undefined;
    const user = await resolveUser(token);
    assertPersonalStudioUser(user, token);
    const parsed = recoverySchema.safeParse(req.body);
    if (!parsed.success) throw expired();
    const { sessionId, messageId, studioLoginCode, phoneCode } = parsed.data;
    await recoverableStudioSource(user, sessionId, messageId);
    await verifyStudioPhone(user, token, studioLoginCode, phoneCode);
    return reply.code(204).send();
  });

  app.post<{ Body: StudioResumeDraftRequest }>('/studio/resume-draft', guard, async (req): Promise<StudioResumeDraftResult> => {
    if (!studioBridgeReady()) throw new StudioBridgeError('声量AI草稿暂不可用');
    const token = req.headers.authorization ? undefined : req.headers['x-user-id'] as string | undefined;
    const user = await resolveUser(token);
    assertPersonalStudioUser(user, token);
    const parsed = openSchema.safeParse(req.body);
    if (!parsed.success) throw expired();
    const { sessionId, messageId, studioLoginCode } = parsed.data;
    const { source, response } = await recoverableStudioSource(user, sessionId, messageId);
    const original = z.object({ text: z.string() }).safeParse(source.userMessage.contentJson);
    const refs = sourceRefs.safeParse(source.userMessage.refsJson ?? []);
    const rawPlan = (source.requestJson as { studioPlan?: unknown } | null)?.studioPlan;
    const plan = studioPlanSchema.safeParse(rawPlan);
    if (!original.success || !refs.success || (!plan.success && !studioIntent(original.data.text))) throw expired();
    const agent = await resolveEffectiveAgent(source.agentKey);
    if (!agent || !hasStudioDraftSkill(agent.key, agent.skillsConfig)) throw new StudioBridgeError('当前对话的草稿制作暂不可用');
    const clientRequestId = `studio-verify-${source.id}`;
    const existing = await prisma.generationJob.findUnique({
      where: { userId_clientRequestId: { userId: user.id, clientRequestId } }, select: { id: true },
    });
    let generationId = existing?.id;
    if (!generationId) {
      const delegation = await studioDelegation(user, token, studioLoginCode);
      const created = await enqueueDurableGeneration(user, {
        sessionId, text: original.data.text, refs: refs.data, studioLoginCode, clientRequestId,
      }, undefined, { user, personalToken: token, delegation, sourceMessageId: source.userMessage.id, plan: plan.data });
      generationId = created.job.id;
    }

    if (response.studioPhoneVerification === 'required') {
      const resumed = {
        ...response, text: '手机号已核验，已继续准备草稿。', studioPhoneVerification: 'completed',
      } satisfies Prisma.InputJsonValue;
      await prisma.$transaction([
        prisma.message.update({ where: { id: messageId }, data: { contentJson: resumed } }),
        prisma.generationJob.update({ where: { id: source.id }, data: { replyJson: resumed } }),
      ]);
    }
    return { generationId };
  });

  app.post('/studio/cancel', guard, async (req, reply) => {
    const token = req.headers.authorization ? undefined : req.headers['x-user-id'] as string | undefined;
    const user = await resolveUser(token);
    assertStudioUser(user, token);
    const parsed = cancelSchema.safeParse(req.body);
    if (!parsed.success) throw expired();
    const where = { id: parsed.data.openId, userId: user.id, tenantId: user.tenantId,
      identityUid: user.identityUid, identityTokenVersion: user.identityTokenVersion, sessionDigest: sessionDigest(token), expiresAt: { gt: new Date() } };
    const intent = await prisma.studioOpenIntent.findFirst({ where });
    const encrypted = intent?.subjectToken;
    if (encrypted && isEncrypted(encrypted)) {
      await cancelStudioOpen(decryptSecret(encrypted), parsed.data.openId);
      await prisma.studioOpenIntent.deleteMany({ where: { ...where, subjectToken: encrypted } });
    }
    return reply.code(204).send();
  });
}
