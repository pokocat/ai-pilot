import type { AppMode } from './config';

/** 服务端签名登录态为三段 JWT；本地 mock token（mock-/local-）不是 JWT。 */
export function isSignedUserToken(token: string): boolean {
  const parts = token.trim().split('.');
  return parts.length === 3 && parts.every(Boolean);
}

export function shouldUseMock(mode: AppMode, token: string): boolean {
  return mode === 'mock' && !isSignedUserToken(token);
}

export function resolveRuntimeBaseUrl(
  mode: AppMode,
  baseUrl: string,
  impersonationBaseUrl: string,
  token: string
): string {
  return mode === 'mock' && isSignedUserToken(token) ? impersonationBaseUrl : baseUrl;
}
