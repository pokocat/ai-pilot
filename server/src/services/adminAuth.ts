// 运营后台鉴权：保护 /api/admin/* 不被普通小程序用户调用（防止自助开通付费智能体、改价等越权）。
// 放行条件（任一）：
//   1) 共享主密钥：请求头 x-admin-token 或 Authorization: Bearer <token> 命中环境变量 ADMIN_TOKEN（常量时间比对，应急/找回）；
//   2) 后台账户会话：x-admin-token / Bearer 命中有效的 AdminSession token（账号密码登录后下发）；
//   3) 管理员账号：x-user-id 解析到 role='admin' 的用户（兼容旧路径）。
// 否则：已登录的非管理员 → 403；无任何凭证 → 401。
//
// 说明：ADMIN_TOKEN 在「请求时」直接读 process.env（而非启动期缓存），便于密钥轮换与测试注入。
//      未配置 ADMIN_TOKEN 时，仅放行后台账户会话 / role='admin' 账号（安全默认）；演示环境请在 .env 配置 ADMIN_TOKEN。
import type { FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { prisma } from '../db.js';
import { resolveSession } from './adminAccount.js';

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

export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const configured = (process.env.ADMIN_TOKEN ?? '').trim();
  const provided =
    ((req.headers['x-admin-token'] as string | undefined)?.trim() || '') ||
    bearer(req.headers['authorization'] as string | undefined);

  // 1) 共享主密钥（应急/找回）
  if (configured && provided && safeEqual(provided, configured)) return;

  // 2) 后台账户会话 token
  if (provided && (await resolveSession(provided))) return;

  // 3) 管理员账号（role=admin，兼容旧路径）
  const uid = ((req.headers['x-user-id'] as string | undefined) ?? '').trim();
  if (uid) {
    const u = await prisma.user.findUnique({ where: { id: uid }, select: { role: true } });
    if (u?.role === 'admin') return;
    if (u) {
      return reply.code(403).send({ error: '需要管理员权限', code: 'ADMIN_FORBIDDEN' });
    }
  }
  return reply.code(401).send({ error: '未授权访问运营后台', code: 'ADMIN_UNAUTHORIZED' });
}
