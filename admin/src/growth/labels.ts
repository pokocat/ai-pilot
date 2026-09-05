// 「增长」组共用的人话表与人物标签。
//
// 为什么单独成文件：这几张表原来只在 `views/referral.tsx` 里（只读的邀请增长页），现在
// 「邀请关系」的归因日志、「邀请链」的每一跳、「代理分销」的流水都要显示同一批枚举。
// 复制一份的必然结果是两屏对同一个 `outcome` 说不同的话——运营会当成两件事。
// 所以抽到这里，`views/referral.tsx` 改成 import（它的逻辑一行没动）。
//
// 纯 .ts、零依赖：旧页面 import 它不会把 shadcn / Tailwind 拖进旧目录
// （DESIGN.md「shadcn 模块（增长组）」那条禁令只禁 `@/components/ui`）。

import type {
  CommissionKind, CommissionStatus, DistributionItemType, DistributorStatus,
  ReferralBindingOutcome, ReferralSource, SettlementStatus,
} from '../api';

/** 归因结果的人话（服务端回的是机器可读的 outcome 值）。 */
export const OUTCOME_LABEL: Record<string, string> = {
  bound: '成功建边',
  self: '自己的码',
  cycle: '会成环',
  unknown_code: '码不存在',
  expired: '超出归因窗口',
  already_bound: '已绑过别人',
  config_unavailable: '配置读取失败（未建边）',
  no_timestamp: '缺捕获时间（未建边）',
};

export const SOURCE_LABEL: Record<string, string> = {
  share_friend: '转发好友',
  share_timeline: '朋友圈',
  poster_qr: '海报扫码',
  manual: '运营补绑',
};

export function outcomeText(k: string): string { return OUTCOME_LABEL[k] ?? k; }
export function sourceText(k: string): string { return SOURCE_LABEL[k] ?? k; }

/**
 * 补绑结果该用什么口吻。`bound` 是成功，其余七种都是「没建成，原因是…」——
 * 它们是 200 的业务结果，不是请求失败，所以不能当红色错误弹，也不能当成功绿。
 */
export function outcomeTone(k: ReferralBindingOutcome | string): 'ok' | 'warn' | 'bad' {
  if (k === 'bound') return 'ok';
  if (k === 'config_unavailable' || k === 'no_timestamp') return 'bad';
  return 'warn';
}

/**
 * 短 id：取 id 的**尾部** 6 位，不是别处那种头部 8 位。
 *
 * 本仓的 id 是 cuid（`c` + 8 位 base36 毫秒时间戳 + 计数 + 指纹 + 8 位随机）。`slice(0, 8)`
 * 等于「c + 时间戳的前 7 位」——同一个 ~36ms 窗口里建出来的号，头部完全相同。而这几块屏要消歧的
 * 恰恰是「同一批被刷出来的新号」，用头部就等于在最需要区分的场景里失效。尾部落在随机块上，
 * 6 位 base36 ≈ 22 亿种，够用。别处的 `slice(0, 8)` 是给人工对一眼用的，这里不跟随那个惯例。
 */
export function shortId(userId: string): string {
  return userId.length > 6 ? userId.slice(-6) : userId;
}

/**
 * 一个人在界面上的标签。**永远带短 id**（2026-08-18 复审的应改项）。
 *
 * 上一轮把手机号收成掩码（阻断修复，不能退回完整号码），代价是识人信息随之变少：两个还没补姓名、
 * 号段又同前三后四的新号，在同一个风险组里显示得**完全一样**——而「连号批量注册」正是刷号的典型
 * 形状，也就是说最需要区分的时候一定区分不出来。响应里本来就有 `userId`，把它的短形接在标签后面
 * 即可消歧；完整 id 放在 title / tooltip 里（悬停或长按可见），需要拿去查库时不用另找入口。
 */
export function personText(name: string | null, phone: string | null, userId: string): string {
  const label = name?.trim() || phone || '';
  return label ? `${label} · ${shortId(userId)}` : `#${shortId(userId)}`;
}

/* ── 「增长」组自己的枚举人话（旧页面没有这些状态） ── */

/** 被邀人的开通状态（planGate 口径：有 planId 且未到期 = 已开通）。 */
export const ACTIVATION_LABEL: Record<string, string> = {
  activated: '已开通',
  registered: '仅注册',
};

export const DISTRIBUTOR_STATUS_LABEL: Record<DistributorStatus | string, string> = {
  pending: '待审',
  active: '生效中',
  suspended: '暂停计提',
  terminated: '已终止',
};

/** 代理状态的语义色：只表状态，不作装饰（DESIGN.md「The Status Is Not Brand Rule」）。 */
export function distributorTone(s: DistributorStatus | string): 'ok' | 'warn' | 'bad' | 'muted' {
  if (s === 'active') return 'ok';
  if (s === 'suspended') return 'warn';
  if (s === 'terminated') return 'bad';
  return 'muted';
}

export const COMMISSION_STATUS_LABEL: Record<CommissionStatus | string, string> = {
  pending: '冻结期',
  confirmed: '可结算',
  settled: '已结算',
  reversed: '已冲销',
};

export const COMMISSION_KIND_LABEL: Record<CommissionKind | string, string> = {
  accrual: '计提',
  clawback: '追回',
};

export const SETTLEMENT_STATUS_LABEL: Record<SettlementStatus | string, string> = {
  draft: '草稿',
  approved: '已核',
  paid: '已打款',
  void: '已作废',
};

export function settlementTone(s: SettlementStatus | string): 'ok' | 'warn' | 'bad' | 'muted' {
  if (s === 'paid') return 'ok';
  if (s === 'approved') return 'warn';
  if (s === 'void') return 'bad';
  return 'muted';
}

/** 计提规则的商品维度。`all` 是兜底，精确类型优先（服务端匹配顺序，界面上要说清楚）。 */
export const ITEM_TYPE_LABEL: Record<DistributionItemType | string, string> = {
  plan: '套餐',
  sku: '单次付费',
  all: '全部（兜底）',
};

export const REFERRAL_SOURCE_OPTIONS: { value: ReferralSource; label: string }[] = [
  { value: 'share_friend', label: '转发好友' },
  { value: 'share_timeline', label: '朋友圈' },
  { value: 'poster_qr', label: '海报扫码' },
  { value: 'manual', label: '运营补绑' },
];

export const OUTCOME_OPTIONS: { value: ReferralBindingOutcome; label: string }[] =
  (Object.keys(OUTCOME_LABEL) as ReferralBindingOutcome[]).map((k) => ({ value: k, label: OUTCOME_LABEL[k] }));

/**
 * ISO 时刻 → 北京时间的自然日（YYYY-MM-DD）。
 *
 * **别用 `iso.slice(0, 10)`**：服务端下发的是 UTC ISO，结算周期又是运营按北京时间自然日选的，
 * 直接切前 10 位会把「2026-08-01 起」显示成「2026-07-31」——运营会以为自己选错了周期，
 * 或者以为系统把周期挪了一天。结算周期错一天就是钱错一笔，这不是排版问题。
 * （行内时间戳仍走 format.tsx 的 `fmtTime`，那是全站既有口径，不在这条里改。）
 */
export function beijingDay(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso.slice(0, 10);
  return new Date(t + 8 * 3600_000).toISOString().slice(0, 10);
}

/** 万分比 → 百分比文本（两位小数）。rateBp=250 → 「2.50%」。 */
export function rateText(rateBp: number): string {
  return `${(rateBp / 100).toFixed(2)}%`;
}
