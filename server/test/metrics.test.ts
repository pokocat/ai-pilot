// /metrics 端点 —— 纯单元测试（不连库、不联网）。
//   cd server && node --import tsx --test test/metrics.test.ts
//
// 锁住三件事：
//   ① 鉴权：未配 METRICS_TOKEN 时整个端点关闭（404）；配了但 token 不对 → 401。
//      这条特别重要——生产开了 trustProxy，req.ip 来自 X-Forwarded-File 可伪造，
//      真实 TCP 对端又恒为 Nginx 的 127.0.0.1，所以 IP 白名单在这个拓扑下根本不成立，
//      共享密钥是唯一的门。一旦有人把它退化成「内网直接放行」，这里就会红。
//   ② 输出是合法 Prometheus 文本，且包含压测/告警要用的那几组指标名。
//   ③ 不泄漏任何密钥：即使端点池里放了带 apiKey/baseUrl 的端点，也不能出现在输出里。
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { metricsRoutes } from '../src/routes/metrics.js';
import {
  noteRequestStart, noteRequestEnd, noteOverloadRejected,
  gateEnter, __resetMetrics, __stopEventLoopMonitor,
} from '../src/services/metrics.js';
import { __setPoolForTest, __resetLlmPool } from '../src/services/llmPool.js';
import { __resetLlmGate, acquireLlmSlot } from '../src/services/llmGate.js';

const TOKEN = 'metrics-token-for-test';
let savedToken: string | undefined;

async function build() {
  const app = Fastify({ logger: false });
  await app.register(metricsRoutes, { prefix: '/api' });
  await app.ready();
  return app;
}

beforeEach(() => {
  savedToken = process.env.METRICS_TOKEN;
  __resetMetrics();
  __resetLlmGate();
  __resetLlmPool();
});
afterEach(() => {
  if (savedToken === undefined) delete process.env.METRICS_TOKEN; else process.env.METRICS_TOKEN = savedToken;
  __resetMetrics();
  __resetLlmGate();
  __resetLlmPool();
  __stopEventLoopMonitor();
});

describe('鉴权', () => {
  test('未配 METRICS_TOKEN → 404，端点整体关闭', async () => {
    delete process.env.METRICS_TOKEN;
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/metrics' });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().code, 'METRICS_DISABLED');
    await app.close();
  });

  test('配了 token 但请求不带凭据 → 401', async () => {
    process.env.METRICS_TOKEN = TOKEN;
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/metrics' });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().code, 'METRICS_UNAUTHORIZED');
    await app.close();
  });

  test('token 不对 → 401；长度不同也不能抛异常（timingSafeEqual 要求等长）', async () => {
    process.env.METRICS_TOKEN = TOKEN;
    const app = await build();
    for (const bad of ['x', `${TOKEN}x`, TOKEN.slice(0, -1), '']) {
      const res = await app.inject({
        method: 'GET', url: '/api/metrics',
        headers: bad ? { authorization: `Bearer ${bad}` } : {},
      });
      assert.equal(res.statusCode, 401, `token=${JSON.stringify(bad)} 应当 401`);
    }
    await app.close();
  });

  test('token 正确 → 200 且 Content-Type 是 Prometheus 文本', async () => {
    process.env.METRICS_TOKEN = TOKEN;
    const app = await build();
    const res = await app.inject({
      method: 'GET', url: '/api/metrics', headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] as string, /text\/plain/);
    assert.match(res.body, /^junshi_up 1$/m);
    await app.close();
  });
});

