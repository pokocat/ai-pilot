import http from 'k6/http';
import { check } from 'k6';

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
  check(response, {
    'status is 200': (r) => r.status === 200,
  }, { endpoint: endpoint.name });
}

export function handleSummary(data) {
  return {
    [`/results/${runId}.json`]: JSON.stringify(data, null, 2),
    stdout: `run=${runId} rate=${rate}/s duration=${duration}\n`,
  };
}
