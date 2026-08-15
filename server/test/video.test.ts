import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import { assertAidramaGatewayUrl } from '../src/services/video/aidramaGateway.js';
import {
  assertVideoMediaModerationReady,
  assertVideoUploadContent,
  clipMediaModerationBypassEnabled,
  projectText,
} from '../src/services/video/moderation.js';
import { getBalance, grantCredits } from '../src/services/credits.js';
import { assertSandboxSafe } from '../src/services/sandbox.js';
import { api, cleanBusiness, closeApp, getApp, login, seedBaseline, uniquePhone } from './helpers.js';

process.env.AIDRAMA_CLIP_BASE_URL = 'https://aidrama.example.test';
process.env.AIDRAMA_CLIP_SERVICE_TOKEN = 'test-service-token';
process.env.AIDRAMA_CLIP_ALLOW_PRIVATE_NET = 'false';
// 本组用例验的是计费与结算，不是机审链路（机审自有用例）。不开旁路的话每次上传都 503，
// 计费逻辑一行都跑不到。NODE_ENV!=production 时这个开关才生效，生产另有硬拒绝。
process.env.CLIP_MEDIA_MODERATION_BYPASS = 'true';

const originalFetch = globalThis.fetch;
let jobStatus = 'queued';
let voiceStatus = 'ready';
let cloneCalls = 0;
let cloneUpstream: Record<string, unknown> = { voiceId: 'VC-new' };
/** 非 null 时让上游 clone 直接报错，用来验「上游失败 → 预扣必须退回」。 */
let cloneUpstreamError: { status: number; code: string; error: string } | null = null;
let renderCalls = 0;
let seenHeaders: Headers | null = null;
let renderBlock: Promise<void> | null = null;
let signalRenderStarted: (() => void) | null = null;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

before(async () => {
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    seenHeaders = new Headers(init?.headers);
    if (url.pathname === '/api/me/clip/projects/cp_test' && (!init?.method || init.method === 'GET')) {
      return json({
        id: 'cp_test', templateId: 'ct_test', title: '测试片', status: 'draft', variables: {},
        segments: [{ no: 1, text: '这是一段正常的口播文案', role: 'avatar', actualDurationSec: 4 }],
      });
    }
    if (url.pathname === '/api/me/clip/projects/cp_test' && init?.method === 'PUT') {
      const saved = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
      return json({
        id: 'cp_test', templateId: 'ct_test', templateName: '测试模板', title: '测试片', status: 'draft', variables: {},
        segments: [{ no: 1, text: '这是一段正常的口播文案', role: 'avatar', actualDurationSec: 4 }],
        ...saved,
      });
    }
    if (url.pathname === '/api/me/clip/projects/cp_test/estimate') {
      return json({
        total: 6,
        items: [{ key: 'avatar', label: '分身出镜', credits: 6 }],
        summary: { totalSec: 4, avatarSec: 4, tailSec: 0, avatarCount: 1, brollCount: 0, tailCount: 0, chars: 12 },
      });
    }
    if (url.pathname === '/api/me/clip/projects/cp_test/render') {
      renderCalls += 1;
      signalRenderStarted?.();
      if (renderBlock) await renderBlock;
      return json({ jobId: 'cj_test', projectId: 'cp_test', status: 'queued' }, 201);
    }
    if (url.pathname === '/api/me/clip/jobs/cj_test') {
      return json({ id: 'cj_test', status: jobStatus, stage: 'avatar', progress: jobStatus === 'failed' ? 40 : 10, errorMessage: jobStatus === 'failed' ? '上游失败' : null });
    }
    if (url.pathname === '/api/me/clip/avatars' && (!init?.method || init.method === 'GET')) {
      return json([{ id: 'DH-scene', name: '门店形象', imageStatus: 'ready', voiceStatus: 'ready', linkedVoiceId: 'VC-scene', linkedVoiceName: '主理人声线' }]);
    }
    if (url.pathname === '/api/me/clip/voices') {
      return json([{ id: 'VC-scene', name: '主理人声线', status: voiceStatus, source: 'dedicated', progress: 100 }]);
    }
    if (url.pathname === '/api/me/clip/avatar/clone') {
      cloneCalls += 1;
      if (cloneUpstreamError) return json({ error: cloneUpstreamError.error, code: cloneUpstreamError.code }, cloneUpstreamError.status);
      return json({ ok: true, kind: 'voice', status: 'training', ...cloneUpstream });
    }
    if (url.pathname === '/api/me/clip/avatars/DH-scene' && init?.method === 'DELETE') {
      return json({ ok: true });
    }
    if (url.pathname === '/api/me/clip/works' && (!init?.method || init.method === 'GET')) {
      return json([{
        id: 'cp_test', projectId: 'cp_test', title: '测试作品', status: 'done', durationSec: 12, avatarSec: 4,
        createdAt: '2026-08-11T18:01:02Z', generatedAt: '2026-08-11T18:04:05Z', aiWatermark: false,
      }]);
    }
    if (url.pathname === '/api/me/clip/works/cp_test' && init?.method === 'DELETE') {
      return json({ ok: true, cancelledJobIds: ['cj_test'] });
    }
    return json({ error: 'not found', code: 'CLIP_NOT_FOUND' }, 404);
  };
  await getApp();
});

