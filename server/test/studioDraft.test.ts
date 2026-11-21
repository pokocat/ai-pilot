import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import sharp from 'sharp';
import { api, cleanBusiness, closeApp, getApp, login, seedBaseline, uniquePhone } from './helpers.js';
import { prisma } from '../src/db.js';
import { enqueueDurableGeneration } from '../src/services/generationRequest.js';
import { tickGenerationWorker } from '../src/services/generationWorker.js';
import { ingestChatImage } from '../src/services/chatImage.js';
import { hasStudioDraftSkill, studioIntent, studioReferenceSelection, studioSpecifications } from '../src/services/studioIntent.js';
import { STUDIO_ORIGIN, studioDraftUrl, studioSubjectToken } from '../src/services/studioBridge.js';
import { resetIdentityJwksCache } from '../src/services/identity.js';
import { signUserToken } from '../src/services/userToken.js';
import { openStudioIntentTicket, recallStudioIntent } from '../src/services/studioAiRecall.js';

const ISSUER = 'https://identity.studio.test';
const DRAFT_ID = 'draft-junshi-studio-test';
const KIND = 'video';
const SCENE = 'brand-story';
const TARGET = `${STUDIO_ORIGIN}/${KIND}?scene=${SCENE}&draft=${DRAFT_ID}`;

test('制作意图只授权现在要做的图片或视频', () => {
  for (const text of [
    '按这两张图写一条 15 秒新品视频脚本', '请先帮我读图，再写一个视频脚本', '帮我生成短视频脚本',
    '我想做视频，有什么建议？', '如何制作图片', '暂不出图', '做图之前先写文案',
    '不要生成视频', '给快出片生成一条视频', '用爱速拍做一条视频',
  ]) assert.equal(studioIntent(text), null, text);
  for (const [text, kind] of [
    ['用第二版做视频，第一张作商品参考，第二张不要进视频', 'video'],
    ['用第二版，第一张作商品参考，竖屏', 'previous'],
    ['帮我画一张山水', 'image'], ['来一张秋季宣传海报', 'image'],
    ['帮我做一条 15 秒的产品视频：突出防水涂层', 'video'],
  ]) assert.equal(studioIntent(text)?.kind, kind, text);
  assert.deepEqual(studioSpecifications('做视频，16:9，15 秒：这里再写一个 60 秒版本', 'video'), { ratio: '16:9', duration: 15 });
  assert.deepEqual(studioReferenceSelection('用第二版做视频，第一张作商品参考，第二张不要进视频', 2), [1]);
  assert.deepEqual(studioReferenceSelection('做视频，用第一张作为参考图，第二张只参考风格', 2), [1]);
  assert.deepEqual(studioReferenceSelection('用这两张图片做视频', 2), [1, 2]);
  assert.deepEqual(studioReferenceSelection('做视频，第 1 张和第 2 张作参考，但第 2 张不上传', 2), [1]);
  assert.deepEqual(studioReferenceSelection('做视频，所有图片都作为参考，但是第二张不上传', 2), [1]);
  assert.deepEqual(studioReferenceSelection('以附件中的风格写脚本', 2), []);
  assert.equal(studioReferenceSelection('附件图作为参考', 2), 'clarify');
  for (const [text, available, selected] of [
    ['把这张图做成视频', 1, [1]],
    ['把这张图做成视频', 2, 'clarify'],
    ['把这张图做成视频，图片只参考风格', 1, []],
    ['把第一张图做成视频，第二张仅作为风格参考', 2, [1]],
    ['将这张照片转成视频', 1, [1]],
    ['把第一张图做成视频', 2, [1]],
    ['用这两张图片生成视频', 2, [1, 2]],
    ['图生视频', 1, [1]],
    ['图生视频', 0, 'clarify'],
    ['图生视频', 2, 'clarify'],
    ['图生视频，用第二张', 2, [2]],
    ['生成一段新品宣传视频', 2, []],
  ] as const) {
    assert.equal(studioIntent(text)?.kind, 'video', text);
    assert.deepEqual(studioReferenceSelection(text, available), selected, text);
  }
  assert.equal(studioIntent('先看图，再写一条图生视频的脚本'), null);
  assert.equal(hasStudioDraftSkill('general', null), true);
  assert.equal(hasStudioDraftSkill('general', { tools: [] }), false);
  assert.equal(hasStudioDraftSkill('poster', {}), false);
  assert.equal(hasStudioDraftSkill('shortvideo', { tools: ['studio_media_draft'] }), true);
});

