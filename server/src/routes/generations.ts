import type { FastifyInstance, FastifyReply } from 'fastify';
import type { GenerationView } from '../../../shared/contracts';
import { resolveUser } from '../services/context.js';
import {
  GenerationJobError,
  generationView,
  getGenerationForUser,
  requestGenerationCancel,
} from '../services/generationJobs.js';
import { prisma } from '../db.js';

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
  let previousText = '';
  reply.raw.on('close', () => { closed = true; });
  while (!closed && !reply.raw.writableEnded && !reply.raw.destroyed) {
    const row = await prisma.generationJob.findUnique({ where: { id: generationId } });
    if (!row) {
      send(reply, 'error', { code: 'GENERATION_NOT_FOUND', message: '生成任务不存在' });
      break;
    }
    const view = generationView(row);
    if (view.snapshotVersion > lastVersion || TERMINAL.has(view.status)) {
      send(reply, 'snapshot', view);
      if (opts.compatibilityEvents) {
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
      return generationView(await getGenerationForUser(req.params.id, user));
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
}