after(async () => {
  globalThis.fetch = originalFetch;
  await closeApp();
});

beforeEach(async () => {
  await cleanBusiness();
  await seedBaseline();
  voiceStatus = 'ready';
  cloneCalls = 0;
  cloneUpstream = { voiceId: 'VC-new' };
  cloneUpstreamError = null;
  jobStatus = 'queued';
  renderCalls = 0;
  seenHeaders = null;
  renderBlock = null;
  signalRenderStarted = null;
});

test('视频 BFF 未登录一律 401', async () => {
  const res = await api('GET', '/api/video/templates');
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'UNAUTHORIZED');
});

test('视频 BFF 拒绝非法或带凭据的网关地址', async () => {
  await assert.rejects(() => assertAidramaGatewayUrl('file:///etc/passwd'), /配置非法/);
  await assert.rejects(() => assertAidramaGatewayUrl('https://user:pass@example.com'), /配置非法/);
});

test('视频 BFF 返回多数字人和可复用声音，并支持按分身删除', async () => {
  const token = await login(uniquePhone(), '多数字人用户');
  const avatarResult = await api('GET', '/api/video/avatars', { token });
  assert.equal(avatarResult.status, 200, JSON.stringify(avatarResult.body));
  assert.equal(avatarResult.body[0].id, 'DH-scene');
  assert.equal(avatarResult.body[0].linkedVoiceId, 'VC-scene');

  const voiceResult = await api('GET', '/api/video/voices', { token });
  assert.equal(voiceResult.status, 200, JSON.stringify(voiceResult.body));
  assert.equal(voiceResult.body[0].name, '主理人声线');

  const deleted = await api('DELETE', '/api/video/avatars/DH-scene', { token });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.equal(deleted.body.ok, true);
});

test('视频 BFF 透传作品生成时间并支持删除作品', async () => {
  const token = await login(uniquePhone(), '作品管理用户');
  const user = await prisma.user.findUniqueOrThrow({ where: { id: token }, select: { tenantId: true } });
  await grantCredits(user.tenantId, token, 20, '作品删除退款测试');
  const beforeBalance = await getBalance(token);
  const works = await api('GET', '/api/video/works', { token });
  assert.equal(works.status, 200, JSON.stringify(works.body));
  assert.equal(works.body[0].createdAt, '2026-08-11T18:01:02Z');
  assert.equal(works.body[0].generatedAt, '2026-08-11T18:04:05Z');

  const render = await api('POST', '/api/video/projects/cp_test/render', {
    token,
    body: { clientRequestId: 'clip:test:delete-001', expectedCredits: 6 },
  });
  assert.equal(render.status, 200, JSON.stringify(render.body));
  assert.equal(await getBalance(token), beforeBalance - 6);

  const deleted = await api('DELETE', '/api/video/works/cp_test', { token });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.equal(deleted.body.ok, true);
  assert.deepEqual(deleted.body.cancelledJobIds, ['cj_test']);
  assert.equal(await getBalance(token), beforeBalance, '删除生成中作品必须立即退回未结算预扣');
  assert.equal(await prisma.videoCreditHold.count({ where: { userId: token, status: 'refunded' } }), 1);
});

