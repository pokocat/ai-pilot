import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { FastifyReply } from 'fastify';
import { api, cleanBusiness, closeApp, getApp, login, seedBaseline, uniquePhone } from './helpers.ts';
import { prisma } from '../src/db.ts';
import { enqueueDurableGeneration } from '../src/services/generationRequest.ts';
import {
  claimNextGenerationJob,
  finalizeGeneration,
  finishGenerationAttempt,
  GenerationLeaseLostError,
  generationView,
  requestGenerationCancel,
  startGenerationAttempt,
  writeGenerationSnapshot,
} from '../src/services/generationJobs.ts';
import { tickGenerationWorker } from '../src/services/generationWorker.ts';
import { durableGenerationBody } from '../src/routes/sessions.ts';
import { pipeGenerationSSE } from '../src/routes/generations.ts';

describe('GenerationJob durable lifecycle', () => {
  before(async () => {
    await getApp();
    await cleanBusiness();
    await seedBaseline();
  });
  after(async () => { await closeApp(); });

  test('production compatibility: legacy client without id is upgraded to a durable request', () => {
    process.env.TEST_DURABLE_LEGACY_GENERATION = '1';
    try {
      const first = durableGenerationBody({ text: '旧版客户端也不能因断连取消', agentKey: 'general' });
      const second = durableGenerationBody({ text: '旧版客户端也不能因断连取消', agentKey: 'general' });
      assert.match(first?.clientRequestId ?? '', /^legacy-[0-9a-f-]{36}$/);
      assert.notEqual(first?.clientRequestId, second?.clientRequestId, '服务端须为每笔旧请求生成独立 key');
    } finally {
      delete process.env.TEST_DURABLE_LEGACY_GENERATION;
    }
  });

  test('same clientRequestId attaches to one job and one user message; worker persists final reply', async () => {
    const phone = uniquePhone();
    await login(phone, '持久生成用户');
    const user = await prisma.user.findUniqueOrThrow({ where: { phone } });
    const body = {
      text: '帮我判断当前最重要的一件事',
      agentKey: 'general',
      clientRequestId: `generation-idem-${Date.now()}`,
    };
    const first = await enqueueDurableGeneration(user, body);
    const retry = await enqueueDurableGeneration(user, body);
    assert.equal(retry.job.id, first.job.id);
    assert.equal(retry.attached, true);
    assert.equal(await prisma.message.count({ where: { sessionId: first.session.id, role: 'user' } }), 1);

    const sessionWhileQueued = await prisma.session.findUniqueOrThrow({ where: { id: first.session.id }, include: { activeGeneration: true } });
    assert.equal(sessionWhileQueued.activeGeneration?.id, first.job.id);
    assert.equal(await tickGenerationWorker(), true);

    const done = await prisma.generationJob.findUniqueOrThrow({ where: { id: first.job.id } });
    assert.ok(['completed', 'truncated'].includes(done.status));
    assert.equal(done.quotaCharged, 0, '纯 mock/本地模板未发起 provider，不得虚扣用户额度');
    assert.ok(done.resultMessageId);
    assert.equal((await prisma.session.findUniqueOrThrow({ where: { id: first.session.id } })).activeGenerationId, null);
    assert.equal(await prisma.message.count({ where: { sessionId: first.session.id, role: 'assistant' } }), 1);
  });

  test('durable thought snapshots stream incrementally before the answer and survive terminal fallback', async () => {
    const phone = uniquePhone();
    await login(phone, '思路快照用户');
    const user = await prisma.user.findUniqueOrThrow({ where: { phone } });
    const created = await enqueueDurableGeneration(user, {
      text: '请先判断现金流风险，再给行动顺序',
      agentKey: 'general',
      clientRequestId: `generation-thought-${Date.now()}`,
    });
    const claimed = await claimNextGenerationJob('worker-thought', 15_000);
    assert.equal(claimed?.id, created.job.id);
    await writeGenerationSnapshot({
      jobId: created.job.id,
      workerId: 'worker-thought',
      leaseVersion: claimed!.leaseVersion,
      text: '',
      thoughtSummary: '\n先核对',
    });

    let body = '';
    const raw = new EventEmitter() as EventEmitter & {
      writableEnded: boolean;
      destroyed: boolean;
      write: (chunk: string) => boolean;
    };
    raw.writableEnded = false;
    raw.destroyed = false;
    raw.write = (chunk) => { body += chunk; return true; };
    const stream = pipeGenerationSSE({ raw } as unknown as FastifyReply, created.job.id, { compatibilityEvents: true });

    await new Promise((resolve) => setTimeout(resolve, 80));
    await writeGenerationSnapshot({
      jobId: created.job.id,
      workerId: 'worker-thought',
      leaseVersion: claimed!.leaseVersion,
      text: '结论：先守住现金流。',
      thoughtSummary: '\n先核对现金流\n',
    });
    await new Promise((resolve) => setTimeout(resolve, 420));
    await prisma.generationJob.update({
      where: { id: created.job.id },
      data: {
        status: 'completed',
        phase: 'finalize',
        replyJson: { text: '结论：先守住现金流。', thoughtSummary: '先核对现金流' },
        snapshotVersion: { increment: 1 },
        completedAt: new Date(),
      },
    });
    await stream;

    assert.match(body, /event: thought\ndata: \{"text":"先核对"\}/);
    assert.match(body, /event: thought\ndata: \{"text":"现金流"\}/, '后续快照只能补发新增思路，不能整段重复');
    assert.equal(body.match(/event: thought/g)?.length, 2, '终态 trim 不能导致完整摘要重复补发');
    assert.match(body, /event: token\ndata: \{"text":"结论：先守住现金流。","replace":false\}/);
    assert.match(body, /event: done/);
    const stored = await prisma.generationJob.findUniqueOrThrow({ where: { id: created.job.id } });
    assert.equal(stored.thoughtSummary, '\n先核对现金流\n');
  });

  test('queued explicit cancel is durable, idempotent and never starts provider', async () => {
    const phone = uniquePhone();
    await login(phone, '取消生成用户');
    const user = await prisma.user.findUniqueOrThrow({ where: { phone } });
    const created = await enqueueDurableGeneration(user, {
      text: '这一轮先别生成', agentKey: 'general', clientRequestId: `generation-cancel-${Date.now()}`,
    });
    const cancelled = await requestGenerationCancel(created.job.id, user);
    assert.equal(generationView(cancelled).status, 'cancelled');
    const again = await requestGenerationCancel(created.job.id, user);
    assert.equal(again.status, 'cancelled');
    assert.equal(await prisma.generationAttempt.count({ where: { jobId: created.job.id } }), 0);
    assert.equal((await prisma.session.findUniqueOrThrow({ where: { id: created.session.id } })).activeGenerationId, null);
  });

  test('context 阶段取消不重建上下文、不创建 attempt，确定 0 不标成估算', async () => {
    const phone = uniquePhone();
    await login(phone, '上下文取消用户');
    const user = await prisma.user.findUniqueOrThrow({ where: { phone } });
    const created = await enqueueDurableGeneration(user, {
      text: '还在梳理上下文时停止', agentKey: 'general', clientRequestId: `generation-context-cancel-${Date.now()}`,
    });
    const oldLease = await claimNextGenerationJob('worker-context-old', 15_000);
    assert.equal(oldLease?.id, created.job.id);
    await requestGenerationCancel(created.job.id, user);
    await prisma.generationJob.update({ where: { id: created.job.id }, data: { leaseExpiresAt: new Date(0) } });

    assert.equal(await tickGenerationWorker(), true);
    const done = await prisma.generationJob.findUniqueOrThrow({ where: { id: created.job.id } });
    assert.equal(done.status, 'cancelled');
    assert.equal(done.quotaCharged, 0);
    assert.equal(done.usageSource, 'provider', '无 attempt 是确定 0，不是 estimated/mixed');
    assert.equal(await prisma.generationAttempt.count({ where: { jobId: created.job.id } }), 0);
    assert.equal(done.contextFrozenAt, null, '取消任务不应再构建并冻结上下文');
  });

  test('same clientRequestId with different payload is rejected instead of attaching to the wrong answer', async () => {
    const phone = uniquePhone();
    await login(phone, '幂等冲突用户');
    const user = await prisma.user.findUniqueOrThrow({ where: { phone } });
    const clientRequestId = `generation-mismatch-${Date.now()}`;
    const first = await enqueueDurableGeneration(user, { text: '问题 A', agentKey: 'general', clientRequestId });
    await assert.rejects(
      enqueueDurableGeneration(user, { text: '问题 B', agentKey: 'general', clientRequestId }),
      (error: Error & { code?: string }) => error.code === 'GENERATION_IDEMPOTENCY_MISMATCH',
    );
    await requestGenerationCancel(first.job.id, user);
  });

  // 真机 2026-08-08：发送 → 点停止 → 再发送，用户看到的是「石沉大海」。
  // running 态的取消是软取消（只写 cancelRequestedAt，落终态要等 worker 那一拍），
  // 这段窗口里旧实现照旧抛 GENERATION_IN_PROGRESS，把用户已经明确放弃的那条回复变成路障。
  test('cancelled-but-not-yet-finalized generation must not block the next message', async () => {
    const phone = uniquePhone();
    await login(phone, '停止后重发用户');
    const user = await prisma.user.findUniqueOrThrow({ where: { phone } });
    const first = await enqueueDurableGeneration(user, {
      text: '这条我马上就会点停止',
      agentKey: 'general',
      clientRequestId: `generation-stop-${Date.now()}`,
    });
    // 进 running 后再取消 —— 这才会走软取消分支（queued 态取消是就地终结，不构成路障）。
    const claimed = await claimNextGenerationJob('worker-stop', 15_000);
    assert.equal(claimed?.id, first.job.id);
    const firstAttempt = await startGenerationAttempt(first.job.id, 'worker-stop', claimed!.leaseVersion, 'main');
    assert.ok(first.job.quotaReserved > 0, '回归场景需要旧任务真实占住一笔额度预留');
    // 模拟旧任务恰好占完当前可用额度：旧实现只写 cancelRequestedAt，不释放这笔预留，
    // 所以下一条消息会稳定 402，点「重新回答」也只会继续撞同一笔冻结额度。
    await prisma.tokenWallet.update({ where: { userId: user.id }, data: { balance: 0 } });
    const cancelling = await requestGenerationCancel(first.job.id, user);
    assert.ok(cancelling.cancelRequestedAt, '软取消必须留下 cancelRequestedAt');
    assert.ok(!['cancelled', 'completed', 'failed', 'truncated'].includes(cancelling.status), '这一步还没落终态');
    assert.equal(cancelling.quotaReserved, 0, '取消确认必须把未结算预留转回钱包，finalize 再按实际 usage 扣费');
    assert.equal(
      (await prisma.tokenWallet.findUniqueOrThrow({ where: { userId: user.id } })).balance,
      first.job.quotaReserved,
      '停止返回时额度必须已经可供下一轮使用',
    );

    // 关键断言：此时重发既不得被 409 挡回，也不得因旧预留仍冻结而 402。
    const second = await enqueueDurableGeneration(user, {
      text: '停完马上换个问法再问一次',
      agentKey: 'general',
      sessionId: first.session.id,
      clientRequestId: `generation-resend-${Date.now()}`,
    });
    assert.notEqual(second.job.id, first.job.id);
    const session = await prisma.session.findUniqueOrThrow({ where: { id: first.session.id } });
    assert.equal(session.activeGenerationId, second.job.id, '会话的在途任务必须让位给新消息');
    await requestGenerationCancel(second.job.id, user);

    // 提前释放不是免单：旧任务最终拿到 provider usage 后，仍要从钱包扣掉真实消耗。
    const balanceBeforeFinalize = (await prisma.tokenWallet.findUniqueOrThrow({ where: { userId: user.id } })).balance;
    await finishGenerationAttempt({
      jobId: first.job.id,
      attemptNo: firstAttempt,
      leaseVersion: claimed!.leaseVersion,
      status: 'cancelled',
      usage: { inputTokens: 11, outputTokens: 7, cachedInput: 0, billableTokens: 18 },
      usageSource: 'provider',
      provider: 'openai',
      model: 'test-model',
      terminationReason: 'user_cancelled',
    });
    const finalized = await finalizeGeneration({
      jobId: first.job.id,
      workerId: 'worker-stop',
      leaseVersion: claimed!.leaseVersion,
      status: 'cancelled',
      terminationReason: 'user_cancelled',
    });
    assert.ok(finalized.quotaCharged > 0);
    assert.equal(
      (await prisma.tokenWallet.findUniqueOrThrow({ where: { userId: user.id } })).balance,
      balanceBeforeFinalize - finalized.quotaCharged,
      '旧任务提前释放预留后，最终真实消耗仍必须入账',
    );
  });

  test('expired lease is reclaimed, old attempt is conservatively billed and stale worker is fenced out', async () => {
    const phone = uniquePhone();
    await login(phone, '租约接管用户');
    const user = await prisma.user.findUniqueOrThrow({ where: { phone } });
    const created = await enqueueDurableGeneration(user, {
      text: '请分析这个需要跨进程恢复的问题',
      agentKey: 'general',
      clientRequestId: `generation-reclaim-${Date.now()}`,
    });
    const firstLease = await claimNextGenerationJob('worker-old', 15_000);
    assert.equal(firstLease?.id, created.job.id);
    const firstAttempt = await startGenerationAttempt(created.job.id, 'worker-old', firstLease!.leaseVersion, 'main');
    await prisma.generationJob.update({
      where: { id: created.job.id },
      data: {
        partialText: '旧进程已经从上游收到的部分正文',
        contextJson: { ctx: { systemPrompt: '一段已冻结的上下文' } },
        leaseExpiresAt: new Date(0),
      },
    });

    const secondLease = await claimNextGenerationJob('worker-new', 15_000);
    assert.equal(secondLease?.id, created.job.id);
    assert.equal(secondLease!.leaseVersion, firstLease!.leaseVersion + 1);
    const closedOldAttempt = await prisma.generationAttempt.findUniqueOrThrow({
      where: { jobId_attemptNo: { jobId: created.job.id, attemptNo: firstAttempt } },
    });
    assert.equal(closedOldAttempt.status, 'failed');
    assert.equal(closedOldAttempt.usageSource, 'estimated');
    assert.equal(closedOldAttempt.terminationReason, 'process_recovered');
    assert.ok(Number((closedOldAttempt.usageJson as { billableTokens?: number }).billableTokens) > 0);

    await assert.rejects(
      finishGenerationAttempt({
        jobId: created.job.id,
        attemptNo: firstAttempt,
        leaseVersion: firstLease!.leaseVersion,
        status: 'completed',
        usage: { inputTokens: 1, outputTokens: 1, cachedInput: 0, billableTokens: 2 },
        usageSource: 'provider',
      }),
      GenerationLeaseLostError,
    );

    const secondAttempt = await startGenerationAttempt(created.job.id, 'worker-new', secondLease!.leaseVersion, 'main');
    await finishGenerationAttempt({
      jobId: created.job.id,
      attemptNo: secondAttempt,
      leaseVersion: secondLease!.leaseVersion,
      status: 'completed',
      usage: { inputTokens: 11, outputTokens: 7, cachedInput: 0, billableTokens: 18 },
      usageSource: 'provider',
      provider: 'openai',
      model: 'test-model',
    });
    await writeGenerationSnapshot({
      jobId: created.job.id,
      workerId: 'worker-new',
      leaseVersion: secondLease!.leaseVersion,
      text: '新进程完成的回复',
    });
    const done = await finalizeGeneration({
      jobId: created.job.id,
      workerId: 'worker-new',
      leaseVersion: secondLease!.leaseVersion,
      status: 'completed',
      effectKeys: ['title'],
    });
    assert.equal(done.status, 'completed');
    assert.equal(done.usageSource, 'mixed');
    assert.ok(done.quotaCharged > 18, '新旧两次真实外呼的消耗都必须进结算');
    assert.equal(
      await prisma.generationEffect.count({ where: { jobId: created.job.id, effectKey: 'title' } }),
      1,
      '终态与副作用 outbox 必须同事务落库',
    );
  });

  test('finalize 阶段重启只恢复推荐项与终态，不重跑已经落库的主生成', async () => {
    const phone = uniquePhone();
    await login(phone, '收尾恢复用户');
    const user = await prisma.user.findUniqueOrThrow({ where: { phone } });
    const created = await enqueueDurableGeneration(user, {
      text: '主回复已经生成，请只恢复收尾',
      agentKey: 'general',
      clientRequestId: `generation-finalize-reclaim-${Date.now()}`,
    });
    const oldLease = await claimNextGenerationJob('worker-finalize-old', 15_000);
    assert.equal(oldLease?.id, created.job.id);
    const mainAttempt = await startGenerationAttempt(created.job.id, 'worker-finalize-old', oldLease!.leaseVersion, 'main');
    await finishGenerationAttempt({
      jobId: created.job.id,
      attemptNo: mainAttempt,
      leaseVersion: oldLease!.leaseVersion,
      status: 'completed',
      usage: { inputTokens: 10, outputTokens: 5, cachedInput: 0, billableTokens: 15 },
      usageSource: 'provider',
      provider: 'openai',
      model: 'test-model',
    });
    const storedReply = {
      text: '这是已经交付给用户的权威正文。',
      asks: [{ q: '下一步先做什么？', options: ['核对目标', '开始执行'] }],
    };
    const resultMessage = await prisma.message.create({
      data: { sessionId: created.session.id, role: 'assistant', contentJson: storedReply },
    });
    await prisma.generationJob.update({
      where: { id: created.job.id },
      data: {
        phase: 'finalize',
        resultMessageId: resultMessage.id,
        replyJson: storedReply,
        partialText: storedReply.text,
        contextFrozenAt: new Date(),
        contextJson: {
          ctx: {
            agentKey: 'general', agentName: '总军师', systemPrompt: '测试上下文', deliverableKey: null,
            profile: null, memories: [], benmingColor: '玄青', benchmark: '', userMessage: '主回复已经生成，请只恢复收尾',
            tenantId: user.tenantId, userId: user.id,
          },
          memoryConfig: {}, knowledgeUsed: [], refNotices: [],
        },
        leaseExpiresAt: new Date(0),
      },
    });

    assert.equal(await tickGenerationWorker(), true);
    const done = await prisma.generationJob.findUniqueOrThrow({ where: { id: created.job.id } });
    assert.equal(done.status, 'completed');
    assert.equal(
      await prisma.generationAttempt.count({ where: { jobId: created.job.id, kind: 'main' } }),
      1,
      '接管者不得为同一正文再创建 main attempt',
    );
    assert.equal(
      (await prisma.message.findUniqueOrThrow({ where: { id: resultMessage.id } }).then((m) => m.contentJson) as { text?: string }).text,
      storedReply.text,
      '接管不能改写用户已看到的正文',
    );
  });

  test('session list exposes generation phase and active session cannot be deleted', async () => {
    const phone = uniquePhone();
    const token = await login(phone, '生成状态用户');
    const user = await prisma.user.findUniqueOrThrow({ where: { phone } });
    const created = await enqueueDurableGeneration(user, {
      text: '稍后回到小程序继续看',
      agentKey: 'general',
      clientRequestId: `generation-list-${Date.now()}`,
    });
    const list = await api<{ id: string; snippet: string; activeGeneration?: { id: string } }[]>('GET', '/api/sessions', { token });
    assert.equal(list.status, 200);
    const item = list.body.find((row) => row.id === created.session.id)!;
    assert.equal(item.snippet, '已排队，等军师接手…');
    assert.equal(item.activeGeneration?.id, created.job.id);

    const blocked = await api('DELETE', `/api/sessions/${created.session.id}`, { token });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.code, 'GENERATION_IN_PROGRESS');
    assert.equal(blocked.body.generationId, created.job.id);

    await requestGenerationCancel(created.job.id, user);
    const deleted = await api('DELETE', `/api/sessions/${created.session.id}`, { token });
    assert.equal(deleted.status, 200);
  });
});
