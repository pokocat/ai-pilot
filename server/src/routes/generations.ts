import type { FastifyInstance, FastifyReply } from 'fastify';
import type { GenerationView } from '../../../shared/contracts';
import { resolveUser } from '../services/context.js';
import {
  countQueuedAhead,
  GenerationJobError,
  generationView,
  getGenerationForUser,
  requestGenerationCancel,
} from '../services/generationJobs.js';
import { prisma } from '../db.js';
import { enqueueNextDeliveryStage } from '../services/generationRequest.js';

const TERMINAL = new Set(['completed', 'truncated', 'failed', 'cancelled']);
const POLL_MS = 350;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function setupGenerationSSE(reply: FastifyReply): void {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no',
  });
}

function send(reply: FastifyReply, event: string, data: unknown): void {
  if (reply.raw.writableEnded || reply.raw.destroyed) return;
  try { reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* subscriber already gone */ }
}

/** DB 权威全文快照订阅。连接关闭只退出这个循环，不写 cancel、不碰 worker。 */
export async function pipeGenerationSSE(
  reply: FastifyReply,
  generationId: string,
  opts: { after?: number; compatibilityEvents?: boolean } = {},
): Promise<void> {
  let closed = false;
  let lastVersion = Math.max(-1, opts.after ?? -1);
  let lastAhead: number | null = null;
  let lastStatus = '';
  let lastPhase = '';
  let pollTick = 0;
  let previousText = '';
  let previousThought = '';
  reply.raw.on('close', () => { closed = true; });
  while (!closed && !reply.raw.writableEnded && !reply.raw.destroyed) {
    const row = await prisma.generationJob.findUnique({ where: { id: generationId } });
    if (!row) {
      send(reply, 'error', { code: 'GENERATION_NOT_FOUND', message: '生成任务不存在' });
      break;
    }
    let view = generationView(row);
    // 排队期间 worker 还没接手，snapshotVersion 一动不动；而位次前进是用户此刻唯一能看到的进展。
    // 所以推送条件必须把「ahead 变了」也算上，否则「前面还有 N 位」会一直停在首帧的初值。
    // 位次 COUNT 每 4 拍（约 1.4s）才刷一次：它以「位」为粒度前进，350ms 刷新只是给数据库加压，
    // 排队订阅一多就是 O(队列长 × 订阅数) 的乘法。
    let ahead: number | null = null;
    if (row.status === 'queued') {
      ahead = pollTick % 4 === 0 || lastAhead == null ? await countQueuedAhead(row) : lastAhead;
      view = { ...view, queue: { ahead } };
    }
    pollTick++;
    // status/phase 变化必须独立触发推送：claim 把 queued→running 时**不递增 snapshotVersion**，
    // 只看版本的话「排队中·前面还有 N 位」会一直挂到首个 token 快照才消失。
    const stateChanged = row.status !== lastStatus || row.phase !== lastPhase;
    if (view.snapshotVersion > lastVersion || TERMINAL.has(view.status) || (ahead != null && ahead !== lastAhead) || stateChanged) {
      send(reply, 'snapshot', view);
      lastAhead = ahead;
      lastStatus = row.status;
      lastPhase = row.phase;
      if (opts.compatibilityEvents) {
        // 增量 parser 会暂时保留标签内首尾换行，最终 ChatReply 会 trim；比较前统一规范化，
        // 否则终态快照会因空白差异被误判为整段替换，再把完整摘要重复发一次。
        const thought = (view.thoughtSummary || '').trim();
        const thoughtDelta = thought.startsWith(previousThought) ? thought.slice(previousThought.length) : thought;
        if (thoughtDelta) send(reply, 'thought', { text: thoughtDelta });
        previousThought = thought;
        const text = view.partialText || '';
        const delta = text.startsWith(previousText) ? text.slice(previousText.length) : text;
        if (delta) send(reply, 'token', { text: delta, replace: !text.startsWith(previousText) });
        previousText = text;
      }
      lastVersion = view.snapshotVersion;
    }
    if (TERMINAL.has(view.status)) {
      if (opts.compatibilityEvents) {
        if (view.reply) send(reply, 'chat', view.reply);
        if (view.deliverable) {
          send(reply, 'begin', { title: view.deliverable.title, icon: view.deliverable.icon, meta: view.deliverable.meta });
          view.deliverable.sections.forEach((section, index) => send(reply, 'section', { index, ...section }));
          send(reply, 'footer', { trust: view.deliverable.trust, actions: view.deliverable.actions });
        }
      }
      if (view.status === 'failed') send(reply, 'error', { code: view.terminationReason ?? 'GENERATION_FAILED', message: '军师暂时没能完成这次回答，请稍后重试。' });
      send(reply, 'done', { generationId: view.id, messageId: view.resultMessageId, status: view.status, snapshotVersion: view.snapshotVersion });
      break;
    }
    await sleep(POLL_MS);
  }
}

function publicError(error: unknown): { statusCode: number; body: { error: string; code: string; generationId?: string } } {
  if (error instanceof GenerationJobError) {
    return { statusCode: error.statusCode, body: { error: error.message, code: error.code, ...(error.generationId ? { generationId: error.generationId } : {}) } };
  }
  const e = error as Error & { statusCode?: number; code?: string };
  return { statusCode: e.statusCode ?? 500, body: { error: e.message || '生成任务处理失败', code: e.code ?? 'INTERNAL' } };
}

export async function generationRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>('/generations/:id', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    try {
      const job = await getGenerationForUser(req.params.id, user);
      const view = generationView(job);
      // 断连重连/冷启动恢复走的是这个 GET，排位必须在这里也能拿到，不能只靠 SSE 推。
      if (job.status === 'queued') return { ...view, queue: { ahead: await countQueuedAhead(job) } };
      return view;
    } catch (error) {
      const out = publicError(error);
      return reply.code(out.statusCode).send(out.body);
    }
  });

  app.get<{ Params: { id: string }; Querystring: { after?: string } }>('/generations/:id/stream', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    try {
      await getGenerationForUser(req.params.id, user);
    } catch (error) {
      const out = publicError(error);
      return reply.code(out.statusCode).send(out.body);
    }
    setupGenerationSSE(reply);
    await pipeGenerationSSE(reply, req.params.id, { after: Number(req.query.after ?? -1) || -1 });
    if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.end();
  });

  app.post<{ Params: { id: string } }>('/generations/:id/cancel', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    try {
      return generationView(await requestGenerationCancel(req.params.id, user));
    } catch (error) {
      const out = publicError(error);
      return reply.code(out.statusCode).send(out.body);
    }
  });

  app.post<{ Params: { id: string } }>('/generations/:id/next-stage', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    try {
      const created = await enqueueNextDeliveryStage(user, req.params.id);
      const view = generationView(created.job);
      const statusCode = TERMINAL.has(view.status) ? 200 : 202;
      return reply.code(statusCode).send({
        sessionId: created.job.sessionId,
        created: false,
        agentKey: created.agentKey,
        kind: created.kind,
        generationId: created.job.id,
        status: view.status,
        snapshotVersion: view.snapshotVersion,
        messageId: view.resultMessageId ?? undefined,
        ...(view.reply ? { reply: view.reply } : {}),
        ...(view.deliverable ? { deliverable: view.deliverable } : {}),
      });
    } catch (error) {
      const out = publicError(error);
      return reply.code(out.statusCode).send(out.body);
    }
  });
}
