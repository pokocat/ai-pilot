import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { verifyUserToken } from './userToken.js';

export function isoSecond(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

type AuditJsonObject = { [key: string]: Prisma.InputJsonValue | null };

const requestStart = new WeakMap<FastifyRequest, number>();
const SENSITIVE_KEY = /(^code$|password|passwd|pwd|^token$|[-_]token$|authToken|accessToken|refreshToken|authorization|cookie|secret|api.?key|session.?key|phoneCode|loginCode|smsCode|verifyCode|verificationCode|captcha)$/i;
const PHONE_KEY = /(phone|mobile|tel)$/i;
const MAX_STRING = 360;
const MAX_KEYS = 40;
const MAX_ARRAY = 20;
const MAX_DEPTH = 4;

function headerText(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string').join(', ');
  return null;
}

export function maskAuditPhone(phone?: string | null): string | null {
  if (!phone) return null;
  if (phone.startsWith('wx_')) return '微信账号';
  if (/^1\d{10}$/.test(phone)) return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
  if (phone.length > 8) return `${phone.slice(0, 3)}***${phone.slice(-3)}`;
  return phone;
}

function truncateText(text: string, max = MAX_STRING): string {
  return text.length > max ? `${text.slice(0, max)}...(${text.length} chars)` : text;
}

export function summarizeForAudit(value: unknown, depth = 0, key = ''): Prisma.InputJsonValue | null {
  if (value === undefined || value === null) return null;
  if (SENSITIVE_KEY.test(key)) return '[redacted]';
  if (PHONE_KEY.test(key) && typeof value === 'string') return maskAuditPhone(value);
  if (typeof value === 'string') return truncateText(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'boolean') return value;
  if (value instanceof Date) return isoSecond(value);
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return `[buffer ${value.length} bytes]`;
  if (depth >= MAX_DEPTH) return '[max-depth]';
  if (Array.isArray(value)) {
    const arr = value.slice(0, MAX_ARRAY).map((item) => summarizeForAudit(item, depth + 1));
    if (value.length > MAX_ARRAY) arr.push(`...(${value.length - MAX_ARRAY} more)`);
    return arr;
  }
  if (typeof value === 'object') {
    const out: AuditJsonObject = {};
    const entries = Object.entries(value as Record<string, unknown>).slice(0, MAX_KEYS);
    for (const [k, v] of entries) out[k] = summarizeForAudit(v, depth + 1, k);
    const total = Object.keys(value as Record<string, unknown>).length;
    if (total > MAX_KEYS) out.__truncatedKeys = total - MAX_KEYS;
    return out;
  }
  return String(value);
}

export function requestMeta(req: FastifyRequest): AuditJsonObject {
  const xff = headerText(req.headers['x-forwarded-for']);
  return {
    ip: xff?.split(',')[0]?.trim() || req.ip || null,
    xForwardedFor: xff,
    userAgent: truncateText(headerText(req.headers['user-agent']) ?? ''),
    referer: truncateText(headerText(req.headers.referer) ?? headerText(req.headers.referrer) ?? ''),
    origin: truncateText(headerText(req.headers.origin) ?? ''),
    requestId: req.id,
  };
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
  app.addHook('onRequest', async (req) => {
    requestStart.set(req, Date.now());
  });

  app.addHook('onResponse', async (req, reply) => {
    const path = req.url.split('?')[0] ?? req.url;
    if (!path.startsWith('/api/') || path === '/api/health') return;

    const token = (req.headers['x-user-id'] as string | undefined)?.trim();
    const resolvedId = verifyUserToken(token); // JWT→sub / 历史→userId 原样
    const adminToken = (req.headers['x-admin-token'] as string | undefined)?.trim()
      || ((req.headers.authorization as string | undefined)?.trim().startsWith('Bearer ') ? '[bearer]' : '');
    const user = resolvedId
      ? await prisma.user.findUnique({ where: { id: resolvedId }, select: { id: true, tenantId: true, role: true } }).catch(() => null)
      : null;
    const durationMs = Math.max(0, Date.now() - (requestStart.get(req) ?? Date.now()));
    const authState = token ? (user ? 'user_resolved' : 'invalid_user_token') : 'anonymous';
    const action = path.startsWith('/api/admin/') ? 'admin.http' : path.startsWith('/api/auth/') ? 'auth.http' : 'user.http';
    const query = summarizeForAudit(req.query);
    const body = summarizeForAudit(req.body);

    const payload: AuditJsonObject = {
      method: req.method,
      path,
      statusCode: reply.statusCode,
      ok: reply.statusCode >= 200 && reply.statusCode < 400,
      durationMs,
      request: requestMeta(req),
      auth: {
        state: authState,
        userTokenPresent: !!token,
        userResolved: !!user,
        userRole: user?.role ?? null,
        adminTokenPresent: !!adminToken,
      },
    };
    if (query && typeof query === 'object' && Object.keys(query as object).length > 0) payload.query = query;
    if (body !== null && !(typeof body === 'object' && !Array.isArray(body) && Object.keys(body as object).length === 0)) payload.body = body;

    await recordAudit({
      tenantId: user?.tenantId,
      userId: user?.id,
      action,
      payload,
    });
  });
}
