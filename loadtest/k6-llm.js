import http from 'k6/http';
import exec from 'k6/execution';
import { check } from 'k6';
import { Counter, Rate } from 'k6/metrics';

const concurrency = Number(__ENV.CONCURRENCY || 1);
const iterationsPerVu = Number(__ENV.ITERATIONS_PER_VU || 4);
const provider = (__ENV.LLM_PROVIDER || 'claude').toLowerCase();
const baseUrl = (__ENV.LLM_BASE_URL || '').replace(/\/+$/, '').replace(/\/v1\/messages$/, '');
const model = __ENV.LLM_MODEL || '';
const apiKey = __ENV.LLM_API_KEY || '';
const runId = __ENV.RUN_ID || `llm-c${concurrency}`;
const perResponseTokenGuard = Number(__ENV.PER_RESPONSE_TOKEN_GUARD || 200);

if (!baseUrl || !model || !apiKey) {
  throw new Error('LLM_BASE_URL / LLM_MODEL / LLM_API_KEY must be set');
}

const inputTokens = new Counter('llm_input_tokens');
const outputTokens = new Counter('llm_output_tokens');
const totalTokens = new Counter('llm_total_tokens');
const providerErrors = new Rate('llm_provider_errors');
const status429 = new Counter('llm_status_429');
const status5xx = new Counter('llm_status_5xx');
const statusOtherError = new Counter('llm_status_other_error');

export const options = {
  scenarios: {
    llm_probe: {
      executor: 'shared-iterations',
      vus: concurrency,
      iterations: concurrency * iterationsPerVu,
      maxDuration: '3m',
    },
  },
  thresholds: {
    llm_provider_errors: [{ threshold: 'rate<0.01', abortOnFail: true, delayAbortEval: '5s' }],
    http_req_duration: ['p(95)<60000'],
  },
};

function request() {
  if (provider === 'claude') {
    return http.post(`${baseUrl}/v1/messages`, JSON.stringify({
      model,
      max_tokens: 1,
      temperature: 0,
      messages: [{ role: 'user', content: '1' }],
    }), {
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': apiKey,
        Authorization: `Bearer ${apiKey}`,
      },
      timeout: '60s',
    });
  }

  return http.post(`${baseUrl}/chat/completions`, JSON.stringify({
    model,
    max_tokens: 1,
    temperature: 0,
    messages: [{ role: 'user', content: '1' }],
  }), {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    timeout: '60s',
  });
}

export default function () {
  const res = request();
  let body = {};
  try {
    body = res.json();
  } catch {
    body = {};
  }

  const usage = body.usage || {};
  const input = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0);
  const output = Number(usage.output_tokens ?? usage.completion_tokens ?? 0);
  const total = Number(usage.total_tokens ?? (input + output));
  inputTokens.add(input);
  outputTokens.add(output);
  totalTokens.add(total);

  if (res.status === 429) status429.add(1);
  else if (res.status >= 500) status5xx.add(1);
  else if (res.status < 200 || res.status >= 300) statusOtherError.add(1);

  const ok = check(res, {
    'provider returned 2xx': (r) => r.status >= 200 && r.status < 300,
    'usage stayed within per-response guard': () => total <= perResponseTokenGuard,
  });
  providerErrors.add(!ok);

  if (total > perResponseTokenGuard) {
    exec.test.abort(`token guard crossed: response used ${total} tokens`);
  }
}

export function handleSummary(data) {
  return {
    stdout: `run=${runId} provider=${provider} model=${model} concurrency=${concurrency}\n`,
    [`/results/${runId}.json`]: JSON.stringify(data, null, 2),
  };
}
