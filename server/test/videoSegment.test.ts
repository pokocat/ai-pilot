// 分段生成的**钱**：预扣、结算、退款、幂等、受理不明。
//
// 整片出片那套（video.test.ts）已经验过一遍同样的规则，这里不是重复：分段把「一单一片」
// 拆到了段上，每一段自己一条 hold。拆开之后最容易出的两类错，正是这组用例盯的：
//   · 指纹命中（上游没重跑，直接回已有产物）时忘了把预扣退回去 —— 白收一次钱；
//   · 请求发出去了但没拿到任务号时误退款 —— 那一单可能在上游跑着，退了就是双花。
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import { getBalance, grantCredits } from '../src/services/credits.js';
import { api, cleanBusiness, closeApp, getApp, login, seedBaseline, uniquePhone } from './helpers.js';

process.env.AIDRAMA_CLIP_BASE_URL = 'https://aidrama.example.test';
process.env.AIDRAMA_CLIP_SERVICE_TOKEN = 'test-service-token';
process.env.AIDRAMA_CLIP_ALLOW_PRIVATE_NET = 'false';
// 这组验计费，不验机审（机审自有用例）。不旁路的话每条带文案的提交都 503，一行计费逻辑都跑不到。
process.env.CLIP_MEDIA_MODERATION_BYPASS = 'true';

const originalFetch = globalThis.fetch;

/** 上游对 shots/:no/generate 的应答，逐个用例改。 */
let generateReply: { status: number; body: unknown } = {
  status: 200, body: { jobId: 'sj_1', status: 'queued', credits: 6 },
};
let generateCalls = 0;
let generationStatus = 'running';
let assembleReply: { status: number; body: unknown } = {
  status: 200, body: { jobId: 'aj_1', projectId: 'cp_test', status: 'queued' },
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

before(async () => {
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const p = url.pathname;
    if (p === '/api/me/clip/pricing') {
      return json({
        creditPerAvatarSecond: 1, creditPerImage: 2, creditPerT2vSecond: 1,
        creditPerI2vSecond: 1, creditPerAssemble: 3, creditPerKChar: 5,
      });
    }
    if (/\/shots\/\d+\/generate$/.test(p)) {
      generateCalls += 1;
      return json(generateReply.body, generateReply.status);
    }
    if (/\/shots\/\d+\/generation$/.test(p)) {
      return json({ jobId: 'sj_1', status: generationStatus, progress: 40, credits: 6 });
    }
    if (/\/shots\/\d+\/cancel$/.test(p)) return json({ jobId: 'sj_1', status: 'cancelled' });
    if (p.endsWith('/assemble')) return json(assembleReply.body, assembleReply.status);
    if (p.endsWith('/duplicate')) return json({ id: 'cp_copy', templateId: 'ct_test', status: 'draft' });
    return json({ error: '未在本用例桩里的上游路径: ' + p }, 404);
  };
  await getApp();
  await seedBaseline();
});

beforeEach(async () => {
  await cleanBusiness();
  generateCalls = 0;
  generationStatus = 'running';
  generateReply = { status: 200, body: { jobId: 'sj_1', status: 'queued', credits: 6 } };
  assembleReply = { status: 200, body: { jobId: 'aj_1', projectId: 'cp_test', status: 'queued' } };
});

after(async () => { globalThis.fetch = originalFetch; await closeApp(); });

async function payingUser(credits = 100) {
  const token = await login(uniquePhone(), '分段用户');
  const user = await prisma.user.findUniqueOrThrow({ where: { id: token }, select: { tenantId: true } });
  await grantCredits(user.tenantId, token, credits, '分段测试充值');
  return { token, before: await getBalance(token) };
}

const GEN = '/api/video/projects/cp_test/shots/3/generate';

test('单价表原样透传，键名与端上对齐', async () => {
  const { token } = await payingUser();
  const res = await api('GET', '/api/video/pricing', { token });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  for (const key of ['creditPerAvatarSecond', 'creditPerImage', 'creditPerT2vSecond',
    'creditPerI2vSecond', 'creditPerAssemble', 'creditPerKChar']) {
    assert.ok(Number.isFinite(res.body[key]), `缺少单价键 ${key}`);
  }
});

