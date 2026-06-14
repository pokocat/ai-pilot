// 运营后台账户：单一管理员账户（密钥引导初始化）+ 账号密码登录 + 会话 token。
// 密码哈希用 Node 内置 crypto.scrypt（带随机盐），不引外部依赖；会话为不透明随机串，落库带过期。
// 主密钥 ADMIN_TOKEN 保留为应急/找回通道（见 adminAuth.requireAdmin）。
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { prisma } from '../db.js';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 会话有效期 7 天
const SCRYPT_KEYLEN = 64;

// —— 密码哈希（scrypt$saltHex$hashHex）——
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const dk = scryptSync(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('hex')}$${dk.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  let salt: Buffer, expected: Buffer;
  try {
    salt = Buffer.from(parts[1], 'hex');
    expected = Buffer.from(parts[2], 'hex');
  } catch {
    return false;
  }
  if (expected.length === 0) return false;
  const dk = scryptSync(password, salt, expected.length);
  return dk.length === expected.length && timingSafeEqual(dk, expected);
}

// —— 主密钥（ADMIN_TOKEN）——
export function masterKeyConfigured(): boolean {
  return !!(process.env.ADMIN_TOKEN ?? '').trim();
}

export function masterKeyValid(provided?: string): boolean {
  const configured = (process.env.ADMIN_TOKEN ?? '').trim();
  const given = (provided ?? '').trim();
  if (!configured || !given) return false;
  const a = Buffer.from(configured);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

// —— 账户 ——
export async function isInitialized(): Promise<boolean> {
  return (await prisma.adminAccount.count()) > 0;
}

const USERNAME_RE = /^[a-zA-Z0-9_.-]{2,40}$/;

export interface AccountError extends Error { code: string; statusCode: number; }
function err(code: string, message: string, statusCode = 400): AccountError {
  return Object.assign(new Error(message), { code, statusCode });
}

/** 初始化单一管理员账户（仅在尚未初始化时允许；调用方需先校验主密钥）。 */
export async function initAccount(username: string, password: string): Promise<{ token: string; username: string }> {
  if (await isInitialized()) throw err('ALREADY_INIT', '管理员账户已初始化', 409);
  const u = (username ?? '').trim();
  if (!USERNAME_RE.test(u)) throw err('BAD_USERNAME', '账号仅限 2-40 位字母/数字/._-');
  if ((password ?? '').length < 6) throw err('BAD_PASSWORD', '密码至少 6 位');
  const account = await prisma.adminAccount.create({
    data: { username: u, passwordHash: hashPassword(password) },
  });
  const token = await createSession(account.id);
  return { token, username: account.username };
}

/** 账号密码登录：成功下发会话 token，失败返回 null（调用方统一回 401，避免账号枚举）。 */
export async function loginAccount(username: string, password: string): Promise<{ token: string; username: string } | null> {
  const u = (username ?? '').trim();
  if (!u || !password) return null;
  const account = await prisma.adminAccount.findUnique({ where: { username: u } });
  if (!account || !verifyPassword(password, account.passwordHash)) return null;
  const token = await createSession(account.id);
  await prisma.adminAccount.update({ where: { id: account.id }, data: { lastLoginAt: new Date() } });
  return { token, username: account.username };
}

/** 改密：主密钥可直接重置（应急）；否则需当前密码正确。单账户场景。 */
export async function changePassword(opts: { currentPassword?: string; newPassword: string; masterKey?: string }): Promise<void> {
  if ((opts.newPassword ?? '').length < 6) throw err('BAD_PASSWORD', '新密码至少 6 位');
  const account = await prisma.adminAccount.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!account) throw err('NOT_INIT', '尚未初始化管理员账户', 409);
  const viaMaster = masterKeyValid(opts.masterKey);
  if (!viaMaster && !verifyPassword(opts.currentPassword ?? '', account.passwordHash)) {
    throw err('BAD_CURRENT', '当前密码不正确', 401);
  }
  await prisma.adminAccount.update({ where: { id: account.id }, data: { passwordHash: hashPassword(opts.newPassword) } });
  // 改密后吊销该账户所有既有会话（强制重新登录）。
  await prisma.adminSession.deleteMany({ where: { accountId: account.id } });
}

// —— 会话 ——
export async function createSession(accountId: string): Promise<string> {
  const token = randomBytes(32).toString('hex');
  await prisma.adminSession.create({
    data: { token, accountId, expiresAt: new Date(Date.now() + SESSION_TTL_MS) },
  });
  return token;
}

/** 校验会话 token：有效（未过期）返回 accountId，否则 null。顺手清理过期会话懒删除。 */
export async function resolveSession(token: string): Promise<string | null> {
  const t = (token ?? '').trim();
  if (!t) return null;
  const s = await prisma.adminSession.findUnique({ where: { token: t } });
  if (!s) return null;
  if (s.expiresAt.getTime() <= Date.now()) {
    await prisma.adminSession.delete({ where: { token: t } }).catch(() => {});
    return null;
  }
  return s.accountId;
}

export async function deleteSession(token: string): Promise<void> {
  const t = (token ?? '').trim();
  if (!t) return;
  await prisma.adminSession.deleteMany({ where: { token: t } });
}
