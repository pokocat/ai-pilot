// 爱速拍新增的 BFF 契约（ai-quickreel `docs/WORKPLAN_2026-09-05.md`）：
//   §1.3 一句话生成全片   POST /api/video/projects/:id/script/generate
//   §1.4 一句话提取要素   POST /api/video/intake/extract
//   §1.5 配音预览时间线   POST|GET /api/video/projects/:id/tts-preview（透传）
//   §1.6 段级出片状态     GET /api/video/jobs/:id 的 segments（透传）
//   WP-A3 文案 AI 改写    POST /api/video/projects/:id/script/ai-rewrite（收回 BFF 网关）
//
// 测试环境不接真实模型（isAiTestMode），所以 LLM 端点在这里验的是**入参闸、审核闸与失败形态**：
// 产出不可用时必须显式报错，绝不返回一份空壳冒充成功、更不许把没生成出来的东西写回上游项目。
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, cleanBusiness, closeApp, getApp, login, seedBaseline, uniquePhone } from './helpers.js';

process.env.AIDRAMA_CLIP_BASE_URL = 'https://aidrama.example.test';
process.env.AIDRAMA_CLIP_SERVICE_TOKEN = 'test-service-token';
process.env.AIDRAMA_CLIP_ALLOW_PRIVATE_NET = 'false';

const originalFetch = globalThis.fetch;
/**
 * 上游 tts-preview 的几种形态。WP-A2 第 2 条要分流的正是前两种 404：
 *   ready     正常返回时间线
 *   notFound  路由在，但这一版文案还没有预览结果 → 404 且 body code=CLIP_TTS_PREVIEW_NOT_FOUND
 *   offline   路由压根没上线 → 404 但不带该码
 *   noMethod  只实现了另一半（比如只有 POST） → 405
 *   sparse    上游全局 non_null：errorCode / errorMessage / audioUrl / credits 全部缺席
 */
let ttsPreviewMode: 'ready' | 'notFound' | 'offline' | 'noMethod' | 'sparse' = 'ready';
let savedProjectBody: Record<string, unknown> | null = null;
/** 上游 `script/ai-rewrite` 收到的 body。`VIDEO_SCRIPT_ENGINE=bff`（默认）时必须恒为 null。 */
let upstreamRewriteBody: Record<string, unknown> | null = null;
/** 上游 `GET /projects/cp_one` 被读了几次——审核不过时不该白跑一趟上游。 */
let projectFetchCount = 0;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const PROJECT = {
  id: 'cp_one', templateId: 'ct_shiti', templateName: '实体商家模板', title: '修鞋铺', status: 'draft',
  variables: {},
  segments: [
    { no: 1, text: '我在学院路开了十二年修鞋铺', role: 'avatar', hint: '正面口播', actualDurationSec: 4 },
    { no: 2, text: '街坊的鞋子都是我一双双缝好的', role: 'broll', hint: '手艺特写', actualDurationSec: 5 },
    { no: 3, text: '欢迎来店里坐坐', role: 'tail', actualDurationSec: 2 },
  ],
};