describe('指标内容', () => {
  const get = async () => {
    process.env.METRICS_TOKEN = TOKEN;
    const app = await build();
    const res = await app.inject({
      method: 'GET', url: '/api/metrics', headers: { authorization: `Bearer ${TOKEN}` },
    });
    await app.close();
    return res.body;
  };

  test('每个指标都带 HELP/TYPE，且行格式合法', async () => {
    const body = await get();
    const samples = body.split('\n').filter((l) => l && !l.startsWith('#'));
    assert.ok(samples.length > 10, `样本太少：${samples.length}`);
    for (const l of samples) {
      // Prometheus 值可以是整数/浮点/科学计数（含负指数，如事件循环延迟的 5.11e-7）或 NaN/±Inf。
      assert.match(
        l,
        /^[a-zA-Z_:][a-zA-Z0-9_:]*(\{.*\})? (-?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?|NaN|[+-]Inf)$/,
        `不合法的指标行：${l}`,
      );
    }
    // 每个出现的指标名都必须有 TYPE 声明（Prometheus 不强制，但缺了就没法在面板里分类）
    const names = new Set(samples.map((l) => l.replace(/\{.*/, '').split(' ')[0]));
    for (const n of names) {
      if (n.startsWith('prisma_')) continue; // Prisma 自带的那段由它自己声明
      assert.ok(body.includes(`# TYPE ${n} `), `${n} 缺少 # TYPE`);
    }
  });

  test('HTTP 计数如实反映在途与响应分类', async () => {
    noteRequestStart(); noteRequestStart(); noteRequestStart();
    noteRequestEnd(200);
    noteRequestEnd(503);
    gateEnter();
    noteOverloadRejected(); noteOverloadRejected();

    const body = await get();
    assert.match(body, /^junshi_http_in_flight 1$/m, '3 进 2 出应剩 1');
    assert.match(body, /^junshi_http_in_flight_peak 3$/m);
    assert.match(body, /^junshi_http_overload_in_flight 1$/m);
    assert.match(body, /^junshi_http_overload_rejected_total 2$/m);
    assert.match(body, /junshi_http_responses_total\{class="2xx"\} 1/);
    assert.match(body, /junshi_http_responses_total\{class="5xx"\} 1/);
  });

  test('429 既计入 5xx 之外的分类也单独计数（告警线按 429 率算）', async () => {
    noteRequestStart(); noteRequestEnd(429);
    const body = await get();
    assert.match(body, /^junshi_http_rate_limited_total 1$/m);
    assert.match(body, /junshi_http_responses_total\{class="4xx"\} 1/);
  });

  test('LLM 闸门按车道上报，占用与上限都可见', async () => {
    const slot = await acquireLlmSlot('main');
    const body = await get();
    assert.match(body, /junshi_llm_in_flight\{lane="main"\} 1/);
    assert.match(body, /junshi_llm_max_concurrency\{lane="main"\} 8/);
    assert.match(body, /junshi_llm_queued\{lane="main"\} 0/);
    assert.match(body, /junshi_llm_cooling\{lane="main"\} 0/);
    slot.release();
  });

  test('端点池状态上报冷却与权重，且**不泄漏 apiKey / baseUrl**', async () => {
    __setPoolForTest(
      [{
        id: 'ep1', label: '主端点', provider: 'claude',
        baseUrl: 'https://secret-gateway.example.com/bypass/anthropic',
        apiKey: 'sk-super-secret-key-value',
        model: 'claude-opus-4-6', temperature: 0.7,
        thinkingMode: 'disabled', thinkingBudget: 1024,
        weight: 3, tier: 0, maxConcurrency: 0,
      }],
      { mode: 'pool', sticky: true },
    );
    const body = await get();
    assert.match(body, /^junshi_llm_pool_enabled 1$/m);
    assert.match(body, /^junshi_llm_pool_sticky 1$/m);
    assert.match(body, /^junshi_llm_pool_endpoints 1$/m);
    assert.match(body, /junshi_llm_pool_endpoint_weight\{[^}]*endpoint="ep1"[^}]*\} 3/);
    assert.match(body, /junshi_llm_pool_endpoint_cooling\{[^}]*endpoint="ep1"[^}]*\} 0/);

    assert.ok(!body.includes('sk-super-secret-key-value'), '指标输出泄漏了 apiKey');
    assert.ok(!body.includes('secret-gateway.example.com'), '指标输出泄漏了 baseUrl');
  });

  test('single 模式下端点池指标为 0，不误报成已分流', async () => {
    __setPoolForTest([], { mode: 'single', sticky: true });
    const body = await get();
    assert.match(body, /^junshi_llm_pool_enabled 0$/m);
    assert.match(body, /^junshi_llm_pool_endpoints 0$/m);
  });

  test('进程与事件循环指标存在（耐久场景靠它们判漂移）', async () => {
    const body = await get();
    assert.match(body, /^junshi_process_resident_memory_bytes \d+$/m);
    assert.match(body, /junshi_nodejs_event_loop_delay_seconds\{quantile="0.95"\}/);
    assert.match(body, /^junshi_nodejs_event_loop_delay_max_seconds /m);
  });
});
