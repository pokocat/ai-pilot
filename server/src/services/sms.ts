// 短信验证码：生成/哈希/发送（console 演示 + 阿里云 provider）+ 发放/校验生命周期 + 限频。
// 安全口径：明文验证码不落库（仅 sha256(phone:code)）；按手机号限频、限尝试、限有效期；命中即消费防重放。
import crypto from 'node:crypto';
import { prisma } from '../db.js';
import { env } from '../env.js';
import type { Prisma } from '@prisma/client';

function httpError(message: string, statusCode: number, code: string) {
  return Object.assign(new Error(message), { statusCode, code });
}

/** 6 位数字验证码（100000–999999，避开前导 0 的输入歧义）。 */
export function generateCode(): string {
  return String(crypto.randomInt(100000, 1000000));
}

/** 验证码哈希：绑定手机号，避免彩虹表 / 跨号复用。 */
export function hashCode(phone: string, code: string): string {
  return crypto.createHash('sha256').update(`${phone}:${code}`).digest('hex');
}

/** 日志/审计脱敏：138****8000 */
export function maskPhone(p: string): string {
  return /^\d{11}$/.test(p) ? `${p.slice(0, 3)}****${p.slice(7)}` : p;
}

/** 测试运行（NODE_ENV=test）：一律不触达真实运营商，验证码改走演示口径回传，避免跑测打爆短信额度。 */
export function isSmsTestMode(): boolean {
  return process.env.NODE_ENV === 'test';
}

/** 是否把验证码随响应回传：测试运行 / 显式开启 / console provider 的非生产环境（便于联调/演示）。 */
export function shouldReturnDevCode(): boolean {
  return isSmsTestMode() || env.smsReturnCode || (env.smsProvider === 'console' && process.env.NODE_ENV !== 'production');
}

// ───────────────────────── 发送 provider ─────────────────────────

export interface SmsSendOutcome { ok: boolean; provider: string; detail?: string; }

/** 发送一条验证码短信。失败返回 ok:false（由上层决定是否阻断）。 */
export async function sendSmsCode(phone: string, code: string): Promise<SmsSendOutcome> {
  const ttlMin = Math.max(1, Math.round(env.smsCodeTtlSec / 60));
  // 测试运行：绝不调真实运营商（防止跑测把短信额度打爆 / 误发给真实号码）。
  if (isSmsTestMode()) {
    console.log(`[sms:test] → ${maskPhone(phone)} 验证码 ${code}（测试环境不实发，${ttlMin} 分钟内有效）`);
    return { ok: true, provider: 'test' };
  }
  if (env.smsProvider === 'aliyun') return sendViaAliyun(phone, code);
  // console：开发/演示通道，不接真实运营商，仅打印（脱敏）。验证码经响应回传给前端自动回填。
  console.log(`[sms:console] → ${maskPhone(phone)} 验证码 ${code}（${ttlMin} 分钟内有效）`);
  return { ok: true, provider: 'console' };
}

// —— 阿里云短信（Dysmsapi 2017-05-25，RPC 风格签名）——
// 模板需在阿里云控制台预先报备，变量名为 code，例如「您的验证码为 ${code}，请勿泄露」。
async function sendViaAliyun(phone: string, code: string): Promise<SmsSendOutcome> {
  const keyId = env.aliyunSmsKeyId, secret = env.aliyunSmsKeySecret;
  const signName = env.aliyunSmsSignName, templateCode = env.aliyunSmsTemplateCode;
  if (!keyId || !secret || !signName || !templateCode) {
    return { ok: false, provider: 'aliyun', detail: 'ALIYUN_SMS_* 配置不完整' };
  }
  const params: Record<string, string> = {
    Action: 'SendSms',
    Version: '2017-05-25',
    RegionId: env.aliyunSmsRegion,
    PhoneNumbers: phone,
    SignName: signName,
    TemplateCode: templateCode,
    TemplateParam: JSON.stringify({ code }),
    Format: 'JSON',
    AccessKeyId: keyId,
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    SignatureNonce: crypto.randomUUID(),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), // ISO8601 UTC，无毫秒
  };
  const signature = aliyunSignature('GET', params, secret);
  const qs = `${canonicalQuery(params)}&Signature=${percentEncode(signature)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`https://dysmsapi.aliyuncs.com/?${qs}`, { signal: controller.signal });
    const data = (await res.json()) as { Code?: string; Message?: string };
    if (data.Code === 'OK') return { ok: true, provider: 'aliyun' };
    return { ok: false, provider: 'aliyun', detail: `${data.Code}: ${data.Message}` };
  } catch (e) {
    const aborted = (e as { name?: string })?.name === 'AbortError';
    return { ok: false, provider: 'aliyun', detail: aborted ? '阿里云短信接口超时' : '阿里云短信接口不可达' };
  } finally {
    clearTimeout(timer);
  }
}

