import { createHash } from 'node:crypto';
import type { GenerationJob } from '@prisma/client';
import { z } from 'zod';
import type { ChatAsk, ChatReply, MessageRef, StudioDraftCard } from '../../../shared/contracts';
import { prisma } from '../db.js';
import { getStudioReferenceImage } from './chatImage.js';
import { StudioBridgeError, StudioMcp, studioDraftUrl, studioId, type StudioDelegation } from './studioBridge.js';
import { STUDIO_SCRIPT_VERSION_HEADING, studioIntent, studioReferenceSelection, studioScriptSelection, studioScriptVersion, studioSpecifications } from './studioIntent.js';
import { moderate } from './moderation.js';
import { requireLocalIdentityActive } from './identityState.js';
import type { StudioDraftPlan } from './studioAiRecall.js';

export type StudioGeneration = { delegation: StudioDelegation; sourceMessageId?: string }
  | { error: string; code: string } | { clarification: string; ask?: ChatAsk };
const scriptRequest = /(?:写|稿|脚本|改|剧本|分镜|文案|提示词)/;
const videoWords = /视频|分镜|短片|口播/;
const imageWords = /图片|图像|海报|主视觉|商品图/;
const attachmentList = z.array(z.object({ id: studioId, kind: z.literal('image') }));
const slot = z.object({ label: z.string(), required: z.boolean(), maxImages: z.number().int().nonnegative() });
const scenes = z.array(z.object({ sceneId: studioId, referenceSlots: z.array(slot), oneOfSlotsRequired: z.array(z.number().int()) }));
const draftSchema = z.object({
  draftId: studioId, sceneId: studioId, kind: z.enum(['video', 'image']), docVersion: z.string().min(1),
  url: z.string(), chargedCredits: z.literal(0), prompt: z.string(), initialDocVersion: z.string().optional(), canInitialize: z.boolean().optional(),
  ratio: z.string().optional(), duration: z.number().optional(),
  missingRequired: z.array(z.string()),
  referenceSlots: z.array(slot.extend({ slot: z.number().int(), operationIds: z.array(z.string()).optional() })),
}).refine((draft) => studioDraftUrl(draft.url, draft));
const uploadReceipt = z.object({ draftId: studioId, docVersion: z.string().min(1), chargedCredits: z.literal(0) });
const textMessage = z.object({ text: z.string() });
const StudioMessageCard = z.union([
  z.object({ studioDraft: z.object({ draftId: studioId }) }),
  z.object({ studioPhoneVerification: z.enum(['required', 'completed']) }),
]);
const unavailableScript = /^(?:暂时无法|暂不能|请先在|没找到你选的脚本|这份内容暂无法)/;
const bodyOf = (value: unknown) => textMessage.safeParse(value).data?.text.trim() ?? '';
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function imagesOf(raw: unknown) {
  if (!Array.isArray(raw)) return [];
  return attachmentList.safeParse(raw.filter((part: MessageRef) => part?.kind === 'image')).data ?? [];
}

interface ScriptCandidate { messageId: string; text: string; request: string; refs: unknown; }
function selectedScript(candidates: ScriptCandidate[], selection: number | 'latest' | null): ScriptCandidate | undefined {
  if (typeof selection !== 'number') {
    const recent = candidates.at(-1);
    if (!recent) return undefined;
    const headings = [...recent.text.matchAll(STUDIO_SCRIPT_VERSION_HEADING)];
    return headings.length > 1 ? { ...recent, text: recent.text.slice(headings.at(-1)!.index) } : recent;
  }
  for (const candidate of [...candidates].reverse()) {
    const section = studioScriptVersion(candidate.text, selection);
    if (section) return { ...candidate, text: section };
  }
  return candidates.some((candidate) => candidate.text.search(STUDIO_SCRIPT_VERSION_HEADING) >= 0)
    ? undefined : candidates[selection - 1];
}