test('草稿链接严格绑定主站、草稿 ID、场景与类型', () => {
  const draft = { kind: KIND, draftId: DRAFT_ID, sceneId: SCENE } as const;
  assert.equal(studioDraftUrl(TARGET, draft), true);
  assert.equal(studioDraftUrl(TARGET.replace('aiavatar.aibuzz.cn', 'aistar.aibuzz.cn'), draft), false);
  assert.equal(studioDraftUrl(TARGET + '&next=video', draft), false);
  assert.equal(studioDraftUrl(TARGET + '#page', draft), false);
  assert.equal(studioDraftUrl(TARGET.replace('https://', 'https://user@'), draft), false);
});

const envNames = ['JUNSHI_STUDIO_ENABLED', 'JUNSHI_STUDIO_CLIENT_SECRET', 'ID_ISSUER', 'APP_JWT_SECRET', 'APP_ENCRYPTION_KEY'] as const;
const envBefore = new Map(envNames.map((name) => [name, process.env[name]]));

before(async () => {
  process.env.JUNSHI_STUDIO_ENABLED = 'true';
  process.env.JUNSHI_STUDIO_CLIENT_SECRET = 'test-machine-client-secret';
  process.env.ID_ISSUER = ISSUER;
  process.env.APP_JWT_SECRET = 'test-junshi-studio-local-jwt-signing-key';
  process.env.APP_ENCRYPTION_KEY = 'test-junshi-studio-encryption-key';
  await cleanBusiness();
  await seedBaseline();
});

after(async () => {
  for (const [name, value] of envBefore) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  resetIdentityJwksCache();
  await closeApp();
});

test('AI 召回凭证绑定发送内容和本人会话，可交接短确认，澄清不需要微信凭证', async () => {
  const phone = uniquePhone();
  const token = await login(phone);
  const user = await prisma.user.findUniqueOrThrow({ where: { phone } });
  const turn = { clientRequestId: 'studio-ai-turn', agentKey: 'general', text: '是的', refs: [] };
  const intent = await recallStudioIntent(user, token, turn, async (input) => {
    assert.equal(JSON.parse(input).latest.text, '是的');
    return { action: 'draft', kind: 'image', specs: { ratio: '3:4' }, prompt: '藏青色的品牌海报，右下角放标志。', images: [] };
  });
  assert.equal(intent.action, 'draft');
  assert.ok('studioIntentTicket' in intent);
  const frozen = openStudioIntentTicket(intent.studioIntentTicket, user.id, token, turn);
  assert.equal(frozen.action, 'draft');
  if (frozen.action === 'draft') assert.match(frozen.plan.prompt, /藏青/);
  assert.throws(() => openStudioIntentTicket(intent.studioIntentTicket, user.id, token, { ...turn, text: '取消制作' }));
  assert.throws(() => openStudioIntentTicket(intent.studioIntentTicket, user.id, 'other-session', turn));
  const ambiguous = { ...turn, text: '做个AI图', clientRequestId: 'studio-ai-question' };
  const clarify = await recallStudioIntent(user, token, ambiguous, async () => ({ action: 'clarify', question: '想做什么图？' }));
  assert.ok('studioIntentTicket' in clarify);
  const created = await enqueueDurableGeneration(user, {
    ...ambiguous, studioIntentTicket: clarify.studioIntentTicket,
  }, undefined, { user, personalToken: token });
  await tickGenerationWorker();
  const saved = await prisma.generationJob.findUniqueOrThrow({ where: { id: created.job.id } });
  assert.equal(saved.status, 'completed');
  assert.deepEqual(saved.replyJson, { text: '想做什么图？', studioSkillStage: 'clarify' });
  assert.ok(!JSON.stringify(saved.requestJson).includes(clarify.studioIntentTicket));
});

