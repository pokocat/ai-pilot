// 增长 · 邀请关系：关系账本（Referral 一行一条边）+ 归因日志（ReferralAttribution 全留痕）。
//
// 这一页回答的是**具体的一条关系**：谁邀了谁、用哪个码、什么时候绑上的、被邀人开通了没、
// 付过钱没有。看整体形状请去「邀请增长」；看一个人的整条链请去「邀请链」。
//
// 两个 tab 分别对应两张表，**不是一份数据的两种排序**：
//   · 关系账本 = 建成了的边（Referral），一人最多一条，永久有效；
//   · 归因日志 = 每一次尝试的留痕（ReferralAttribution），**含失败**（self / cycle / 码不存在…）。
//     「为什么这个人没绑上」只能在这里查到——账本里根本没有那一行。
// 所以两个 tab 各自持有取数、切到哪个才挂载（Radix Tabs 之外自己控渲染，见下方注释）。
//
// 写操作只有一个：运营补绑（super）。它只给**尚无推荐人**的用户建边，不改绑不解绑
// （关系不可变更公理）。补绑结果里 `bound` 之外的七种 outcome 都是 **200 的业务结果**，
// 要当「没建成，原因是…」展示——弹成红色故障会让运营去查网络。

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Download, Link2, TriangleAlert, UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { ScRoot } from '@/lib/scPortal';
import {
  api, downloadInvitesCsv,
  type AdminInviteAttribution, type AdminInviteAttributionList, type AdminInviteEdge,
  type AdminInviteAttributionQuery, type AdminInviteList, type AdminInviteListQuery,
  type AdminManualBindResult, type AdminPlanActivation,
  type AdminReferralTenantOption, type ReferralBindingOutcome, type ReferralSource,
} from '../api';
import { PageHead } from '../components';
import { fmtTime } from '../format';
import { useResource, type Resource } from '../useResource';
import {
  ACTIVATION_LABEL, OUTCOME_OPTIONS, REFERRAL_SOURCE_OPTIONS,
  outcomeText, outcomeTone, sourceText,
} from './labels';
import {
  ActionRow, DAY_OPTIONS, FilterRow, GrowthEmpty, GrowthPager, GrowthSearch, GrowthState,
  Money, PersonCell, ReadOnlyNotice, TableScroll, ToneBadge, useDebounced,
} from './ui';

const PAGE_SIZE = 20;
/** Radix Select 不接受空串 value，用哨兵值表示「不筛」。 */
const ANY = '__any__';

type Tab = 'ledger' | 'attributions';

interface Filters {
  q: string;
  source: string;
  status: string;
  outcome: string;
  tenantId: string;
  /** '0' = 全部（关系是永久的，缺省不该被时间窗吃掉） */
  days: string;
}

const EMPTY_FILTERS: Filters = { q: '', source: ANY, status: ANY, outcome: ANY, tenantId: ANY, days: '0' };

