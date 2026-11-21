import { randomBytes, randomUUID } from 'node:crypto';
import { Prisma, type User } from '@prisma/client';
import { prisma } from '../db.js';
import { z } from 'zod';
import type { StudioDraftCard } from '../../../shared/contracts';
import { fetchIdentityUserinfo, identityBaseUrl, identityEnabled, JUNSHI_AUDIENCE, verifyIdentityToken } from './identity.js';
import { decryptSecret, encryptionEnabled, encryptSecret, isEncrypted } from './secretBox.js';
import { lockIdentityUid, requireIdentityActive } from './identityState.js';
import { isPersonalUserToken } from './userToken.js';

export const STUDIO_ORIGIN = 'https://aiavatar.aibuzz.cn';
const STUDIO_API = '/api/v1/ip-studio/junshi';
const UPLOAD_PATH = STUDIO_API + '/reference-upload';
const OPEN_LIFETIME = 120_000;

const oauthResponse = z.object({ access_token: z.string().min(1) });
const delegationResponse = z.object({ accessToken: z.string().min(1), expiresIn: z.number().positive() });
export const studioId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const studioPublicId = z.string().regex(/^[A-Za-z0-9_-]{22,128}$/);
export const studioLoginCode = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);

export function studioBridgeEnabled() {
  return process.env.JUNSHI_STUDIO_ENABLED === 'true';
}

export function studioBridgeReady() {
  return studioBridgeEnabled() && identityEnabled() && encryptionEnabled() && !!process.env.JUNSHI_STUDIO_CLIENT_SECRET?.trim();
}

export class StudioBridgeError extends Error {
  constructor(message: string, readonly statusCode = 503, readonly code = 'STUDIO_UNAVAILABLE') {
    super(message);
  }
}

class StudioUpstreamError extends StudioBridgeError {
  constructor(readonly upstreamStatus: number) {
    super('声量AI暂时无法连接，请稍后重试');
  }
}

type LocalUser = Pick<User, 'id' | 'tenantId' | 'identityUid' | 'identityTokenVersion' | 'deletedAt' | 'phone'>;

export function assertPersonalStudioUser(user: LocalUser, personalToken: string | undefined) {
  if (user.deletedAt || !isPersonalUserToken(personalToken, user.id)) {
    throw new StudioBridgeError('请使用本人登录军师后再操作', 403, 'STUDIO_PERSONAL_SESSION_REQUIRED');
  }
}

export function assertStudioUser(user: LocalUser, personalToken: string | undefined): asserts user is LocalUser & { identityUid: string } {
  assertPersonalStudioUser(user, personalToken);
  if (!user.identityUid) throw new StudioBridgeError('请重新核验声量AI账号后再打开草稿', 403, 'STUDIO_IDENTITY_REQUIRED');
}

function isOrdinaryPhone(phone: string) {
  return /^1[3-9]\d{9}$/.test(phone) && phone !== '13800000000';
}

