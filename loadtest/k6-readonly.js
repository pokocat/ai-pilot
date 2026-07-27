import http from 'k6/http';
import { check } from 'k6';

const rate = Number(__ENV.RATE || 10);
const duration = __ENV.DURATION || '5m';
const maxVus = Number(__ENV.MAX_VUS || Math.max(100, rate * 4));
const baseUrl = (__ENV.BASE_URL || 'http://host.docker.internal:14080').replace(/\/+$/, '');
const userCount = Number(__ENV.LT_USERS || 1000);
const runId = (__ENV.RUN_ID || `rate-${rate}`).replace(/[^a-zA-Z0-9_.-]/g, '-');

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
  const headers = endpoint.auth
    ? { 'x-user-id': `lt-user-${pad4(userNo)}`, 'user-agent': `junshi-loadtest/${runId}` }
    : { 'user-agent': `junshi-loadtest/${runId}` };
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
