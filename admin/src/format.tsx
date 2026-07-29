// 运营后台共享格式化与微组件：金额 / token / 时间 / 审计标签 / KV 格。
// 从旧 App.tsx 尾部抽出——原先 25 个 view 组件和这些工具函数挤在同一个 2841 行文件里。
import { type ReactNode } from 'react';
import { type AgentBilling, type AdminUserItem, type AdminUserPlanStatus, type AdminAuditItem } from './api';
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div className="ai-field"><div className="ai-fl">{label}</div>{children}</div>;
}

export function KV({ k, v }: { k: string; v: string }) {
  return <div className="kv"><span>{k}</span><b>{v}</b></div>;
}

export function sum(list: AdminUserItem[], key: 'sessionCount' | 'deliverableCount') {
  return list.reduce((n, item) => n + item[key], 0);
}

export function fmtTime(s: string) {
  return s.replace('T', ' ').replace('Z', '');
}

export function fmtShortTime(s: string) {
  return fmtTime(s).slice(5);
}

export function creditText(v: number) {
  return v < 0 ? '不限量' : `${v} 点`;
}

export function actorText(a: AdminAuditItem) {
  const name = a.userName || '匿名/未解析用户';
  const parts = [name, a.userPhone, a.tenantName, a.userId ? `user:${a.userId}` : null].filter(Boolean);
  return parts.join(' · ') || '无账号上下文';
}

export function compactActorText(a: AdminAuditItem) {
  return a.userName || a.userPhone || (a.userId ? `user:${a.userId.slice(0, 6)}` : '匿名');
}

export function mobileAuditMeta(a: AdminAuditItem) {
  return [compactActorText(a), a.ip].filter(Boolean).join(' · ');
}

export function auditTarget(a: AdminAuditItem) {
  return a.path || auditLabel(a.action);
}

export function actionKind(action: string) {
  if (action.endsWith('.http')) return 'API';
  if (action.includes('login') || action.includes('auth')) return 'AUTH';
  return 'ACT';
}

export function statusClass(status: number | null) {
  if (status === null) return 'muted';
  if (status >= 500) return 'bad';
  if (status >= 400) return 'warn';
  return 'ok';
}

export function formatPayload(payload: unknown) {
  if (payload === null || payload === undefined) return '{}';
  if (typeof payload === 'string') {
    try { return JSON.stringify(JSON.parse(payload), null, 2); }
    catch { return payload; }
  }
  try { return JSON.stringify(payload, null, 2); }
  catch { return String(payload); }
}

export function auditLabel(action: string) {
  const labels: Record<string, string> = {
    'auth.http': '登录 API 行为',
    'admin.http': '后台 API 行为',
    'auth.register': '手机号注册',
    'auth.login': '手机号登录',
    'auth.sms.send_attempt': '短信验证码尝试',
    'auth.login.attempt': '手机号登录尝试',
    'auth.wechat_register': '微信注册',
    'auth.wechat_login': '微信登录',
    'auth.wechat_login.attempt': '微信登录尝试',
    'auth.wechat_phone.attempt': '本机号登录尝试',
    'auth.carrier_onetap.attempt': '运营商一键登录尝试',
    'auth.onetap_register': '一键登录注册',
    'auth.onetap_login': '一键登录',
    'admin.agent.publish': '功能上架',
    'admin.agent.unpublish': '功能下架',
    'admin.agent.update': '智能体配置变更',
    'admin.agent.create': '新增智能体',
    'admin.agentversion.publish': '发布新版本',
    'admin.agentversion.rollback': '回滚版本',
    'admin.eval.run': '发起评测跑分',
    'admin.account.create': '新增运营账户',
    'admin.account.update': '运营账户变更',
    'admin.user.agent.grant': '后台开通智能体',
    'admin.user.agent.revoke': '取消智能体开通',
    'user.agent.purchase': '用户解锁智能体',
    'admin.ai.update': '模型配置变更',
    'admin.ai.model.add': '添加模型',
    'admin.ai.model.update': '编辑模型',
    'admin.ai.model.delete': '删除模型',
    'admin.ai.model.activate': '快速切换模型',
    'admin.account.init': '初始化后台账户',
    'admin.account.init_attempt': '后台初始化尝试',
    'admin.account.login': '后台账户登录',
    'admin.account.login_attempt': '后台登录尝试',
    'admin.account.password': '修改后台密码',
    'admin.account.password_attempt': '后台改密尝试',
    'admin.saying.create': '新增每日献策',
    'admin.saying.update': '更新每日献策',
    'admin.saying.delete': '删除每日献策',
    'admin.survey.update': '问卷配置变更',
    'admin.plan.update': '套餐配置变更',
    'user.plan.purchase': '用户购买套餐',
    'user.http': '用户 API 行为',
    'user.generate': '用户发起产出',
    'user.profile.create': '用户完成建档',
    'user.profile.update': '用户更新建档',
    'user.color.update': '用户更换本命色',
    'user.library.create': '用户存入方案库',
    'user.library.delete': '用户删除方案',
    'user.session.summarize': '用户生成纪要',
  };
  return labels[action] ?? action;
}

export function typeLabel(t: string) { return t === 'advisory' ? '出谋' : t === 'creative' ? '出活' : t === 'custom' ? '自定义' : '通用'; }

export function billingTag(billing: AgentBilling, price: number) {
  if (billing === 'free') return <span className="tag">赠送</span>;
  if (billing === 'metered') return <span className="tag pay">按次 {price}</span>;
  return <span className="tag pay">{price} 点</span>;
}

export function sourceLabel(source: string | null) {
  return source === 'purchase' ? '已购买' : source === 'admin_grant' ? '后台开通' : source === 'gift' ? '赠送' : '已开通';
}

export function fmtTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

export function fmtCny(micros: number): string {
  const cny = micros / 1e6;
  if (cny === 0) return '¥0';
  return cny < 1 ? `¥${cny.toFixed(4)}` : `¥${cny.toFixed(2)}`;
}

export function fmtYuan(fen: number): string {
  return (fen / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtSize(b: number | null): string {
  if (!b) return '';
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)}KB`;
  return `${(b / 1024 / 1024).toFixed(1)}MB`;
}

// A1：用户「用量与额度」块——月度额度 meter + 30 天 token/成本 + byAgent/byModel/byDay + 折叠流水 + 运营动作。
export function planStatusText(p: AdminUserPlanStatus): string {
  if (!p.planName) return '无套餐';
  const parts: string[] = [];
  const st = p.status === 'active' ? '生效中' : p.status === 'expired' ? '已过期' : p.status === 'none' ? '无套餐' : p.status;
  if (st) parts.push(st);
  if (p.daysLeft != null) parts.push(`剩 ${p.daysLeft} 天`);
  return parts.join(' · ') || '—';
}