test('多图指代需要本人明确选择，澄清选项留在同一对话', async () => {
  const phone = uniquePhone();
  const token = await login(phone);
  const user = await prisma.user.findUniqueOrThrow({ where: { phone } });
  const session = await prisma.session.create({ data: { userId: user.id, tenantId: user.tenantId, agentKey: 'general' } });
  const refs = [{ kind: 'image', id: 'first-image' }, { kind: 'image', id: 'second-image' }];
  await prisma.message.create({ data: {
    sessionId: session.id, role: 'user', contentJson: { text: '先看这两张图，暂时只讨论构图。' }, refsJson: refs,
  } });
  const uncertain = { clientRequestId: 'studio-ref-uncertain', sessionId: session.id, text: '用这张做春季新品封面。' };
  const plan = { action: 'draft' as const, kind: 'image' as const, prompt: '春季新品封面', specs: {}, images: [1] };
  const clarify = await recallStudioIntent(user, token, uncertain, async () => plan);
  assert.equal(clarify.action, 'clarify');
  assert.ok('studioIntentTicket' in clarify);
  const created = await enqueueDurableGeneration(user, {
    ...uncertain, studioIntentTicket: clarify.studioIntentTicket,
  }, undefined, { user, personalToken: token });
  await tickGenerationWorker();
  const saved = await prisma.generationJob.findUniqueOrThrow({ where: { id: created.job.id } });
  assert.deepEqual(saved.replyJson, {
    text: '请确认哪张图要作为制作素材。', studioSkillStage: 'clarify',
    asks: [{ q: '选择参考图', options: ['第 1 张作为参考图', '第 2 张作为参考图', '不带参考图'] }],
  });

  const typed = { ...uncertain, text: '用第一张作为参考图，第二张不传。', clientRequestId: 'studio-ref-explicit' };
  const picked = { ...typed, text: '第 1 张作为参考图', clientRequestId: 'studio-ref-quick-reply' };
  for (const body of [typed, picked]) {
    const wrong = await recallStudioIntent(user, token, body, async () => ({ ...plan, images: [2] }));
    assert.equal(wrong.action, 'clarify');
    const correct = await recallStudioIntent(user, token, body, async () => plan);
    assert.ok('studioIntentTicket' in correct);
    const frozen = openStudioIntentTicket(correct.studioIntentTicket, user.id, token, body);
    assert.equal(frozen.action, 'draft');
    if (frozen.action === 'draft') assert.deepEqual(frozen.plan.referenceIds, ['first-image']);
  }
  const noPhoto = { ...uncertain, text: '不带参考图', clientRequestId: 'studio-ref-declined' };
  const declined = await recallStudioIntent(user, token, noPhoto, async () => ({ ...plan, images: [] }));
  assert.ok('studioIntentTicket' in declined);
  const noReferences = openStudioIntentTicket(declined.studioIntentTicket, user.id, token, noPhoto);
  assert.equal(noReferences.action, 'draft');
  if (noReferences.action === 'draft') assert.deepEqual(noReferences.plan.referenceIds, []);
});

