import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

// 确定性验证全局匿名 IP 限流。测试前把 LT_RATE_LIMIT_MAX 调低（如 5），并清空隔离 Redis，
// 以避免前一轮的计数影响精确断言。该脚本只访问公开只读 /api/agents。
const baseUrl = (__ENV.BASE_URL || 'http://gateway:8080').replace(/\/+$/, '');
const mode = __ENV.MODE || 'single'; // single: 同 IP 应精确 429；multi: 多 IP 不应互相影响
const limit = Number(__ENV.LIMIT || 5);
const requests = Number(__ENV.REQUESTS || (mode === 'single' ? limit + 3 : 20));
const runId = (__ENV.RUN_ID || `rate-limit-${mode}`).replace(/[^a-zA-Z0-9_.-]/g, '-');

const allowed = new Counter('rate_limit_allowed');
const limited = new Counter('rate_limit_429');
const unexpected = new Counter('rate_limit_unexpected');

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {
    rate_limit_unexpected: ['count==0'],
  },
};

export default function () {
  let allowedCount = 0;
  let limitedCount = 0;
  let unexpectedCount = 0;

  for (let i = 0; i < requests; i += 1) {
    const ip = mode === 'multi' ? `203.0.113.${i + 1}` : '203.0.113.10';
    const response = http.get(`${baseUrl}/api/agents`, {
      headers: { 'x-forwarded-for': ip, 'user-agent': `junshi-loadtest/${runId}` },
      tags: { run_id: runId, mode },
    });

    if (response.status === 200) { allowed.add(1); allowedCount += 1; }
    else if (response.status === 429) { limited.add(1); limitedCount += 1; }
    else { unexpected.add(1); unexpectedCount += 1; }
  }

  const expectedAllowed = mode === 'multi' ? requests : Math.min(limit, requests);
  const expectedLimited = mode === 'multi' ? 0 : Math.max(0, requests - limit);
  const exact = allowedCount === expectedAllowed && limitedCount === expectedLimited && unexpectedCount === 0;
  check({ exact }, {
    'rate-limit result is exact': (result) => result.exact,
  }, { mode, expected_allowed: String(expectedAllowed), expected_429: String(expectedLimited) });
}

export function handleSummary(data) {
  return {
    [`/results/${runId}.json`]: JSON.stringify(data, null, 2),
    stdout: `run=${runId} mode=${mode} requests=${requests} limit=${limit}\n`,
  };
}
