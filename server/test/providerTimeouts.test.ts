import test from 'node:test';
import assert from 'node:assert/strict';
import { DELIVERABLE_TIMEOUT_MS, deliverableTimeoutMs } from '../src/llm/providerTimeouts.js';

test('成果/报告上游等待至少 300 秒，且更高的运营配置仍生效', () => {
  assert.equal(DELIVERABLE_TIMEOUT_MS, 300_000);
  assert.equal(deliverableTimeoutMs(60_000), 300_000);
  assert.equal(deliverableTimeoutMs(420_000), 420_000);
});