async function scopedInputs(job: GenerationJob, sourceMessageId: string, text: string, refs: unknown) {
  const intent = studioIntent(text);
  if (!intent) return null;
  const source = await prisma.message.findFirstOrThrow({ where: { id: sourceMessageId, sessionId: job.sessionId, role: 'user' } });
  const previous = await prisma.message.findMany({
    where: {
      sessionId: job.sessionId,
      session: { userId: job.userId, tenantId: job.tenantId },
      OR: [{ createdAt: { lt: source.createdAt } }, { createdAt: source.createdAt, id: { lt: source.id } }],
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 32,
    select: { id: true, role: true, contentJson: true, refsJson: true },
  });
  const turns = previous.reverse();
  // 明确选版时只从该会话中的用户写稿要求和对应助手正文取原稿。
  const candidates: ScriptCandidate[] = [];
  let userText = '';
  let currentRefs: unknown;
  let inDraftTopic = false;
  for (const turn of turns) {
    const spoken = bodyOf(turn.contentJson);
    if (turn.role === 'user') {
      userText = spoken;
      currentRefs = turn.refsJson;
      inDraftTopic = scriptRequest.test(spoken) || (inDraftTopic && /再改|换个|再来|重写|开头|结尾|一版|第二版/.test(spoken));
    } else if (turn.role === 'assistant' && inDraftTopic && spoken && !unavailableScript.test(spoken) && !StudioMessageCard.safeParse(turn.contentJson).success) {
      candidates.push({ messageId: turn.id, text: spoken, request: userText, refs: currentRefs });
    }
  }

  const selection = studioScriptSelection(text);
  const chosen = selectedScript(candidates, selection);
  if (selection && !chosen) throw new StudioBridgeError('没找到你选的脚本版本。请粘贴要制作的原稿，或先在当前对话写好后再选。', 400);
  let kind = intent.kind;
  if (kind === 'previous') {
    const last = chosen?.request ?? '';
    if (videoWords.test(last)) kind = 'video';
    else if (imageWords.test(last)) kind = 'image';
    else throw new StudioBridgeError('请注明要把这版做成视频还是图片。', 400);
  }

  const suppliedPrompt = text.split(/[:：](?!\d)/).slice(1).join('：').trim();
  const needsSubject = /^(?:请|帮我|给我|直接|现在|就|再)*\s*(?:生成|制作|创建|建|做|做成|出片|出图|生图)\s*(?:(?:一条|一个|一张|一段|一份|竖屏|横屏|\d+秒)\s*)*(?:视频|短片|短剧|成片|图片|图像|海报|商品图)?(?:草稿)?[。！!]*$/.test(text.trim());
  const usePrior = !!chosen && (needsSubject || selection !== null || /脚本|剧本|这[一]?稿|这[一]?版|上面/.test(text));
  if (needsSubject && !usePrior) throw new StudioBridgeError('请补充要制作的画面内容，或先写好脚本后再选用。', 400);
  const prompt = (usePrior ? chosen!.text : suppliedPrompt || text).trim();
  if (!prompt || prompt.length > 12_000) {
    throw new StudioBridgeError('请明确要保存的内容，草稿正文最多 12000 字。', 400);
  }

  let available = imagesOf(refs);
  if (!available.length && usePrior) available = imagesOf(chosen?.refs);
  if (!available.length) {
    const previousBatches = turns.filter((row) => row.role === 'user' && imagesOf(row.refsJson).length);
    if (previousBatches.length === 1) available = imagesOf(previousBatches[0].refsJson);
  }
  const selected = studioReferenceSelection(text, available.length);
  if (selected === 'clarify' || selected.some((number) => !available[number - 1])) {
    throw new StudioBridgeError('请用「第 1 张作为参考图」的方式指定要送到声量AI的图片。', 400);
  }
  const referenceIds = [...new Set(selected.map((number) => available[number - 1].id))];
  const priorSpecs = usePrior ? studioSpecifications(chosen!.request, kind) : null;
  const specs = { ...Object.fromEntries(Object.entries(priorSpecs ?? {}).filter(([, value]) => value !== undefined)),
    ...Object.fromEntries(Object.entries(studioSpecifications(text, kind)).filter(([, value]) => value !== undefined)) };
  return { kind, prompt, referenceIds, specs, sourceScriptMessageId: usePrior ? chosen!.messageId : null };
}

function chooseScene(rows: z.infer<typeof scenes>, kind: 'video' | 'image', referenceCount: number) {
  const fits = rows.filter((scene) => scene.referenceSlots.length <= 1
    && (!referenceCount || (scene.referenceSlots[0]?.maxImages ?? 0) >= referenceCount)
    && (referenceCount || (!scene.oneOfSlotsRequired.length && !scene.referenceSlots.some((ref) => ref.required))));
  const preferred = kind === 'video' ? 'brand-story' : 'free';
  return fits.find((item) => item.sceneId === preferred) ?? fits[0];
}

export async function prepareStudioDraft(job: GenerationJob, request: {
  text: string; refs?: unknown[]; studio: StudioGeneration; studioPlan?: StudioDraftPlan;
}, signal: AbortSignal): Promise<ChatReply> {
  try {
    if ('clarification' in request.studio) return {
      text: request.studio.clarification,
      studioSkillStage: 'clarify',
      ...(request.studio.ask ? { asks: [request.studio.ask] } : {}),
    };
    if ('error' in request.studio) return {
      text: request.studio.error,
      ...(request.studio.code === 'STUDIO_PHONE_PROOF_REQUIRED' ? { studioPhoneVerification: 'required' as const } : {}),
    };
    const { delegation } = request.studio;
    const user = await prisma.user.findFirst({
      where: { id: job.userId, tenantId: job.tenantId, identityUid: delegation.identityUid,
        identityTokenVersion: delegation.version, deletedAt: null },
      select: { identityUid: true },
    });
    if (!user) return { text: '本次账号授权已失效，请重新登录军师后发起制作。' };
    await requireLocalIdentityActive(user.identityUid);
    const sourceMessageId = request.studio.sourceMessageId ?? job.userMessageId;
    // 模型方案已验证并冻结。只有仍使用旧协议的任务才解析原始制作指令。
    const plan = request.studioPlan ?? await scopedInputs(job, sourceMessageId, request.text, request.refs);
    if (!plan) return { text: '请明确要制作的视频或图片，以及需要随稿保存的图片。' };
    const allowed = await moderate('input', `${request.text}\n${plan.prompt}`, {
      tenantId: job.tenantId, userId: job.userId, sessionId: job.sessionId, failClosed: true,
    });
    if (!allowed) return { text: '这份内容暂无法提交制作，请调整后重试。' };

    const client = new StudioMcp(delegation, signal);
    const operationId = digest({
      userId: job.userId, sessionId: job.sessionId, ...plan,
      copy: /另(?:存|建|做)|新副本|另开/.test(request.text) ? job.userMessageId : null,
    });
    const catalog = scenes.parse(await client.call('list_media_scenes', { kind: plan.kind }));
    const scene = chooseScene(catalog, plan.kind, plan.referenceIds.length);
    if (!scene) return { text: '这些参考图无法放入同一个草稿。请减少图片，或在声量AI里逐个选择素材位置。' };
    const open = { kind: plan.kind, sceneId: scene.sceneId, operationId };
    let current = draftSchema.parse(await client.call('open_media_draft', open));
    if (current.kind !== plan.kind || current.sceneId !== scene.sceneId) throw new StudioBridgeError('声量AI草稿信息有变，请重试');
    if (!current.prompt && current.canInitialize === undefined) {
      throw new StudioBridgeError('暂时无法核对草稿版本，请稍后重试');
    }
    const editedInStudio = current.prompt ? current.prompt !== plan.prompt : current.canInitialize === false;
    if (!editedInStudio && !current.prompt) {
      current = draftSchema.parse(await client.call('fill_media_draft', {
        kind: plan.kind, draftId: current.draftId, docVersion: current.docVersion, prompt: plan.prompt, ...plan.specs,
      }));
    }
    const draftId = current.draftId;
    const missing: string[] = [];
    const attached: string[] = [];
    for (const [index, refId] of plan.referenceIds.entries()) {
      const referenceOperationId = digest({ operationId, refId });
      if (current.referenceSlots[0]?.operationIds?.includes(referenceOperationId)) {
        attached.push(refId);
        continue;
      }
      if (editedInStudio) continue;
      try {
        const image = await getStudioReferenceImage(job.userId, job.tenantId, refId);
        if (!image) {
          missing.push(`参考图 ${index + 1}（原图取不到）`);
          continue;
        }
        const permit = await client.call('prepare_reference_upload', {
          kind: plan.kind, draftId, docVersion: current.docVersion, slot: 1, operationId: referenceOperationId,
          fileName: image.fileName, bytes: image.bytes.length,
          sha256: createHash('sha256').update(image.bytes).digest('hex'),
        });
        const receipt = uploadReceipt.parse(await client.upload(permit, image.bytes, image.contentType));
        if (receipt.draftId !== draftId) throw new StudioBridgeError('参考图回执所属草稿不一致');
        current = { ...current, docVersion: receipt.docVersion };
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        console.info('[studio] 参考图待核对', job.id, index + 1, (error as Error).name);
        current = draftSchema.parse(await client.call('open_media_draft', { kind: plan.kind, draftId }));
      }
    }
    current = draftSchema.parse(await client.call('open_media_draft', { kind: plan.kind, draftId }));
    if (current.draftId !== draftId || current.kind !== plan.kind || current.sceneId !== scene.sceneId || (!editedInStudio && !current.prompt)) {
      throw new StudioBridgeError('暂时无法确认草稿已保存，请重试');
    }
    for (const [index, refId] of plan.referenceIds.entries()) {
      const refOp = digest({ operationId, refId });
      if (current.referenceSlots[0]?.operationIds?.includes(refOp)) {
        if (!attached.includes(refId)) attached.push(refId);
      } else if (!missing.some((item) => item.startsWith(`参考图 ${index + 1}（`))) {
        missing.push(`参考图 ${index + 1}（待补）`);
      }
    }
    const studioDraft: StudioDraftCard = {
      kind: current.kind, draftId, sceneId: current.sceneId, docVersion: current.docVersion,
      url: current.url, sourceMessageId, sourceScriptMessageId: plan.sourceScriptMessageId,
      sourceScriptSha256: createHash('sha256').update(plan.prompt).digest('hex'),
      referenceIds: attached, referenceCount: attached.length, missing: [...new Set([...current.missingRequired, ...missing])],
      ratio: current.ratio, duration: current.duration,
    };
    return {
      text: editedInStudio
        ? '这份草稿已在声量AI里编辑过。打开草稿可查看最新内容。'
        : '已保存到你的声量AI草稿。打开后可以检查内容和费用，再决定是否生成。',
      studioDraft,
    };
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    console.warn('[studio] 草稿准备未完成', job.id, (error as Error).name);
    return { text: error instanceof StudioBridgeError ? error.message : '暂时无法核对声量AI草稿，请重新发起制作。' };
  }
}
