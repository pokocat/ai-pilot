// 密钥/敏感字段对称加密（AES-256-GCM，Node 内置 crypto，零外部依赖）。
//
// 设计目标：把存库的明文密钥（AiSetting/AiModel/Agent.apiKey、difyApiKey、SkillTool 鉴权头…）
// 改为「写时加密、读时解密」，同时**向后兼容**历史明文：
//   - 加密产物带版本前缀 `enc:v1:`，解密时据此判别；无前缀 → 视为历史明文，原样返回。
//   - 未配置 APP_ENCRYPTION_KEY 时退化为透传（演示/本地零配置仍可跑），仅在写入时不加密。
// 这样上线只需设一个环境变量并对存量字段跑一次回填脚本（scripts/encryptSecrets.ts），无需停机改造读路径。

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const PREFIX = 'enc:v1:';
const SCRYPT_SALT = 'junshi.secretbox.v1'; // 固定盐：密钥派生用，非口令哈希，无需随机
let cachedKey: Buffer | null = null;
let cachedSecret = '';

function masterSecret(): string {
  // 兼容多种命名：优先专用变量，其次复用 admin 主密钥（运维少配一个）。
  return process.env.APP_ENCRYPTION_KEY ?? process.env.SECRET_ENCRYPTION_KEY ?? '';
}

/** 是否已启用加密（配置了主密钥）。未启用时写入走明文透传。 */
export function encryptionEnabled(): boolean {
  return !!masterSecret().trim();
}

function deriveKey(): Buffer {
  const secret = masterSecret();
  if (!secret) throw new Error('APP_ENCRYPTION_KEY 未配置');
  if (cachedKey && cachedSecret === secret) return cachedKey;
  cachedKey = scryptSync(secret, SCRYPT_SALT, 32);
  cachedSecret = secret;
  return cachedKey;
}

/** 是否为本模块产出的密文（带版本前缀）。 */
export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

/**
 * 加密明文。未配主密钥时原样返回（透传，演示兼容）；空串/已是密文则原样返回（幂等）。
 * 返回格式：`enc:v1:<ivB64>:<tagB64>:<cipherB64>`
 */
export function encryptSecret(plain: string | null | undefined): string {
  const text = plain ?? '';
  if (!text) return '';
  if (isEncrypted(text)) return text; // 幂等：已加密不二次加密
  if (!encryptionEnabled()) return text; // 透传
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(), iv);
  const ct = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + [iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
}

/**
 * 解密。无前缀 → 历史明文，原样返回；有前缀但未配主密钥 → 抛错（避免静默返回密文当明文用）。
 */
export function decryptSecret(value: string | null | undefined): string {
  const text = value ?? '';
  if (!text) return '';
  if (!isEncrypted(text)) return text; // 历史明文兼容
  if (!encryptionEnabled()) {
    throw new Error('字段已加密但 APP_ENCRYPTION_KEY 未配置，无法解密');
  }
  const body = text.slice(PREFIX.length);
  const [ivB64, tagB64, ctB64] = body.split(':');
  if (!ivB64 || !tagB64 || !ctB64) throw new Error('密文格式非法');
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}

/** 解密但不抛错：失败/未配密钥时返回空串，用于「能读则读、不能读当未配置」的降级读路径。 */
export function decryptSecretSafe(value: string | null | undefined): string {
  try {
    return decryptSecret(value);
  } catch {
    return '';
  }
}
