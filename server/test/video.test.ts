import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import { assertAidramaGatewayUrl } from '../src/services/video/aidramaGateway.js';
import {
  assertVideoMediaModerationReady,
  assertVideoUploadContent,
  clipMediaModerationBypassEnabled,
} from '../src/services/video/moderation.js';
import { getBalance, grantCredits } from '../src/services/credits.js';
import { assertSandboxSafe } from '../src/services/sandbox.js';
import { api, cleanBusiness, closeApp, getApp, login, seedBaseline, uniquePhone } from './helpers.js';

process.env.AIDRAMA_CLIP_BASE_URL = 'https://aidrama.example.test';
process.env.AIDRAMA_CLIP_SERVICE_TOKEN = 'test-service-token';
process.env.AIDRAMA_CLIP_ALLOW_PRIVATE_NET = 'false';

const originalFetch = globalThis.fetch;
let jobStatus = 'queued';
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

test('媒体机审旁路只在非生产显式开启，并留下独立审计', async () => {
  const token = await login(uniquePhone(), '视频旁路用户');
  const user = await prisma.user.findUniqueOrThrow({ where: { id: token }, select: { tenantId: true } });
  const savedNodeEnv = process.env.NODE_ENV;
  const savedBypass = process.env.CLIP_MEDIA_MODERATION_BYPASS;
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
    assert.equal(clipMediaModerationBypassEnabled(), false, 'production 不能因误配而实际旁路');
    assert.throws(() => assertSandboxSafe(), /CLIP_MEDIA_MODERATION_BYPASS/);
    await assert.rejects(
      () => assertVideoMediaModerationReady('image/png'),
      (error: unknown) => (error as { code?: string }).code === 'CLIP_MEDIA_MODERATION_NOT_CONFIGURED',
    );
  } finally {
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = savedNodeEnv;
    if (savedBypass === undefined) delete process.env.CLIP_MEDIA_MODERATION_BYPASS;
    else process.env.CLIP_MEDIA_MODERATION_BYPASS = savedBypass;
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
