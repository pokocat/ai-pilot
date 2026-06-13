import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';

export function isoSecond(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export async function recordAudit(opts: {
  tenantId?: string | null;
  userId?: string | null;
  action: string;
  payload?: Prisma.InputJsonValue;
}) {
  await prisma.auditLog
    .create({
      data: {
        tenantId: opts.tenantId ?? undefined,
        userId: opts.userId ?? undefined,
        action: opts.action,
        payloadJson: opts.payload ?? undefined,
      },
    })
    .catch(() => {});
}

export function registerHttpAudit(app: FastifyInstance) {
  app.addHook('onResponse', async (req, reply) => {
    const url = req.url.split('?')[0] ?? req.url;
    if (!url.startsWith('/api/') || url.startsWith('/api/admin/') || url === '/api/health') return;

    const token = (req.headers['x-user-id'] as string | undefined)?.trim();
    if (!token) return;

    const user = await prisma.user.findUnique({ where: { id: token }, select: { id: true, tenantId: true } }).catch(() => null);
    if (!user) return;

    await recordAudit({
      tenantId: user.tenantId,
      userId: user.id,
      action: 'user.http',
      payload: {
        method: req.method,
        path: url,
        statusCode: reply.statusCode,
      },
    });
  });
}