test('视频 BFF 原样保存默认关闭的 AI 水印偏好', async () => {
  const token = await login(uniquePhone(), '水印设置用户');
  const result = await api('PUT', '/api/video/projects/cp_test', {
    token,
    body: { subtitleStyle: { aiWatermark: false } },
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.subtitleStyle.aiWatermark, false);
});

// 封面 = 拼在成片最前面的一张 720x1280 图（只占 1~2 帧，不影响视频内容），
// 平台发布后拿第一帧当缩略图。BFF 只做透传，截断与「不填就不加」的判定都在 AIStar 侧。
test('视频 BFF 原样透传成片封面配置', async () => {
  const token = await login(uniquePhone(), '封面设置用户');
  const cover = {
    enabled: true,
    templateId: 'cover_shiti',
    keyword: '团结',
    handle: '@可乐米乐麻麻讲Ai',
    sloganLines: ['一群人一条心', '一件事一起拼'],
    signature: '集体为实体发声',
  };
  const result = await api('PUT', '/api/video/projects/cp_test', { token, body: { cover } });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(result.body.cover, cover, '封面四个槽位必须一字不改地送到 AIStar');
});

test('初始文案支持连续 AI 对话；测试环境无真实模型时诚实保留原稿', async () => {
  const token = await login(uniquePhone(), '文案对话用户');
  const result = await api('POST', '/api/video/projects/cp_test/script/chat', {
    token,
    body: { message: '帮我写得更像老板本人说话，别太像广告。' },
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.applied, false);
  assert.equal(result.body.project.scriptChat.length, 2);
  assert.deepEqual(result.body.project.scriptChat.map((item: { role: string }) => item.role), ['user', 'assistant']);
  assert.ok(result.body.project.shots.length >= 1);
  assert.match(result.body.reply, /原稿没有改动/);
});

test('媒体机审旁路需显式开启；生产还要二次确认，并留下独立审计', async () => {
  const token = await login(uniquePhone(), '视频旁路用户');
  const user = await prisma.user.findUniqueOrThrow({ where: { id: token }, select: { tenantId: true } });
  const savedNodeEnv = process.env.NODE_ENV;
  const savedBypass = process.env.CLIP_MEDIA_MODERATION_BYPASS;
  const savedProductionBypass = process.env.CLIP_MEDIA_MODERATION_ALLOW_PRODUCTION;
  try {
    process.env.NODE_ENV = 'development';
    process.env.CLIP_MEDIA_MODERATION_BYPASS = 'true';
    assert.equal(clipMediaModerationBypassEnabled(), true);
    await assertVideoMediaModerationReady('image/png');
    await assertVideoUploadContent(Buffer.from('test-image'), 'image/png', { tenantId: user.tenantId, userId: token });
    assert.equal(await prisma.auditLog.count({
      where: { userId: token, action: 'user.video.media.moderation.bypassed' },
    }), 1);

    process.env.NODE_ENV = 'production';
    delete process.env.CLIP_MEDIA_MODERATION_ALLOW_PRODUCTION;
    assert.equal(clipMediaModerationBypassEnabled(), false, 'production 单开旁路不能生效');
    assert.throws(() => assertSandboxSafe(), /CLIP_MEDIA_MODERATION_BYPASS/);
    await assert.rejects(
      () => assertVideoMediaModerationReady('image/png'),
      (error: unknown) => (error as { code?: string }).code === 'CLIP_MEDIA_MODERATION_NOT_CONFIGURED',
    );

    process.env.CLIP_MEDIA_MODERATION_ALLOW_PRODUCTION = 'true';
    assert.equal(clipMediaModerationBypassEnabled(), true, 'production 双开关才允许运营旁路');
    assert.doesNotThrow(() => assertSandboxSafe());
    await assertVideoMediaModerationReady('image/png');
    await assertVideoUploadContent(Buffer.from('production-test-image'), 'image/png', { tenantId: user.tenantId, userId: token });
    const productionAudit = await prisma.auditLog.findFirstOrThrow({
      where: { userId: token, action: 'user.video.media.moderation.bypassed' },
      orderBy: { createdAt: 'desc' },
    });
    assert.equal((productionAudit.payloadJson as { provider?: string }).provider, 'operator-bypass');
  } finally {
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = savedNodeEnv;
    if (savedBypass === undefined) delete process.env.CLIP_MEDIA_MODERATION_BYPASS;
    else process.env.CLIP_MEDIA_MODERATION_BYPASS = savedBypass;
    if (savedProductionBypass === undefined) delete process.env.CLIP_MEDIA_MODERATION_ALLOW_PRODUCTION;
    else process.env.CLIP_MEDIA_MODERATION_ALLOW_PRODUCTION = savedProductionBypass;
  }
});

test('出片按 clientRequestId 幂等预扣，上游失败只退款一次', async () => {
  const token = await login(uniquePhone(), '视频用户');
  const user = await prisma.user.findUniqueOrThrow({ where: { id: token }, select: { tenantId: true } });
  await grantCredits(user.tenantId, token, 50, '视频测试充值');
  const beforeBalance = await getBalance(token);
  const body = { clientRequestId: 'clip:test:request-001', expectedCredits: 6 };

  const first = await api('POST', '/api/video/projects/cp_test/render', { token, body });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.jobId, 'cj_test');
  assert.equal(first.body.creditsHeld, 6);
  assert.equal(await getBalance(token), beforeBalance - 6);

  const second = await api('POST', '/api/video/projects/cp_test/render', { token, body });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.reused, true);
  assert.equal(renderCalls, 1, '重复提交不得重复请求上游建单');
  assert.equal(await getBalance(token), beforeBalance - 6, '重复提交不得重复扣费');

  assert.equal(seenHeaders?.get('authorization'), 'Bearer test-service-token');
  assert.equal(seenHeaders?.get('x-external-owner-id'), token);
  assert.equal(seenHeaders?.get('x-user-id'), null, '军师用户 token 不得透传到 aidrama');

  jobStatus = 'failed';
  const failed = await api('GET', '/api/video/jobs/cj_test', { token });
  assert.equal(failed.status, 200);
  assert.equal(await getBalance(token), beforeBalance, '失败轮询应退回预扣');
  await api('GET', '/api/video/jobs/cj_test', { token });
  assert.equal(await getBalance(token), beforeBalance, '重复轮询失败不得双退');
  assert.equal(await prisma.videoCreditHold.count({ where: { userId: token, status: 'refunded' } }), 1);
});