before(async () => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    if (url.pathname === '/api/me/clip/projects/cp_one/script/ai-rewrite') {
      upstreamRewriteBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      // 上游 clip 域没接 LLM：非 mock 网关一律 503。这正是 WP-A3 要绕开的那一格。
      return json({ error: '口播文案改写模型尚未完成配置', code: 'CLIP_SCRIPT_ENGINE_NOT_CONFIGURED' }, 503);
    }
    if (url.pathname === '/api/me/clip/projects/cp_one' && method === 'GET') { projectFetchCount += 1; return json(PROJECT); }
    if (url.pathname === '/api/me/clip/projects/cp_one' && method === 'PUT') {
      savedProjectBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return json({ ...PROJECT, ...savedProjectBody });
    }
    if (url.pathname === '/api/me/clip/projects/cp_one/tts-preview') {
      if (ttsPreviewMode === 'notFound') {
        return json({ error: '这一版文案还没有配音预览', code: 'CLIP_TTS_PREVIEW_NOT_FOUND' }, 404);
      }
      if (ttsPreviewMode === 'offline') return json({ error: '接口不存在', code: 'CLIP_NOT_FOUND' }, 404);
      if (ttsPreviewMode === 'noMethod') return json({ error: '方法不允许' }, 405);
      if (ttsPreviewMode === 'sparse') {
        // non_null 序列化：null 字段整个不出现（errorCode / errorMessage / audioUrl / credits）。
        return json({
          status: 'generating',
          timelineHash: 'sha256:sparse',
          voiceId: 'VC-scene',
          totalDurationSec: 9,
          segments: [{ no: 1, durationSec: 4, startSec: 0 }, { no: 2, durationSec: 5, startSec: 4 }],
        });
      }
      return json({
        status: 'ready',
        timelineHash: 'sha256:abc',
        voiceId: 'VC-scene',
        totalDurationSec: 9,
        segments: [
          { no: 1, audioUrl: 'https://cdn.example.test/1.mp3', durationSec: 4, startSec: 0 },
          { no: 2, audioUrl: 'https://cdn.example.test/2.mp3', durationSec: 5, startSec: 4 },
        ],
        errorCode: null,
        errorMessage: null,
        credits: 0,
        triggered: method === 'POST',
      });
    }
    if (url.pathname === '/api/me/clip/jobs/cj_seg') {
      return json({
        id: 'cj_seg', status: 'generating', stage: 'avatar', progress: 40,
        segments: [
          { no: 1, role: 'avatar', status: 'done' },
          { no: 2, role: 'broll', status: 'generating' },
          { no: 3, role: 'avatar', status: 'failed', errorCode: 'CLIP_ENGINE_CALL_FAILED' },
        ],
      });
    }
    return json({ error: 'not found', code: 'CLIP_NOT_FOUND' }, 404);
  }) as typeof fetch;
  await getApp();
});

after(async () => {
  globalThis.fetch = originalFetch;
  await closeApp();
});

beforeEach(async () => {
  await cleanBusiness();
  await seedBaseline();
  ttsPreviewMode = 'ready';
  savedProjectBody = null;
  upstreamRewriteBody = null;
  projectFetchCount = 0;
  delete process.env.VIDEO_SCRIPT_ENGINE;
});

test('四条新端点未登录一律 401', async () => {
  for (const [method, url, body] of [
    ['POST', '/api/video/projects/cp_one/script/generate', { brief: '我开了家修鞋铺' }],
    ['POST', '/api/video/intake/extract', { text: '我开了家修鞋铺' }],
    ['POST', '/api/video/projects/cp_one/tts-preview', {}],
    ['GET', '/api/video/projects/cp_one/tts-preview', undefined],
  ] as const) {
    const res = await api(method, url, body === undefined ? {} : { body });
    assert.equal(res.status, 401, `${method} ${url}`);
    assert.equal(res.body.code, 'UNAUTHORIZED');
  }
});

test('§1.3 一句话生成：入参闸（空 / 超 500 字）', async () => {
  const token = await login(uniquePhone(), '一句话用户');
  const empty = await api('POST', '/api/video/projects/cp_one/script/generate', { token, body: { brief: '   ' } });
  assert.equal(empty.status, 422);
  assert.equal(empty.body.code, 'CLIP_BRIEF_INVALID');

  const tooLong = await api('POST', '/api/video/projects/cp_one/script/generate', { token, body: { brief: '啊'.repeat(501) } });
  assert.equal(tooLong.status, 422);
  assert.equal(tooLong.body.code, 'CLIP_BRIEF_INVALID');
  assert.equal(savedProjectBody, null, '入参不合法不许写上游项目');
});

test('§1.3 模型不可用时显式报错，绝不悄悄保存空稿', async () => {
  const token = await login(uniquePhone(), '一句话用户2');
  const res = await api('POST', '/api/video/projects/cp_one/script/generate', {
    token, body: { brief: '我在学院路开了十二年修鞋铺，想让街坊知道我们还在' },
  });
  // 测试环境不接真实模型 → structured 恒空 → 必须 502，且上游项目不能被改。
  assert.equal(res.status, 502, JSON.stringify(res.body));
  assert.equal(res.body.code, 'CLIP_SCRIPT_AI_INVALID');
  assert.equal(savedProjectBody, null);
});

test('§1.4 提取要素：入参闸与失败形态', async () => {
  const token = await login(uniquePhone(), '提取用户');
  const empty = await api('POST', '/api/video/intake/extract', { token, body: { text: '' } });
  assert.equal(empty.status, 422);
  assert.equal(empty.body.code, 'CLIP_INTAKE_INVALID');

  const res = await api('POST', '/api/video/intake/extract', {
    token, body: { text: '我在学院路开了十二年修鞋铺', templateId: 'ct_shiti' },
  });
  assert.equal(res.status, 502, JSON.stringify(res.body));
  assert.equal(res.body.code, 'CLIP_INTAKE_AI_INVALID');
});

