import { APP_MODE, BASE_URL, IMPERSONATION_BASE_URL } from './config';
import { getToken } from './token';
import { resolveRuntimeBaseUrl, shouldUseMock } from './runtimeModeCore';
export { isSignedUserToken, resolveRuntimeBaseUrl, shouldUseMock } from './runtimeModeCore';

// mock 构建下，一旦附身 token 校验通过并落 storage，后续所有业务必须随该真实身份走服务端。
export function useMockApi(): boolean {
  return shouldUseMock(APP_MODE, getToken());
}

export function getApiBaseUrl(): string {
  return resolveRuntimeBaseUrl(APP_MODE, BASE_URL, IMPERSONATION_BASE_URL, getToken());
}