export function InvitesView({ isSuper, onOpenChain, toast }: {
  isSuper: boolean;
  onOpenChain: (userId: string) => void;
  toast: (m: string) => void;
}) {
  const [tab, setTab] = useState<Tab>('ledger');
  const [f, setF] = useState<Filters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [bindOpen, setBindOpen] = useState(false);
  const debouncedQ = useDebounced(f.q);

  // 租户筛选项自己是一个 Resource：读失败要显示成「筛选项没加载出来」，不能伪装成
  // 「暂无带邀请关系的租户」（业务空态与读失败不许混）。两个 tab 共用一份，不随 tab/筛选重取。
  const tenants = useResource(useCallback(() => api.referralTenants(), []), []);

  const patch = (next: Partial<Filters>) => { setF((prev) => ({ ...prev, ...next })); setPage(1); };
  const switchTab = (next: Tab) => { setTab(next); setPage(1); };

  /* query 必须 memo：`useResource` 的 deps 里放一个每次渲染都新建的对象字面量 = 无限重取。
     两个 tab 各一份（字段集不同：账本筛开通状态，日志筛归因结果）。 */
  const ledgerQuery = useMemo<AdminInviteListQuery>(() => ({
    q: debouncedQ.trim() || undefined,
    source: f.source === ANY ? undefined : (f.source as ReferralSource),
    status: f.status === ANY ? undefined : (f.status as AdminPlanActivation),
    tenantId: f.tenantId === ANY ? undefined : f.tenantId,
    days: Number(f.days) || undefined,
    page,
    pageSize: PAGE_SIZE,
  }), [debouncedQ, f.source, f.status, f.tenantId, f.days, page]);

  const attrQuery = useMemo<AdminInviteAttributionQuery>(() => ({
    q: debouncedQ.trim() || undefined,
    source: f.source === ANY ? undefined : f.source,
    outcome: f.outcome === ANY ? undefined : (f.outcome as ReferralBindingOutcome),
    tenantId: f.tenantId === ANY ? undefined : f.tenantId,
    days: Number(f.days) || undefined,
    page,
    pageSize: PAGE_SIZE,
  }), [debouncedQ, f.source, f.outcome, f.tenantId, f.days, page]);

  const bar = (
    <>
      <FilterRow>
        <GrowthSearch
          value={f.q}
          onChange={(v) => patch({ q: v })}
          placeholder={tab === 'ledger' ? '搜姓名 / 手机号 / 邀请码 / userId' : '搜姓名 / 手机号 / 邀请码'}
        />
        <Select value={f.source} onValueChange={(v) => patch({ source: v })}>
          <SelectTrigger className="h-9 w-[7.5rem] text-[13px]" aria-label="按来源筛选">
            <SelectValue placeholder="来源" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>全部来源</SelectItem>
            {REFERRAL_SOURCE_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
          </SelectContent>
        </Select>
        {tab === 'ledger' ? (
          <Select value={f.status} onValueChange={(v) => patch({ status: v })}>
            <SelectTrigger className="h-9 w-[8rem] text-[13px]" aria-label="按被邀人开通状态筛选">
              <SelectValue placeholder="开通状态" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>开通状态不限</SelectItem>
              <SelectItem value="activated">已开通</SelectItem>
              <SelectItem value="registered">仅注册</SelectItem>
            </SelectContent>
          </Select>
        ) : (
          <Select value={f.outcome} onValueChange={(v) => patch({ outcome: v })}>
            <SelectTrigger className="h-9 w-[9.5rem] text-[13px]" aria-label="按归因结果筛选">
              <SelectValue placeholder="归因结果" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>结果不限</SelectItem>
              {OUTCOME_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
        <TenantSelect res={tenants} value={f.tenantId} onChange={(v) => patch({ tenantId: v })} />
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={f.days}
          onValueChange={(v) => { if (v) patch({ days: v }); }}
          aria-label={tab === 'ledger' ? '按绑定时间筛选' : '按留痕时间筛选'}
        >
          {DAY_OPTIONS.map((o) => (
            <ToggleGroupItem key={o.value} value={o.value} className="text-[12px]">{o.label}</ToggleGroupItem>
          ))}
        </ToggleGroup>
      </FilterRow>
      {tenants.error && (
        <div className="mb-3 flex items-center gap-2 text-[11.5px] text-destructive" role="alert">
          <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
          租户筛选项没加载出来（{tenants.error}）——这不代表没有租户
          <Button type="button" variant="link" size="sm" className="h-auto p-0 text-[11.5px]" onClick={tenants.reload}>重试</Button>
        </div>
      )}
    </>
  );

  const tabs = (
    <Tabs value={tab} onValueChange={(v) => switchTab(v as Tab)}>
      <TabsList className="mb-3">
        <TabsTrigger value="ledger" className="text-[13px]">关系账本</TabsTrigger>
        <TabsTrigger value="attributions" className="text-[13px]">归因日志</TabsTrigger>
      </TabsList>
    </Tabs>
  );

  /* 不用 TabsContent 承载正文：页头（PageHead）要挂当前 tab 那份数据的「刚刚更新」与刷新按钮，
     而两个 tab 的 Resource 各自在子组件里。所以 Tabs 只当分段控件用，正文按 tab 条件渲染
     ——切到哪个才挂载哪份取数（同 views/referral.tsx 的理由）。 */
  return (
    <ScRoot>
      {tab === 'ledger' ? (
        <LedgerSection
          query={ledgerQuery}
          isSuper={isSuper}
          page={page}
          onPage={setPage}
          onOpenChain={onOpenChain}
          onOpenBind={() => setBindOpen(true)}
          toast={toast}
        >
          {tabs}
          {bar}
        </LedgerSection>
      ) : (
        <AttributionSection
          query={attrQuery}
          page={page}
          onPage={setPage}
          onOpenChain={onOpenChain}
        >
          {tabs}
          {bar}
        </AttributionSection>
      )}
      {bindOpen && (
        <ManualBindDialog
          onClose={() => setBindOpen(false)}
          onOpenChain={onOpenChain}
          toast={toast}
        />
      )}
    </ScRoot>
  );
}

function TenantSelect({ res, value, onChange }: {
  res: Resource<AdminReferralTenantOption[]>;
  value: string;
  onChange: (v: string) => void;
}) {
  const list = res.data ?? [];
  return (
    <Select value={value} onValueChange={onChange} disabled={res.initial}>
      <SelectTrigger className="h-9 w-[9rem] text-[13px]" aria-label="按租户筛选">
        <SelectValue placeholder="租户" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ANY}>全部租户</SelectItem>
        {list.map((t) => (
          <SelectItem key={t.tenantId} value={t.tenantId}>{t.name}（{t.edges}）</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/* ══════════════ 关系账本 ══════════════ */

function LedgerSection({ query, isSuper, page, onPage, onOpenChain, onOpenBind, toast, children }: {
  query: AdminInviteListQuery;
  isSuper: boolean;
  page: number;
  onPage: (p: number) => void;
  onOpenChain: (userId: string) => void;
  onOpenBind: () => void;
  toast: (m: string) => void;
  children: ReactNode;
}) {
  const res = useResource(useCallback(() => api.invites(query), [query]), [query]);
  const [exporting, setExporting] = useState(false);

  const exportCsv = async () => {
    setExporting(true);
    try {
      await downloadInvitesCsv(query);
      toast('已开始下载 CSV');
    } catch (e) {
      // 服务端原文照抄：盖成「导出失败」会把「需要 owner 权限」说成故障。
      toast((e as Error)?.message || '导出失败');
    } finally {
      setExporting(false);
    }
  };

  return (
    <>
      <PageHead k="invites" res={res} badge={res.data ? `${res.data.total} 条关系` : undefined} />
      {children}
      {isSuper ? (
        <ActionRow>
          <Button type="button" variant="outline" size="sm" disabled={exporting} onClick={exportCsv}>
            <Download className="size-3.5" /> {exporting ? '导出中…' : '导出 CSV'}
          </Button>
          <Button type="button" size="sm" onClick={onOpenBind}>
            <UserPlus className="size-3.5" /> 运营补绑
          </Button>
        </ActionRow>
      ) : (
        <ReadOnlyNotice what="导出 CSV 与运营补绑" />
      )}
      <GrowthState res={res}>{(d: AdminInviteList) => (
        d.items.length === 0 ? (
          <GrowthEmpty
            msg="这个筛选下没有邀请关系"
            hint="换个搜索词或把时间窗放到「全部」再看一次；关系是永久的，默认不按时间窗筛。"
          />
        ) : (
          <>
            <LedgerTable items={d.items} onOpenChain={onOpenChain} />
            <LedgerCards items={d.items} onOpenChain={onOpenChain} />
            <GrowthPager page={page} total={d.total} pageSize={d.pageSize} onChange={onPage} />
          </>
        )
      )}</GrowthState>
    </>
  );
}

function ActivationBadge({ status }: { status: AdminPlanActivation }) {
  return (
    <ToneBadge tone={status === 'activated' ? 'ok' : 'muted'}>
      {ACTIVATION_LABEL[status] ?? status}
    </ToneBadge>
  );
}

function FirstPaidCell({ edge }: { edge: AdminInviteEdge }) {
  if (!edge.firstPaid) return <span className="text-muted-foreground">—</span>;
  const { amount, paidAt, refunded, outTradeNo } = edge.firstPaid;
  return (
    <div className="min-w-0" title={`单号 ${outTradeNo}`}>
      <Money fen={amount} />
      {refunded && <ToneBadge tone="bad" className="ml-1.5">已退款</ToneBadge>}
      <div className="font-mono text-[10.5px] text-muted-foreground">{fmtTime(paidAt)}</div>
    </div>
  );
}

function ChainButton({ userId, onOpenChain, label = '查链' }: {
  userId: string;
  onOpenChain: (userId: string) => void;
  label?: string;
}) {
  return (
    <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-[11.5px]" onClick={() => onOpenChain(userId)}>
      <Link2 className="size-3" /> {label}
    </Button>
  );
}

function LedgerTable({ items, onOpenChain }: { items: AdminInviteEdge[]; onOpenChain: (userId: string) => void }) {
  return (
    <div className="hidden md:block">
      <TableScroll>
        <Table className="min-w-[56rem]">
          <TableHeader>
            <TableRow>
              <TableHead>被邀人</TableHead>
              <TableHead>邀请人</TableHead>
              <TableHead>邀请码</TableHead>
              <TableHead>来源</TableHead>
              <TableHead>绑定时间</TableHead>
              <TableHead>被邀人开通</TableHead>
              <TableHead>首笔付费</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((e) => (
              <TableRow key={`${e.invitee.userId}-${e.boundAt}`}>
                <TableCell><PersonCell person={e.invitee} /></TableCell>
                <TableCell>
                  <div className="flex items-center gap-1.5">
                    <PersonCell person={e.inviter} />
                    {e.inviterIsDistributor && <ToneBadge tone="gold">代理</ToneBadge>}
                  </div>
                </TableCell>
                <TableCell className="font-mono text-[11.5px]">{e.inviteCode}</TableCell>
                <TableCell className="text-[12.5px]">{sourceText(e.source)}</TableCell>
                <TableCell className="font-mono text-[11.5px] text-muted-foreground">{fmtTime(e.boundAt)}</TableCell>
                <TableCell><ActivationBadge status={e.inviteeStatus} /></TableCell>
                <TableCell><FirstPaidCell edge={e} /></TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1.5">
                    <ChainButton userId={e.invitee.userId} onOpenChain={onOpenChain} label="被邀人链" />
                    <ChainButton userId={e.inviter.userId} onOpenChain={onOpenChain} label="邀请人链" />
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableScroll>
    </div>
  );
}

/** 窄屏改成纵向卡片：桌面表格有 8 列，375px 下横滚等于让运营左右扒着看（DESIGN.md 的硬要求）。 */
function LedgerCards({ items, onOpenChain }: { items: AdminInviteEdge[]; onOpenChain: (userId: string) => void }) {
  return (
    <div className="space-y-2 md:hidden">
      {items.map((e) => (
        <div key={`${e.invitee.userId}-${e.boundAt}`} className="rounded-lg border bg-card p-3">
          <div className="flex items-start justify-between gap-2">
            <PersonCell person={e.invitee} />
            <ActivationBadge status={e.inviteeStatus} />
          </div>
          <div className="mt-2 flex items-center gap-1.5 border-t pt-2">
            <span className="shrink-0 text-[11px] text-muted-foreground">邀请人</span>
            <PersonCell person={e.inviter} />
            {e.inviterIsDistributor && <ToneBadge tone="gold">代理</ToneBadge>}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            <span className="font-mono">{e.inviteCode}</span>
            <span>{sourceText(e.source)}</span>
            <span className="font-mono">{fmtTime(e.boundAt)}</span>
          </div>
          <div className="mt-2 flex items-end justify-between gap-2">
            <FirstPaidCell edge={e} />
            <div className="flex gap-1.5">
              <ChainButton userId={e.invitee.userId} onOpenChain={onOpenChain} label="被邀人链" />
              <ChainButton userId={e.inviter.userId} onOpenChain={onOpenChain} label="邀请人链" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ══════════════ 归因日志 ══════════════ */

function AttributionSection({ query, page, onPage, onOpenChain, children }: {
  query: AdminInviteAttributionQuery;
  page: number;
  onPage: (p: number) => void;
  onOpenChain: (userId: string) => void;
  children: ReactNode;
}) {
  const res = useResource(useCallback(() => api.inviteAttributions(query), [query]), [query]);
  return (
    <>
      <PageHead k="invites" res={res} badge={res.data ? `${res.data.total} 条留痕` : undefined} />
      {children}
      <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
        每一次归因尝试都留痕，含没建成的（自己的码 / 会成环 / 码不存在 / 已绑过别人）——
        「这个人为什么没绑上」只能在这里查到，关系账本里没有那一行。
        响应不下发 userAgent（一处不展示，下发等于白白扩散设备指纹）；手机号已按审计口径掩码。
      </p>
      <GrowthState res={res}>{(d: AdminInviteAttributionList) => (
        d.items.length === 0 ? (
          <GrowthEmpty
            msg="这个筛选下没有归因留痕"
            hint="留痕按时间窗筛，默认「全部」；若在查某个人为什么没绑上，用手机号或邀请码搜。"
          />
        ) : (
          <>
            <AttributionTable items={d.items} onOpenChain={onOpenChain} />
            <AttributionCards items={d.items} onOpenChain={onOpenChain} />
            <GrowthPager page={page} total={d.total} pageSize={d.pageSize} onChange={onPage} />
          </>
        )
      )}</GrowthState>
    </>
  );
}

function AttributionTable({ items, onOpenChain }: { items: AdminInviteAttribution[]; onOpenChain: (userId: string) => void }) {
  return (
    <div className="hidden md:block">
      <TableScroll>
        <Table className="min-w-[52rem]">
          <TableHeader>
            <TableRow>
              <TableHead>时间</TableHead>
              <TableHead>结果</TableHead>
              <TableHead>邀请码</TableHead>
              <TableHead>来源</TableHead>
              <TableHead>新用户</TableHead>
              <TableHead>邀请人</TableHead>
              <TableHead>来源 IP</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((a) => (
              <TableRow key={a.id}>
                <TableCell className="font-mono text-[11.5px] text-muted-foreground">{fmtTime(a.createdAt)}</TableCell>
                <TableCell><ToneBadge tone={outcomeTone(a.outcome)}>{outcomeText(a.outcome)}</ToneBadge></TableCell>
                <TableCell className="font-mono text-[11.5px]">{a.inviteCode}</TableCell>
                <TableCell className="text-[12.5px]">{sourceText(a.source)}</TableCell>
                <TableCell>{a.newUser ? <PersonCell person={a.newUser} /> : <span className="text-muted-foreground">—</span>}</TableCell>
                <TableCell>{a.referrer ? <PersonCell person={a.referrer} /> : <span className="text-muted-foreground">—</span>}</TableCell>
                <TableCell className="font-mono text-[11.5px] text-muted-foreground">{a.clientIp || '—'}</TableCell>
                <TableCell className="text-right">
                  {a.newUser ? <ChainButton userId={a.newUser.userId} onOpenChain={onOpenChain} /> : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableScroll>
    </div>
  );
}

function AttributionCards({ items, onOpenChain }: { items: AdminInviteAttribution[]; onOpenChain: (userId: string) => void }) {
  return (
    <div className="space-y-2 md:hidden">
      {items.map((a) => (
        <div key={a.id} className="rounded-lg border bg-card p-3">
          <div className="flex items-center justify-between gap-2">
            <ToneBadge tone={outcomeTone(a.outcome)}>{outcomeText(a.outcome)}</ToneBadge>
            <span className="font-mono text-[10.5px] text-muted-foreground">{fmtTime(a.createdAt)}</span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            <span className="font-mono">{a.inviteCode}</span>
            <span>{sourceText(a.source)}</span>
            <span className="font-mono">IP {a.clientIp || '—'}</span>
          </div>
          {a.newUser && (
            <div className="mt-2 flex items-end justify-between gap-2 border-t pt-2">
              <PersonCell person={a.newUser} />
              <ChainButton userId={a.newUser.userId} onOpenChain={onOpenChain} />
            </div>
          )}
          {a.referrer && (
            <div className="mt-2 flex items-center gap-1.5 border-t pt-2">
              <span className="shrink-0 text-[11px] text-muted-foreground">邀请人</span>
              <PersonCell person={a.referrer} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/* ══════════════ 运营补绑（super） ══════════════ */

function ManualBindDialog({ onClose, onOpenChain, toast }: {
  onClose: () => void;
  onOpenChain: (userId: string) => void;
  toast: (m: string) => void;
}) {
  const [userId, setUserId] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [result, setResult] = useState<AdminManualBindResult | null>(null);

  const ready = userId.trim().length > 0 && inviteCode.trim().length > 0 && reason.trim().length > 0;

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true); setErr(''); setResult(null);
    try {
      const r = await api.manualBindInvite({ userId: userId.trim(), inviteCode: inviteCode.trim(), reason: reason.trim() });
      setResult(r);
      if (r.outcome === 'bound') toast('已补绑');
    } catch (e) {
      // 透出服务端原文（禁固定文案）：「需要 owner 权限」「用户不存在」都是可行动的线索。
      setErr((e as Error)?.message || '补绑失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>运营补绑邀请关系</DialogTitle>
          <DialogDescription>
            只能给「尚无推荐人」的用户建边，来源记为「运营补绑」，不受归因窗口限制。
            本期不提供改绑与解绑（关系不可变更）。原因会进审计。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="mb-user" className="text-[12px]">被绑定的用户 userId</Label>
            <Input id="mb-user" className="h-9 font-mono text-[12.5px]" value={userId} placeholder="cm…（在用户页复制完整 id）" onChange={(e) => setUserId(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mb-code" className="text-[12px]">邀请人的邀请码</Label>
            <Input id="mb-code" className="h-9 font-mono text-[12.5px]" value={inviteCode} placeholder="邀请码" onChange={(e) => setInviteCode(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mb-reason" className="text-[12px]">补绑原因（进审计，1–200 字）</Label>
            <Textarea id="mb-reason" className="min-h-16 text-[12.5px]" maxLength={200} value={reason} placeholder="例：用户注册时未走分享链接，凭聊天记录核实由 XXX 推荐" onChange={(e) => setReason(e.target.value)} />
          </div>

          {err && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2.5 text-xs text-destructive" role="alert">
              <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden="true" />
              <span className="break-words">{err}</span>
            </div>
          )}

          {result && <BindOutcome result={result} onOpenChain={onOpenChain} />}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>{result ? '关闭' : '取消'}</Button>
          <Button type="button" onClick={submit} disabled={busy || !ready}>
            {busy ? '提交中…' : '提交补绑'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 回显 outcome 的人话。`bound` 之外都不是「失败」，是「没建成，原因是…」。 */
function BindOutcome({ result, onOpenChain }: { result: AdminManualBindResult; onOpenChain: (userId: string) => void }) {
  const tone = outcomeTone(result.outcome);
  const WHY: Record<string, string> = {
    bound: '关系已建立，来源记为「运营补绑」。',
    self: '这是这个用户自己的邀请码，自己不能邀请自己。',
    cycle: '按这条边建下去会成环（邀请人在被邀人的下游），已拒绝。',
    unknown_code: '这个邀请码在库里找不到对应用户，核对一下有没有多字少字。',
    already_bound: '这个用户已经有推荐人了。本期不提供改绑 / 解绑。',
    config_unavailable: '服务端读配置失败，没有建边——这是故障，可重试或找研发看日志。',
    no_timestamp: '缺少捕获时间，没有建边（补绑不该出现这一项，出现请反馈）。',
  };
  return (
    <div className="rounded-md border bg-muted/40 p-3">
      <div className="flex items-center gap-2">
        <ToneBadge tone={tone}>{outcomeText(result.outcome)}</ToneBadge>
        <span className="text-[12.5px] text-foreground">{result.outcome === 'bound' ? '补绑成功' : '没有建边'}</span>
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{WHY[result.outcome] ?? '服务端返回了未知的 outcome，请反馈。'}</p>
      {result.edge && (
        <div className="mt-2.5 flex items-end justify-between gap-2 border-t pt-2.5">
          <div className="min-w-0 space-y-1">
            <PersonCell person={result.edge.invitee} />
            <div className="text-[11px] text-muted-foreground">↑ 邀请人：{result.edge.inviter.name?.trim() || result.edge.inviter.phone || result.edge.inviter.userId}</div>
          </div>
          <ChainButton userId={result.edge.invitee.userId} onOpenChain={onOpenChain} />
        </div>
      )}
    </div>
  );
}
