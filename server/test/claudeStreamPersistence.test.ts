import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, closeApp, cleanBusiness, seedBaseline, login, uniquePhone } from './helpers.js';
import { prisma } from '../src/db.js';
import { env } from '../src/env.js';
import { configurePurpose, __wipeAiV2 } from '../src/services/aiV2Admin.js';
import { __setClaudeFetchForTest } from '../src/llm/providers/claude.js';
import { enqueueDurableGeneration } from '../src/services/generationRequest.js';
import { tickGenerationWorker } from '../src/services/generationWorker.js';
import type { LlmContextTrace } from '../../shared/contracts';

const savedFallback = env.aiFallbackMock;
const savedReal = process.env.AI_ALLOW_REAL_PROVIDER;

function response(initial: string, stop: boolean): Response {
  const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  let body = ev('message_start', { message: { id: 'msg_persistence', type: 'message', role: 'assistant', model: 'claude-stream-persistence', content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 12000, output_tokens: 0, cache_read_input_tokens: 2000, cache_creation_input_tokens: 1000 } } });
  body += ev('content_block_start', { index: 0, content_block: { type: 'text', text: initial } });
  body += ev('content_block_stop', { index: 0 });
  body += ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 357 } });
  if (stop) body += ev('message_stop', {});
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', 'x-request-id': 'stream-persistence-request' } });
}

describe('Claude 流异常贯穿 trace / usage / durable job', () => {
  before(async () => {
    process.env.AI_ALLOW_REAL_PROVIDER = '1';
    env.aiFallbackMock = false;
    await getApp();
    await __wipeAiV2();
    await configurePurpose('chat', { label: '流式回归', provider: 'claude', baseUrl: 'https://offline.invalid', model: 'claude-stream-persistence', apiKey: 'sk-stream-test-only' });
  });
  beforeEach(async () => { await cleanBusiness(); await seedBaseline(); });
  after(async () => {
    __setClaudeFetchForTest(null);
    env.aiFallbackMock = savedFallback;
    if (savedReal === undefined) delete process.env.AI_ALLOW_REAL_PROVIDER;
    else process.env.AI_ALLOW_REAL_PROVIDER = savedReal;
    await __wipeAiV2();
    await closeApp();
  });

  for (const [name, text, stop, status] of [
    ['空正文', '', true, 'failed'],
    ['无结束标记且无正文', '', false, 'failed'],
    ['初始正文无结束标记', '已获得的部分判断', false, 'truncated'],
  ] as const) {
    test(`${name}：诊断和实际失败用量落库，Worker 不丢输出计数`, async () => {
      let calls = 0;
      __setClaudeFetchForTest(async (_url, init) => {
        const request = JSON.parse(String(init?.body ?? '{}'));
        if (!request.stream) {
          return Response.json({ id: 'msg_aux', type: 'message', role: 'assistant', model: 'claude-stream-persistence',
            content: [{ type: 'text', text: '{"asks":[],"facts":[],"items":[],"title":"回归"}' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } });
        }
        calls++;
        return response(text, stop);
      });
      const phone = uniquePhone();
      await login(phone, '流式诊断回归');
      const user = await prisma.user.findUniqueOrThrow({ where: { phone } });
      await prisma.profile.create({ data: { tenantId: user.tenantId, industry: '企业服务' } });
      const created = await enqueueDurableGeneration(user, { agentKey: 'general', text: '请简短说明毛利。', clientRequestId: `stream-diag-${Date.now()}` });
      assert.equal(await tickGenerationWorker(), true);
      const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: created.job.id }, include: { attempts: true } });
      assert.equal(job.status, status);
      assert.equal(calls, 1, '异常流不能隐式重新调用供应商');
      const trace = await prisma.llmTrace.findFirstOrThrow({ where: { sessionId: created.session.id, kind: 'chat' } });
      assert.equal(trace.outputTokens, 357);
      assert.equal(trace.inputTokens, 15000);
      assert.equal(trace.cachedInput, 2000);
      assert.equal(trace.cacheWrite, 1000);
      assert.equal(trace.upstreamIds, 'stream-persistence-request');
      const diagnostics = (trace.contextJson as unknown as LlmContextTrace).streamDiagnostics!;
      assert.equal(diagnostics[0].messageStop, stop);
      assert.equal(diagnostics[0].textChars, text.length);
      assert.equal(diagnostics[0].errorCode, stop ? 'AI_EMPTY_RESPONSE' : 'AI_STREAM_INCOMPLETE');
      const rows = await prisma.tokenUsage.findMany({ where: { sessionId: created.session.id, kind: 'chat' } });
      assert.equal(rows.length, 1, '流水只记一次，不能漏掉失败调用或重复记账');
      assert.equal(rows[0].outputTokens, 357);
      const attempt = job.attempts.find(x => x.kind === 'main');
      assert.equal((attempt?.usageJson as { outputTokens: number }).outputTokens, 357);
      assert.notEqual(attempt?.usageSource, 'estimated', '已报告用量不能因错误包装丢失而全部估算');
      assert.ok(job.quotaCharged > 0);
      if (text) {
        assert.equal(job.partialText, text);
        assert.ok(job.resultMessageId);
        assert.equal((job.replyJson as { truncated: boolean }).truncated, true);
      } else {
        assert.equal(trace.status, 'error');
        assert.equal(job.resultMessageId, null);
      }
    });
  }
});
