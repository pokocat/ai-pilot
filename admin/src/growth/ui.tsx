// 「增长」组三页共用的 shadcn 皮肤件：三态 / 空态 / 状态徽标 / 人物单元 / 金额 / 分页 / 筛选条。
//
// 为什么不直接复用 components.tsx 的 ViewState、EmptyState、Pager：那三个输出的是 admin.css 的
// 组件类（`state-err` / `empty` / `pager`），在 shadcn 页里会出现「两套边框圆角、两套按钮」的拼接感。
// **语义一模一样、一条不减**：
//   ① loading / error / empty 三态不许互相冒充（接口 500 显示成「暂无数据」= 后台在事故里说谎）；
//   ② error 必须带**服务端原文** + 重试；
//   ③ 403 不是故障：不给重试按钮（再点还是 403），文案指向「找 owner 授权」；
//   ④ 已有旧数据但刷新失败 → 保留数据、错误提示放在上方，不把运营正在看的内容抽走。
// 逻辑组件（useResource / PageHead）照旧共用，不重造。

import { useEffect, useState, type ReactNode } from 'react';
import { RefreshCw, Search, TriangleAlert, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { fmtYuan } from '../format';
import type { Resource } from '../useResource';
import { personText, shortId } from './labels';
import type { AdminPersonRef } from '../api';

/* ══════════════ 三态 ══════════════ */

export function GrowthState<T>({ res, skeleton = 'rows', children }: {
  res: Resource<T>;
  skeleton?: 'rows' | 'stats' | 'none';
  children: (data: T) => ReactNode;
}) {
  if (res.error && res.data === null) {
    return <GrowthError msg={res.error} onRetry={res.reload} forbidden={res.forbidden} />;
  }
  if (res.initial) return skeleton === 'none' ? null : <GrowthSkeleton kind={skeleton} />;
  if (res.data === null) return null;
  return (
    <>
      {res.error && <GrowthError msg={res.error} onRetry={res.reload} stale forbidden={res.forbidden} />}
      {children(res.data)}
    </>
  );
}

/** forbidden=403：登录态没问题，是账户权限不够——不给重试按钮，文案指向找 owner 授权。 */
export function GrowthError({ msg, onRetry, stale = false, forbidden = false }: {
  msg: string;
  onRetry?: () => void;
  stale?: boolean;
  forbidden?: boolean;
}) {
  const title = forbidden
    ? (stale ? '权限已变化，下面是上一次的数据' : '当前账户没有查看这块内容的权限')
    : (stale ? '刷新失败，下面是上一次的数据' : '数据没能加载出来');
  return (
    <div className="my-3 flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3.5" role="alert">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-semibold text-foreground">{title}</div>
        {/* 服务端原文照抄，不换成「加载失败」——原文才带得出「租户不存在」这类真正的线索 */}
        <div className="mt-1 text-xs break-words text-muted-foreground">
          {forbidden ? `${msg} · 需要的话请让 owner 调整授权（重试无效）` : msg}
        </div>
      </div>
      {onRetry && !forbidden && (
        <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={onRetry}>
          <RefreshCw className="size-3.5" /> 重试
        </Button>
      )}
    </div>
  );
}

export function GrowthSkeleton({ kind = 'rows' }: { kind?: 'rows' | 'stats' }) {
  if (kind === 'stats') {
    return (
      <div className="space-y-3 py-3">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-20 rounded-lg" />)}
        </div>
        {[0, 1].map((i) => <Skeleton key={i} className="h-11 rounded-lg" />)}
      </div>
    );
  }
  return (
    <div className="space-y-2 py-3">
      {[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-11 rounded-lg" />)}
    </div>
  );
}

/** 空态。文案要按**当前筛选**写（「这个筛选下没有」≠「一条都还没有」），别写通用的「暂无数据」。 */
export function GrowthEmpty({ msg, hint }: { msg: string; hint?: string }) {
  return (
    <div className="my-3 rounded-lg border border-dashed bg-muted/40 px-4 py-8 text-center">
      <div className="text-[13px] text-foreground">{msg}</div>
      {hint && <div className="mt-1.5 text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

/* ══════════════ 状态徽标 ══════════════ */

export type Tone = 'ok' | 'warn' | 'bad' | 'gold' | 'muted';

// One Command Color：金=品牌动作色（gold 只给「代理」这类身份标记）；绿/赭/红只表状态。
const TONE_CLASS: Record<Tone, string> = {
  ok: 'bg-success-soft text-success',
  warn: 'bg-warning-soft text-warning',
  bad: 'bg-destructive/10 text-destructive',
  gold: 'bg-accent text-accent-foreground',
  muted: 'bg-muted text-muted-foreground',
};

export function ToneBadge({ tone, children, className }: { tone: Tone; children: ReactNode; className?: string }) {
  return (
    <Badge className={cn('border-transparent px-2 py-0.5 text-[11px] font-medium', TONE_CLASS[tone], className)}>
      {children}
    </Badge>
  );
}

/* ══════════════ 人物 / 金额 / 比例 ══════════════ */

/**
 * 表格里的「一个人」。手机号**服务端已按 maskAuditPhone 掩码**，这里原样显示（别再截一次，
 * 会把 138****1234 截成 138**）；短 id 取尾 6 位消歧，完整 id 挂在 title 上供拿去查库。
 */
export function PersonCell({ person, sub }: { person: AdminPersonRef; sub?: ReactNode }) {
  const name = person.name?.trim();
  // 没填姓名时主行就退成掩码手机号；此时副行**不再重复一遍手机号**（会渲染成
  // 「139****0003 / 139****0003 · x56gzr」，两行说同一件事，还把短 id 挤到看不见）。
  const meta = [name ? person.phone : null, shortId(person.userId)].filter(Boolean);
  return (
    <div className="min-w-0" title={`userId ${person.userId}`}>
      <div className="truncate text-[13px] text-foreground">{name || person.phone || '未填姓名'}</div>
      <div className="truncate font-mono text-[10.5px] text-muted-foreground">
        {meta.join(' · ')}
        {sub ? <> · {sub}</> : null}
      </div>
    </div>
  );
}

/** 一行式人物标签（上溯链、下钻树这种一行一人的地方用）。 */
export function personLine(person: AdminPersonRef): string {
  return personText(person.name, person.phone, person.userId);
}

/**
 * 金额（分 → 元）。负数是 clawback（追回），把负号提到 ¥ 前面——`¥-12.00` 读起来像单价写错了。
 */
export function fenText(fen: number): string {
  return fen < 0 ? `-¥${fmtYuan(-fen)}` : `¥${fmtYuan(fen)}`;
}

export function Money({ fen, className }: { fen: number; className?: string }) {
  return (
    <span className={cn('font-mono text-[12.5px] tabular-nums', fen < 0 && 'text-destructive', className)}>
      {fenText(fen)}
    </span>
  );
}

/* ══════════════ 布局件 ══════════════ */

/** 页内小节：标题 + 说明 + 右侧动作。用 border+底色分层，不做嵌套卡（DESIGN.md「No Nested Cards」）。 */
export function Section({ title, desc, actions, children, className }: {
  title: ReactNode;
  desc?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('rounded-lg border bg-card p-4', className)}>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="font-serif text-[15px] font-semibold text-foreground">{title}</h2>
          {desc && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{desc}</p>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

/** 指标卡。value 用衬线（DESIGN.md：衬线只给品牌标记 / 标题 / 关键数字）。 */
export function StatCard({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="rounded-lg border bg-card px-3.5 py-3">
      <div className="text-[11.5px] font-medium text-muted-foreground">{label}</div>
      <div className="mt-1.5 font-serif text-[21px] leading-none font-semibold text-foreground">{value}</div>
      {sub && <div className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{sub}</div>}
    </div>
  );
}

/** 筛选条容器：窄屏换行、永不横滚。 */
export function FilterRow({ children }: { children: ReactNode }) {
  return <div className="mb-3 flex flex-wrap items-center gap-2">{children}</div>;
}

/**
 * 页面级动作行（导出 / 登记 / 新增 / 生成…）。
 *
 * 为什么**不塞进 `PageHead` 的 actions**：admin.css 的 `.ph` 是不换行的 flex，
 * `.ph-actions{flex:0 0 auto}` 永不收缩，而 `.ph-b{flex:1;min-width:0}` 会被压到 0
 * ——375px 下放两个按钮，标题就竖成一列一个字（走查截到过）。旧页面每屏最多一个小按钮
 * 才侥幸没事。所以本模块的写动作一律走这一行：自己会换行，宽度多少都不会挤标题。
 */
export function ActionRow({ children }: { children: ReactNode }) {
  return <div className="mb-3 flex flex-wrap items-center gap-2">{children}</div>;
}

/** 宽表格的横滚容器：**只有表格自己横滚**，页面主体永不横滚（旧页面同一条约束）。 */
export function TableScroll({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('w-full overflow-x-auto rounded-lg border', className)}>{children}</div>;
}

export function GrowthSearch({ value, onChange, placeholder, className }: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  className?: string;
}) {
  return (
    // 窄屏独占一行：和两个不收缩的 Select 挤在同一行时，搜索框会被压到只剩「搜姓」两个字。
    <div className={cn('relative w-full min-w-0 sm:w-auto sm:flex-1 sm:max-w-72', className)}>
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
      <Input
        className="h-9 pr-8 pl-8 text-[13px]"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      {value && (
        <button
          type="button"
          className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          onClick={() => onChange('')}
          aria-label="清除搜索"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}

export function GrowthPager({ page, total, pageSize, onChange }: {
  page: number;
  total: number;
  pageSize: number;
  onChange: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
  if (pages <= 1) {
    return total ? <div className="pt-3 text-center text-[11.5px] text-muted-foreground">共 {total} 条</div> : null;
  }
  return (
    <nav className="flex items-center justify-center gap-3 pt-3" aria-label="分页">
      <Button type="button" variant="outline" size="sm" disabled={page <= 1} onClick={() => onChange(page - 1)}>上一页</Button>
      <span className="font-mono text-[11.5px] text-muted-foreground">第 {page} / {pages} 页 · 共 {total} 条</span>
      <Button type="button" variant="outline" size="sm" disabled={page >= pages} onClick={() => onChange(page + 1)}>下一页</Button>
    </nav>
  );
}

/** 非 super 的页头提示：写按钮一律**不渲染**（别摆注定 403 的按钮），但要说清为什么少了东西。 */
export function ReadOnlyNotice({ what }: { what: string }) {
  return (
    <div className="mb-3 rounded-lg border border-dashed bg-muted/40 px-3.5 py-2.5 text-xs text-muted-foreground">
      当前账户是普通运营，这一页只读：{what}需要超级管理员（owner / master）权限。
    </div>
  );
}

/* ══════════════ 小工具 ══════════════ */

/** 搜索框防抖：每敲一个字就打一次分页接口，既慢又会让「快速切筛选」的旧响应盖掉新响应。 */
export function useDebounced<T>(value: T, ms = 350): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

/** 天数窗口的可选值：`0` = 全量（关系是永久的，默认不该被窗口吃掉）。 */
export const DAY_OPTIONS: { value: string; label: string }[] = [
  { value: '0', label: '全部' },
  { value: '7', label: '7 天' },
  { value: '30', label: '30 天' },
  { value: '90', label: '90 天' },
];
