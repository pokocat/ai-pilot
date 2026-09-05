// 增长 · 代理分销：代理名册 / 分销规则 / 佣金流水 / 结算单。
//
// 合规定位（别在界面上说走样）：代理 = 运营在后台登记的**签约渠道合作方**（B2B）。佣金在服务端
// 按已支付订单计提，由运营生成结算单，**线下打款后回填凭证号**。小程序端零暴露——没有「我的佣金 /
// 提现」，本页也不该出现任何「返利 / 提现 / 赚钱」的说法。佣金只发给代理，不发给普通邀请人。
//
// 两个数值不在本页改：总开关 `distribution` 与冻结期 `distribution-hold` 都是功能开关，
// 唯一写口在「配置 · 功能开关」。这里只显示 + 给一条链接过去——同一个值两个入口必然漂移。
//
// 破坏性动作的口径（DESIGN.md「Destructive Confirmation」）：
//   · 终止合作、作废结算单 = 手打确认词的 AlertDialog；
//   · 回填打款 = Dialog 且必填凭证号，并回显「对谁 / 多少钱 / 几条流水」；
//   · 非 super 一律**不渲染**写按钮（别摆注定 403 的按钮），页头写明只读；
//   · 所有写操作的 catch 透出 `e.message`，禁止盖成「保存失败」。

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import { ArrowRight, Ban, ChevronRight, Ellipsis, ExternalLink, Plus, Trash2, TriangleAlert } from 'lucide-react';
import {
  AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { Toggle } from '@/components/ui/toggle';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { ScRoot } from '@/lib/scPortal';
import {
  api,
  type AdminChainLevelStat, type AdminCommissionEntry, type AdminCommissionList, type AdminCommissionQuery,
  type AdminDistributionConfig, type AdminDistributorDetail, type AdminDistributorItem,
  type AdminDistributorList, type AdminDistributorListQuery, type AdminDistributorTier,
  type AdminSettlement, type AdminSettlementList, type AdminSettlementQuery,
  type CommissionKind, type CommissionStatus, type DistributionItemType, type DistributorStatus,
  type SettlementStatus,
} from '../api';
import { PageHead } from '../components';
import { fmtTime } from '../format';
import { useResource, type Resource } from '../useResource';
import {
  COMMISSION_KIND_LABEL, COMMISSION_STATUS_LABEL, DISTRIBUTOR_STATUS_LABEL, ITEM_TYPE_LABEL,
  SETTLEMENT_STATUS_LABEL, beijingDay, distributorTone, rateText, settlementTone,
} from './labels';
import {
  ActionRow, FilterRow, GrowthEmpty, GrowthError, GrowthPager, GrowthSearch, GrowthState,
  Money, PersonCell, ReadOnlyNotice, Section, StatCard, TableScroll, ToneBadge, fenText, useDebounced,
} from './ui';

const PAGE_SIZE = 20;
const ANY = '__any__';

type Tab = 'roster' | 'rules' | 'commissions' | 'settlements';

const TABS: [Tab, string][] = [
  ['roster', '代理名册'],
  ['rules', '分销规则'],
  ['commissions', '佣金流水'],
  ['settlements', '结算单'],
];

export function DistributionView({ isSuper, distributorId, onOpenDistributor, onOpenChain, toast }: {
  isSuper: boolean;
  /** 来自 `#/distribution/<distributorId>`；非空 = 看某个代理的详情 */
  distributorId: string;
  onOpenDistributor: (id: string) => void;
  onOpenChain: (userId: string) => void;
  toast: (m: string) => void;
}) {
  const [tab, setTab] = useState<Tab>('roster');

  if (distributorId) {
    return (
      <ScRoot>
        <DistributorDetailSection
          id={distributorId}
          onBack={() => onOpenDistributor('')}
          onOpenChain={onOpenChain}
        />
      </ScRoot>
    );
  }

  const tabs = (
    <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
      <TabsList className="mb-3">
        {TABS.map(([k, label]) => (
          <TabsTrigger key={k} value={k} className="text-[13px]">{label}</TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );

  /* Tabs 只当分段控件：正文按 tab 条件渲染，切到哪个才挂载哪份取数——只看一张比例矩阵
     不该顺带跑一遍全量佣金聚合（同 views/referral.tsx 的理由）。 */
  return (
    <ScRoot>
      {tab === 'roster' && <RosterTab isSuper={isSuper} onOpenDistributor={onOpenDistributor} onOpenChain={onOpenChain} toast={toast}>{tabs}</RosterTab>}
      {tab === 'rules' && <RulesTab isSuper={isSuper} toast={toast}>{tabs}</RulesTab>}
      {tab === 'commissions' && <CommissionsTab>{tabs}</CommissionsTab>}
      {tab === 'settlements' && <SettlementsTab isSuper={isSuper} toast={toast}>{tabs}</SettlementsTab>}
    </ScRoot>
  );
}

/* ══════════════ 总开关与冻结期（只显示，链到功能开关页） ══════════════ */

function ConfigBanner({ res }: { res: Resource<AdminDistributionConfig> }) {
  if (res.error && res.data === null) return <GrowthError msg={res.error} onRetry={res.reload} forbidden={res.forbidden} />;
  const d = res.data;
  if (!d) return null;
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border bg-muted/40 px-3.5 py-2.5 text-[12.5px]">
      <span className="flex items-center gap-2">
        <span className="text-muted-foreground">计提总开关</span>
        <ToneBadge tone={d.enabled ? 'ok' : 'muted'}>{d.enabled ? '已开启' : '已关闭'}</ToneBadge>
      </span>
      <span className="flex items-center gap-2">
        <span className="text-muted-foreground">退款冻结期</span>
        <span className="font-mono text-foreground">{d.holdDays} 天</span>
        {!d.holdConfigured && <ToneBadge tone="warn">代码兜底值，运营还没配</ToneBadge>}
      </span>
      <span className="text-[11px] text-muted-foreground">
        关闭时新订单直接不计提，开启后也不追溯历史订单
      </span>
      {/* 唯一写口在功能开关页：同一个数值两个入口必然漂移 */}
      <a className="ml-auto inline-flex items-center gap-1 text-[12px] text-primary underline-offset-4 hover:underline" href="#/flags">
        去功能开关改（{d.flagKeys.enabled} / {d.flagKeys.hold}）
        <ExternalLink className="size-3" aria-hidden="true" />
      </a>
    </div>
  );
}

/* ══════════════ Tab 1：代理名册 ══════════════ */

function RosterTab({ isSuper, onOpenDistributor, onOpenChain, toast, children }: {
  isSuper: boolean;
  onOpenDistributor: (id: string) => void;
  onOpenChain: (userId: string) => void;
  toast: (m: string) => void;
  children: ReactNode;
}) {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState(ANY);
  const [tierId, setTierId] = useState(ANY);
  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);
  const debouncedQ = useDebounced(q);

  const config = useResource(useCallback(() => api.distributionConfig(), []), []);
  const tiers = useResource(useCallback(() => api.distributionTiers(), []), []);

  const query = useMemo<AdminDistributorListQuery>(() => ({
    q: debouncedQ.trim() || undefined,
    status: status === ANY ? undefined : (status as DistributorStatus),
    tierId: tierId === ANY ? undefined : tierId,
    page,
    pageSize: PAGE_SIZE,
  }), [debouncedQ, status, tierId, page]);
  const res = useResource(useCallback(() => api.distributors(query), [query]), [query]);

  return (
    <>
      <PageHead k="distribution" res={res} badge={res.data ? `${res.data.total} 位代理` : undefined} />
      {children}
      <ConfigBanner res={config} />
      {isSuper ? (
        <ActionRow>
          <Button type="button" size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="size-3.5" /> 登记代理
          </Button>
        </ActionRow>
      ) : (
        <ReadOnlyNotice what="登记代理、改状态、改比例、生成与打款结算单" />
      )}
      <FilterRow>
        <GrowthSearch value={q} onChange={(v) => { setQ(v); setPage(1); }} placeholder="搜姓名 / 手机号 / 对外名称" />
        <Select value={status} onValueChange={(v) => { setStatus(v); setPage(1); }}>
          <SelectTrigger className="h-9 w-[8rem] text-[13px]" aria-label="按状态筛选"><SelectValue placeholder="状态" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>全部状态</SelectItem>
            {(['pending', 'active', 'suspended', 'terminated'] as DistributorStatus[]).map((s) => (
              <SelectItem key={s} value={s}>{DISTRIBUTOR_STATUS_LABEL[s]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={tierId} onValueChange={(v) => { setTierId(v); setPage(1); }} disabled={tiers.initial}>
          <SelectTrigger className="h-9 w-[9rem] text-[13px]" aria-label="按等级筛选"><SelectValue placeholder="等级" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>全部等级</SelectItem>
            {(tiers.data ?? []).map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </FilterRow>
      <GrowthState res={res}>{(d: AdminDistributorList) => (
        d.items.length === 0 ? (
          <GrowthEmpty
            msg="这个筛选下没有代理"
            hint={isSuper ? '代理由运营在这里登记；没有等级与规则时不会计提任何佣金。' : '代理由超级管理员登记。'}
          />
        ) : (
          <>
            <RosterTable items={d.items} isSuper={isSuper} onOpenDistributor={onOpenDistributor} onOpenChain={onOpenChain} onDone={res.reload} toast={toast} />
            <GrowthPager page={page} total={d.total} pageSize={d.pageSize} onChange={setPage} />
          </>
        )
      )}</GrowthState>
      {createOpen && (
        <CreateDistributorDialog
          tiers={tiers.data ?? []}
          onClose={() => setCreateOpen(false)}
          onDone={() => { setCreateOpen(false); res.reload(); }}
          toast={toast}
        />
      )}
    </>
  );
}

function RosterTable({ items, isSuper, onOpenDistributor, onOpenChain, onDone, toast }: {
  items: AdminDistributorItem[];
  isSuper: boolean;
  onOpenDistributor: (id: string) => void;
  onOpenChain: (userId: string) => void;
  onDone: () => void;
  toast: (m: string) => void;
}) {
  const [terminating, setTerminating] = useState<AdminDistributorItem | null>(null);

  const setStatus = async (d: AdminDistributorItem, next: 'active' | 'suspended') => {
    try {
      await api.updateDistributor(d.id, { status: next });
      toast(next === 'active' ? '已恢复计提' : '已暂停计提');
      onDone();
    } catch (e) {
      toast((e as Error)?.message || '状态没改成');
    }
  };

  const actionsFor = (d: AdminDistributorItem) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="icon" className="size-7" aria-label={`${d.displayName || d.user.name || '该代理'}的操作`}>
          <Ellipsis className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => onOpenDistributor(d.id)}>查看详情</DropdownMenuItem>
        <DropdownMenuItem onClick={() => onOpenChain(d.user.userId)}>查邀请链</DropdownMenuItem>
        {isSuper && d.status !== 'terminated' && (
          <>
            <DropdownMenuSeparator />
            {d.status === 'suspended'
              ? <DropdownMenuItem onClick={() => setStatus(d, 'active')}>恢复计提</DropdownMenuItem>
              : <DropdownMenuItem onClick={() => setStatus(d, 'suspended')}>暂停计提</DropdownMenuItem>}
            <DropdownMenuItem variant="destructive" onClick={() => setTerminating(d)}>终止合作</DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <>
      {/* 窄屏走卡片：这张表 9 列，375px 下横滚等于让运营左右扒着看。名册是运营最可能在手机上开的一屏
          （客服/渠道对接现场），所以专门做了纵向版；佣金流水与结算单是台面上的对账动作，仍用表格
          （容器内横滚，页面主体不滚）。 */}
      <div className="space-y-2 md:hidden">
        {items.map((d) => (
          <div key={d.id} className="rounded-lg border bg-card p-3">
            <div className="flex items-start justify-between gap-2">
              <PersonCell person={d.user} />
              <div className="flex shrink-0 items-center gap-1.5">
                <ToneBadge tone={distributorTone(d.status)}>{DISTRIBUTOR_STATUS_LABEL[d.status] ?? d.status}</ToneBadge>
                {actionsFor(d)}
              </div>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-2 text-[11.5px] text-muted-foreground">
              <span className="text-foreground">{d.displayName || '未填对外名称'}</span>
              <span className="font-mono">{d.contactPhone || '无联系手机'}</span>
              <span>{d.tier?.name ?? '未分级'}</span>
              <span className="font-mono">团队 {d.team.lv1}/{d.team.lv2}/{d.team.lv3}</span>
            </div>
            <div className="mt-2 grid grid-cols-3 gap-2 border-t pt-2 text-center">
              {([['累计计提', d.commission.accrued], ['待结', d.commission.pending], ['已结', d.commission.settled]] as const).map(([label, fen]) => (
                <div key={label}>
                  <div className="text-[10.5px] text-muted-foreground">{label}</div>
                  <Money fen={fen} />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <TableScroll className="hidden md:block">
        <Table className="min-w-[60rem]">
          <TableHeader>
            <TableRow>
              <TableHead>代理</TableHead>
              <TableHead>对外名称 / 联系</TableHead>
              <TableHead>等级</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>团队 L1/L2/L3</TableHead>
              <TableHead className="text-right">累计计提</TableHead>
              <TableHead className="text-right">待结</TableHead>
              <TableHead className="text-right">已结</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((d) => (
              <TableRow key={d.id}>
                <TableCell><PersonCell person={d.user} /></TableCell>
                <TableCell>
                  <div className="min-w-0">
                    <div className="truncate text-[12.5px]">{d.displayName || <span className="text-muted-foreground">未填</span>}</div>
                    <div className="truncate font-mono text-[10.5px] text-muted-foreground">{d.contactPhone || '无联系手机'}</div>
                  </div>
                </TableCell>
                <TableCell className="text-[12.5px]">{d.tier?.name ?? <span className="text-muted-foreground">未分级</span>}</TableCell>
                <TableCell><ToneBadge tone={distributorTone(d.status)}>{DISTRIBUTOR_STATUS_LABEL[d.status] ?? d.status}</ToneBadge></TableCell>
                <TableCell className="font-mono text-[11.5px]">{d.team.lv1} / {d.team.lv2} / {d.team.lv3}</TableCell>
                <TableCell className="text-right"><Money fen={d.commission.accrued} /></TableCell>
                <TableCell className="text-right"><Money fen={d.commission.pending} /></TableCell>
                <TableCell className="text-right"><Money fen={d.commission.settled} /></TableCell>
                <TableCell className="text-right">{actionsFor(d)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableScroll>
      {terminating && (
        <TerminateDialog
          target={terminating}
          onClose={() => setTerminating(null)}
          onDone={() => { setTerminating(null); onDone(); }}
          toast={toast}
        />
      )}
    </>
  );
}

/** 终止是终态：之后只读，不能恢复。故按 DESIGN.md 走手打确认词 + 回显对象。 */
function TerminateDialog({ target, onClose, onDone, toast }: {
  target: AdminDistributorItem;
  onClose: () => void;
  onDone: () => void;
  toast: (m: string) => void;
}) {
  const WORD = '终止';
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const blocked = typed.trim() !== WORD;

  const submit = async () => {
    if (blocked || busy) return;
    setBusy(true); setErr('');
    try {
      await api.updateDistributor(target.id, { status: 'terminated' });
      toast('已终止合作');
      onDone();
    } catch (e) {
      setBusy(false);
      setErr((e as Error)?.message || '终止没成功');
    }
  };

  return (
    <AlertDialog open onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>终止与该代理的合作</AlertDialogTitle>
          <AlertDialogDescription>
            终止是终态，之后这条档案只读、不能再恢复计提。已产生的佣金流水与结算单不受影响，仍可正常结算。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <EchoRows rows={[
          { k: '代理', v: `${target.displayName || target.user.name || '未填姓名'}（${target.user.phone ?? target.user.userId}）` },
          { k: '等级', v: target.tier?.name ?? '未分级' },
          { k: '待结佣金', v: fenText(target.commission.pending), amount: true },
        ]} />
        <div className="space-y-1.5">
          <Label htmlFor="term-word" className="text-[12px]">请输入「{WORD}」以确认</Label>
          <Input id="term-word" className="h-9" value={typed} placeholder={WORD} onChange={(e) => setTyped(e.target.value)} />
        </div>
        {err && <InlineError msg={err} />}
        <AlertDialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>取消</Button>
          <Button type="button" variant="destructive" onClick={submit} disabled={busy || blocked}>
            <Ban className="size-3.5" /> {busy ? '执行中…' : '确认终止'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function CreateDistributorDialog({ tiers, onClose, onDone, toast }: {
  tiers: AdminDistributorTier[];
  onClose: () => void;
  onDone: () => void;
  toast: (m: string) => void;
}) {
  const [userId, setUserId] = useState('');
  const [tierId, setTierId] = useState(ANY);
  const [displayName, setDisplayName] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [remark, setRemark] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async () => {
    if (!userId.trim() || busy) return;
    setBusy(true); setErr('');
    try {
      await api.createDistributor({
        userId: userId.trim(),
        tierId: tierId === ANY ? null : tierId,
        displayName: displayName.trim() || null,
        contactPhone: contactPhone.trim() || null,
        remark: remark.trim() || null,
      });
      toast('已登记为代理');
      onDone();
    } catch (e) {
      setBusy(false);
      setErr((e as Error)?.message || '登记没成功');
    }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>登记签约代理</DialogTitle>
          <DialogDescription>
            登记即生效（状态为「生效中」）。没有等级、或等级下没有启用的比例规则时，一律不计提——
            代码不带任何默认比例。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Field label="用户 userId" htmlFor="cd-user">
            <Input id="cd-user" className="h-9 font-mono text-[12.5px]" value={userId} placeholder="cm…（在用户页复制完整 id）" onChange={(e) => setUserId(e.target.value)} />
          </Field>
          <Field label="等级（可留空，之后再分）" htmlFor="cd-tier">
            <Select value={tierId} onValueChange={setTierId}>
              <SelectTrigger id="cd-tier" className="h-9 text-[13px]"><SelectValue placeholder="不分级" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>不分级</SelectItem>
                {tiers.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          <Field label="对外名称（公司 / 个人）" htmlFor="cd-name">
            <Input id="cd-name" className="h-9 text-[13px]" value={displayName} placeholder="例：某某文化传媒" onChange={(e) => setDisplayName(e.target.value)} />
          </Field>
          <Field label="联系手机（可与账号手机不同；列表里按审计口径掩码）" htmlFor="cd-phone">
            <Input id="cd-phone" className="h-9 font-mono text-[12.5px]" value={contactPhone} placeholder="13800001234" onChange={(e) => setContactPhone(e.target.value)} />
          </Field>
          <Field label="备注" htmlFor="cd-remark">
            <Textarea id="cd-remark" className="min-h-14 text-[12.5px]" value={remark} placeholder="签约背景、对接人、协议编号…" onChange={(e) => setRemark(e.target.value)} />
          </Field>
          {err && <InlineError msg={err} />}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>取消</Button>
          <Button type="button" onClick={submit} disabled={busy || !userId.trim()}>{busy ? '提交中…' : '登记'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ══════════════ Tab 2：分销规则 ══════════════ */

const LEVELS: (1 | 2 | 3)[] = [1, 2, 3];
const ITEM_TYPES: DistributionItemType[] = ['plan', 'sku', 'all'];

function RulesTab({ isSuper, toast, children }: { isSuper: boolean; toast: (m: string) => void; children: ReactNode }) {
  const config = useResource(useCallback(() => api.distributionConfig(), []), []);
  const res = useResource(useCallback(() => api.distributionTiers(), []), []);
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <>
      <PageHead k="distribution" res={res} badge={res.data ? `${res.data.length} 个等级` : undefined} />
      {children}
      <ConfigBanner res={config} />
      {isSuper ? (
        <ActionRow>
          <Button type="button" size="sm" onClick={() => setCreateOpen(true)}><Plus className="size-3.5" /> 新增等级</Button>
        </ActionRow>
      ) : (
        <ReadOnlyNotice what="新增等级与改比例" />
      )}
      <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
        比例按「等级 × 层级 × 商品类型」配置，单位是万分比（0–10000）；商品类型精确匹配优先于「全部（兜底）」。
        空规则等于不计提，代码不带任何默认值、也不会自己建等级。合规上只要一级计提，把 L2/L3 留空即可。
      </p>
      <GrowthState res={res} skeleton="rows">{(tiers: AdminDistributorTier[]) => (
        tiers.length === 0 ? (
          <GrowthEmpty
            msg="还没有任何代理等级"
            hint={isSuper ? '先建一个等级，再给它配比例矩阵；等级目录是运营资产，代码不 seed。' : '等级由超级管理员维护。'}
          />
        ) : (
          <div className="space-y-3">
            {tiers.map((t) => <TierCard key={t.id} tier={t} isSuper={isSuper} onDone={res.reload} toast={toast} />)}
          </div>
        )
      )}</GrowthState>
      {createOpen && (
        <TierDialog
          onClose={() => setCreateOpen(false)}
          onDone={() => { setCreateOpen(false); res.reload(); }}
          toast={toast}
        />
      )}
    </>
  );
}

interface CellDraft { rate: string; enabled: boolean }
type Matrix = Record<string, CellDraft>;
const cellKey = (level: number, itemType: string) => `${level}:${itemType}`;

function toMatrix(tier: AdminDistributorTier): Matrix {
  const m: Matrix = {};
  for (const r of tier.rules) m[cellKey(r.level, r.itemType)] = { rate: String(r.rateBp), enabled: r.enabled };
  return m;
}

function TierCard({ tier, isSuper, onDone, toast }: {
  tier: AdminDistributorTier;
  isSuper: boolean;
  onDone: () => void;
  toast: (m: string) => void;
}) {
  const [matrix, setMatrix] = useState<Matrix>(() => toMatrix(tier));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [editOpen, setEditOpen] = useState(false);
  const [delOpen, setDelOpen] = useState(false);

  const setCell = (level: number, itemType: string, next: Partial<CellDraft>) => {
    setMatrix((prev) => {
      const cur = prev[cellKey(level, itemType)] ?? { rate: '', enabled: true };
      return { ...prev, [cellKey(level, itemType)]: { ...cur, ...next } };
    });
  };

  const save = async () => {
    setBusy(true); setErr('');
    // 空格子 = 删掉这条规则（契约：不在列表里的 (level,itemType) 组合视为删除）。
    const rules: { level: 1 | 2 | 3; itemType: DistributionItemType; rateBp: number; enabled: boolean }[] = [];
    for (const level of LEVELS) {
      for (const itemType of ITEM_TYPES) {
        const cell = matrix[cellKey(level, itemType)];
        if (!cell || cell.rate.trim() === '') continue;
        const rateBp = Number(cell.rate);
        if (!Number.isInteger(rateBp) || rateBp < 0 || rateBp > 10000) {
          setBusy(false);
          setErr(`L${level} · ${ITEM_TYPE_LABEL[itemType]} 的比例要是 0–10000 的整数（万分比）`);
          return;
        }
        rules.push({ level, itemType, rateBp, enabled: cell.enabled });
      }
    }
    try {
      await api.saveDistributionRules(tier.id, { rules });
      toast(`已保存「${tier.name}」的比例`);
      onDone();
    } catch (e) {
      setErr((e as Error)?.message || '比例没保存成');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title={
        <span className="flex flex-wrap items-center gap-2">
          {tier.name}
          <ToneBadge tone={tier.enabled ? 'ok' : 'muted'}>{tier.enabled ? '启用' : '停用'}</ToneBadge>
          <Badge variant="outline" className="font-mono text-[10.5px]">{tier.distributorCount} 位代理</Badge>
        </span>
      }
      desc={tier.note || `排序 ${tier.sort} · 更新于 ${fmtTime(tier.updatedAt)}`}
      actions={isSuper ? (
        <>
          <Button type="button" variant="outline" size="sm" onClick={() => setEditOpen(true)}>改名 / 排序</Button>
          <Button type="button" variant="outline" size="sm" disabled={tier.distributorCount > 0} onClick={() => setDelOpen(true)} title={tier.distributorCount > 0 ? '还有代理挂在这个等级上，先改他们的等级' : undefined}>
            <Trash2 className="size-3.5" /> 删除
          </Button>
          <Button type="button" size="sm" disabled={busy} onClick={save}>{busy ? '保存中…' : '保存比例'}</Button>
        </>
      ) : undefined}
    >
      <div className="space-y-2">
        {LEVELS.map((level) => (
          <div key={level} className="rounded-md border bg-muted/30 p-2.5">
            <div className="mb-2 text-[11.5px] font-medium text-muted-foreground">
              第 {level} 级{level === 1 ? '（直接邀请人）' : ''}
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {ITEM_TYPES.map((itemType) => {
                const cell = matrix[cellKey(level, itemType)] ?? { rate: '', enabled: true };
                return (
                  <div key={itemType} className="rounded-md border bg-card p-2">
                    <div className="mb-1.5 text-[11px] text-muted-foreground">{ITEM_TYPE_LABEL[itemType]}</div>
                    <div className="flex items-center gap-1.5">
                      <Input
                        className="h-8 w-20 font-mono text-[12px]"
                        inputMode="numeric"
                        value={cell.rate}
                        placeholder="空=不计提"
                        disabled={!isSuper}
                        aria-label={`第 ${level} 级 ${ITEM_TYPE_LABEL[itemType]} 的万分比`}
                        onChange={(e) => setCell(level, itemType, { rate: e.target.value.replace(/[^\d]/g, '') })}
                      />
                      <span className="font-mono text-[11px] text-muted-foreground">
                        {cell.rate.trim() === '' ? '—' : rateText(Number(cell.rate))}
                      </span>
                      {isSuper && cell.rate.trim() !== '' && (
                        <Toggle
                          size="sm"
                          className="ml-auto h-8 px-2 text-[11px]"
                          pressed={cell.enabled}
                          onPressedChange={(v) => setCell(level, itemType, { enabled: v })}
                          aria-label={`第 ${level} 级 ${ITEM_TYPE_LABEL[itemType]} 是否启用`}
                        >
                          {cell.enabled ? '启用' : '停用'}
                        </Toggle>
                      )}
                      {!isSuper && cell.rate.trim() !== '' && (
                        <ToneBadge tone={cell.enabled ? 'ok' : 'muted'} className="ml-auto">{cell.enabled ? '启用' : '停用'}</ToneBadge>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
        {err && <InlineError msg={err} />}
      </div>
      {editOpen && (
        <TierDialog
          tier={tier}
          onClose={() => setEditOpen(false)}
          onDone={() => { setEditOpen(false); onDone(); }}
          toast={toast}
        />
      )}
      {delOpen && (
        <DeleteTierDialog
          tier={tier}
          onClose={() => setDelOpen(false)}
          onDone={() => { setDelOpen(false); onDone(); }}
          toast={toast}
        />
      )}
    </Section>
  );
}

function TierDialog({ tier, onClose, onDone, toast }: {
  tier?: AdminDistributorTier;
  onClose: () => void;
  onDone: () => void;
  toast: (m: string) => void;
}) {
  const [name, setName] = useState(tier?.name ?? '');
  const [sort, setSort] = useState(String(tier?.sort ?? 0));
  const [note, setNote] = useState(tier?.note ?? '');
  const [enabled, setEnabled] = useState(tier?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true); setErr('');
    const body = { name: name.trim(), sort: Number(sort) || 0, note: note.trim() || null, enabled };
    try {
      if (tier) await api.updateDistributionTier(tier.id, body);
      else await api.createDistributionTier(body);
      toast(tier ? '等级已更新' : '等级已新增');
      onDone();
    } catch (e) {
      setBusy(false);
      setErr((e as Error)?.message || '保存没成功');
    }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{tier ? '编辑代理等级' : '新增代理等级'}</DialogTitle>
          <DialogDescription>等级只是比例的挂靠点；停用等级不影响已产生的佣金流水。</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Field label="等级名称" htmlFor="tier-name">
            <Input id="tier-name" className="h-9 text-[13px]" value={name} placeholder="例：核心渠道" onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="排序（小的在前）" htmlFor="tier-sort">
            <Input id="tier-sort" className="h-9 w-24 font-mono text-[12.5px]" inputMode="numeric" value={sort} onChange={(e) => setSort(e.target.value.replace(/[^\d-]/g, ''))} />
          </Field>
          <Field label="说明" htmlFor="tier-note">
            <Textarea id="tier-note" className="min-h-14 text-[12.5px]" value={note} placeholder="这个等级给谁、怎么谈的" onChange={(e) => setNote(e.target.value)} />
          </Field>
          <div className="flex items-center gap-2">
            <Toggle size="sm" pressed={enabled} onPressedChange={setEnabled} aria-label="等级是否启用" className="h-8 px-2.5 text-[12px]">
              {enabled ? '启用' : '停用'}
            </Toggle>
            <span className="text-[11.5px] text-muted-foreground">停用后新订单不再按这个等级计提</span>
          </div>
          {err && <InlineError msg={err} />}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>取消</Button>
          <Button type="button" onClick={submit} disabled={busy || !name.trim()}>{busy ? '保存中…' : '保存'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteTierDialog({ tier, onClose, onDone, toast }: {
  tier: AdminDistributorTier;
  onClose: () => void;
  onDone: () => void;
  toast: (m: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async () => {
    setBusy(true); setErr('');
    try {
      await api.deleteDistributionTier(tier.id);
      toast('等级已删除');
      onDone();
    } catch (e) {
      setBusy(false);
      setErr((e as Error)?.message || '删除没成功');
    }
  };
  return (
    <AlertDialog open onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>删除等级「{tier.name}」</AlertDialogTitle>
          <AlertDialogDescription>
            连带删除这个等级下的比例规则。已产生的佣金流水带着计提当时的规则快照，不受影响。
          </AlertDialogDescription>
        </AlertDialogHeader>
        {err && <InlineError msg={err} />}
        <AlertDialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>取消</Button>
          <Button type="button" variant="destructive" onClick={submit} disabled={busy}>{busy ? '删除中…' : '确认删除'}</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/* ══════════════ Tab 3：佣金流水 ══════════════ */

const CHART_CONFIG = {
  accrued: { label: '计提', color: 'var(--sc-chart-1)' },
  clawback: { label: '追回', color: 'var(--sc-chart-5)' },
} satisfies ChartConfig;

function CommissionsTab({ children }: { children: ReactNode }) {
  const [distributorId, setDistributorId] = useState(ANY);
  const [status, setStatus] = useState(ANY);
  const [kind, setKind] = useState(ANY);
  const [days, setDays] = useState('30');
  const [page, setPage] = useState(1);

  const config = useResource(useCallback(() => api.distributionConfig(), []), []);
  // 代理下拉：一次拉一页足够大的名册（筛选项而非正文，不做分页）。
  const roster = useResource(useCallback(() => api.distributors({ page: 1, pageSize: 200 }), []), []);

  const query = useMemo<AdminCommissionQuery>(() => ({
    distributorId: distributorId === ANY ? undefined : distributorId,
    status: status === ANY ? undefined : (status as CommissionStatus),
    kind: kind === ANY ? undefined : (kind as CommissionKind),
    days: Number(days) || undefined,
    page,
    pageSize: PAGE_SIZE,
  }), [distributorId, status, kind, days, page]);
  const res = useResource(useCallback(() => api.commissions(query), [query]), [query]);

  return (
    <>
      <PageHead k="distribution" res={res} badge={res.data ? `${res.data.total} 条流水` : undefined} />
      {children}
      <ConfigBanner res={config} />
      <FilterRow>
        <Select value={distributorId} onValueChange={(v) => { setDistributorId(v); setPage(1); }} disabled={roster.initial}>
          <SelectTrigger className="h-9 w-[12rem] text-[13px]" aria-label="按代理筛选"><SelectValue placeholder="代理" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>全部代理</SelectItem>
            {(roster.data?.items ?? []).map((d) => (
              <SelectItem key={d.id} value={d.id}>{d.displayName || d.user.name || d.user.phone || d.id}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={(v) => { setStatus(v); setPage(1); }}>
          <SelectTrigger className="h-9 w-[8.5rem] text-[13px]" aria-label="按状态筛选"><SelectValue placeholder="状态" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>全部状态</SelectItem>
            {(['pending', 'confirmed', 'settled', 'reversed'] as CommissionStatus[]).map((s) => (
              <SelectItem key={s} value={s}>{COMMISSION_STATUS_LABEL[s]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={kind} onValueChange={(v) => { setKind(v); setPage(1); }}>
          <SelectTrigger className="h-9 w-[7rem] text-[13px]" aria-label="按类型筛选"><SelectValue placeholder="类型" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>计提 + 追回</SelectItem>
            <SelectItem value="accrual">仅计提</SelectItem>
            <SelectItem value="clawback">仅追回</SelectItem>
          </SelectContent>
        </Select>
        <ToggleGroup type="single" variant="outline" size="sm" value={days} onValueChange={(v) => { if (v) { setDays(v); setPage(1); } }} aria-label="按时间筛选">
          {[['7', '7 天'], ['30', '30 天'], ['90', '90 天']].map(([v, l]) => (
            <ToggleGroupItem key={v} value={v} className="text-[12px]">{l}</ToggleGroupItem>
          ))}
        </ToggleGroup>
      </FilterRow>
      <GrowthState res={res} skeleton="stats">{(d: AdminCommissionList) => (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {(['pending', 'confirmed', 'settled', 'reversed'] as CommissionStatus[]).map((s) => {
              const row = d.summary.find((x) => x.status === s);
              return (
                <StatCard
                  key={s}
                  label={COMMISSION_STATUS_LABEL[s]}
                  value={<Money fen={row?.amount ?? 0} className="text-[19px]" />}
                  sub={`${row?.count ?? 0} 条`}
                />
              );
            })}
          </div>
          <DailyChart daily={d.daily} />
          {d.items.length === 0 ? (
            <GrowthEmpty
              msg="这个筛选下没有佣金流水"
              hint="计提发生在订单支付成功之后；总开关关闭期间的订单不会补算。"
            />
          ) : (
            <>
              <CommissionTable items={d.items} />
              <GrowthPager page={page} total={d.total} pageSize={d.pageSize} onChange={setPage} />
            </>
          )}
        </div>
      )}</GrowthState>
    </>
  );
}

function DailyChart({ daily }: { daily: AdminCommissionList['daily'] }) {
  // 图上按「元」显示：分做纵轴刻度会变成六位数，读不出量级。
  const data = useMemo(
    () => daily.map((r) => ({ date: r.date.slice(5), accrued: r.accrued / 100, clawback: Math.abs(r.clawback) / 100 })),
    [daily],
  );
  if (data.length === 0) {
    return <GrowthEmpty msg="这个窗口内没有按日计提" hint="换个时间范围再看；空窗口不等于没有代理。" />;
  }
  return (
    <Section title="按日计提 / 追回" desc="单位元（北京时间自然日）。追回取绝对值画在同一侧，便于看「哪天退款集中」。">
      <ChartContainer config={CHART_CONFIG} className="aspect-auto h-56 w-full">
        <BarChart data={data} margin={{ left: 4, right: 4, top: 4, bottom: 0 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={8} interval="preserveStartEnd" />
          <YAxis tickLine={false} axisLine={false} width={44} tickMargin={4} />
          <ChartTooltip content={<ChartTooltipContent />} />
          <Bar dataKey="accrued" fill="var(--color-accrued)" radius={[3, 3, 0, 0]} />
          <Bar dataKey="clawback" fill="var(--color-clawback)" radius={[3, 3, 0, 0]} />
        </BarChart>
      </ChartContainer>
    </Section>
  );
}

function CommissionTable({ items }: { items: AdminCommissionEntry[] }) {
  return (
    <TableScroll>
      <Table className="min-w-[64rem]">
        <TableHeader>
          <TableRow>
            <TableHead>时间</TableHead>
            <TableHead>类型</TableHead>
            <TableHead>受益代理</TableHead>
            <TableHead>买家</TableHead>
            <TableHead>层级</TableHead>
            <TableHead>商品</TableHead>
            <TableHead className="text-right">订单实付</TableHead>
            <TableHead className="text-right">比例</TableHead>
            <TableHead className="text-right">金额</TableHead>
            <TableHead>状态</TableHead>
            <TableHead>冻结至 / 结算单</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((c) => (
            <TableRow key={c.id}>
              <TableCell className="font-mono text-[11.5px] text-muted-foreground" title={`单号 ${c.outTradeNo}`}>{fmtTime(c.createdAt)}</TableCell>
              <TableCell><ToneBadge tone={c.kind === 'clawback' ? 'bad' : 'muted'}>{COMMISSION_KIND_LABEL[c.kind] ?? c.kind}</ToneBadge></TableCell>
              <TableCell><PersonCell person={c.beneficiary} /></TableCell>
              <TableCell><PersonCell person={c.buyer} /></TableCell>
              <TableCell className="font-mono text-[11.5px]">L{c.level}</TableCell>
              <TableCell className="text-[12px]">
                <div className="min-w-0">
                  <div>{ITEM_TYPE_LABEL[c.itemType] ?? c.itemType}</div>
                  <div className="truncate font-mono text-[10.5px] text-muted-foreground">{c.itemKey}</div>
                </div>
              </TableCell>
              <TableCell className="text-right"><Money fen={c.baseAmount} /></TableCell>
              <TableCell className="text-right font-mono text-[11.5px]" title={c.ruleSnapshot ? `等级 ${c.ruleSnapshot.tierName} · 冻结 ${c.ruleSnapshot.holdDays} 天` : '无规则快照'}>
                {rateText(c.rateBp)}
              </TableCell>
              <TableCell className="text-right"><Money fen={c.amount} /></TableCell>
              <TableCell>
                <ToneBadge tone={c.status === 'settled' ? 'ok' : c.status === 'reversed' ? 'bad' : c.status === 'confirmed' ? 'gold' : 'muted'}>
                  {COMMISSION_STATUS_LABEL[c.status] ?? c.status}
                </ToneBadge>
              </TableCell>
              <TableCell className="font-mono text-[10.5px] text-muted-foreground">
                {c.settlementId
                  ? `单 ${c.settlementId.slice(-6)}`
                  : c.reversedAt ? `冲销 ${fmtTime(c.reversedAt)}` : fmtTime(c.holdUntil)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableScroll>
  );
}

/* ══════════════ Tab 4：结算单 ══════════════ */

function SettlementsTab({ isSuper, toast, children }: { isSuper: boolean; toast: (m: string) => void; children: ReactNode }) {
  const [distributorId, setDistributorId] = useState(ANY);
  const [status, setStatus] = useState(ANY);
  const [page, setPage] = useState(1);
  const [genOpen, setGenOpen] = useState(false);

  const roster = useResource(useCallback(() => api.distributors({ page: 1, pageSize: 200 }), []), []);
  const query = useMemo<AdminSettlementQuery>(() => ({
    distributorId: distributorId === ANY ? undefined : distributorId,
    status: status === ANY ? undefined : (status as SettlementStatus),
    page,
    pageSize: PAGE_SIZE,
  }), [distributorId, status, page]);
  const res = useResource(useCallback(() => api.settlements(query), [query]), [query]);

  return (
    <>
      <PageHead k="distribution" res={res} badge={res.data ? `${res.data.total} 张单` : undefined} />
      {children}
      {isSuper ? (
        <ActionRow>
          <Button type="button" size="sm" onClick={() => setGenOpen(true)}><Plus className="size-3.5" /> 生成结算单</Button>
        </ActionRow>
      ) : (
        <ReadOnlyNotice what="生成、核准、回填打款与作废结算单" />
      )}
      <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
        流程：草稿 → 已核 → 已打款（回填线下打款凭证号）。作废只允许在草稿 / 已核阶段，作废会把流水解绑回「可结算」。
        银行账户等打款资料不入库，后台只记凭证号。
      </p>
      <FilterRow>
        <Select value={distributorId} onValueChange={(v) => { setDistributorId(v); setPage(1); }} disabled={roster.initial}>
          <SelectTrigger className="h-9 w-[12rem] text-[13px]" aria-label="按代理筛选"><SelectValue placeholder="代理" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>全部代理</SelectItem>
            {(roster.data?.items ?? []).map((d) => (
              <SelectItem key={d.id} value={d.id}>{d.displayName || d.user.name || d.user.phone || d.id}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={(v) => { setStatus(v); setPage(1); }}>
          <SelectTrigger className="h-9 w-[8.5rem] text-[13px]" aria-label="按状态筛选"><SelectValue placeholder="状态" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>全部状态</SelectItem>
            {(['draft', 'approved', 'paid', 'void'] as SettlementStatus[]).map((s) => (
              <SelectItem key={s} value={s}>{SETTLEMENT_STATUS_LABEL[s]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FilterRow>
      <GrowthState res={res}>{(d: AdminSettlementList) => (
        d.items.length === 0 ? (
          <GrowthEmpty
            msg="这个筛选下没有结算单"
            hint="结算单要运营手动生成：只纳入「可结算」且未挂单的流水；零行的代理不会出单。"
          />
        ) : (
          <>
            <SettlementTable items={d.items} isSuper={isSuper} onDone={res.reload} toast={toast} />
            <GrowthPager page={page} total={d.total} pageSize={d.pageSize} onChange={setPage} />
          </>
        )
      )}</GrowthState>
      {genOpen && (
        <GenerateSettlementDialog
          roster={roster.data?.items ?? []}
          onClose={() => setGenOpen(false)}
          onDone={() => { setGenOpen(false); res.reload(); }}
          toast={toast}
        />
      )}
    </>
  );
}

type SettlementAction = { kind: 'approve' | 'paid' | 'void'; row: AdminSettlement };

function SettlementTable({ items, isSuper, onDone, toast }: {
  items: AdminSettlement[];
  isSuper: boolean;
  onDone: () => void;
  toast: (m: string) => void;
}) {
  const [act, setAct] = useState<SettlementAction | null>(null);
  return (
    <>
      <TableScroll>
        <Table className="min-w-[58rem]">
          <TableHeader>
            <TableRow>
              <TableHead>单号</TableHead>
              <TableHead>代理</TableHead>
              <TableHead>周期</TableHead>
              <TableHead className="text-right">条数</TableHead>
              <TableHead className="text-right">净额</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>核准 / 打款</TableHead>
              <TableHead>凭证号</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((s) => (
              <TableRow key={s.id}>
                <TableCell className="font-mono text-[11px] text-muted-foreground" title={s.id}>{s.id.slice(-6)}</TableCell>
                <TableCell className="text-[12.5px]">
                  <div className="min-w-0">
                    <div className="truncate">{s.distributor.displayName || s.distributor.userId}</div>
                    <div className="truncate font-mono text-[10.5px] text-muted-foreground">{s.distributor.tier?.name ?? '未分级'}</div>
                  </div>
                </TableCell>
                <TableCell className="font-mono text-[11px] text-muted-foreground">
                  {beijingDay(s.periodStart)} → {beijingDay(s.periodEnd)}
                </TableCell>
                <TableCell className="text-right font-mono text-[11.5px]">{s.entryCount}</TableCell>
                <TableCell className="text-right"><Money fen={s.totalAmount} /></TableCell>
                <TableCell><ToneBadge tone={settlementTone(s.status)}>{SETTLEMENT_STATUS_LABEL[s.status] ?? s.status}</ToneBadge></TableCell>
                <TableCell className="text-[10.5px] text-muted-foreground">
                  <div>{s.approvedBy ? `${s.approvedBy} · ${fmtTime(s.approvedAt ?? '')}` : '—'}</div>
                  <div>{s.paidBy ? `${s.paidBy} · ${fmtTime(s.paidAt ?? '')}` : ''}</div>
                </TableCell>
                <TableCell className="font-mono text-[11px]">{s.paidRef || <span className="text-muted-foreground">—</span>}</TableCell>
                <TableCell className="text-right">
                  {!isSuper || s.status === 'paid' || s.status === 'void' ? (
                    <span className="text-[11px] text-muted-foreground">{s.status === 'paid' ? '已完成' : s.status === 'void' ? '已作废' : '只读'}</span>
                  ) : (
                    <div className="flex justify-end gap-1.5">
                      {s.status === 'draft' && (
                        <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-[11.5px]" onClick={() => setAct({ kind: 'approve', row: s })}>核准</Button>
                      )}
                      {s.status === 'approved' && (
                        <Button type="button" size="sm" className="h-7 px-2 text-[11.5px]" onClick={() => setAct({ kind: 'paid', row: s })}>回填打款</Button>
                      )}
                      <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-[11.5px]" onClick={() => setAct({ kind: 'void', row: s })}>作废</Button>
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableScroll>
      {act?.kind === 'approve' && (
        <ApproveDialog row={act.row} onClose={() => setAct(null)} onDone={() => { setAct(null); onDone(); }} toast={toast} />
      )}
      {act?.kind === 'paid' && (
        <PaidDialog row={act.row} onClose={() => setAct(null)} onDone={() => { setAct(null); onDone(); }} toast={toast} />
      )}
      {act?.kind === 'void' && (
        <VoidDialog row={act.row} onClose={() => setAct(null)} onDone={() => { setAct(null); onDone(); }} toast={toast} />
      )}
    </>
  );
}

function settlementEcho(row: AdminSettlement) {
  return [
    { k: '代理', v: row.distributor.displayName || row.distributor.userId },
    { k: '周期', v: `${beijingDay(row.periodStart)} → ${beijingDay(row.periodEnd)}` },
    { k: '流水条数', v: `${row.entryCount} 条` },
    { k: '净额', v: fenText(row.totalAmount), amount: true },
  ];
}

function ApproveDialog({ row, onClose, onDone, toast }: {
  row: AdminSettlement; onClose: () => void; onDone: () => void; toast: (m: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async () => {
    setBusy(true); setErr('');
    try { await api.approveSettlement(row.id); toast('已核准'); onDone(); }
    catch (e) { setBusy(false); setErr((e as Error)?.message || '核准没成功'); }
  };
  return (
    <AlertDialog open onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>核准这张结算单</AlertDialogTitle>
          <AlertDialogDescription>核准只是确认金额可以拿去线下打款，还不动流水状态；打款后回填凭证号才会把流水转成「已结算」。</AlertDialogDescription>
        </AlertDialogHeader>
        <EchoRows rows={settlementEcho(row)} />
        {err && <InlineError msg={err} />}
        <AlertDialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>取消</Button>
          <Button type="button" onClick={submit} disabled={busy}>{busy ? '执行中…' : '确认核准'}</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function PaidDialog({ row, onClose, onDone, toast }: {
  row: AdminSettlement; onClose: () => void; onDone: () => void; toast: (m: string) => void;
}) {
  const [paidRef, setPaidRef] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async () => {
    if (!paidRef.trim() || busy) return;
    setBusy(true); setErr('');
    try { await api.paySettlement(row.id, { paidRef: paidRef.trim(), note: note.trim() || null }); toast('已回填打款'); onDone(); }
    catch (e) { setBusy(false); setErr((e as Error)?.message || '回填没成功'); }
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>回填线下打款凭证</DialogTitle>
          <DialogDescription>
            这一步会把这张单关联的佣金流水从「可结算」转成「已结算」，不可撤销。请核对下面的对象与金额。
          </DialogDescription>
        </DialogHeader>
        <EchoRows rows={settlementEcho(row)} />
        <div className="space-y-3">
          <Field label="打款凭证号（必填）" htmlFor="paid-ref">
            <Input id="paid-ref" className="h-9 font-mono text-[12.5px]" value={paidRef} placeholder="银行流水号 / 转账单号" onChange={(e) => setPaidRef(e.target.value)} />
          </Field>
          <Field label="备注" htmlFor="paid-note">
            <Textarea id="paid-note" className="min-h-14 text-[12.5px]" value={note} placeholder="打款方式、经办人…" onChange={(e) => setNote(e.target.value)} />
          </Field>
          {err && <InlineError msg={err} />}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>取消</Button>
          <Button type="button" onClick={submit} disabled={busy || !paidRef.trim()}>{busy ? '提交中…' : '确认已打款'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function VoidDialog({ row, onClose, onDone, toast }: {
  row: AdminSettlement; onClose: () => void; onDone: () => void; toast: (m: string) => void;
}) {
  const WORD = '作废';
  const [typed, setTyped] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const blocked = typed.trim() !== WORD || !reason.trim();
  const submit = async () => {
    if (blocked || busy) return;
    setBusy(true); setErr('');
    try { await api.voidSettlement(row.id, { reason: reason.trim() }); toast('已作废'); onDone(); }
    catch (e) { setBusy(false); setErr((e as Error)?.message || '作废没成功'); }
  };
  return (
    <AlertDialog open onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>作废这张结算单</AlertDialogTitle>
          <AlertDialogDescription>
            作废后这张单上的流水会解绑回「可结算」，可以重新出单。已打款的单不能作废。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <EchoRows rows={settlementEcho(row)} />
        <div className="space-y-3">
          <Field label="作废原因（进审计）" htmlFor="void-reason">
            <Input id="void-reason" className="h-9 text-[13px]" value={reason} placeholder="例：周期选错，重新出单" onChange={(e) => setReason(e.target.value)} />
          </Field>
          <Field label={`请输入「${WORD}」以确认`} htmlFor="void-word">
            <Input id="void-word" className="h-9" value={typed} placeholder={WORD} onChange={(e) => setTyped(e.target.value)} />
          </Field>
          {err && <InlineError msg={err} />}
        </div>
        <AlertDialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>取消</Button>
          <Button type="button" variant="destructive" onClick={submit} disabled={busy || blocked}>{busy ? '执行中…' : '确认作废'}</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * 结算周期一律拼成北京时间零点 + 显式 `+08:00`。
 * 不带偏移就会按浏览器所在时区解释，运营在海外或改了系统时区时整段周期漂一天——
 * 而结算周期错一天就是钱错一笔（见 memory「Prisma raw SQL Date 参数时区偏移」同类坑）。
 */
function beijingIso(date: string): string {
  return `${date}T00:00:00+08:00`;
}

function GenerateSettlementDialog({ roster, onClose, onDone, toast }: {
  roster: AdminDistributorItem[];
  onClose: () => void;
  onDone: () => void;
  toast: (m: string) => void;
}) {
  const [distributorId, setDistributorId] = useState(ANY);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [result, setResult] = useState<{ created: number; skipped: number } | null>(null);
  const ready = !!from && !!to && from < to;

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true); setErr(''); setResult(null);
    try {
      const r = await api.generateSettlements({
        distributorId: distributorId === ANY ? undefined : distributorId,
        periodStart: beijingIso(from),
        periodEnd: beijingIso(to),
      });
      setResult({ created: r.created.length, skipped: r.skippedDistributors });
      if (r.created.length > 0) { toast(`已生成 ${r.created.length} 张草稿`); onDone(); }
    } catch (e) {
      setErr((e as Error)?.message || '生成没成功');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>生成结算单（草稿）</DialogTitle>
          <DialogDescription>
            只纳入状态为「可结算」且还没挂在别的单上的流水（含追回的负行）。零行的代理不出单。
            周期按北京时间自然日，含起始日、不含结束日。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Field label="代理（留空 = 全部生效中 / 暂停中的代理各出一张）" htmlFor="gen-dist">
            <Select value={distributorId} onValueChange={setDistributorId}>
              <SelectTrigger id="gen-dist" className="h-9 text-[13px]"><SelectValue placeholder="全部代理" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>全部代理</SelectItem>
                {roster.map((d) => (
                  <SelectItem key={d.id} value={d.id}>{d.displayName || d.user.name || d.user.phone || d.id}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="起始日（含）" htmlFor="gen-from">
              <Input id="gen-from" type="date" className="h-9 w-40 text-[12.5px]" value={from} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <ArrowRight className="mb-2.5 size-4 text-muted-foreground" aria-hidden="true" />
            <Field label="结束日（不含）" htmlFor="gen-to">
              <Input id="gen-to" type="date" className="h-9 w-40 text-[12.5px]" value={to} onChange={(e) => setTo(e.target.value)} />
            </Field>
          </div>
          {from && to && from >= to && <InlineError msg="结束日要晚于起始日（结束日不含当天）" />}
          {err && <InlineError msg={err} />}
          {result && (
            <div className="rounded-md border bg-muted/40 p-3 text-[12.5px]">
              {result.created > 0
                ? <>已生成 <b className="font-mono">{result.created}</b> 张草稿；<b className="font-mono">{result.skipped}</b> 位代理这个周期内没有可结算流水，未出单。</>
                : <>这个周期内没有任何可结算流水，一张都没生成（跳过 <b className="font-mono">{result.skipped}</b> 位代理）。</>}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>{result ? '关闭' : '取消'}</Button>
          <Button type="button" onClick={submit} disabled={busy || !ready}>{busy ? '生成中…' : '生成草稿'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ══════════════ 代理详情（#/distribution/<id>） ══════════════ */

function DistributorDetailSection({ id, onBack, onOpenChain }: {
  id: string;
  onBack: () => void;
  onOpenChain: (userId: string) => void;
}) {
  const res = useResource(useCallback(() => api.distributor(id), [id]), [id]);
  return (
    <>
      <PageHead k="distribution" res={res} />
      <ActionRow>
        <Button type="button" variant="outline" size="sm" onClick={onBack}>返回名册</Button>
      </ActionRow>
      <GrowthState res={res} skeleton="stats">{(d: AdminDistributorDetail) => (
        <div className="space-y-3">
          <Section
            title={<span className="flex flex-wrap items-center gap-2">
              {d.distributor.displayName || d.distributor.user.name || '未填对外名称'}
              <ToneBadge tone={distributorTone(d.distributor.status)}>{DISTRIBUTOR_STATUS_LABEL[d.distributor.status] ?? d.distributor.status}</ToneBadge>
              <Badge variant="outline" className="font-mono text-[10.5px]">{d.distributor.tier?.name ?? '未分级'}</Badge>
            </span>}
            desc={<>登记于 {fmtTime(d.distributor.createdAt)}{d.distributor.approvedBy ? ` · 经办 ${d.distributor.approvedBy}` : ''}</>}
            actions={
              <Button type="button" variant="outline" size="sm" onClick={() => onOpenChain(d.distributor.user.userId)}>
                <ChevronRight className="size-3.5" /> 查邀请链
              </Button>
            }
          >
            <div className="grid grid-cols-1 gap-2 text-[12.5px] sm:grid-cols-2">
              <KvRow k="账号"><PersonCell person={d.distributor.user} /></KvRow>
              <KvRow k="联系手机"><span className="font-mono">{d.distributor.contactPhone || '未填'}</span></KvRow>
              <KvRow k="团队"><span className="font-mono">L1 {d.distributor.team.lv1} · L2 {d.distributor.team.lv2} · L3 {d.distributor.team.lv3}</span></KvRow>
              <KvRow k="备注"><span className="break-words">{d.distributor.remark || '无'}</span></KvRow>
            </div>
          </Section>

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="累计计提" value={<Money fen={d.distributor.commission.accrued} className="text-[19px]" />} />
            <StatCard label="待结（含冻结期）" value={<Money fen={d.distributor.commission.pending} className="text-[19px]" />} />
            <StatCard label="已结算" value={<Money fen={d.distributor.commission.settled} className="text-[19px]" />} />
            <StatCard
              label="团队佣金合计"
              value={<Money fen={d.team.reduce((n, t) => n + (t.commission ?? 0), 0)} className="text-[19px]" />}
              sub={<span className="font-mono">{d.team.map((t: AdminChainLevelStat) => `L${t.level} ${t.commission === null ? '—' : fenText(t.commission)}`).join(' · ')}</span>}
            />
          </div>

          <Section title="最近佣金流水" desc="最近 20 条；完整流水去「佣金流水」tab 按代理筛。">
            {d.recentCommissions.length === 0
              ? <GrowthEmpty msg="这个代理还没有佣金流水" hint="计提要同时满足：总开关开启、他在买家的三级上溯里、他的等级在那一层有启用的比例。" />
              : <CommissionTable items={d.recentCommissions} />}
          </Section>

          <Section title="结算单" desc="生成 / 核准 / 打款 / 作废都在「结算单」tab 操作。">
            {d.settlements.length === 0
              ? <GrowthEmpty msg="还没有为这个代理出过结算单" hint="结算单要运营手动生成，不会自动出。" />
              : (
                <TableScroll>
                  <Table className="min-w-[40rem]">
                    <TableHeader>
                      <TableRow>
                        <TableHead>单号</TableHead>
                        <TableHead>周期</TableHead>
                        <TableHead className="text-right">条数</TableHead>
                        <TableHead className="text-right">净额</TableHead>
                        <TableHead>状态</TableHead>
                        <TableHead>凭证号</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {d.settlements.map((s) => (
                        <TableRow key={s.id}>
                          <TableCell className="font-mono text-[11px] text-muted-foreground" title={s.id}>{s.id.slice(-6)}</TableCell>
                          <TableCell className="font-mono text-[11px] text-muted-foreground">{beijingDay(s.periodStart)} → {beijingDay(s.periodEnd)}</TableCell>
                          <TableCell className="text-right font-mono text-[11.5px]">{s.entryCount}</TableCell>
                          <TableCell className="text-right"><Money fen={s.totalAmount} /></TableCell>
                          <TableCell><ToneBadge tone={settlementTone(s.status)}>{SETTLEMENT_STATUS_LABEL[s.status] ?? s.status}</ToneBadge></TableCell>
                          <TableCell className="font-mono text-[11px]">{s.paidRef || <span className="text-muted-foreground">—</span>}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableScroll>
              )}
          </Section>
        </div>
      )}</GrowthState>
    </>
  );
}

/* ══════════════ 小件 ══════════════ */

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor} className="text-[12px] leading-relaxed">{label}</Label>
      {children}
    </div>
  );
}

function KvRow({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-md bg-muted/40 px-2.5 py-2">
      <span className="w-16 shrink-0 text-[11.5px] text-muted-foreground">{k}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}

/** 资金动作前的回显：对谁、多少钱、几条（DESIGN.md「Echo the object」）。 */
function EchoRows({ rows }: { rows: { k: string; v: string; amount?: boolean }[] }) {
  return (
    <div className="divide-y rounded-md border bg-muted/40">
      {rows.map((r) => (
        <div key={r.k} className="flex items-center justify-between gap-3 px-3 py-2 text-[12.5px]">
          <span className="text-muted-foreground">{r.k}</span>
          <span className={r.amount ? 'font-mono font-semibold tabular-nums' : 'min-w-0 truncate text-right'}>{r.v}</span>
        </div>
      ))}
    </div>
  );
}

function InlineError({ msg }: { msg: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2.5 text-xs text-destructive" role="alert">
      <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden="true" />
      <span className="break-words">{msg}</span>
    </div>
  );
}