test('真实持久任务路径保存选中原稿与本人原图，开卡时另行授权', async (t) => {
  const phone = '13922198765';
  const token = await login(phone);
  const user = await prisma.user.findUniqueOrThrow({ where: { phone } });
  const other = await login(uniquePhone());
  const uid = 'studio-test-linked-uid';
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...rsa.publicKey.export({ format: 'jwk' }), kid: 'studio-test-rsa', use: 'sig', alg: 'RS256' };
  const firstPng = await sharp({ create: { width: 2200, height: 25, channels: 3, background: '#301000' } }).png().toBuffer();
  const secondPng = await sharp({ create: { width: 200, height: 25, channels: 3, background: '#000040' } }).png().toBuffer();
  const firstImage = await ingestChatImage({ userId: user.id, tenantId: user.tenantId, mime: 'image/png', buf: firstPng, fileName: '商品.png' });
  const secondImage = await ingestChatImage({ userId: user.id, tenantId: user.tenantId, mime: 'image/png', buf: secondPng, fileName: '场景.png' });

  let verifiedPhone = false;
  function subject(code: string) {
    const now = Math.floor(Date.now() / 1000);
    const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid: jwk.kid })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      iss: ISSUER, sub: uid, exp: now + 3600, aud: 'junshi-api', azp: 'mini-junshi',
      phone_verified: verifiedPhone, scope: 'openid phone', jti: code,
    })).toString('base64url');
    return `${head}.${payload}.${sign('sha256', Buffer.from(`${head}.${payload}`), rsa.privateKey).toString('base64url')}`;
  }

  let prompt = '';
  let duration: number | undefined;
  let ratio: string | undefined;
  let docVersion = 'v1';
  let operationId = '';
  let referenceOperationId = '';
  let uploaded = false;
  let openSubject = '';
  let checkSessionId = '';
  let toolCalls = 0;
  let expectedPrompt: string | undefined;
  const openCalls: string[] = [];
  const approved: string[] = [];
  const view = () => ({
    draftId: DRAFT_ID, sceneId: SCENE, kind: KIND, initialDocVersion: 'v1', canInitialize: docVersion === 'v1', docVersion, url: TARGET,
    chargedCredits: 0, prompt, ratio, duration, missingRequired: [],
    referenceSlots: [{ slot: 1, label: '参考图', required: false, maxImages: 3, operationIds: uploaded ? [referenceOperationId] : [] }],
  });
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === '/oauth2/jwks') {
      assert.equal(url.origin, ISSUER);
      return Response.json({ keys: [jwk] });
    }
    if (url.pathname === '/oauth2/token') {
      const form = new URLSearchParams(String(init?.body));
      assert.equal(url.origin, ISSUER);
      if (form.get('grant_type') === 'client_credentials') {
        assert.equal(form.get('scope'), 'studio:bridge');
        assert.match((init?.headers as Record<string, string>).authorization, /^Basic /);
        return Response.json({ access_token: 'machine' });
      }
      assert.equal(form.get('client_id'), 'mini-junshi');
      assert.match(form.get('code') ?? '', /^proof-/);
      return Response.json({ access_token: subject(form.get('code')!) });
    }
    if (url.pathname === '/userinfo') return Response.json({ sub: uid, phone_number: phone, phone_verified: verifiedPhone });
    if (url.pathname.startsWith('/api/studio-bridge/')) {
      assert.equal(url.origin, ISSUER);
      assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer machine');
      const data = JSON.parse(String(init?.body));
      if (url.pathname.endsWith('/mcp-token')) return Response.json({ accessToken: 'delegated-mcp', expiresIn: 120 });
      if (url.pathname.endsWith('/verify-phone')) {
        assert.equal(data.expectedPhone, phone);
        assert.equal(data.phoneCode, 'fresh-phone-proof');
        verifiedPhone = true;
      }
      if (url.pathname.endsWith('/verify-login')) {
        if (data.expectedPhone) {
          if (data.phoneCode === 'wrong-phone-proof') return Response.json({ code: 'STUDIO_PHONE_MISMATCH' }, { status: 403 });
          assert.deepEqual(data, { loginCode: 'proof-verify-phone', phoneCode: 'fresh-phone-proof', expectedPhone: phone });
          verifiedPhone = true;
          return Response.json({ uid, phone, openid: 'studio-old-openid', unionid: null });
        }
        assert.deepEqual(data, { loginCode: 'normal-wechat-login', phoneCode: 'normal-wechat-phone' });
        return Response.json({ uid: 'studio-new-person', phone: '13922198766', openid: 'studio-new-openid', unionid: null });
      }

      if (url.pathname.endsWith('/open')) { openSubject = data.subjectToken; openCalls.push(data.openId); }
      if (url.pathname.endsWith('/approve')) { assert.equal(data.subjectToken, openSubject); approved.push(data.transactionId); }
      return new Response(null, { status: 204 });
    }
    assert.equal(url.origin, STUDIO_ORIGIN);
    const hdrs = init?.headers as Record<string, string>;
    if (url.pathname.endsWith('/reference-upload')) {
      assert.equal(hdrs['X-WorkBuddy-Upload'], 'test-permit');
      assert.equal(hdrs.authorization, undefined);
      assert.deepEqual(Buffer.from(init?.body as Uint8Array), firstPng);
      uploaded = true;
      docVersion = 'v3';
      return Response.json({ draftId: DRAFT_ID, docVersion, chargedCredits: 0 });
    }
    assert.equal(hdrs.authorization, 'Bearer delegated-mcp');
    const data = JSON.parse(String(init?.body));
    if (url.pathname.endsWith('/open-intents')) {
      assert.equal(data.draftId, DRAFT_ID);
      checkSessionId = data.openId;
      return new Response(null, { status: 204 });
    }
    assert.equal(url.pathname, '/api/v1/ip-studio/junshi/mcp');
    assert.equal(data.method, 'tools/call');
    toolCalls++;
    const args = data.params.arguments;
    let result: unknown;
    switch (data.params.name) {
      case 'list_media_scenes':
        result = [{ sceneId: SCENE, referenceSlots: [{ label: '参考图', required: false, maxImages: 3 }], oneOfSlotsRequired: [] }];
        break;
      case 'open_media_draft':
        if (args.operationId) {
          if (operationId) assert.equal(args.operationId, operationId);
          operationId = args.operationId;
        } else assert.equal(args.draftId, DRAFT_ID);
        result = view();
        break;
      case 'fill_media_draft':
        assert.equal(args.docVersion, 'v1');
        if (expectedPrompt) assert.equal(args.prompt, expectedPrompt);
        else {
          assert.match(args.prompt, /^## 第二版/);
          assert.doesNotMatch(args.prompt, /初稿镜头|第三版/);
        }
        ({ prompt, duration, ratio } = args);
        docVersion = 'v2';
        result = view();
        break;
      case 'prepare_reference_upload':
        assert.equal(args.docVersion, 'v2');
        assert.equal(args.slot, 1);
        assert.equal(args.fileName, '商品.png');
        assert.equal(args.sha256, createHash('sha256').update(firstPng).digest('hex'));
        assert.equal(args.bytes, firstPng.length);
        referenceOperationId = args.operationId;
        result = { uploadUrl: `${STUDIO_ORIGIN}/api/v1/ip-studio/junshi/reference-upload`, method: 'POST',
          headerName: 'X-WorkBuddy-Upload', uploadToken: 'test-permit' };
        break;
      default: assert.fail(`unexpected tool: ${data.params.name}`);
    }
    return Response.json({ jsonrpc: '2.0', id: data.id, result: { isError: false, content: [{ type: 'text', text: JSON.stringify(result) }] } });
  });

  const refs = [
    { kind: 'image' as const, id: firstImage.id, label: '商品图' },
    { kind: 'image' as const, id: secondImage.id, label: '场景图' },
  ];
  const context = { user, personalToken: token };
  const first = await enqueueDurableGeneration(user, {
    text: '看两张图写一条 15 秒产品视频脚本', clientRequestId: 'test-studio-reads-images', refs, studioLoginCode: 'proof-write',
  }, undefined, context);
  await tickGenerationWorker();
  assert.equal(toolCalls, 0);
  const firstReply = await prisma.generationJob.findUniqueOrThrow({ where: { id: first.job.id } });
  await prisma.message.update({ where: { id: firstReply.resultMessageId! }, data: {
    contentJson: { text: '## 第一版\n初稿镜头，展示外包装材质和企划主题，结尾带一句购买引导。\n\n## 第二版\n镜头近景拍产品开封，旁白先提示使用场景，再展示防水。\n\n## 第三版\n使用更多远景，结尾保留全景。' },
  } });
  const draftBody = {
    text: '用第二版做视频，第一张作商品参考，第二张不要进视频，竖屏',
    sessionId: first.session.id, clientRequestId: 'test-studio-produces', studioLoginCode: 'proof-make',
  };
  await assert.rejects(studioSubjectToken(user, signUserToken(user.id, { extra: { imp: 'owner' } }), 'proof-impersonate'), { code: 'STUDIO_PERSONAL_SESSION_REQUIRED' });
  const draft = await enqueueDurableGeneration(user, draftBody, undefined, context);
  const replay = await enqueueDurableGeneration(user, draftBody, undefined, context);
  assert.equal(draft.job.id, replay.job.id);
  await tickGenerationWorker();
  const needsProof = await prisma.generationJob.findUniqueOrThrow({ where: { id: draft.job.id } });
  assert.equal((needsProof.replyJson as { studioPhoneVerification: string }).studioPhoneVerification, 'required');
  assert.equal(toolCalls, 0);
  const originalSource = { sessionId: first.session.id, messageId: needsProof.resultMessageId };
  const attempt = await api('POST', '/api/studio/resume-draft', { token, body: { ...originalSource, studioLoginCode: 'proof-resume-unverified' } });
  assert.equal(attempt.status, 403);
  const wrongPhone = await api('POST', '/api/studio/verify-phone', {
    token, body: { ...originalSource, studioLoginCode: 'proof-verify-other-phone', phoneCode: 'wrong-phone-proof' },
  });
  assert.equal(wrongPhone.status, 403);
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).identityUid, null);
  assert.equal(toolCalls, 0);
  const verified = await api('POST', '/api/studio/verify-phone', {
    token, body: { ...originalSource, studioLoginCode: 'proof-verify-phone', phoneCode: 'fresh-phone-proof' },
  });
  assert.equal(verified.status, 204);
  const resumed = await api('POST', '/api/studio/resume-draft', { token, body: { ...originalSource, studioLoginCode: 'proof-resume-verified' } });
  assert.equal(resumed.status, 200);
  await tickGenerationWorker();
  const saved = await prisma.generationJob.findUniqueOrThrow({ where: { id: resumed.body.generationId } });
  assert.equal(saved.status, 'completed');
  assert.equal(saved.quotaCharged, 0);
  assert.equal(Object.hasOwn(saved.requestJson as object, 'studio'), false);
  const content = saved.replyJson as any;
  assert.equal(content.studioDraft.url, TARGET);
  assert.equal(content.studioDraft.duration, 15);
  assert.equal(content.studioDraft.ratio, '9:16');
  assert.equal(content.studioDraft.referenceCount, 1);
  assert.deepEqual(content.studioDraft.referenceIds, [firstImage.id]);
  assert.equal(content.studioDraft.sourceScriptMessageId, firstReply.resultMessageId);
  assert.equal(content.studioDraft.sourceMessageId, draft.job.userMessageId);

  const openBody = { sessionId: first.session.id, messageId: saved.resultMessageId, studioLoginCode: 'proof-open' };
  const opened = await api('POST', '/api/studio/open', { token, body: openBody });
  assert.equal(opened.status, 200);
  assert.match(opened.body.url, /^https:\/\/aiavatar\.aibuzz\.cn\/junshi\/open\?openId=/);
  assert.equal(opened.body.openId, checkSessionId);
  assert.deepEqual(openCalls, [checkSessionId]);
  const transactionId = 'transaction-test-012345678901';
  const approveBody = { openId: opened.body.openId, transactionId };
  assert.equal((await api('POST', '/api/studio/open', { token: other, body: openBody })).status, 403);
  const otherLocalSession = signUserToken(user.id, { extra: { client: 'different-session' } });
  assert.equal((await api('POST', '/api/studio/approve', { token: otherLocalSession, body: approveBody })).status, 404);
  assert.equal((await api('POST', '/api/studio/approve', { token, body: approveBody })).status, 204);
  assert.equal((await api('POST', '/api/studio/approve', { token, body: approveBody })).status, 204);
  assert.deepEqual(approved, [transactionId]);
  assert.equal((await api('POST', '/api/studio/cancel', { token, body: { openId: checkSessionId } })).status, 204);
  assert.equal(await prisma.studioOpenIntent.findUnique({ where: { id: checkSessionId } }), null);

  const newLogin = await api('POST', '/api/auth/wechat-phone', {
    body: { loginCode: 'normal-wechat-login', phoneCode: 'normal-wechat-phone' },
  });
  assert.equal(newLogin.status, 200);
  const newUser = await prisma.user.findUniqueOrThrow({ where: { phone: '13922198766' } });
  assert.equal(newUser.identityUid, 'studio-new-person');
  assert.equal(newUser.wechatOpenId, 'studio-new-openid');

  expectedPrompt = '今天下单更划算';
  prompt = ''; duration = undefined; ratio = undefined; operationId = ''; uploaded = false; docVersion = 'v1';
  const linkedUser = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  const linkedContext = { user: linkedUser, personalToken: token };
  const short = await enqueueDurableGeneration(linkedUser, {
    text: '只写一句视频广告脚本', clientRequestId: 'studio-short-script',
  }, undefined, linkedContext);
  assert.equal(short.job.kind, 'chat');
  await tickGenerationWorker();
  const shortReply = await prisma.generationJob.findUniqueOrThrow({ where: { id: short.job.id } });
  await prisma.message.update({ where: { id: shortReply.resultMessageId! }, data: { contentJson: { text: '今天下单更划算' } } });
  const shortBody = { text: '把你上一条完整分镜做成视频草稿', sessionId: short.session.id, clientRequestId: 'studio-short-video' };
  const shortIntent = await recallStudioIntent(linkedUser, token, shortBody, async () => ({
    action: 'draft', kind: 'video', prompt: '这里是模型整理后的描述，不替代原稿', images: [], specs: {}, scriptTurn: 2,
  }));
  assert.ok('studioIntentTicket' in shortIntent);
  const shortDraft = await enqueueDurableGeneration(linkedUser, {
    ...shortBody, studioIntentTicket: shortIntent.studioIntentTicket, studioLoginCode: 'proof-verified-short',
  }, undefined, linkedContext);
  await tickGenerationWorker();
  const shortSaved = (await prisma.generationJob.findUniqueOrThrow({ where: { id: shortDraft.job.id } })).replyJson as any;
  assert.ok(shortSaved.studioDraft, JSON.stringify(shortSaved));
  assert.equal(shortSaved.studioDraft.sourceScriptMessageId, shortReply.resultMessageId);
  assert.equal(prompt, '今天下单更划算');

  expectedPrompt = '用三个镜头讲书店老板收到一封信。';
  prompt = ''; operationId = ''; docVersion = 'v1';
  const newBody = { text: '书店老板收到一封信，三个镜头。就按这版做。', clientRequestId: 'studio-new-brief' };
  const newIntent = await recallStudioIntent(linkedUser, token, newBody, async () => ({
    action: 'draft', kind: 'video', prompt: expectedPrompt!, images: [], specs: {},
  }));
  assert.ok('studioIntentTicket' in newIntent);
  const newDraft = await enqueueDurableGeneration(linkedUser, {
    ...newBody, studioIntentTicket: newIntent.studioIntentTicket, studioLoginCode: 'proof-verified-brief',
  }, undefined, linkedContext);
  await tickGenerationWorker();
  const newSaved = (await prisma.generationJob.findUniqueOrThrow({ where: { id: newDraft.job.id } })).replyJson as any;
  assert.ok(newSaved.studioDraft, JSON.stringify(newSaved));
  assert.equal(newSaved.studioDraft.sourceScriptMessageId, null);
  assert.equal(prompt, expectedPrompt);
});