test('§1.5 配音预览：POST 触发 / GET 轮询都原样透传', async () => {
  const token = await login(uniquePhone(), '配音用户');
  const triggered = await api('POST', '/api/video/projects/cp_one/tts-preview', { token, body: {} });
  assert.equal(triggered.status, 200, JSON.stringify(triggered.body));
  assert.equal(triggered.body.status, 'ready');
  assert.equal(triggered.body.triggered, true);

  const polled = await api('GET', '/api/video/projects/cp_one/tts-preview', { token });
  assert.equal(polled.status, 200, JSON.stringify(polled.body));
  assert.equal(polled.body.timelineHash, 'sha256:abc');
  assert.equal(polled.body.totalDurationSec, 9);
  assert.equal(polled.body.segments.length, 2);
  assert.equal(polled.body.segments[1].startSec, 4);
  assert.equal(polled.body.credits, 0, '计费字段必须原样透传');
  assert.equal(polled.body.triggered, false);
});

test('§1.5 上游还没上线：404 无业务码 → 明确的 CLIP_TTS_PREVIEW_UNAVAILABLE，不冒充「项目不存在」', async () => {
  ttsPreviewMode = 'offline';
  const token = await login(uniquePhone(), '配音用户2');
  const res = await api('GET', '/api/video/projects/cp_one/tts-preview', { token });
  assert.equal(res.status, 503, JSON.stringify(res.body));
  assert.equal(res.body.code, 'CLIP_TTS_PREVIEW_UNAVAILABLE');
});

test('§1.5 上游 405（只实现了另一半方法）同样按「功能没上线」→ 503', async () => {
  ttsPreviewMode = 'noMethod';
  const token = await login(uniquePhone(), '配音用户5');
  const res = await api('GET', '/api/video/projects/cp_one/tts-preview', { token });
  assert.equal(res.status, 503, JSON.stringify(res.body));
  assert.equal(res.body.code, 'CLIP_TTS_PREVIEW_UNAVAILABLE');
});

test('§1.5 两种 404 必须分流：CLIP_TTS_PREVIEW_NOT_FOUND 原样 404 透传，端上据此重新 POST', async () => {
  ttsPreviewMode = 'notFound';
  const token = await login(uniquePhone(), '配音用户3');
  for (const method of ['GET', 'POST'] as const) {
    const res = await api(method, '/api/video/projects/cp_one/tts-preview', method === 'POST' ? { token, body: {} } : { token });
    assert.equal(res.status, 404, `${method}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.code, 'CLIP_TTS_PREVIEW_NOT_FOUND', `${method} 不许被映射成 UNAVAILABLE`);
  }
});

test('§1.5 上游 non_null 省掉的字段由 BFF 补齐：errorCode/errorMessage=null、audioUrl=""、credits=0', async () => {
  ttsPreviewMode = 'sparse';
  const token = await login(uniquePhone(), '配音用户4');
  const res = await api('GET', '/api/video/projects/cp_one/tts-preview', { token });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.status, 'generating');
  assert.equal(res.body.errorCode, null, '端上按 null 判断，不能拿到 undefined');
  assert.equal(res.body.errorMessage, null);
  assert.equal(res.body.credits, 0, 'credits 必填且恒 ≥ 0');
  assert.equal(res.body.segments[0].audioUrl, '', '未合成段给空串，不是 undefined');
  assert.equal(res.body.segments[1].startSec, 4, '其余字段原样透传');
});

/* ── WP-A3：文案 AI 改写收回军师自己的 LLM 网关 ── */

test('WP-A3 ai-rewrite 未登录 401', async () => {
  const res = await api('POST', '/api/video/projects/cp_one/script/ai-rewrite', { body: { scope: 'segment', no: 1, text: '我在学院路开了十二年修鞋铺' } });
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'UNAUTHORIZED');
});

test('WP-A3 ai-rewrite 入参闸：scope 非法 / segment 缺文案 / 超长', async () => {
  const token = await login(uniquePhone(), '改写用户入参');
  const cases: [Record<string, unknown>, string][] = [
    [{}, '缺 scope'],
    [{ scope: 'paragraph', no: 1, text: '随便' }, 'scope 不在白名单'],
    [{ scope: 'segment', no: 1, text: '   ' }, 'segment 文案为空'],
    [{ scope: 'segment', no: 1, text: '啊'.repeat(501) }, 'segment 文案超 500 字'],
    [{ scope: 'all', text: '啊'.repeat(501) }, 'all 指令超 500 字'],
  ];
  for (const [body, why] of cases) {
    const res = await api('POST', '/api/video/projects/cp_one/script/ai-rewrite', { token, body });
    assert.equal(res.status, 422, `${why}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.code, 'CLIP_REWRITE_INVALID', why);
  }
  assert.equal(projectFetchCount, 0, '入参不合法不许去读上游项目');
  assert.equal(savedProjectBody, null, '入参不合法不许写上游项目');
});

