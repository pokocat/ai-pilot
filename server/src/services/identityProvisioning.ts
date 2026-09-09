// 账号中心 uid（令牌 `sub`）→ 军师本地 `User` 的解析与首登建档。
//
// 口径对齐 AIStarEcosystem 的 `IdentityProvisioningService`，但**多一道手机号闸**：
// 军师的账号键是手机号（钱包、老用户迁移、注销都按它，`User.phone` 是 NOT NULL 唯一键），
// 所以这个产品**要求**手机号 —— 这正是 aibuzz-id README §11.2 第 3 条留给产品判断的那件事。
//
// 顺序（契约见 ai-quickreel `docs/WORKPLAN_2026-09-05.md` §1.1）：
//   1. `User.identityUid` 命中 → 直接用；
//   2. 未命中且令牌 `phone_verified !== true` → 403 `PHONE_BINDING_REQUIRED`（端上开绑手机浮层）；
//   3. 有手机号 → 用同一张 bearer 读 `/userinfo` 取 `phone_number`：
//        · 手机号已有账号 → 回填 `identityUid`（已绑别的 uid → 409 `IDENTITY_CONFLICT`）；
//        · 没有 → 走与登录路由同一条建号路径（新 Tenant + User），不发短信、不做邀请归因。
//   4. 并发首登靠唯一键兜底：插入冲突后按 `identityUid` / `phone` 回读赢家，只会有一行。
import { Prisma } from '@prisma/client';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '../db.js';
import { suggestAliasName } from '../data/aliasNames.js';
import { createUserWithTenant } from './accountProvision.js';
import { maskAuditPhone } from './audit.js';
import {
  bearerOf, fetchIdentityUserinfo, identityEnabled, reportProductLink,
  verifyIdentityToken, verifyIdentityTokenCached,
  type IdentityClaims,
} from './identity.js';
import { signUserToken, verifyUserToken } from './userToken.js';

export class PhoneBindingRequiredError extends Error {
  statusCode = 403;
  code = 'PHONE_BINDING_REQUIRED';
  constructor() { super('请先绑定手机号'); }
}

export class IdentityConflictError extends Error {
  statusCode = 409;
  code = 'IDENTITY_CONFLICT';
  constructor() { super('这个手机号已经绑定了另一个账号，请换个手机号或联系客服'); }
}

/** 令牌说有手机号，但 `/userinfo` 给不出来（多半是端上申请令牌时漏了 `phone` scope）。 */
export class IdentityPhoneUnavailableError extends Error {
  statusCode = 502;
  code = 'IDENTITY_PHONE_UNAVAILABLE';
  constructor() { super('暂时读不到你的手机号，请退出后重新登录再试'); }
}

/** uid → 本地 userId 的正向缓存。只缓存命中，TTL 短；解析出来的用户仍由 resolveUser 复核状态。 */
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 10_000;
const uidCache = new Map<string, { userId: string; at: number }>();

export function resetIdentityUserCache(): void { uidCache.clear(); }

function cacheGet(uid: string): string | null {
  const row = uidCache.get(uid);
  if (!row) return null;
  if (Date.now() - row.at > CACHE_TTL_MS) { uidCache.delete(uid); return null; }
  return row.userId;
}

function cacheSet(uid: string, userId: string): void {
  if (uidCache.size >= CACHE_MAX) uidCache.clear(); // 粗暴但有界：这是缓存不是账本
  uidCache.set(uid, { userId, at: Date.now() });
}

const PHONE_RULE = /^1\d{10}$/;

function isUniqueConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/** 按 uid 回读（并发落败方走这条路拿到赢家）。 */
async function findByUid(uid: string): Promise<string | null> {
  const row = await prisma.user.findUnique({ where: { identityUid: uid }, select: { id: true } });
  return row?.id ?? null;
}

/**
 * 把 uid 绑到已有的手机号账号上。
 * 条件更新（`identityUid: null`）保证不会覆盖别人已经绑好的 uid；
 * 影响 0 行说明这行已经被绑走了，回查一次判断是「本来就是自己」还是真冲突。
 */
