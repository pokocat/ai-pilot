// 附身登录（impersonation）：owner-only 签发目标用户短时 token，H5 凭 ?imp_token 登入排查。
// 全程无外部服务（NODE_ENV=test）；本文件显式配 APP_JWT_SECRET 以走 JWT 签发路径（含 imp 标记、2h 过期）。
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, uniquePhone } from './helpers.js';
import { createOperator, createSession } from '../src/services/adminAccount.js';
import { verifyUserToken } from '../src/services/userToken.js';

process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'test-admin-token';
process.env.APP_JWT_SECRET = 'unit-imp-secret'; // 走 JWT 路径：签出真 token，可被 verifyUserToken 还原

before(async () => { await getApp(); });
after(async () => { await closeApp(); delete process.env.APP_JWT_SECRET; });

// 造一个操作员会话 token（role=operator）——用于验证 requireSuper 拒绝。
async function operatorToken(): Promise<string> {
  const acc = await createOperator(`op_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, 'pw-123456', 'operator');
  return createSession(acc.id);
}

async function mkTenantUser() {
  const tenant = await prisma.tenant.create({ data: { name: '附身测试企业' } });
  const user = await prisma.user.create({ data: { tenantId: tenant.id, phone: uniquePhone(), name: '附身用户', role: 'owner' } });
  return { tenantId: tenant.id, userId: user.id };
}

/** 解出 JWT payload（测试内解码，不验签）。 */
function decodeJwtPayload(token: string): Record<string, unknown> {
  const p = token.split('.')[1];
  return JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}

describe('POST /admin/users/:id/impersonate', () => {
  beforeEach(async () => { await cleanBusiness(); await seedBaseline(); });

  test('404：用户不存在', async () => {
    const r = await api('POST', '/api/admin/users/nope/impersonate', { body: {} });
    assert.equal(r.status, 404);
  });

  test('operator → 403', async () => {
    const { userId } = await mkTenantUser();
    const r = await api('POST', `/api/admin/users/${userId}/impersonate`, { body: {}, adminToken: await operatorToken() });
    assert.equal(r.status, 403);
  });

  test('超管签发：token 可被 verifyUserToken 还原为目标 userId；带 imp 标记 + 2h 过期；审计落库', async () => {
    const { userId } = await mkTenantUser();
    const r = await api('POST', `/api/admin/users/${userId}/impersonate`, { body: {} });
    assert.equal(r.status, 200, JSON.stringify(r.body));

    // token 为三段 JWT，且能还原出目标 userId（等价于 app 端 resolveUser 会认这个身份）
    assert.equal(r.body.token.split('.').length, 3, '应为三段 JWT');
    assert.equal(verifyUserToken(r.body.token), userId, 'token 解出目标 userId');
    assert.equal(r.body.warning, undefined, '配了密钥不应带 warning');

    // 附身标记 imp + exp 约 2 小时后
    const payload = decodeJwtPayload(r.body.token);
    assert.ok(typeof payload.imp === 'string' && payload.imp, 'payload 带 imp 附身标记');
    assert.equal(payload.sub, userId);
    const nowSec = Math.floor(Date.now() / 1000);
    assert.ok(Math.abs((payload.exp as number) - (nowSec + 7200)) < 60, 'exp ≈ now + 2h');

    // expiresAt 为 ISO，且约 2 小时后
    assert.ok(r.body.expiresAt, 'expiresAt 非空');
    const drift = new Date(r.body.expiresAt).getTime() - (Date.now() + 7200 * 1000);
    assert.ok(Math.abs(drift) < 5000, 'expiresAt ≈ now + 2h');

    // 审计：admin.user.impersonate，payload 带 actor 与 ttlSec=7200
    const audit = await prisma.auditLog.findFirst({ where: { userId, action: 'admin.user.impersonate' }, orderBy: { createdAt: 'desc' } });
    assert.ok(audit, '审计落库');
    const ap = audit!.payloadJson as { actor?: string; ttlSec?: number };
    assert.ok(ap.actor, 'payload 带操作者 actor');
    assert.equal(ap.ttlSec, 7200, 'payload 记 ttlSec=7200');
  });
});