// 阿里云 RPC 签名工具（导出供单测验证编码/排序的确定性）。
/** RFC3986 百分号编码 + 阿里云特例（+→%20, *→%2A, %7E→~）。 */
export function percentEncode(s: string): string {
  return encodeURIComponent(s).replace(/\+/g, '%20').replace(/\*/g, '%2A').replace(/%7E/g, '~');
}
/** 按 key 升序拼成 canonicalized query string。 */
export function canonicalQuery(params: Record<string, string>): string {
  return Object.keys(params).sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(params[k])}`)
    .join('&');
}
/** signature = Base64(HMAC-SHA1(secret + "&", StringToSign))。 */
export function aliyunSignature(method: string, params: Record<string, string>, secret: string): string {
  const stringToSign = `${method}&${percentEncode('/')}&${percentEncode(canonicalQuery(params))}`;
  return crypto.createHmac('sha1', `${secret}&`).update(stringToSign).digest('base64');
}

// ───────────────────────── 发放 / 校验生命周期 ─────────────────────────

export interface IssueResult { cooldownSec: number; expiresInSec: number; devCode?: string; }

async function lockSmsLifecycle(db: Prisma.TransactionClient, phone: string, scene: string): Promise<void> {
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`sms:${scene}:${phone}`}))`;
}

/** 发放验证码：限频（冷却 + 每小时上限）→ 落库（哈希）→ 发送。devCode 仅在演示口径回传。 */
export async function issueSmsCode(phone: string, ip?: string, scene = 'login'): Promise<IssueResult> {
  const now = Date.now();
  const code = generateCode();

  await prisma.$transaction(async (tx) => {
    await lockSmsLifecycle(tx, phone, scene);

    // 冷却：上一条距今不足 cooldown → 拒绝（防轰炸）。
    const last = await tx.smsCode.findFirst({
      where: { phone, scene },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    if (last) {
      const sinceSec = (now - last.createdAt.getTime()) / 1000;
      if (sinceSec < env.smsResendCooldownSec) {
        throw httpError(`请 ${Math.ceil(env.smsResendCooldownSec - sinceSec)} 秒后再获取`, 429, 'SMS_TOO_FREQUENT');
      }
    }
    // 每小时上限：防止单号被刷爆运营商额度。
    const hourAgo = new Date(now - 3600_000);
    const recent = await tx.smsCode.count({ where: { phone, createdAt: { gte: hourAgo } } });
    if (recent >= env.smsMaxPerHour) {
      throw httpError('获取过于频繁，请稍后再试', 429, 'SMS_RATE_LIMITED');
    }

    await tx.smsCode.create({
      data: { phone, scene, ip, codeHash: hashCode(phone, code), expiresAt: new Date(now + env.smsCodeTtlSec * 1000) },
    });
  });
  const out = await sendSmsCode(phone, code);
  if (!out.ok) throw httpError(out.detail || '短信发送失败，请稍后再试', 502, 'SMS_SEND_FAILED');

  return {
    cooldownSec: env.smsResendCooldownSec,
    expiresInSec: env.smsCodeTtlSec,
    devCode: shouldReturnDevCode() ? code : undefined,
  };
}

/** 校验验证码：取最近一条未消费的；命中即消费，错误累加尝试次数（超限作废）。 */
export async function verifySmsCode(phone: string, code: string, scene = 'login'): Promise<boolean> {
  const row = await prisma.smsCode.findFirst({
    where: { phone, scene, consumedAt: null }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  if (!row) return false;
  if (row.expiresAt.getTime() < Date.now()) return false;
  if (row.attempts >= env.smsMaxAttempts) return false;

  if (row.codeHash === hashCode(phone, code)) {
    const consumed = await prisma.smsCode.updateMany({
      where: { id: row.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    return consumed.count === 1;
  }
  await prisma.smsCode.updateMany({
    where: { id: row.id, consumedAt: null, attempts: { lt: env.smsMaxAttempts } },
    data: { attempts: { increment: 1 } },
  });
  return false;
}