test('WP-A3 ai-rewrite 输入过机审：命中禁用词一律 422 CLIP_CONTENT_BLOCKED，不碰上游', async () => {
  const token = await login(uniquePhone(), '改写用户机审');
  for (const body of [
    { scope: 'segment', no: 1, text: '来我店里看暴力表演' },
    { scope: 'all', text: '整篇改成暴力风格' },
  ]) {
    const res = await api('POST', '/api/video/projects/cp_one/script/ai-rewrite', { token, body });
    assert.equal(res.status, 422, JSON.stringify(res.body));
    assert.equal(res.body.code, 'CLIP_CONTENT_BLOCKED');
  }
  assert.equal(projectFetchCount, 0, '审核不过就不该再去读上游项目');
  assert.equal(savedProjectBody, null);
});

test('WP-A3 ai-rewrite 默认走 BFF 网关：模型不可用时显式 502，原稿一个字不动', async () => {
  const token = await login(uniquePhone(), '改写用户单句');
  const segment = await api('POST', '/api/video/projects/cp_one/script/ai-rewrite', {
    token, body: { scope: 'segment', no: 1, text: '我在学院路开了十二年修鞋铺' },
  });
  assert.equal(segment.status, 502, JSON.stringify(segment.body));
  assert.equal(segment.body.code, 'CLIP_SCRIPT_AI_INVALID');

  const all = await api('POST', '/api/video/projects/cp_one/script/ai-rewrite', {
    token, body: { scope: 'all', text: '说得再朴实一点' },
  });
  assert.equal(all.status, 502, JSON.stringify(all.body));
  assert.equal(all.body.code, 'CLIP_SCRIPT_AI_INVALID');

  // 空指令 = 「润色全篇」，同样必须是 BFF 自己的失败码，而不是上游那条 503。
  const polish = await api('POST', '/api/video/projects/cp_one/script/ai-rewrite', { token, body: { scope: 'all' } });
  assert.equal(polish.status, 502, JSON.stringify(polish.body));
  assert.equal(polish.body.code, 'CLIP_SCRIPT_AI_INVALID');

  assert.equal(upstreamRewriteBody, null, '默认引擎下绝不能再打上游 script/ai-rewrite（那条生产必 503）');
  assert.equal(savedProjectBody, null, '没生成出东西就不许写回上游项目');
  assert.equal(projectFetchCount, 3, '三次都要读一次项目拿模板骨架');
});

test('WP-A3 VIDEO_SCRIPT_ENGINE=aidrama 才退回旧透传，上游的 503 原样透出', async () => {
  const token = await login(uniquePhone(), '改写用户透传');
  process.env.VIDEO_SCRIPT_ENGINE = 'aidrama';
  try {
    const res = await api('POST', '/api/video/projects/cp_one/script/ai-rewrite', {
      token, body: { scope: 'segment', no: 2, text: '街坊的鞋子都是我一双双缝好的' },
    });
    // 上游 5xx 一律被网关收成 502（`safeUpstreamError`），业务码原样透出。
    assert.equal(res.status, 502, JSON.stringify(res.body));
    assert.equal(res.body.code, 'CLIP_SCRIPT_ENGINE_NOT_CONFIGURED', '生产配这个开关就是这个结果，故意留在测试里当警示');
    assert.deepEqual(upstreamRewriteBody, { scope: 'segment', no: 2, text: '街坊的鞋子都是我一双双缝好的' });
    assert.equal(projectFetchCount, 0, '透传路径不读项目');
  } finally { delete process.env.VIDEO_SCRIPT_ENGINE; }
});

test('§1.6 段级出片状态原样透传', async () => {
  const token = await login(uniquePhone(), '出片用户');
  const res = await api('GET', '/api/video/jobs/cj_seg', { token });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.segments.length, 3);
  assert.deepEqual(res.body.segments[2], { no: 3, role: 'avatar', status: 'failed', errorCode: 'CLIP_ENGINE_CALL_FAILED' });
});