test('用户确认价与服务端重算不一致时拒绝扣费和建单', async () => {
  const token = await login(uniquePhone(), '报价校验用户');
  const user = await prisma.user.findUniqueOrThrow({ where: { id: token }, select: { tenantId: true } });
  await grantCredits(user.tenantId, token, 50, '视频报价测试充值');
  const beforeBalance = await getBalance(token);

  const result = await api('POST', '/api/video/projects/cp_test/render', {
    token,
    body: { clientRequestId: 'clip:test:quote-001', expectedCredits: 5 },
  });
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.equal(result.body.code, 'CLIP_QUOTE_CHANGED');
  assert.equal(await getBalance(token), beforeBalance);
  assert.equal(renderCalls, 0);
  assert.equal(await prisma.videoCreditHold.count({ where: { userId: token } }), 0);
});

test('同一出片请求并发时复用者不能重复建单或退掉首个预扣', async () => {
  const token = await login(uniquePhone(), '并发视频用户');
  const user = await prisma.user.findUniqueOrThrow({ where: { id: token }, select: { tenantId: true } });
  await grantCredits(user.tenantId, token, 50, '视频并发测试充值');
  const beforeBalance = await getBalance(token);
  let releaseRender!: () => void;
  renderBlock = new Promise<void>((resolve) => { releaseRender = resolve; });
  const renderStarted = new Promise<void>((resolve) => { signalRenderStarted = resolve; });
  const body = { clientRequestId: 'clip:test:concurrent-001', expectedCredits: 6 };

  const firstPromise = api('POST', '/api/video/projects/cp_test/render', { token, body });
  await renderStarted;
  const second = await api('POST', '/api/video/projects/cp_test/render', { token, body });
  assert.equal(second.status, 409, JSON.stringify(second.body));
  assert.equal(second.body.code, 'CLIP_RENDER_CREATING');
  assert.equal(renderCalls, 1);
  assert.equal(await getBalance(token), beforeBalance - 6, '并发复用请求不能退掉首个请求的预扣');

  releaseRender();
  const first = await firstPromise;
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.jobId, 'cj_test');
  assert.equal(await prisma.videoCreditHold.count({ where: { userId: token, status: 'submitted' } }), 1);
});

// 封面上的四个文本槽位会被烧进成片第一帧、随作品一起发布出去，
// 所以它必须和口播文案一起过机审 —— 只审 segments 会留下「图上写什么都行」的绕过路径。
test('封面文案与口播文案一起进机审送检文本', () => {
  const text = projectText({
    segments: [
      { role: 'avatar', text: '我来开场' },
      { role: 'tail', text: '固定尾段不送检' },
    ],
    cover: {
      enabled: true,
      keyword: '团结',
      handle: '@可乐米乐麻麻讲Ai',
      sloganLines: ['一群人一条心', '一件事一起拼'],
      signature: '集体为实体发声',
    },
  });

  assert.ok(text.includes('我来开场'));
  assert.ok(text.includes('团结'), '封面关键词必须送检');
  assert.ok(text.includes('@可乐米乐麻麻讲Ai'), '封面账号名必须送检');
  assert.ok(text.includes('一件事一起拼'), '封面标语必须送检');
  assert.ok(text.includes('集体为实体发声'), '封面落款必须送检');
  assert.ok(!text.includes('固定尾段不送检'), '固定尾段仍不送检，口径不变');
});

