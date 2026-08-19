// 生产鉴权配置闸门：任何启用的登录通道都必须真正可用，且登录态只允许强 JWT。
// 该模块保持纯函数，便于启动前 fail-fast 与单测共用；路由只读取同一组 enable 判定。

export type AuthConfigSource = Record<string, string | undefined>;

function enabled(source: AuthConfigSource, name: string, productionDefault: boolean): boolean {
  const raw = source[name]?.trim().toLowerCase();
  if (!raw) return productionDefault;
  return raw === 'true' || raw === '1';
}

function value(source: AuthConfigSource, ...names: string[]): string {
  for (const name of names) {
    const candidate = source[name]?.trim();
    if (candidate) return candidate;
  }
  return '';
}

export function smsLoginEnabled(source: AuthConfigSource = process.env): boolean {
  return enabled(source, 'AUTH_SMS_LOGIN_ENABLED', true);
}

export function wechatLoginEnabled(source: AuthConfigSource = process.env): boolean {
  return enabled(source, 'AUTH_WECHAT_LOGIN_ENABLED', true);
}

export function productionAuthConfigErrors(source: AuthConfigSource): string[] {
  if (source.NODE_ENV !== 'production') return [];

  const errors: string[] = [];
  const jwtSecret = value(source, 'APP_JWT_SECRET');
  const weakSecret = /fake|replace|change[-_ ]?me|your[-_ ]?secret|example/i.test(jwtSecret)
    || new Set(jwtSecret).size < 8;
  if (Buffer.byteLength(jwtSecret, 'utf8') < 32 || weakSecret) {
    errors.push('APP_JWT_SECRET 必须是至少 32 字节的高强度随机串');
  }
  if (value(source, 'APP_JWT_REQUIRED').toLowerCase() !== 'true') {
    errors.push('APP_JWT_REQUIRED 必须为 true，生产不得接受裸 userId token');
  }

  const smsEnabled = smsLoginEnabled(source);
  const wechatEnabled = wechatLoginEnabled(source);
  if (!smsEnabled && !wechatEnabled) {
    errors.push('AUTH_SMS_LOGIN_ENABLED 与 AUTH_WECHAT_LOGIN_ENABLED 不能同时关闭');
  }

  if (smsEnabled) {
    if (value(source, 'SMS_REQUIRE_CODE').toLowerCase() !== 'true') {
      errors.push('启用短信登录时 SMS_REQUIRE_CODE 必须为 true');
    }
    if (value(source, 'SMS_PROVIDER').toLowerCase() !== 'aliyun') {
      errors.push('生产启用短信登录时 SMS_PROVIDER 必须为 aliyun');
    }
    const requiredSms = [
      'ALIYUN_SMS_ACCESS_KEY_ID',
      'ALIYUN_SMS_ACCESS_KEY_SECRET',
      'ALIYUN_SMS_SIGN_NAME',
      'ALIYUN_SMS_TEMPLATE_CODE',
    ];
    const missing = requiredSms.filter((name) => !value(source, name));
    if (missing.length) errors.push(`短信登录缺少配置：${missing.join(', ')}`);
  }

  if (wechatEnabled) {
    if (!value(source, 'WECHAT_MINI_APPID', 'WECHAT_APPID')) {
      errors.push('快捷登录缺少 WECHAT_MINI_APPID');
    }
    if (!value(source, 'WECHAT_MINI_SECRET', 'WECHAT_APPSECRET')) {
      errors.push('快捷登录缺少 WECHAT_MINI_SECRET');
    }
  }

  return errors;
}

export function assertProductionAuthSafe(source: AuthConfigSource = process.env): void {
  const errors = productionAuthConfigErrors(source);
  if (!errors.length) return;
  throw Object.assign(
    new Error(`[安全配置错误] 生产鉴权拒绝启动：\n  - ${errors.join('\n  - ')}`),
    { code: 'UNSAFE_PRODUCTION_AUTH_CONFIG', errors },
  );
}