test('生成一段：提交即预扣，同一 clientRequestId 重投不重扣也不重复建单', async () => {
  const { token, before } = await payingUser();
  const body = { clientRequestId: 'shot:req:0001', expectedCredits: 6, model: 'avatar' };

  const first = await api('POST', GEN, { token, body });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.jobId, 'sj_1');
  assert.equal(await getBalance(token), before - 6, '提交后应当预扣');

  const second = await api('POST', GEN, { token, body });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.reused, true);
  assert.equal(generateCalls, 1, '重投不得再打一次上游');
  assert.equal(await getBalance(token), before - 6, '重投不得重复扣费');
});

test('指纹命中：上游没重跑，预扣要原样退回', async () => {
  const { token, before } = await payingUser();
  // 上游发现输入没变、产物还在：不给 jobId，直接回 succeeded
  generateReply = { status: 200, body: { status: 'succeeded', artifact: { url: 'https://x/a.mp4', fingerprint: 'fp1' } } };
  const res = await api('POST', GEN, { token, body: { clientRequestId: 'shot:req:0002', expectedCredits: 6 } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.cached, true);
  assert.equal(res.body.credits, 0, '没重跑就不该报一个非零的价');
  assert.equal(await getBalance(token), before, '没重跑就不该收钱');
});

test('上游明确拒单（4xx）：预扣当场退回，不让用户挨了报错还被扣着钱', async () => {
  const { token, before } = await payingUser();
  generateReply = { status: 422, body: { error: '这一段太长了', code: 'CLIP_SEGMENT_TOO_LONG' } };
  const res = await api('POST', GEN, { token, body: { clientRequestId: 'shot:req:0003', expectedCredits: 6 } });
  assert.notEqual(res.status, 200);
  // 4xx = 上游答复过并且拒绝了，那一单根本没建起来，退款是安全的也是必须的
  assert.equal(await getBalance(token), before, '明确被拒就该当场退回');
  const hold = await prisma.videoCreditHold.findFirst({ where: { userId: token, clientRequestId: 'shot:req:0003' } });
  assert.equal(hold?.status, 'refunded');
});

test('上游连不上（5xx / 超时）：标 unknown 不退款，交给对账', async () => {
  const { token, before } = await payingUser();
  generateReply = { status: 503, body: { error: '视频引擎没配', code: 'CLIP_ENGINE_NOT_CONFIGURED' } };
  const res = await api('POST', GEN, { token, body: { clientRequestId: 'shot:req:0003b', expectedCredits: 6 } });
  assert.notEqual(res.status, 200);
  // 这时那一单可能已经落到上游手里了，退款会双花
  const hold = await prisma.videoCreditHold.findFirst({ where: { userId: token, clientRequestId: 'shot:req:0003b' } });
  assert.equal(hold?.status, 'unknown', '不知道有没有建单时不许退款');
  assert.equal(await getBalance(token), before - 6);
});

test('上游没返回任务号：标 unknown 不退款（那一单可能已经在跑）', async () => {
  const { token, before } = await payingUser();
  generateReply = { status: 200, body: { status: 'queued' } };
  const res = await api('POST', GEN, { token, body: { clientRequestId: 'shot:req:0004', expectedCredits: 6 } });
  assert.equal(res.status, 502, JSON.stringify(res.body));
  const hold = await prisma.videoCreditHold.findFirst({ where: { userId: token, clientRequestId: 'shot:req:0004' } });
  assert.equal(hold?.status, 'unknown');
  assert.equal(await getBalance(token), before - 6, '不许在受理不明时退款，那会造成双花');
});

test('轮询到终态就地结算：失败退款，重复轮询不双退', async () => {
  const { token, before } = await payingUser();
  await api('POST', GEN, { token, body: { clientRequestId: 'shot:req:0005', expectedCredits: 6 } });
  assert.equal(await getBalance(token), before - 6);

  generationStatus = 'failed';
  await api('GET', '/api/video/projects/cp_test/shots/3/generation', { token });
  assert.equal(await getBalance(token), before, '失败要退回预扣');
  await api('GET', '/api/video/projects/cp_test/shots/3/generation', { token });
  assert.equal(await getBalance(token), before, '重复轮询不得双退');
  assert.equal(await prisma.videoCreditHold.count({ where: { userId: token, status: 'refunded' } }), 1);
});

test('成功落账：succeeded 之后钱不再退', async () => {
  const { token, before } = await payingUser();
  await api('POST', GEN, { token, body: { clientRequestId: 'shot:req:0006', expectedCredits: 6 } });
  generationStatus = 'succeeded';
  await api('GET', '/api/video/projects/cp_test/shots/3/generation', { token });
  assert.equal(await getBalance(token), before - 6, '成功就该收这一段的钱');
  const hold = await prisma.videoCreditHold.findFirst({ where: { userId: token, clientRequestId: 'shot:req:0006' } });
  assert.equal(hold?.status, 'settled');
});

test('取消不扣钱', async () => {
  const { token, before } = await payingUser();
  await api('POST', GEN, { token, body: { clientRequestId: 'shot:req:0007', expectedCredits: 6 } });
  await api('POST', '/api/video/projects/cp_test/shots/3/cancel', { token, body: {} });
  assert.equal(await getBalance(token), before, '取消要把预扣退回去');
});

test('镜头序号非法当场挡下，不进计费', async () => {
  const { token, before } = await payingUser();
  for (const no of ['0', '999', 'abc']) {
    const res = await api('POST', `/api/video/projects/cp_test/shots/${no}/generate`, {
      token, body: { clientRequestId: `shot:req:bad-${no}`, expectedCredits: 6 },
    });
    assert.notEqual(res.status, 200, `序号 ${no} 应当被拒`);
  }
  assert.equal(await getBalance(token), before, '被挡下的请求一分钱都不该扣');
  assert.equal(generateCalls, 0, '被挡下的请求不该打上游');
});

test('缺 clientRequestId 或缺确认报价一律拒收', async () => {
  const { token, before } = await payingUser();
  const noReq = await api('POST', GEN, { token, body: { expectedCredits: 6 } });
  assert.equal(noReq.status, 422);
  assert.equal(noReq.body.code, 'CLIENT_REQUEST_ID_REQUIRED');
  const noQuote = await api('POST', GEN, { token, body: { clientRequestId: 'shot:req:0008' } });
  assert.equal(noQuote.status, 422);
  assert.equal(noQuote.body.code, 'CLIP_EXPECTED_CREDITS_REQUIRED');
  assert.equal(await getBalance(token), before);
});

test('合成整片：单独一条 hold，重投同一请求不重扣', async () => {
  const { token, before } = await payingUser();
  const body = { clientRequestId: 'assemble:req:0001', expectedCredits: 3 };
  const first = await api('POST', '/api/video/projects/cp_test/assemble', { token, body });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.jobId, 'aj_1');
  assert.equal(await getBalance(token), before - 3);

  const second = await api('POST', '/api/video/projects/cp_test/assemble', { token, body });
  assert.equal(second.body.reused, true);
  assert.equal(await getBalance(token), before - 3, '重投不得重复扣费');
});

test('复制成新草稿不计费', async () => {
  const { token, before } = await payingUser();
  const res = await api('POST', '/api/video/projects/cp_test/duplicate', { token, body: {} });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.id, 'cp_copy');
  assert.equal(await getBalance(token), before, '复制一份稿子不该收钱');
});

test('未登录一律 401，不进计费', async () => {
  for (const [method, url] of [
    ['GET', '/api/video/pricing'],
    ['POST', GEN],
    ['GET', '/api/video/projects/cp_test/shots/3/generation'],
    ['POST', '/api/video/projects/cp_test/assemble'],
    ['POST', '/api/video/projects/cp_test/duplicate'],
  ] as const) {
    const res = await api(method, url, { body: method === 'POST' ? {} : undefined });
    assert.equal(res.status, 401, `${method} ${url} 未登录应当 401`);
  }
});