test('封面藏在 payloadJson 里也照样送检，且没有封面时口径不变', () => {
  const nested = projectText({
    payloadJson: { segments: [{ role: 'avatar', text: '正文' }], cover: { enabled: true, signature: '落款' } },
  });
  assert.ok(nested.includes('正文'));
  assert.ok(nested.includes('落款'));

  assert.equal(projectText({ segments: [{ role: 'avatar', text: '只有正文' }] }), '只有正文');
  assert.equal(projectText({ segments: [], cover: null }), '');
});

/* ── 克隆预扣：界面标了多少钱，服务端就得真扣多少 ─────────────────────────── */

/**
 * 手搓 multipart。字段必须排在文件之前 —— @fastify/multipart 的 req.file() 是流式的，
 * 排在文件后面的字段读不到，测试会莫名其妙地缺参数。
 */
function multipart(fields: Record<string, string>) {
  const boundary = '----clipCloneTestBoundary';
  const parts: Buffer[] = [];
  for (const [key, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`));
  }
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="voice.mp3"\r\n`
    + 'Content-Type: audio/mpeg\r\n\r\n',
  ));
  // ID3 magic：服务端按魔数判真实类型，不信 multipart 声明的 MIME。
  parts.push(Buffer.concat([Buffer.from('ID3'), Buffer.alloc(4096, 1)]));
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function postClone(token: string, fields: Record<string, string>) {
  const app = await getApp();
  const { payload, contentType } = multipart(fields);
  const res = await app.inject({
    method: 'POST', url: '/api/video/avatar/clone',
    headers: { 'x-user-id': token, 'content-type': contentType }, payload,
  });
  let body: any = null;
  try { body = res.json(); } catch { body = res.body; }
  return { status: res.statusCode, body };
}

async function cloneUser(balance: number) {
  const token = await login(uniquePhone(), '克隆计费');
  const user = await prisma.user.findUniqueOrThrow({ where: { id: token }, select: { tenantId: true } });
  await grantCredits(user.tenantId, token, balance, '克隆计费测试余额');
  return token;
}

test('训练声音真的扣钻石，而不是只在界面上写着要扣', async () => {
  const token = await cloneUser(1000);
  const before = await getBalance(token);
  const res = await postClone(token, {
    kind: 'voice', clientRequestId: 'clone-req-0001', expectedCredits: '200',
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(cloneCalls, 1);
  assert.equal(await getBalance(token), before - 200, '预扣必须落到余额上');
});

test('微信克隆上传的完整七字段不会被 multipart 全局上限截断', async () => {
  const token = await cloneUser(1000);
  const before = await getBalance(token);
  // wx.uploadFile 会把空的可选字段也逐项放进 multipart；计费版新增的幂等号和确认报价排在最后。
  // 全局 fields 上限若还停在 5，最后两项会被静默截掉，最新版客户端会被误判成旧版并返回 422。
  const res = await postClone(token, {
    kind: 'voice',
    voiceSource: '',
    avatarId: '',
    voiceId: '',
    name: '',
    clientRequestId: 'clone-req-full-fields',
    expectedCredits: '200',
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(cloneCalls, 1, '完整字段必须进入克隆上游，不能在 BFF 入口被截断');
  assert.equal(await getBalance(token), before - 200);
});

test('缺幂等标识 / 报价对不上，一律挡在调用上游之前', async () => {
  const token = await cloneUser(1000);
  const before = await getBalance(token);

  const noId = await postClone(token, { kind: 'voice', expectedCredits: '200' });
  assert.equal(noId.status, 422);
  assert.equal(noId.body.code, 'CLIP_CLONE_CLIENT_OUTDATED');
  assert.match(noId.body.error, /更新/, '老客户端要看得懂该干什么，不能甩字段名');

  // 端上看到 60（重训档）却按新建提交 —— 停下来重新确认，绝不按另一个数字静默扣。
  const wrongQuote = await postClone(token, {
    kind: 'voice', clientRequestId: 'clone-req-0002', expectedCredits: '60',
  });
  assert.equal(wrongQuote.status, 409);
  assert.equal(wrongQuote.body.code, 'CLIP_CLONE_QUOTE_CHANGED');

  assert.equal(cloneCalls, 0, '报价没对齐就不该碰上游');
  assert.equal(await getBalance(token), before, '被挡下的请求分文不扣');
});

test('余额不够时直接 402，不会先把训练跑起来', async () => {
  const token = await cloneUser(10);
  const before = await getBalance(token);
  assert.ok(before < 200, '前置条件：这个账号确实付不起一次训练');
  const res = await postClone(token, {
    kind: 'voice', clientRequestId: 'clone-req-0003', expectedCredits: '200',
  });
  assert.equal(res.status, 402);
  assert.equal(res.body.code, 'INSUFFICIENT_CREDITS');
  assert.equal(cloneCalls, 0, '钱不够就不该消耗供应商算力');
  assert.equal(await getBalance(token), before);
});

test('带 voiceId 走重训档：更便宜，且这条路以前端上根本走不到', async () => {
  const token = await cloneUser(1000);
  const before = await getBalance(token);
  const res = await postClone(token, {
    kind: 'voice', voiceId: 'VC-scene', clientRequestId: 'clone-req-0004', expectedCredits: '60',
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(await getBalance(token), before - 60, '重训按重训档收，不是按新建档');
});

test('训练失败后，钻石在下一次查状态时退回来', async () => {
  const token = await cloneUser(1000);
  const before = await getBalance(token);
  cloneUpstream = { voiceId: 'VC-scene' };
  const res = await postClone(token, {
    kind: 'voice', clientRequestId: 'clone-req-0005', expectedCredits: '200',
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(await getBalance(token), before - 200);

  // 上游给出终态 failed：端上本来就会轮询声音列表，谁先看到终态谁负责结账。
  voiceStatus = 'failed';
  const list = await api('GET', '/api/video/voices', { token });
  assert.equal(list.status, 200);
  assert.equal(await getBalance(token), before, '训练失败必须全额退回');
});

test('训练成功则结清，不会被后续查询误退', async () => {
  const token = await cloneUser(1000);
  const before = await getBalance(token);
  cloneUpstream = { voiceId: 'VC-scene' };
  await postClone(token, { kind: 'voice', clientRequestId: 'clone-req-0006', expectedCredits: '200' });

  await api('GET', '/api/video/voices', { token });       // ready → 结算
  assert.equal(await getBalance(token), before - 200);

  voiceStatus = 'failed';                                  // 之后这条声音被重训并失败
  await api('GET', '/api/video/voices', { token });
  assert.equal(await getBalance(token), before - 200, '已结算的那一单不该被后来的失败退掉');
});

test('重训额度用尽：上游报错不回落成新建，预扣当场退回', async () => {
  const token = await cloneUser(1000);
  const before = await getBalance(token);
  // 上游 retrainVoice 已去掉「回落成新建」：额度用尽直接 409，绝不悄悄多建一条声音。
  cloneUpstreamError = { status: 409, code: 'CLIP_VOICE_RETRAIN_QUOTA_EXHAUSTED', error: '这条声音的 4 次免费重新训练已经用完，请新建一条声音' };

  const res = await postClone(token, {
    kind: 'voice', voiceId: 'VC-scene', clientRequestId: 'clone-req-0007', expectedCredits: '60',
  });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.code, 'CLIP_VOICE_RETRAIN_QUOTA_EXHAUSTED');
  assert.match(res.body.error, /用完/, '错误文案要说清是额度用完，而不是笼统的失败');
  assert.equal(await getBalance(token), before, '上游没干成活，扣掉的必须原样退回');
  assert.equal(await prisma.videoCloneHold.count({ where: { userId: token, status: 'refunded' } }), 1);
});

test('同一请求标识在失败退款后不许复用：必须换一单重来', async () => {
  const token = await cloneUser(1000);
  cloneUpstreamError = { status: 409, code: 'CLIP_VOICE_RETRAIN_QUOTA_EXHAUSTED', error: '已经用完' };
  await postClone(token, { kind: 'voice', voiceId: 'VC-scene', clientRequestId: 'clone-req-0008', expectedCredits: '60' });

  // 退过款的 hold 再被复用，会卡在「既不扣费也不建单」的死角上。
  cloneUpstreamError = null;
  const retry = await postClone(token, { kind: 'voice', voiceId: 'VC-scene', clientRequestId: 'clone-req-0008', expectedCredits: '60' });
  assert.equal(retry.status, 409);
  assert.equal(retry.body.code, 'CLIP_CLONE_REQUEST_CLOSED');
});
