export type AuthReason =
  | 'chat'
  | 'history'
  | 'search'
  | 'upload'
  | 'save'
  | 'purchase'
  | 'profile'
  | 'execute';

const REASON_TEXT: Record<AuthReason, string> = {
  chat: '登录后，军师才能记住你的处境并继续这次对话。',
  history: '登录后可查看并继续你过去的问策记录。',
  search: '登录后可搜索你的会话、案卷、方案与资料。',
  upload: '登录后才能把资料安全存入你的专属智库。',
  save: '登录后才能把这份内容保存到你的账号。',
  purchase: '登录后才能确认购买并把权益发到你的账号。',
  profile: '登录后才能查看和维护你的个人档案。',
  execute: '登录后才能创建、打卡和复盘你的军令。',
};

export function authReasonText(reason?: AuthReason): string {
  return reason ? REASON_TEXT[reason] : '登录后可保存进度，并让军师持续理解你。';
}

/** 只有请求发出时确实带着登录凭证，401 才表示“登录态失效”；游客访问私有接口只需留在原页面。 */
export function shouldInterruptForUnauthorized(tokenAtRequest: string): boolean {
  return tokenAtRequest.trim().length > 0;
}
