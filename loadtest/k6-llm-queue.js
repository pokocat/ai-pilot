import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import { SharedArray } from 'k6/data';

// 只打隔离 API 的 mock 生成路径。配 AI_MOCK_LATENCY_MS 后该路径会真实占用 llmGate 槽位，
// 可验证并发、排队超时和 429 冷却，且不会调用外部模型或消耗 token。
const baseUrl = (__ENV.BASE_URL || 'http://gateway:8080').replace(/\/+$/, '');
const vus = Number(__ENV.VUS || 8);
const iterations = Number(__ENV.ITERATIONS || vus);
const allowInjectedFailure = __ENV.ALLOW_INJECTED_FAILURE === '1';
const runId = (__ENV.RUN_ID || `llm-queue-v${vus}`).replace(/[^a-zA-Z0-9_.-]/g, '-');
const TOKENS = new SharedArray('loadtest tokens', () => JSON.parse(open(__ENV.LT_TOKENS_FILE || '/scripts/tokens.json')));

if (!Array.isArray(TOKENS) || TOKENS.length === 0) throw new Error('tokens.json 为空');

const success = new Counter('llm_queue_success');
const busy = new Counter('llm_queue_ai_busy');
const unexpected = new Counter('llm_queue_unexpected');

export const options = {
  scenarios: {
    burst: {
      executor: 'shared-iterations',
      vus,
      iterations,
      maxDuration: __ENV.MAX_DURATION || '90s',
      gracefulStop: '5s',
    },
  },
  thresholds: {
    llm_queue_unexpected: ['count==0'],
  },
};

export default function () {
  const token = TOKENS[(__VU - 1) % TOKENS.length];
  const response = http.post(`${baseUrl}/api/generate-sync`, JSON.stringify({
    agentKey: 'general',
    text: `LLM 闸门隔离压测 ${runId}，只验证排队与冷却。`,
  }), {
    headers: {
      'content-type': 'application/json',
      'x-user-id': token,
      'x-forwarded-for': `203.0.113.${(__VU % 254) + 1}`,
      'user-agent': `junshi-loadtest/${runId}`,
    },
    tags: { run_id: runId, scenario: 'llm_queue' },
    timeout: '60s',
  });

  const isBusy = response.status === 503;
  if (response.status >= 200 && response.status < 300) success.add(1);
  else if (isBusy || (allowInjectedFailure && (response.status === 429 || (response.status >= 500 && response.status < 600)))) busy.add(1);
  else unexpected.add(1);
  check(response, {
    'generation completed or expected injected failure': (r) =>
      (r.status >= 200 && r.status < 300) || r.status === 503 ||
      (allowInjectedFailure && (r.status === 429 || (r.status >= 500 && r.status < 600))),
  });
}

export function handleSummary(data) {
  return {
    [`/results/${runId}.json`]: JSON.stringify(data, null, 2),
    stdout: `run=${runId} vus=${vus} iterations=${iterations}\n`,
  };
}
