import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

// 错误必须按状态码拆开统计。上一轮 T0 报了 5.04% 错误就下了「不可比」的结论，
// 但 429 和 503 的含义完全相反：503 是我方过载闸主动快速失败（预期行为），
// 429 是限流层在拦——真出现 429 说明分桶算错了，那是生产 bug。一个笼统的
// http_req_failed 把这两件事混成一个数，等于把最该查的信号丢掉了。
const err429 = new Counter('errors_429_rate_limited');
const err503 = new Counter('errors_503_overload');
const err5xxOther = new Counter('errors_5xx_other');
const err4xxOther = new Counter('errors_4xx_other');

const rate = Number(__ENV.RATE || 10);
const duration = __ENV.DURATION || '5m';
const maxVus = Number(__ENV.MAX_VUS || Math.max(100, rate * 4));
const baseUrl = (__ENV.BASE_URL || 'http://host.docker.internal:14080').replace(/\/+$/, '');
const runId = (__ENV.RUN_ID || `rate-${rate}`).replace(/[^a-zA-Z0-9_.-]/g, '-');

// 真实 HS256 JWT（loadtest/prepare.sh 生成）。上一轮直接发裸 `x-user-id: lt-user-0001`，
// 服务端 verifyUserToken() 走「非 JWT 形原样放行」分支，验签一次都没执行，而生产每个请求都要验。
// 挂载：-v "$PWD/loadtest/tokens.json:/scripts/tokens.json:ro"
const TOKENS = JSON.parse(open(__ENV.LT_TOKENS_FILE || '/scripts/tokens.json'));
if (!Array.isArray(TOKENS) || TOKENS.length === 0) {
  throw new Error('tokens.json 为空——先执行 bash loadtest/prepare.sh，并把它挂进 /scripts/tokens.json');
}
const userCount = Number(__ENV.LT_USERS || TOKENS.length);

export const options = {
  discardResponseBodies: true,
  scenarios: {
    readonly_api: {
      executor: 'constant-arrival-rate',
      rate,
      timeUnit: '1s',
      duration,
      preAllocatedVUs: Math.min(maxVus, Math.max(20, rate)),
      maxVUs: maxVus,
      gracefulStop: '10s',
    },
  },
  thresholds: {
    http_req_failed: [{ threshold: 'rate<0.01', abortOnFail: true, delayAbortEval: '30s' }],
    http_req_duration: ['p(95)<2000'],
  },
};

function pad4(n) {
  return String(n).padStart(4, '0');
}

function target() {
  const roll = Math.random() * 100;
  if (roll < 5) return { path: '/api/health', name: 'health', auth: false };
  if (roll < 15) return { path: '/api/agents', name: 'agents', auth: true };
  if (roll < 28) return { path: '/api/me', name: 'me', auth: true };
  if (roll < 48) return { path: '/api/sessions', name: 'sessions', auth: true };
  if (roll < 64) return { path: '/api/projects', name: 'projects', auth: true };
  if (roll < 79) return { path: '/api/knowledge', name: 'knowledge', auth: true };
  if (roll < 90) return { path: '/api/reports', name: 'reports', auth: true };
  return { path: '/api/library', name: 'library', auth: true };
}

export default function () {
  const endpoint = target();
  const userNo = ((__VU - 1) % userCount) + 1;
  // 合成 X-Forwarded-For：限流按「已登录按用户、未登录按 IP」分桶，匿名请求若全部同一个 IP
  // 就会挤进同一个桶，把限流层测成「一撞就 429」。每个 VU 一个稳定的假客户端 IP 才贴近真实。
  const xff = `203.0.113.${(userNo % 254) + 1}`;
  const headers = endpoint.auth
    ? {
      'x-user-id': TOKENS[(userNo - 1) % TOKENS.length],
      'x-forwarded-for': xff,
      'user-agent': `junshi-loadtest/${runId}`,
    }
    : { 'x-forwarded-for': xff, 'user-agent': `junshi-loadtest/${runId}` };
  const response = http.get(`${baseUrl}${endpoint.path}`, {
    headers,
    tags: { endpoint: endpoint.name, run_id: runId },
    timeout: '10s',
  });
  const tag = { endpoint: endpoint.name };
  if (response.status === 429) err429.add(1, tag);
  else if (response.status === 503) err503.add(1, tag);
  else if (response.status >= 500) err5xxOther.add(1, tag);
  else if (response.status >= 400) err4xxOther.add(1, tag);

  check(response, {
    'status is 200': (r) => r.status === 200,
  }, { endpoint: endpoint.name });
}

export function handleSummary(data) {
  const n = (name) => data.metrics[name]?.values?.count ?? 0;
  const total = data.metrics.http_reqs?.values?.count ?? 0;
  const pct = (v) => (total ? `${((v / total) * 100).toFixed(2)}%` : '0%');
  // 直接打在 stdout 上，省得每次回头翻 JSON。429 非 0 就要当成 bug 查，不是容量问题。
  const breakdown = [
    `run=${runId} rate=${rate}/s duration=${duration} 总请求=${total}`,
    `  429 限流   = ${n('errors_429_rate_limited')} (${pct(n('errors_429_rate_limited'))})  ← 非 0 说明限流分桶有问题`,
    `  503 过载闸 = ${n('errors_503_overload')} (${pct(n('errors_503_overload'))})  ← 预期的主动快速失败`,
    `  其它 5xx   = ${n('errors_5xx_other')} (${pct(n('errors_5xx_other'))})`,
    `  其它 4xx   = ${n('errors_4xx_other')} (${pct(n('errors_4xx_other'))})`,
    '',
  ].join('\n');
  return {
    [`/results/${runId}.json`]: JSON.stringify(data, null, 2),
    stdout: breakdown,
  };
}
