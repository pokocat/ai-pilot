// 运营后台鉴权：保护 /api/admin/* 不被普通小程序用户调用（防止自助开通付费智能体、改价等越权）。
// 放行条件（任一），并解析「操作者身份」AdminActor 供下游做归属与按 agent 授权：
//   1) 共享主密钥：x-admin-token / Bearer 命中 ADMIN_TOKEN（常量时间比对）→ master（超管，应急/找回）；
//   2) 后台账户会话：命中有效 AdminSession 且账户未停用 → account（owner=超管 / operator=按 agent 授权）；
//   3) 管理员账号：x-user-id 解析到 role='admin' 的用户 → legacyUser（兼容旧路径，超管）。
// 否则：已登录的非管理员 → 403；无任何凭证 → 401。
//
// 说明：ADMIN_TOKEN 在「请求时」直接读 process.env（而非启动期缓存），便于密钥轮换与测试注入。
import type { FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { prisma } from '../db.js';
import { resolveSession } from './adminAccount.js';
import { verifyUserToken } from './userToken.js';

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length === 0 || ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function bearer(h?: string): string {
  if (!h) return '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : '';
}

function providedToken(req: FastifyRequest): string {
  return (
    ((req.headers['x-admin-token'] as string | undefined)?.trim() || '') ||
    bearer(req.headers['authorization'] as string | undefined)
  );
}

// 操作者身份：用于审计/版本归属（createdBy）与按 agent 的细粒度授权。
export type AdminActor =
  | { kind: 'master' }
  | { kind: 'account'; id: string; username: string; role: string }
  | { kind: 'legacyUser'; id: string };

/** master / legacyUser / owner 账户 = 超管：隐式拥有全部 agent 与账户管理权。 */
export function isSuperActor(a: AdminActor): boolean {
  return a.kind === 'master' || a.kind === 'legacyUser' || (a.kind === 'account' && a.role === 'owner');
}

/** 解析操作者身份（不发响应）。未授权 → null。停用账户视为未授权。 */
export async function getAdminActor(req: FastifyRequest): Promise<AdminActor | null> {
  const configured = (process.env.ADMIN_TOKEN ?? '').trim();
  const provided = providedToken(req);

  if (configured && provided && safeEqual(provided, configured)) return { kind: 'master' };

  if (provided) {
    const accountId = await resolveSession(provided);
    if (accountId) {
      const acc = await prisma.adminAccount.findUnique({
        where: { id: accountId },
        select: { id: true, username: true, role: true, disabledAt: true },
      });
      if (acc && !acc.disabledAt) return { kind: 'account', id: acc.id, username: acc.username, role: acc.role };
      // 账户已停用/已删 → 此凭证不放行
    }
  }

  // 3) 管理员账号（role=admin，兼容旧路径）
  const uid = verifyUserToken((req.headers['x-user-id'] as string | undefined) ?? '');
  if (uid) {
    const u = await prisma.user.findUnique({ where: { id: uid }, select: { role: true } });
    if (u?.role === 'admin') return { kind: 'legacyUser', id: uid };
  }
  return null;
}

// 把已解析的操作者挂到 request 上，下游 handler 用 actorOf(req) 取，避免重复解析。
type WithActor = { adminActor?: AdminActor };

export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const actor = await getAdminActor(req);
  if (actor) {
    (req as unknown as WithActor).adminActor = actor;
    return;
  }
  // 区分「已登录非管理员 → 403」与「无凭证 → 401」（沿用旧行为）。
  const uid = ((req.headers['x-user-id'] as string | undefined) ?? '').trim();
  if (uid) {
    const u = await prisma.user.findUnique({ where: { id: uid }, select: { role: true } });
    if (u && u.role !== 'admin') {
      return reply.code(403).send({ error: '需要管理员权限', code: 'ADMIN_FORBIDDEN' });
    }
  }
  return reply.code(401).send({ error: '未授权访问运营后台', code: 'ADMIN_UNAUTHORIZED' });
}

/** 取已挂在 request 上的操作者（requireAdmin 之后必有）。 */
export function actorOf(req: FastifyRequest): AdminActor {
  const a = (req as unknown as WithActor).adminActor;
  if (!a) throw Object.assign(new Error('未授权'), { statusCode: 401, code: 'ADMIN_UNAUTHORIZED' });
  return a;
}

export class AdminForbiddenError extends Error {
  statusCode = 403;
  code = 'ADMIN_AGENT_FORBIDDEN';
  constructor(msg = '你没有该智能体的操作权限') { super(msg); }
}

/** 按 agent 授权：超管放行；operator 需是该 agent 的协作者（editor 可写、viewer 只读）。 */
export async function requireAgentAccess(actor: AdminActor, agentKey: string, level: 'viewer' | 'editor'): Promise<void> {
  if (isSuperActor(actor)) return;
  if (actor.kind !== 'account') throw new AdminForbiddenError();
  const collab = await prisma.agentCollaborator.findUnique({
    where: { agentKey_accountId: { agentKey, accountId: actor.id } },
  });
  if (!collab) throw new AdminForbiddenError();
  if (level === 'editor' && collab.role !== 'editor') throw new AdminForbiddenError('你对该智能体仅有只读权限');
}

/** 操作者可见的 agentKey 集合；超管返回 null（= 全部）。用于列表过滤。 */
export async function accessibleAgentKeys(actor: AdminActor): Promise<Set<string> | null> {
  if (isSuperActor(actor)) return null;
  if (actor.kind !== 'account') return new Set();
  const rows = await prisma.agentCollaborator.findMany({ where: { accountId: actor.id }, select: { agentKey: true } });
  return new Set(rows.map((r) => r.agentKey));
}

/** 当前操作者的 AdminAccount.id（master/legacyUser 无账户行 → null），用于 createdBy 归属。 */
export function actorAccountId(actor: AdminActor): string | null {
  return actor.kind === 'account' ? actor.id : null;
}