async function bindUidToExistingUser(userId: string, uid: string): Promise<string> {
  const updated = await prisma.user.updateMany({ where: { id: userId, identityUid: null }, data: { identityUid: uid } });
  if (updated.count === 1) return userId;
  const current = await prisma.user.findUnique({ where: { id: userId }, select: { identityUid: true } });
  if (current?.identityUid === uid) return userId;
  throw new IdentityConflictError();
}

/** 已存在就返回，不存在就按手机号建档。返回**军师本地 userId**。 */
export async function resolveOrProvisionIdentityUser(claims: IdentityClaims, bearer: string): Promise<string> {
  const uid = claims.sub;
  const cached = cacheGet(uid);
  if (cached) return cached;

  const hit = await findByUid(uid);
  if (hit) { cacheSet(uid, hit); return hit; }

  // 军师要求手机号（见文件头注释）。令牌没说有，就让端上先去绑，绝不建一个没有手机号的账号。
  if (!claims.phoneVerified) throw new PhoneBindingRequiredError();

  const info = await fetchIdentityUserinfo(bearer);
  const phone = info.phone;
  if (!PHONE_RULE.test(phone)) {
    console.warn(`[identity] 令牌 phone_verified=true 但 /userinfo 没有可用手机号 uid=${uid}（多半缺 phone scope）`);
    throw new IdentityPhoneUnavailableError();
  }

  const existing = await prisma.user.findUnique({ where: { phone }, select: { id: true, identityUid: true } });
  if (existing) {
    if (existing.identityUid && existing.identityUid !== uid) throw new IdentityConflictError();
    const bound = await bindUidToExistingUser(existing.id, uid);
    cacheSet(uid, bound);
    return bound;
  }

  try {
    const created = await createUserWithTenant({
      // 不编造称呼：userinfo 当前只给 sub / 手机号（aibuzz-id `IdOidcUserInfoMapper`），
      // 拿不到名字就用现有别名生成，与短信/微信建号一致。
      phone,
      name: info.name || suggestAliasName(),
      auditAction: 'auth.identity_register',
      auditPayload: { phone: maskAuditPhone(phone), identityUid: uid, aud: claims.aud },
    });
    const bound = await bindUidToExistingUser(created.id, uid);
    cacheSet(uid, bound);
    // 回报走 best-effort：账号中心抖动绝不能把用户挡在登录外（README §9.2「提交之后再回报」）。
    void reportProductLink({ uid, localUserId: bound, aud: claims.aud });
    console.info(`[identity] 首登建档 uid=${uid} localUserId=${bound}`);
    return bound;
  } catch (err) {
    if (!isUniqueConflict(err)) throw err;
    // 并发首登：另一条线程赢了。按 uid 回读赢家；uid 还没回填就按手机号回读再绑。
    const winner = await findByUid(uid);
    if (winner) { cacheSet(uid, winner); return winner; }
    const byPhone = await prisma.user.findUnique({ where: { phone }, select: { id: true, identityUid: true } });
    if (!byPhone) throw err;
    if (byPhone.identityUid && byPhone.identityUid !== uid) throw new IdentityConflictError();
    const bound = await bindUidToExistingUser(byPhone.id, uid);
    cacheSet(uid, bound);
    return bound;
  }
}

/* ────────────────────────── 请求侧接入 ────────────────────────── */

export interface RequestIdentity {
  /** 限流分桶键：老链路 `u:<userId>`，账号中心 `id:<sub>`。 */
  key: string;
  /** 军师本地 userId；账号中心令牌在 onRequest 钩子解析之前为 null。 */
  userId: string | null;
  /** 账号中心 uid；老链路为 null。 */
  sub: string | null;
  /**
   * 已验签令牌里的 `aud`（原样，可能不止一项）。**老链路恒为空数组** ——
   * 套餐闸据它放行爱速拍（`quickreel-api`），空数组即「按军师老口径处理」。
   */
  aud: string[];
}

type IdentityRequest = FastifyRequest & { identityContext?: { sub: string; userId: string; aud: string[] } };

