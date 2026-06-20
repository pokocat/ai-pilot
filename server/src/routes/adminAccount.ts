// 运营后台账户接口：状态 / 初始化 / 登录（公开）+ 退出 / 改密（需登录）。
// 路由前缀 /api（在 app.ts 注册），路径 /admin/auth/*。注意：本插件不挂 requireAdmin 全局 hook，
// 公开接口靠主密钥/密码自证；退出/改密用 per-route preHandler requireAdmin（接受会话 token 或主密钥）。
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Prisma } from '@prisma/client';
import { requireAdmin, actorOf, actorAccountId, isSuperActor } from '../services/adminAuth.js';
import { recordAudit, requestMeta, summarizeForAudit } from '../services/audit.js';
import {
  isInitialized, masterKeyConfigured, masterKeyValid,
  initAccount, loginAccount, changePassword, deleteSession,
  type AccountError,
} from '../services/adminAccount.js';
import type {
  AdminAuthStatus, AdminInitRequest, AdminLoginRequest, AdminAuthResult, AdminChangePasswordRequest, AdminMe,
} from '../../../shared/contracts';

function token(req: { headers: Record<string, unknown> }): string {
  const x = (req.headers['x-admin-token'] as string | undefined)?.trim();
  if (x) return x;
  const auth = (req.headers['authorization'] as string | undefined) ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  return m ? m[1].trim() : '';
}

function adminAttemptPayload(req: FastifyRequest, extra: Record<string, unknown>): Prisma.InputJsonValue {
  return summarizeForAudit({ ...extra, request: requestMeta(req) }) as Prisma.InputJsonValue;
}

async function recordAdminAccountAttempt(req: FastifyRequest, action: string, extra: Record<string, unknown>) {
  await recordAudit({ action, payload: adminAttemptPayload(req, extra) });
}

export async function adminAccountRoutes(app: FastifyInstance) {
  // 登录页据此决定显示「初始化」还是「账号密码登录」表单。
  app.get('/admin/auth/status', async (): Promise<AdminAuthStatus> => ({
    initialized: await isInitialized(),
    masterKeyEnabled: masterKeyConfigured(),
  }));

  // 初始化单一管理员账户：需主密钥；仅未初始化时可用。成功自动登录（下发会话 token）。
  app.post<{ Body: AdminInitRequest }>('/admin/auth/init', async (req, reply): Promise<AdminAuthResult | void> => {
    const b = req.body ?? ({} as AdminInitRequest);
    if (!masterKeyValid(b.masterKey)) {
      await recordAdminAccountAttempt(req, 'admin.account.init_attempt', {
        ok: false,
        statusCode: 401,
        username: b.username,
        errorCode: 'BAD_MASTER_KEY',
      });
      return reply.code(401).send({ error: '主密钥无效', code: 'BAD_MASTER_KEY' });
    }
    try {
      const r = await initAccount(b.username, b.password);
      await recordAdminAccountAttempt(req, 'admin.account.init_attempt', {
        ok: true,
        statusCode: 200,
        username: r.username,
      });
      await recordAudit({ action: 'admin.account.init', payload: { username: r.username } });
      return r;
    } catch (e) {
      const err = e as AccountError;
      await recordAdminAccountAttempt(req, 'admin.account.init_attempt', {
        ok: false,
        statusCode: err.statusCode ?? 400,
        username: b.username,
        errorCode: err.code ?? 'INIT_FAILED',
        error: err.message,
      });
      return reply.code(err.statusCode ?? 400).send({ error: err.message, code: err.code ?? 'INIT_FAILED' });
    }
  });

  // 账号密码登录。失败统一 401，不区分「账号不存在/密码错」以防枚举。
  app.post<{ Body: AdminLoginRequest }>('/admin/auth/login', async (req, reply): Promise<AdminAuthResult | void> => {
    const b = req.body ?? ({} as AdminLoginRequest);
    const r = await loginAccount(b.username, b.password);
    if (!r) {
      await recordAdminAccountAttempt(req, 'admin.account.login_attempt', {
        ok: false,
        statusCode: 401,
        username: b.username,
        errorCode: 'BAD_CREDENTIALS',
      });
      return reply.code(401).send({ error: '账号或密码错误', code: 'BAD_CREDENTIALS' });
    }
    await recordAdminAccountAttempt(req, 'admin.account.login_attempt', {
      ok: true,
      statusCode: 200,
      username: r.username,
    });
    await recordAudit({ action: 'admin.account.login', payload: { username: r.username } });
    return r;
  });

  // 退出：吊销当前会话 token（主密钥登录时无会话行，幂等无副作用）。
  app.post('/admin/auth/logout', { preHandler: requireAdmin }, async (req) => {
    await deleteSession(token(req));
    return { ok: true };
  });

  // 当前登录者身份：前端按角色显隐「账户管理」、按范围过滤可见 agent。
  app.get('/admin/auth/me', { preHandler: requireAdmin }, async (req): Promise<AdminMe> => {
    const actor = actorOf(req);
    return {
      kind: actor.kind,
      username: actor.kind === 'account' ? actor.username : null,
      role: actor.kind === 'account' ? actor.role : 'owner', // master/legacyUser 视为超管
      isSuper: isSuperActor(actor),
    };
  });

  // 改密：改当前登录账户自己（主密钥可直接重置，否则需当前密码）。成功后吊销该账户全部会话需重新登录。
  app.post<{ Body: AdminChangePasswordRequest }>('/admin/auth/password', { preHandler: requireAdmin }, async (req, reply) => {
    const b = req.body ?? ({} as AdminChangePasswordRequest);
    try {
      await changePassword({ accountId: actorAccountId(actorOf(req)), currentPassword: b.currentPassword, newPassword: b.newPassword, masterKey: b.masterKey });
      await recordAdminAccountAttempt(req, 'admin.account.password_attempt', {
        ok: true,
        statusCode: 200,
        usedMasterKey: !!b.masterKey,
      });
      await recordAudit({ action: 'admin.account.password' });
      return { ok: true };
    } catch (e) {
      const err = e as AccountError;
      await recordAdminAccountAttempt(req, 'admin.account.password_attempt', {
        ok: false,
        statusCode: err.statusCode ?? 400,
        usedMasterKey: !!b.masterKey,
        errorCode: err.code ?? 'CHANGE_FAILED',
        error: err.message,
      });
      return reply.code(err.statusCode ?? 400).send({ error: err.message, code: err.code ?? 'CHANGE_FAILED' });
    }
  });
}
