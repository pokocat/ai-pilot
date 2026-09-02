import { Prisma } from '@prisma/client';
import { prisma, utcTimestamp } from '../db.js';
import { isoSecond } from './audit.js';
import type { AdminAuditItem, AdminAuditListView, AdminDateRange } from '../../../shared/contracts';

type AuditRow = {
  id: string;
  action: string;
  payloadJson: Prisma.JsonValue | null;
  createdAt: Date;
  userId: string | null;
  userName: string | null;
  userPhone: string | null;
  tenantId: string | null;
  tenantName: string | null;
};

type CountRow = { total: bigint | number; failed: bigint | number; users: bigint | number; operators: bigint | number };

function object(value: Prisma.JsonValue | null): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function at(obj: Record<string, unknown>, ...keys: string[]): unknown {
  let value: unknown = obj;
  for (const key of keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    value = (value as Record<string, unknown>)[key];
  }
  return value ?? null;
}

function string(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function displayPhone(phone: string | null): string | null {
  if (!phone) return null;
  return phone.startsWith('wx_') ? '微信账号' : phone;
}

function summary(action: string, payload: Record<string, unknown>): string | null {
  const method = string(payload.method);
  const path = string(payload.path);
  const status = number(payload.statusCode);
  const ok = typeof payload.ok === 'boolean' ? payload.ok : null;
  const duration = number(payload.durationMs);
  const parts = [
    ok === true ? '成功' : ok === false || (status !== null && status >= 400) ? '失败' : null,
    method && path ? `${method} ${path}` : action,
    status !== null ? `HTTP ${status}` : null,
    duration !== null ? `${duration}ms` : null,
    string(payload.code) ?? string(payload.errorCode),
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

function pageNumber(value: number | undefined, fallback: number, max?: number): number {
  const n = Math.max(1, Math.floor(value ?? fallback));
  return max ? Math.min(max, n) : n;
}

export async function adminAuditView(opts: {
  from: Date;
  toExclusive: Date;
  range: AdminDateRange;
  includeAdmin?: boolean;
  includeMetrics?: boolean;
  action?: string;
  userId?: string;
  status?: string;
  q?: string;
  page?: number;
  pageSize?: number;
}): Promise<AdminAuditListView> {
  const page = pageNumber(opts.page, 1);
  const pageSize = pageNumber(opts.pageSize, 50, 200);
  const clauses: Prisma.Sql[] = [
    // Prisma DateTime 列是 UTC naive；raw SQL 裸绑 Date 会按数据库会话时区偏移，
    // 导致后台选「今天」却漏掉刚写入的日志（生产 +8h，本地测试 -7h）。
    Prisma.sql`a."createdAt" >= ${utcTimestamp(opts.from)} AND a."createdAt" < ${utcTimestamp(opts.toExclusive)}`,
  ];
  // 历史 payload 不完全受契约约束；先验明纯数字再 cast，避免一条脏 statusCode
  // 让整页审计查询报 PostgreSQL invalid input syntax。
  const statusCode = Prisma.sql`CASE WHEN COALESCE(a."payloadJson"->>'statusCode', '') ~ '^[0-9]+$' THEN (a."payloadJson"->>'statusCode')::int ELSE 0 END`;
  if (!opts.includeAdmin && !opts.action) clauses.push(Prisma.sql`a.action NOT LIKE 'admin.%'`);
  if (!opts.includeMetrics) clauses.push(Prisma.sql`COALESCE(a."payloadJson"->>'path', '') <> '/api/metrics'`);
  if (opts.action) clauses.push(Prisma.sql`a.action = ${opts.action}`);
  if (opts.userId) clauses.push(Prisma.sql`a."userId" = ${opts.userId}`);
  if (opts.status === 'ok') clauses.push(Prisma.sql`(${statusCode} < 400 AND COALESCE(a."payloadJson"->>'ok', 'true') <> 'false')`);
  if (opts.status === 'error') clauses.push(Prisma.sql`(${statusCode} >= 400 OR a."payloadJson"->>'ok' = 'false')`);
  if (opts.q?.trim()) {
    const q = `%${opts.q.trim()}%`;
    clauses.push(Prisma.sql`(
      a.id ILIKE ${q} OR a.action ILIKE ${q}
      OR COALESCE(a."payloadJson"->>'path', '') ILIKE ${q}
      OR COALESCE(a."payloadJson"->>'method', '') ILIKE ${q}
      OR COALESCE(a."payloadJson"#>>'{request,requestId}', '') ILIKE ${q}
      OR COALESCE(a."payloadJson"#>>'{request,ip}', '') ILIKE ${q}
      OR COALESCE(a."payloadJson"->>'by', '') ILIKE ${q}
      OR COALESCE(u.name, '') ILIKE ${q} OR COALESCE(u.phone, '') ILIKE ${q}
      OR COALESCE(t.name, '') ILIKE ${q}
    )`);
  }
  const where = Prisma.join(clauses, ' AND ');
  const [rows, counts] = await Promise.all([
    prisma.$queryRaw<AuditRow[]>(Prisma.sql`
      SELECT a.id, a.action, a."payloadJson", a."createdAt", a."userId", a."tenantId",
             u.name AS "userName", u.phone AS "userPhone", t.name AS "tenantName"
      FROM audit_log a
      LEFT JOIN app_user u ON u.id = a."userId"
      LEFT JOIN tenant t ON t.id = a."tenantId"
      WHERE ${where}
      ORDER BY a."createdAt" DESC, a.id DESC
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`),
    prisma.$queryRaw<CountRow[]>(Prisma.sql`
      SELECT COUNT(*) AS total,
             COUNT(*) FILTER (WHERE ${statusCode} >= 400 OR a."payloadJson"->>'ok' = 'false') AS failed,
             COUNT(DISTINCT a."userId") FILTER (WHERE a."userId" IS NOT NULL) AS users,
             COUNT(DISTINCT COALESCE(a."payloadJson"->>'by', a."payloadJson"#>>'{auth,admin,username}'))
               FILTER (WHERE COALESCE(a."payloadJson"->>'by', a."payloadJson"#>>'{auth,admin,username}') IS NOT NULL) AS operators
      FROM audit_log a
      LEFT JOIN app_user u ON u.id = a."userId"
      LEFT JOIN tenant t ON t.id = a."tenantId"
      WHERE ${where}`),
  ]);
  const count = counts[0] ?? { total: 0, failed: 0, users: 0, operators: 0 };
  const total = Number(count.total);
  const items: AdminAuditItem[] = rows.map((row) => {
    const payload = object(row.payloadJson);
    return {
      id: row.id,
      action: row.action,
      summary: summary(row.action, payload),
      method: string(payload.method),
      path: string(payload.path),
      statusCode: number(payload.statusCode),
      ip: string(at(payload, 'request', 'ip')),
      userAgent: string(at(payload, 'request', 'userAgent')),
      userId: row.userId,
      userName: row.userName || null,
      userPhone: displayPhone(row.userPhone),
      tenantId: row.tenantId,
      tenantName: row.tenantName || null,
      requestId: string(at(payload, 'request', 'requestId')),
      sessionId: string(payload.sessionId) ?? string(at(payload, 'body', 'sessionId')) ?? string(at(payload, 'query', 'sessionId')),
      operator: string(payload.by) ?? string(at(payload, 'auth', 'admin', 'username')),
      payload: row.payloadJson,
      at: isoSecond(row.createdAt),
    };
  });
  return {
    range: opts.range,
    page,
    pageSize,
    total,
    pages: Math.max(1, Math.ceil(total / pageSize)),
    summary: { events: total, failed: Number(count.failed), users: Number(count.users), operators: Number(count.operators) },
    items,
  };
}