async function bindStudioUid(user: Pick<LocalUser, 'id' | 'tenantId' | 'identityTokenVersion' | 'phone'>, uid: string) {
  try {
    await prisma.$transaction(async (tx) => {
      await lockIdentityUid(tx, uid);
      await requireIdentityActive(uid, tx);
      const result = await tx.user.updateMany({
        where: { id: user.id, tenantId: user.tenantId, phone: user.phone, deletedAt: null,
          identityTokenVersion: user.identityTokenVersion,
          OR: [{ identityUid: null }, { identityUid: uid }],
        },
        data: { identityUid: uid },
      });
      if (result.count !== 1) throw new StudioBridgeError('当前军师账号已有其它绑定，请联系客服核对', 409, 'STUDIO_IDENTITY_CONFLICT');
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new StudioBridgeError('这个声量AI账号已绑定其它军师账号，请联系客服核对', 409, 'STUDIO_IDENTITY_CONFLICT');
    }
    throw error;
  }
}

async function post(url: string, body: string | Buffer, headers: Record<string, string>, signal?: AbortSignal) {
  try {
    const timeout = AbortSignal.timeout(12_000);
    const res = await fetch(url, {
      method: 'POST',
      body: typeof body === 'string' ? body : new Uint8Array(body),
      headers: { accept: 'application/json', ...headers },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      redirect: 'error',
    });
    if (!res.ok) throw new StudioUpstreamError(res.status);
    return res.status === 204 ? null : await res.json() as unknown;
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (error instanceof StudioUpstreamError) throw error;
    console.warn('[studio] 服务调用未成功', new URL(url).pathname, (error as Error).name);
    throw new StudioBridgeError('声量AI暂时无法连接，请稍后重试');
  }
}

const json = { 'content-type': 'application/json' };
const form = { 'content-type': 'application/x-www-form-urlencoded' };

async function studioMiniSubject(user: LocalUser, personalToken: string | undefined, code: unknown) {
  assertPersonalStudioUser(user, personalToken);
  if (!studioBridgeReady()) throw new StudioBridgeError('声量AI草稿暂不可用');
  const parsed = studioLoginCode.safeParse(code);
  if (!parsed.success) throw new StudioBridgeError('请在小程序内重新发起操作', 403, 'STUDIO_LOGIN_PROOF_REQUIRED');
  const result = oauthResponse.safeParse(await post(`${identityBaseUrl()}/oauth2/token`, new URLSearchParams({
    grant_type: 'urn:aibuzz:params:oauth:grant-type:wechat-mini',
    client_id: 'mini-junshi',
    scope: 'openid phone',
    code: parsed.data,
  }).toString(), form));
  if (!result.success) throw new StudioBridgeError('声量AI暂时无法核验账号');
  const token = result.data.access_token;
  const claims = await verifyIdentityToken(token);
  if (!claims || claims.azp !== 'mini-junshi' || !claims.aud.includes(JUNSHI_AUDIENCE)
      || claims.exp * 1000 <= Date.now() + OPEN_LIFETIME) {
    throw new StudioBridgeError('请先核验当前军师账号，再连接声量AI', 403, 'STUDIO_IDENTITY_MISMATCH');
  }
  if (user.identityUid && claims.sub !== user.identityUid) {
    throw new StudioBridgeError('当前登录身份与军师绑定的声量AI账号不同，请切换后重试', 403, 'STUDIO_IDENTITY_MISMATCH');
  }
  return { token, claims };
}

function studioPhoneRequired(phone: string) {
  const realPhone = isOrdinaryPhone(phone);
  return new StudioBridgeError(realPhone ? '核验与军师账号一致的手机号后，就可以继续制作。' : '请先在军师账号设置中绑定手机号，再发起制作。',
    403, realPhone ? 'STUDIO_PHONE_PROOF_REQUIRED' : 'STUDIO_LOCAL_PHONE_REQUIRED');
}

export async function studioSubjectToken(user: LocalUser, personalToken: string | undefined, code: unknown) {
  assertPersonalStudioUser(user, personalToken);
  // 未映射的历史账号先核验手机号，避免普通微信 grant 提前建一个与现有手机账号冲突的 UID。
  if (!user.identityUid) throw studioPhoneRequired(user.phone);
  const { token, claims } = await studioMiniSubject(user, personalToken, code);
  if (!claims.phoneVerified) throw studioPhoneRequired(user.phone);
  return { token, identityUid: claims.sub };
}

export async function verifyStudioPhone(user: LocalUser, personalToken: string | undefined, code: unknown, phoneCode: unknown) {
  assertPersonalStudioUser(user, personalToken);
  if (!isOrdinaryPhone(user.phone) || !studioLoginCode.safeParse(phoneCode).success) {
    throw new StudioBridgeError('请使用与军师账号一致的手机号核验身份', 400, 'STUDIO_PHONE_MISMATCH');
  }
  if (!user.identityUid) {
    const loginCode = studioLoginCode.safeParse(code);
    if (!loginCode.success) throw new StudioBridgeError('请重新发起手机号核验', 400, 'STUDIO_LOGIN_PROOF_REQUIRED');
    const verified = await verifyStudioWechatLogin(loginCode.data, String(phoneCode), user.phone);
    if (verified.phone !== user.phone || !verified.uid) {
      throw new StudioBridgeError('当前手机号无法关联军师账号，请联系客服核对', 409, 'STUDIO_IDENTITY_CONFLICT');
    }
    await bindStudioUid(user, verified.uid);
    return;
  }
  const { token, claims } = await studioMiniSubject(user, personalToken, code);
  if (claims.phoneVerified) {
    const existing = await fetchIdentityUserinfo(token);
    if (!existing.phoneVerified || existing.sub !== claims.sub || existing.phone !== user.phone) {
      throw new StudioBridgeError('当前身份的手机号与军师账号不同', 403, 'STUDIO_PHONE_MISMATCH');
    }
    return;
  }
  try {
    await center('verify-phone', { subjectToken: token, phoneCode: String(phoneCode), expectedPhone: user.phone });
  } catch (error) {
    if (error instanceof StudioUpstreamError && [403, 409].includes(error.upstreamStatus)) {
      throw new StudioBridgeError('授权的手机号与军师账号不一致，或已绑定其他账号，请核对后重试', 403, 'STUDIO_PHONE_MISMATCH');
    }
    throw error;
  }
}

const trustedLoginSchema = z.object({
  uid: z.string().min(1).nullable(), phone: z.string().regex(/^1[3-9]\d{9}$/),
  openid: z.string().min(1), unionid: z.string().nullable().optional(),
});

export async function verifyStudioWechatLogin(loginCode: string, phoneCode: string, expectedPhone?: string) {
  try { return trustedLoginSchema.parse(await center('verify-login', { loginCode, phoneCode, ...(expectedPhone ? { expectedPhone } : {}) })); }
  catch (error) {
    if (expectedPhone && error instanceof StudioUpstreamError && [403, 409].includes(error.upstreamStatus)) {
      throw new StudioBridgeError('授权的手机号与军师账号不一致，或已绑定其他账号，请核对后重试', 403, 'STUDIO_PHONE_MISMATCH');
    }
    throw new StudioBridgeError('手机号快捷登录暂不可用，请重试或使用短信验证码登录', 503, 'STUDIO_WECHAT_VERIFY_UNAVAILABLE');
  }
}

export async function bindStudioVerifiedLogin(user: Pick<LocalUser, 'id' | 'tenantId' | 'identityTokenVersion' | 'phone'>, uid: string) {
  // 快捷登录已经凭手机号定位本人；中心映射冲突只停止联动，保留军师账号登录。
  try { await bindStudioUid(user, uid); }
  catch (error) {
    console.warn('[studio] 快捷登录绑定暂不可用', user.id, (error as Error).name);
  }
}

async function center(path: string, data: Record<string, string>) {
  const secret = process.env.JUNSHI_STUDIO_CLIENT_SECRET?.trim();
  if (!studioBridgeReady() || !secret) throw new StudioBridgeError('声量AI草稿暂不可用');
  const authorization = `Basic ${Buffer.from(`junshi-s2s:${encodeURIComponent(secret)}`).toString('base64')}`;
  const machine = oauthResponse.safeParse(await post(`${identityBaseUrl()}/oauth2/token`,
    'grant_type=client_credentials&scope=studio%3Abridge', { ...form, authorization }));
  if (!machine.success) throw new StudioBridgeError('声量AI暂时无法核验授权');
  return post(`${identityBaseUrl()}/api/studio-bridge/${path}`, JSON.stringify(data),
    { ...json, authorization: `Bearer ${machine.data.access_token}` });
}

export interface StudioDelegation { ciphertext: string; expiresAt: number; identityUid: string; version: number; }

export async function studioDelegation(user: LocalUser, personalToken: string | undefined, code: unknown): Promise<StudioDelegation> {
  const subject = await studioSubjectToken(user, personalToken, code);
  const delegate = await studioMcpToken(subject.token);
  return {
    ciphertext: encryptSecret(delegate.accessToken),
    expiresAt: Date.now() + delegate.expiresIn * 1000,
    identityUid: subject.identityUid,
    version: user.identityTokenVersion,
  };
}

async function studioMcpToken(subjectToken: string) {
  const result = delegationResponse.safeParse(await center('mcp-token', { subjectToken }));
  if (!result.success) throw new StudioBridgeError('声量AI暂时无法核验草稿授权');
  return result.data;
}

export function studioDraftUrl(value: string, draft: Pick<StudioDraftCard, 'kind' | 'sceneId' | 'draftId'>) {
  try {
    const url = new URL(value);
    return url.origin === STUDIO_ORIGIN && !url.password && !url.username && !url.hash
      && url.pathname === `/${draft.kind}` && Array.from(url.searchParams.keys()).length === 2
      && url.searchParams.get('scene') === draft.sceneId && url.searchParams.get('draft') === draft.draftId;
  } catch { return false; }
}

export const StudioDraftCardSchema = z.object({
  kind: z.enum(['image', 'video']), draftId: studioId, docVersion: z.string().min(1),
  sceneId: studioId, url: z.string(), sourceMessageId: studioId, sourceScriptMessageId: studioId.nullable(),
  sourceScriptSha256: z.string().regex(/^[a-f0-9]{64}$/),
  referenceIds: z.array(studioId), referenceCount: z.number().int().nonnegative(), missing: z.array(z.string()),
  duration: z.number().optional(), ratio: z.string().optional(),
}).refine((value) => studioDraftUrl(value.url, value));

const rpcResponse = z.object({ jsonrpc: z.literal('2.0'), id: z.string(), result: z.object({
  isError: z.boolean(), content: z.tuple([z.object({ type: z.literal('text'), text: z.string() })]),
}) });

export class StudioMcp {
  private readonly token: string;

  constructor(delegation: StudioDelegation, private readonly signal: AbortSignal) {
    if (!studioBridgeReady() || !isEncrypted(delegation.ciphertext) || delegation.expiresAt <= Date.now()) {
      throw new StudioBridgeError('本次草稿授权已过期，请重新发起制作');
    }
    this.token = decryptSecret(delegation.ciphertext);
  }

  async call(name: 'list_media_scenes' | 'open_media_draft' | 'fill_media_draft' | 'prepare_reference_upload', arguments_: object) {
    const id = randomUUID();
    const result = rpcResponse.safeParse(await post(`${STUDIO_ORIGIN}${STUDIO_API}/mcp`, JSON.stringify({
      jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: arguments_ },
    }), { ...json, authorization: `Bearer ${this.token}` }, this.signal));
    if (!result.success || result.data.id !== id || result.data.result.isError) {
      throw new StudioBridgeError('声量AI草稿暂时无法保存，请稍后重试');
    }
    return JSON.parse(result.data.result.content[0].text) as unknown;
  }

  async upload(rawPermit: unknown, body: Buffer, contentType: string) {
    const permit = z.object({
      uploadUrl: z.literal(STUDIO_ORIGIN + UPLOAD_PATH), method: z.literal('POST'),
      headerName: z.literal('X-WorkBuddy-Upload'), uploadToken: z.string().min(1),
    }).parse(rawPermit);
    return post(permit.uploadUrl, body, {
      'content-type': contentType,
      'content-length': String(body.length),
      [permit.headerName]: permit.uploadToken,
    }, this.signal);
  }
}

export async function registerStudioOpen(subjectToken: string, draftId: string) {
  const openId = randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + OPEN_LIFETIME);
  const auth = await studioMcpToken(subjectToken);
  await post(`${STUDIO_ORIGIN}${STUDIO_API}/open-intents`, JSON.stringify({ openId, draftId }),
    { ...json, authorization: `Bearer ${auth.accessToken}` });
  await center('open', { subjectToken, openId });
  return {
    openId, expiresAt,
    url: `${STUDIO_ORIGIN}/junshi/open?openId=${openId}`,
  };
}

export async function approveStudioOpen(subjectToken: string, openId: string, transactionId: string) {
  await center('approve', { subjectToken, openId, transactionId });
}

export async function cancelStudioOpen(subjectToken: string, openId: string) {
  await center('cancel', { subjectToken, openId });
}
