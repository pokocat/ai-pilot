// 声量AI 网页直连军师（2026-11-23）。只认账号中心 Bearer（aud 含 junshi-api），小程序的
// x-user-id 登录走原来的 /studio/*，两条路互不相干。
//
// · GET  /studio-web/status          我的军师状态（账号/档案/套餐/额度/今天能否免费诊断），顺带领取挂起的代售订单
// · POST /studio-web/intent          这一轮是不是要做内容；是就返回**明文**制作方案（网页自己去声量AI 建草稿）
// · GET  /studio-web/references/:id  取制作方案里参考图的原图（JPG/PNG），网页拿去传给声量AI
//
// 契约见 docs/STUDIO_WEB_API.md。
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { StudioIntentRequest, StudioWebIntentResult, StudioWebMiniCode, StudioWebStatus } from '../../../shared/contracts';
import { prisma } from '../db.js';
import { resolveUser } from '../services/context.js';
import { identityEnabled, JUNSHI_AUDIENCE } from '../services/identity.js';
import { identifyRequest } from '../services/identityProvisioning.js';
import { resolveEffectiveAgent } from '../services/agentVersions.js';
import { hasStudioDraftSkill } from '../services/studioIntent.js';
import { decideStudioIntent } from '../services/studioAiRecall.js';
import { studioId } from '../services/studioBridge.js';
import { assertAgentAccess } from '../services/entitlements.js';
import { moderate } from '../services/moderation.js';
import { getStudioReferenceImage } from '../services/chatImage.js';
import { hasCompletedOnboarding } from '../services/onboarding.js';
import { getPlanStatus, getQuotaState, graceRemainingToday } from '../services/tokenQuota.js';
import { planGateState } from '../services/planGate.js';
import { claimPendingPlanGrants } from '../services/externalPlanGrant.js';
import { isFeatureEnabled } from '../services/featureFlag.js';
import { QUICKSCAN_DAILY_LIMIT, quickscanUsedToday } from './quickscan.js';
import { WEB_CHAT_PAGE, webChatMiniCode } from '../services/webMiniCode.js';

/** 网页入口开关：与小程序草稿开关（JUNSHI_STUDIO_ENABLED）分开，网页不需要 junshi-s2s 密钥与票据加密。 */
export function studioWebEnabled(): boolean {
  return process.env.JUNSHI_STUDIO_WEB_ENABLED === 'true' && identityEnabled();
}

type Classifier = NonNullable<Parameters<typeof decideStudioIntent>[2]>;
let testClassifier: Classifier | undefined;
/** 仅测试：替换制作意图分类模型（mock provider 不产出结构化决策）。生产环境调用无效。 */
export function __setStudioWebClassifierForTest(fn: Classifier | undefined): void {
  if (process.env.NODE_ENV === 'test') testClassifier = fn;
}

class StudioWebError extends Error {
  constructor(message: string, readonly statusCode: number, readonly code: string) { super(message); }
}

/** 只放行「本请求由账号中心 junshi-api 令牌解析出来」的用户；x-user-id 老登录一律 403。 */
async function webUser(req: FastifyRequest) {
  const identity = identifyRequest(req);
  if (!identity?.sub || !identity.userId) {
    // 没带令牌 / 令牌无效：attachIdentityUser 不会设上下文，按全站口径 401。
    if (!req.headers.authorization) throw new StudioWebError('请先登录', 401, 'UNAUTHORIZED');
    throw new StudioWebError('登录已失效，请重新登录', 401, 'UNAUTHORIZED');
  }
  if (!identity.aud.includes(JUNSHI_AUDIENCE)) throw new StudioWebError('该登录不能访问军师', 403, 'STUDIO_WEB_AUDIENCE_REQUIRED');
  const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
  return { user, uid: identity.sub };
}

function send(reply: FastifyReply, error: unknown) {
  if (error instanceof StudioWebError) return reply.code(error.statusCode).send({ error: error.message, code: error.code });
  throw error;
}

const sourceRefs = z.array(z.object({
  kind: z.enum(['project', 'report', 'knowledge', 'memory', 'image']), id: studioId, label: z.string(),
  versionId: z.string().optional(), version: z.number().optional(),
}));
const intentSchema = z.object({
  sessionId: studioId.optional(), agentKey: studioId.optional(),
  text: z.string().trim().min(1).max(24_000), clientRequestId: z.string().trim().min(1).max(256),
  refs: sourceRefs.max(25).optional(),
});

