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

/** 初始化首个管理员账户（owner，仅在尚未初始化时允许；调用方需先校验主密钥）。 */
export async function initAccount(username: string, password: string): Promise<{ token: string; username: string }> {
  if (await isInitialized()) throw err('ALREADY_INIT', '管理员账户已初始化', 409);
  const u = (username ?? '').trim();
  if (!USERNAME_RE.test(u)) throw err('BAD_USERNAME', '账号仅限 2-40 位字母/数字/._-');
  if ((password ?? '').length < 6) throw err('BAD_PASSWORD', '密码至少 6 位');
  const account = await prisma.adminAccount.create({
    data: { username: u, passwordHash: hashPassword(password), role: 'owner' }, // 首个账户即超管
  });
  const token = await createSession(account.id);
  return { token, username: account.username };
}

// —— 多运营：owner 管理 operator 账户 ——

export interface AdminAccountRow {
  id: string;
  username: string;
  role: string;        // owner | operator
  disabled: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

const ROLES = new Set(['owner', 'operator']);

/** owner 新增运营账户（operator 或再设一个 owner）。 */
export async function createOperator(username: string, password: string, role = 'operator'): Promise<AdminAccountRow> {
  const u = (username ?? '').trim();
  if (!USERNAME_RE.test(u)) throw err('BAD_USERNAME', '账号仅限 2-40 位字母/数字/._-');
  if ((password ?? '').length < 6) throw err('BAD_PASSWORD', '密码至少 6 位');
  const r = ROLES.has(role) ? role : 'operator';
  if (await prisma.adminAccount.findUnique({ where: { username: u } })) throw err('USERNAME_EXISTS', '账号已存在', 409);
  const a = await prisma.adminAccount.create({ data: { username: u, passwordHash: hashPassword(password), role: r } });
  return toRow(a);
}

export async function listAccounts(): Promise<AdminAccountRow[]> {
  const rows = await prisma.adminAccount.findMany({ orderBy: { createdAt: 'asc' } });
  return rows.map(toRow);
}

/** 停用/启用账户。停用即吊销其全部会话；不允许停用最后一个在用的 owner。 */
export async function setAccountDisabled(id: string, disabled: boolean): Promise<AdminAccountRow> {
  const target = await prisma.adminAccount.findUnique({ where: { id } });
  if (!target) throw err('NOT_FOUND', '账户不存在', 404);
  if (disabled && target.role === 'owner') {
    const activeOwners = await prisma.adminAccount.count({ where: { role: 'owner', disabledAt: null } });
    if (activeOwners <= 1) throw err('LAST_OWNER', '不能停用最后一个 owner', 409);
  }
  const a = await prisma.adminAccount.update({ where: { id }, data: { disabledAt: disabled ? new Date() : null } });
  if (disabled) await prisma.adminSession.deleteMany({ where: { accountId: id } });
  return toRow(a);
}

/** 调整账户角色（owner ↔ operator）。不允许把最后一个 owner 降级。 */
export async function setAccountRole(id: string, role: string): Promise<AdminAccountRow> {
  if (!ROLES.has(role)) throw err('BAD_ROLE', '角色非法');
  const target = await prisma.adminAccount.findUnique({ where: { id } });
  if (!target) throw err('NOT_FOUND', '账户不存在', 404);
  if (target.role === 'owner' && role !== 'owner') {
    const activeOwners = await prisma.adminAccount.count({ where: { role: 'owner', disabledAt: null } });
    if (activeOwners <= 1) throw err('LAST_OWNER', '不能降级最后一个 owner', 409);
  }
  const a = await prisma.adminAccount.update({ where: { id }, data: { role } });
  return toRow(a);
}

/** owner 重置某账户密码（吊销其会话）。 */
export async function resetAccountPassword(id: string, newPassword: string): Promise<void> {
  if ((newPassword ?? '').length < 6) throw err('BAD_PASSWORD', '新密码至少 6 位');
  const target = await prisma.adminAccount.findUnique({ where: { id } });
  if (!target) throw err('NOT_FOUND', '账户不存在', 404);
  await prisma.adminAccount.update({ where: { id }, data: { passwordHash: hashPassword(newPassword) } });
  await prisma.adminSession.deleteMany({ where: { accountId: id } });
}

function toRow(a: { id: string; username: string; role: string; disabledAt: Date | null; lastLoginAt: Date | null; createdAt: Date }): AdminAccountRow {
  return {
    id: a.id,
    username: a.username,
    role: a.role,
    disabled: !!a.disabledAt,
    lastLoginAt: a.lastLoginAt ? a.lastLoginAt.toISOString() : null,
    createdAt: a.createdAt.toISOString(),
  };
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

/** 改密：改指定账户（accountId=当前登录者）；主密钥可直接重置（应急，缺 accountId 时落到首个 owner）。 */
export async function changePassword(opts: { accountId?: string | null; currentPassword?: string; newPassword: string; masterKey?: string }): Promise<void> {
  if ((opts.newPassword ?? '').length < 6) throw err('BAD_PASSWORD', '新密码至少 6 位');
  const account = opts.accountId
    ? await prisma.adminAccount.findUnique({ where: { id: opts.accountId } })
    : await prisma.adminAccount.findFirst({ orderBy: { createdAt: 'asc' } });
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
