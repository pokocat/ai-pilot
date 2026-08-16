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
  noteHttpTiming, noteLlmCall, noteTokenUsage, noteGenDegraded, noteOutputTruncated,
  noteRegistration, noteModeration, noteCreditDelta, notePlanGateBlocked,
  notePayOrderCreated, notePayApplied, notePayRefund, notePaySweep,
  noteChatFirstToken, noteChatGenerationFinalized,
  noteSessionDigestState, noteSessionDigestCompaction,
  noteCreativeCritique, noteProbe,
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
    // 每个出现的指标名都必须有 TYPE 声明（Prometheus 不强制，但缺了就没法在面板里分类）。
    // 直方图的 _bucket/_sum/_count 样本行归属基名的 TYPE 声明。
    const names = new Set(samples.map((l) => l.replace(/\{.*/, '').split(' ')[0]));
    for (const n of names) {
      if (n.startsWith('prisma_')) continue; // Prisma 自带的那段由它自己声明
      const base = n.replace(/_(bucket|sum|count)$/, '');
      assert.ok(body.includes(`# TYPE ${n} `) || body.includes(`# TYPE ${base} histogram`), `${n} 缺少 # TYPE`);
    }
  });

  test('HTTP 路由级直方图：bucket/sum/count 齐全且按路由模板分序列', async () => {
    noteHttpTiming('GET', '/api/agents/:key', 200, 0.08);
    noteHttpTiming('GET', '/api/agents/:key', 200, 0.3);
    noteHttpTiming('POST', '/api/generate', 500, 42);
    const body = await get();
    assert.match(body, /# TYPE junshi_http_request_duration_seconds histogram/);
    // 0.08 与 0.3 都 ≤0.5 → le=0.5 桶计 2
    assert.match(body, /junshi_http_request_duration_seconds_bucket\{method="GET",route="\/api\/agents\/:key",le="0\.5"\} 2/);
    assert.match(body, /junshi_http_request_duration_seconds_count\{method="GET",route="\/api\/agents\/:key"\} 2/);
    // 42s 的慢请求只落在 ≥60 的桶
    assert.match(body, /junshi_http_request_duration_seconds_bucket\{method="POST",route="\/api\/generate",le="30"\} 0/);
    assert.match(body, /junshi_http_request_duration_seconds_bucket\{method="POST",route="\/api\/generate",le="60"\} 1/);
    // 路由级状态分类（找 5xx 冒烟点用）
    assert.match(body, /junshi_http_route_responses_total\{method="POST",route="\/api\/generate",class="5xx"\} 1/);
  });

  test('LLM 调用 / token / 成本计数与告警口径对齐', async () => {
    noteLlmCall('chat', 'claude', 'claude-opus-4-6', 'ok', 3200);
    noteLlmCall('deliverable', 'claude', 'claude-opus-4-6', 'error', 60000, 'server_error');
    noteTokenUsage({ kind: 'chat', provider: 'claude', model: 'claude-opus-4-6', inputTokens: 1000, outputTokens: 500, cachedInput: 200, cacheWrite: 0, costMicros: 12_340_000 });
    const body = await get();
    assert.match(body, /junshi_llm_calls_total\{kind="chat",provider="claude",model="claude-opus-4-6",status="ok"\} 1/);
    assert.match(body, /junshi_llm_calls_total\{kind="deliverable",provider="claude",model="claude-opus-4-6",status="error"\} 1/);
    assert.match(body, /junshi_llm_call_duration_seconds_bucket\{kind="chat",provider="claude",model="claude-opus-4-6",le="5"\} 1/);
    // 错误分布：未分类的调用方（本测试）落 bucket 由调用方显式传入，验证按 bucket 分开计数。
    assert.match(body, /junshi_llm_errors_total\{kind="deliverable",provider="claude",model="claude-opus-4-6",bucket="server_error"\} 1/);
    assert.match(body, /junshi_llm_tokens_total\{kind="chat",provider="claude",model="claude-opus-4-6",dir="input"\} 1000/);
    assert.match(body, /junshi_llm_tokens_total\{[^}]*dir="cached_input"\} 200/);
    // 12_340_000 微元 = 12.34 元
    assert.match(body, /junshi_llm_cost_cny_total\{kind="chat",provider="claude",model="claude-opus-4-6"\} 12\.34/);
  });

  test('生成状态与封闭标签集从 0 暴露，首个故障不会被 increase 漏掉', async () => {
    const zero = await get();
    assert.match(zero, /junshi_chat_generation_total\{result="failed"\} 0/);
    assert.match(zero, /junshi_chat_stream_stall_total\{provider="openai",phase="first_event",had_text="no"\} 0/);
    assert.match(zero, /junshi_chat_usage_estimated_total\{provider="unknown"\} 0/);
    assert.match(zero, /junshi_chat_provider_first_token_seconds_count\{provider="claude"\} 0/);

    noteChatFirstToken('claude', 8.4, 2.1);
    noteChatGenerationFinalized({
      result: 'failed',
      queueSeconds: 1.2,
      providerSeconds: 4.5,
      finalizeSeconds: 0.2,
      jobSeconds: 5.9,
      recovered: true,
      usageSource: 'estimated',
      provider: 'unknown',
    });
    const body = await get();
    assert.match(body, /junshi_chat_first_token_seconds_sum\{provider="claude"\} 8\.4/);
    assert.match(body, /junshi_chat_provider_first_token_seconds_sum\{provider="claude"\} 2\.1/);
    assert.match(body, /junshi_chat_generation_total\{result="failed"\} 1/);
    assert.match(body, /^junshi_chat_generation_recovered_total 1$/m);
    assert.match(body, /junshi_chat_usage_estimated_total\{provider="unknown"\} 1/);
  });

  test('长会话摘要状态、压力与滚动压缩均可告警且不带用户级标签', async () => {
    noteSessionDigestState('caught_up', 42, 0);
    noteSessionDigestState('pending', 360, 18);
    noteSessionDigestState('capped', 400, 75);
    noteSessionDigestCompaction('succeeded');
    noteSessionDigestCompaction('failed');
    const body = await get();
    assert.match(body, /junshi_session_digest_updates_total\{status="caught_up",pressure="normal"\} 1/);
    assert.match(body, /junshi_session_digest_updates_total\{status="pending",pressure="near_cap"\} 1/);
    assert.match(body, /junshi_session_digest_updates_total\{status="capped",pressure="capped"\} 1/);
    assert.match(body, /junshi_session_digest_compactions_total\{outcome="succeeded"\} 1/);
    assert.match(body, /junshi_session_digest_compactions_total\{outcome="failed"\} 1/);
    assert.match(body, /junshi_session_digest_items_bucket\{status="pending",le="375"\} 1/);
    assert.match(body, /junshi_session_digest_pending_messages_bucket\{status="capped",le="100"\} 1/);
    assert.doesNotMatch(body, /sessionId|userId/);
  });

  test('产出降级 / 截断 / 审核 / 禁写闸计数', async () => {
    noteGenDegraded('deliverable');
    noteOutputTruncated('claude', 'continued'); // 撞上限但被自动续写救回（用户无感）
    noteOutputTruncated('claude', 'given_up'); // 续写用尽/结构化产出，交回用户
    noteModeration('input', false);
    noteModeration('output', true);
    notePlanGateBlocked('none');
    const body = await get();
    assert.match(body, /junshi_gen_degraded_total\{path="deliverable"\} 1/);
    // continued 与 given_up 必须分开可见：前者高说明该调输出预算或长度约束，后者才是用户真的看到未写完。
    assert.match(body, /junshi_llm_output_truncated_total\{provider="claude",resolved="continued"\} 1/);
    assert.match(body, /junshi_llm_output_truncated_total\{provider="claude",resolved="given_up"\} 1/);
    assert.match(body, /junshi_moderation_checks_total\{ref="input",verdict="block"\} 1/);
    assert.match(body, /junshi_moderation_checks_total\{ref="output",verdict="pass"\} 1/);
    assert.match(body, /junshi_plan_gate_blocked_total\{state="none"\} 1/);
  });

  test('海报视觉评审指标会导出，reset 后不残留上一轮样本', async () => {
    noteCreativeCritique('unparsed');
    const body = await get();
    assert.match(body, /junshi_creative_critique_total\{verdict="unparsed"\} 1/);
    __resetMetrics();
    const reset = await get();
    assert.doesNotMatch(reset, /junshi_creative_critique_total\{verdict="unparsed"\} 1/);
  });

  test('业务事件：注册 / 算力（reason 取 · 首段）/ 支付金额折元', async () => {
    noteRegistration('wechat_register');
    noteCreditDelta(-30, '深度报告 · 战略参谋');
    noteCreditDelta(500, '决策版 · 微信支付');
    notePayOrderCreated();
    notePayApplied('plan', 12800);
    notePayRefund(12800);
    notePaySweep({ scanned: 5, applied: 1, failed: 0, closed: 2 });
    const body = await get();
    assert.match(body, /junshi_user_registrations_total\{channel="wechat_register"\} 1/);
    assert.match(body, /^junshi_user_registrations_72h \d+$/m, '注册静默告警必须导出数据库事实 gauge');
    assert.match(body, /^junshi_user_last_registration_timestamp_seconds \d+(?:\.\d+)?$/m);
    assert.match(body, /junshi_credits_flow_total\{direction="spent",reason="深度报告"\} 30/);
    assert.match(body, /junshi_credits_flow_total\{direction="granted",reason="决策版"\} 500/);
    assert.match(body, /^junshi_pay_orders_created_total 1$/m);
    assert.match(body, /junshi_pay_orders_applied_total\{type="plan"\} 1/);
    assert.match(body, /junshi_pay_amount_cny_total\{type="plan"\} 128$/m);
    assert.match(body, /^junshi_pay_refunds_total 1$/m);
    assert.match(body, /junshi_pay_sweep_last\{result="scanned"\} 5/);
    assert.match(body, /junshi_pay_sweep_last\{result="closed"\} 2/);
    assert.match(body, /^junshi_pay_sweep_runs_total 1$/m);
  });

  test('端点探活指标精确到端点/用途/检测项，手动与定时来源分开', async () => {
    noteProbe({
      endpoint: 'ep-embedding', label: '向量嵌入', purpose: 'embedding', kind: 'embedding', source: 'scheduled',
    }, false, 0.12, 600);
    const body = await get();
    const labels = 'endpoint="ep-embedding",label="向量嵌入",purpose="embedding",kind="embedding",source="scheduled"';
    assert.match(body, new RegExp(`junshi_ai_endpoint_probe_ok\\{${labels}\\} 0`));
    assert.match(body, new RegExp(`junshi_ai_endpoint_probe_interval_seconds\\{${labels}\\} 600`));
    assert.match(body, /junshi_ai_endpoint_probe_total\{endpoint="ep-embedding",label="向量嵌入",purpose="embedding",kind="embedding",source="scheduled",status="fail"\} 1/);
  });

  test('标签基数保护：reason 超 100 种折叠进 other，direction 维度保留、总量守恒', async () => {
    for (let i = 0; i < 130; i++) noteCreditDelta(-1, `理由${i}`);
    const body = await get();
    assert.match(body, /junshi_credits_flow_total\{direction="spent",reason="other"\} 30/);
    const total = [...body.matchAll(/junshi_credits_flow_total\{[^}]*direction="spent"[^}]*\} (\d+)/g)]
      .reduce((acc, m) => acc + Number(m[1]), 0);
    assert.equal(total, 130, '折叠后总量必须守恒');
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
    // 立即授予（未排队）也要记一次 0 等待，直方图才能算出「多少比例根本没等」。
    assert.match(body, /# TYPE junshi_llm_wait_seconds histogram/);
    assert.match(body, /junshi_llm_wait_seconds_bucket\{lane="main",le="0\.1"\} 1/);
    assert.match(body, /junshi_llm_wait_seconds_count\{lane="main"\} 1/);
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

  test('告警阈值配置指标存在（Prometheus 规则 scalar() 的数据源）', async () => {
    const body = await get();
    assert.match(body, /junshi_alert_config\{key="token_daily_budget_cny"\} 200/);
    assert.match(body, /junshi_alert_config\{key="host_cpu_warn_pct"\} 65/);
    assert.match(body, /junshi_alert_config\{key="llm_429_crit_permille"\} 20/);
  });

  test('进程与事件循环指标存在（耐久场景靠它们判漂移）', async () => {
    const body = await get();
    assert.match(body, /^junshi_process_resident_memory_bytes \d+$/m);
    assert.match(body, /junshi_nodejs_event_loop_delay_seconds\{quantile="0.95"\}/);
    assert.match(body, /^junshi_nodejs_event_loop_delay_max_seconds /m);
  });
});