export async function studioWebRoutes(app: FastifyInstance) {
  // 扫码回手机小程序接着聊：全站同一张码（scene=web=chat，与用户无关、不带邀请码）。
  // 鉴权与开关同 /studio-web/status；生成失败回 dataUri:null，不回 5xx（口径同 /invite/qrcode）。
  app.get('/studio-web/mini-code', async (req, reply): Promise<StudioWebMiniCode | void> => {
    try {
      if (!identityEnabled()) throw new StudioWebError('账号服务尚未配置', 503, 'IDENTITY_NOT_CONFIGURED');
      await webUser(req);
      return { dataUri: await webChatMiniCode(), page: WEB_CHAT_PAGE };
    } catch (error) { return send(reply, error); }
  });

  app.get('/studio-web/status', async (req, reply): Promise<StudioWebStatus | void> => {
    try {
      if (!identityEnabled()) throw new StudioWebError('账号服务尚未配置', 503, 'IDENTITY_NOT_CONFIGURED');
      const { user, uid } = await webUser(req);
      // 先领挂起的代售订单，再读套餐：付完款第一次打开就能看到已开通。
      const claimed = await claimPendingPlanGrants(uid).catch((error) => {
        req.log?.warn?.(`[plan-grant] 状态页领取失败 uid=${uid}：${(error as Error).message}`);
        return 0;
      });
      const [plan, planStatus, gate, quota, credit, profile, onboarded, scanned, graceLeft, pending, fortune] = await Promise.all([
        user.planId ? prisma.plan.findUnique({ where: { id: user.planId }, select: { id: true, name: true, period: true, tokenQuotaPerMonth: true, creditsPerMonth: true } }) : null,
        getPlanStatus(user.id),
        planGateState(user.id),
        getQuotaState(user.id),
        prisma.creditLedger.findFirst({ where: { userId: user.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { balance: true } }),
        prisma.profile.findFirst({ where: { tenantId: user.tenantId }, select: { id: true } }),
        hasCompletedOnboarding(user),
        quickscanUsedToday(user.id),
        graceRemainingToday(user.id, 'quickscan'),
        prisma.externalPlanGrant.count({ where: { identityUid: uid, status: { in: ['pending', 'blocked'] } } }),
        isFeatureEnabled('fortune'),
      ]);
      // 速诊（初诊卡）：过期用户被 assertPlanActive 拦；无套餐用户靠每日 1 次保底；有效套餐走额度（额度用完也有保底）。
      const underDailyLimit = scanned < QUICKSCAN_DAILY_LIMIT;
      const quickscanAvailable = gate !== 'expired' && underDailyLimit
        && (graceLeft > 0 || (gate === 'active' && (quota.unlimited || quota.balance > 0)));
      return {
        account: { userId: user.id, identityUid: uid, onboarded, hasProfile: !!profile },
        plan: plan ? { id: plan.id, name: plan.name, period: plan.period } : null,
        planStatus: { state: gate, expiresAt: planStatus.expiresAt, daysRemaining: planStatus.daysRemaining, nextResetAt: planStatus.nextResetAt },
        tokenQuota: { limit: quota.quota, used: quota.used, remaining: quota.balance, unlimited: quota.unlimited, packRemaining: quota.packBalance },
        creditBalance: credit?.balance ?? 0,
        quickscan: {
          availableToday: quickscanAvailable,
          // 「免费」= 不占套餐额度的每日保底那一次还在（无套餐用户只有这一次）。
          freeAvailableToday: gate !== 'expired' && underDailyLimit && graceLeft > 0,
          usedToday: scanned, dailyLimit: QUICKSCAN_DAILY_LIMIT,
        },
        externalGrants: { claimedNow: claimed, unresolved: pending },
        features: { fortune },
      };
    } catch (error) { return send(reply, error); }
  });

  app.post<{ Body: StudioIntentRequest }>('/studio-web/intent', { config: { rateLimit: { max: 40, timeWindow: '1 minute' } } }, async (req, reply): Promise<StudioWebIntentResult | void> => {
    try {
      if (!studioWebEnabled()) return { action: 'chat' as const };
      const { user } = await webUser(req);
      const parsed = intentSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: '参数不合法', code: 'BAD_REQUEST' });
      const input = parsed.data;
      const session = input.sessionId ? await prisma.session.findFirst({
        where: { id: input.sessionId, userId: user.id, tenantId: user.tenantId }, select: { agentKey: true },
      }) : null;
      if (input.sessionId && !session) return reply.code(404).send({ code: 'SESSION_NOT_FOUND', error: '找不到这条对话。' });
      const agent = await resolveEffectiveAgent(session?.agentKey ?? input.agentKey ?? 'general');
      if (!agent || !hasStudioDraftSkill(agent.key, agent.skillsConfig)) return { action: 'chat' as const };
      await assertAgentAccess(user.id, { key: agent.key, billing: agent.billing });
      if (!await moderate('input', input.text, { userId: user.id, tenantId: user.tenantId, sessionId: input.sessionId, failClosed: true })) {
        return { action: 'chat' as const };
      }
      const intent = await decideStudioIntent(user, input, testClassifier);
      if (intent.action !== 'draft') return intent;
      const refs = intent.plan.referenceIds.length ? await prisma.knowledgeItem.findMany({
        where: { id: { in: intent.plan.referenceIds }, userId: user.id, tenantId: user.tenantId },
        select: { id: true, fileName: true, fileType: true },
      }) : [];
      return {
        action: 'draft' as const,
        plan: intent.plan,
        references: intent.plan.referenceIds.map((id) => {
          const item = refs.find((ref) => ref.id === id);
          return { id, fileName: item?.fileName ?? null, fileType: item?.fileType ?? null, url: `/api/studio-web/references/${id}` };
        }),
        source: { sessionId: input.sessionId ?? null, scriptMessageId: intent.plan.sourceScriptMessageId, clientRequestId: input.clientRequestId },
      };
    } catch (error) { return send(reply, error); }
  });

  app.get<{ Params: { id: string } }>('/studio-web/references/:id', async (req, reply) => {
    try {
      if (!studioWebEnabled()) return reply.code(404).send({ error: '暂不可用', code: 'STUDIO_WEB_DISABLED' });
      const { user } = await webUser(req);
      if (!studioId.safeParse(req.params.id).success) return reply.code(404).send({ error: '找不到这张图', code: 'REFERENCE_NOT_FOUND' });
      const image = await getStudioReferenceImage(user.id, user.tenantId, req.params.id);
      if (!image) return reply.code(404).send({ error: '找不到这张图，或它不是 JPG/PNG 原图', code: 'REFERENCE_NOT_FOUND' });
      return reply
        .header('content-type', image.contentType)
        .header('cache-control', 'private, no-store')
        .header('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(image.fileName)}`)
        .send(image.bytes);
    } catch (error) { return send(reply, error); }
  });
}