/**
 * 取「这个请求是谁」——**纯计算、不查库**（限流 keyGenerator 与套餐闸共用同一把尺子）。
 *
 * · 钩子已解析过（`identityContext`）→ 直接用，`aud` 从令牌带出来；
 * · `x-user-id`（HS256 / 历史 userId）→ 老逻辑，一个字节不改，`aud` 为空；
 * · `Authorization: Bearer <RS256>` → 用**已缓存**的 JWKS 同步验签取 `sub` / `aud`。
 *   缓存里没有对应公钥时返回 null（限流退回按 IP 分桶），**绝不放行**——真正的准入在
 *   `attachIdentityUser` 里做，那条路径可以异步刷 JWKS。
 *
 * 顺序上 `identityContext` 排在 `x-user-id` **前面**：`attachIdentityUser` 成功后会把内部令牌
 * 写回 `x-user-id`，若先读那个头就会把 `aud` 丢掉。真·老链路请求永远不会有 `identityContext`
 * （钩子见到 `x-user-id` 就原样返回），所以这个顺序对军师老口径没有任何影响。
 */
export function identifyRequest(req: FastifyRequest): RequestIdentity | null {
  const ctx = (req as IdentityRequest).identityContext;
  if (ctx) return { key: `id:${ctx.sub}`, userId: ctx.userId, sub: ctx.sub, aud: ctx.aud };

  const raw = req.headers['x-user-id'];
  const legacy = verifyUserToken(Array.isArray(raw) ? raw[0] : raw);
  if (legacy) return { key: `u:${legacy}`, userId: legacy, sub: null, aud: [] };

  const bearer = bearerOf(req.headers as Record<string, unknown>);
  if (!bearer) return null;
  const claims = verifyIdentityTokenCached(bearer);
  return claims ? { key: `id:${claims.sub}`, userId: null, sub: claims.sub, aud: claims.aud } : null;
}

/** 不参与账号中心解析的路径：运营后台与指标端点自带 Bearer（不透明 token，不是 JWT）。 */
function skipIdentity(url: string): boolean {
  return url.startsWith('/api/admin') || url.startsWith('/api/metrics') || url.startsWith('/api/health');
}

/**
 * onRequest 钩子：把账号中心令牌换成本地登录态。
 *
 * 换成 `x-user-id` 内部令牌（短时 HS256）而不是改 200 多处 `resolveUser(req.headers['x-user-id'])`
 * 的调用点 —— 老链路一个字节不动，账号中心令牌从这一层之后与老登录态完全同形。
 *
 * · 已经带了 `x-user-id` → 什么都不做（老客户端优先，行为完全不变）；
 * · `ID_ISSUER` 未配 / 验签不过 → 什么都不做，由路由自己的 `resolveUser` 落 401（不静默放行）；
 * · 建档过程中的业务错误（403 绑手机 / 409 冲突 / 502 读不到手机号）在这里直接成型返回，
 *   用的是全站统一的 `{ error, code }` 壳。
 */
export async function attachIdentityUser(req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | void> {
  if (!identityEnabled()) return;
  if (skipIdentity(req.url)) return;
  const raw = req.headers['x-user-id'];
  const legacy = Array.isArray(raw) ? raw[0] : raw;
  if (typeof legacy === 'string' && legacy.trim()) return;
  const bearer = bearerOf(req.headers as Record<string, unknown>);
  if (!bearer) return;

  const claims = await verifyIdentityToken(bearer);
  if (!claims) return; // 无效 RS256 令牌 → 路由层 401，绝不放行

  try {
    const userId = await resolveOrProvisionIdentityUser(claims, bearer);
    (req as IdentityRequest).identityContext = { sub: claims.sub, userId, aud: claims.aud };
    // 只在本次请求内使用，给 5 分钟足够；未配 APP_JWT_SECRET 的非生产环境退回历史口径（=userId）。
    req.headers['x-user-id'] = signUserToken(userId, { ttlSec: 300 });
  } catch (err) {
    const e = err as { statusCode?: number; code?: string; message?: string };
    return reply.code(e.statusCode ?? 500).send({
      error: e.message ?? '登录失败，请稍后再试',
      code: e.code ?? 'IDENTITY_RESOLVE_FAILED',
    });
  }
}
