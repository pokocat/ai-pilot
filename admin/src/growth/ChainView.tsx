// 增长 · 邀请链：以**一个人**为中心的三块——往上溯到根、团队四项统计、往下钻三级。
//
// 与「邀请增长」的关系树不是一回事：那一页画的是「直邀最多的前 N 人」的全景投影，回答
// 「整体长什么样」；这一页只回答「这个人的链路长什么样」，是客服/渠道排查的入口
// （订单里的人是谁带来的、这个代理下面到底有多少人、他的上级是谁）。
//
// 三块的口径各不相同，界面上必须说清，否则运营会把三个数当成同一个窗口下的：
//   · 上溯链：沿 referrerId 一路到根，**不限三级**（服务端 hop 上限 64；撞顶会如实回传）；
//   · 团队统计：只有 lv1/lv2/lv3（与物化路径同深），全量、不带时间窗；
//   · 下钻树：三级子树，节点口径与 /admin/referral/tree 完全一致；红点是「同 IP 聚集」预警，
//     只有它吃 days 窗口——关系本身是永久的，树始终全量。
//
// 全只读：这一页没有任何写操作。补绑在「邀请关系」，代理与结算在「代理分销」。

import { useCallback, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Crown, TriangleAlert, Users } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Breadcrumb, BreadcrumbItem, BreadcrumbList } from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { ScRoot } from '@/lib/scPortal';
import {
  api,
  type AdminChainAncestor, type AdminChainLevelStat, type AdminChainView as ChainData,
  type AdminReferralTreeNode, type AdminUserItem,
} from '../api';
import { PageHead } from '../components';
import { fmtTime } from '../format';
import { useResource } from '../useResource';
import { ACTIVATION_LABEL, personText, shortId, sourceText } from './labels';
import {
  FilterRow, GrowthEmpty, GrowthSearch, GrowthState, Money,
  Section, StatCard, ToneBadge, useDebounced,
} from './ui';

const DAY_OPTIONS = [
  { value: '7', label: '7 天' },
  { value: '30', label: '30 天' },
  { value: '90', label: '90 天' },
];

interface ChainProps {
  onOpenChain: (userId: string) => void;
  onOpenUser: (userId: string) => void;
  onOpenDistributor: (distributorId: string) => void;
}

/**
 * `userId` 为空 = 还没选人：那是**空态**，不是错误。
 * 所以按 id 有无拆成两个组件而不是在一个组件里 if——否则 `useResource` 会照样发一次
 * `/admin/invites/chain/`（尾巴空着）的请求，把「还没选人」渲染成 4xx 错误屏。
 */
export function ChainView({ userId, ...props }: ChainProps & { userId: string }) {
  if (!userId) return <ScRoot><ChainPicker onPick={props.onOpenChain} /></ScRoot>;
  return <ChainDetail userId={userId} {...props} />;
}

function ChainDetail({ userId, onOpenChain, onOpenUser, onOpenDistributor }: ChainProps & { userId: string }) {
  const [days, setDays] = useState('30');
  const query = useMemo(() => ({ days: Number(days) }), [days]);
  const res = useResource(useCallback(() => api.inviteChain(userId, query), [userId, query]), [userId, query]);

  return (
    <ScRoot>
      <PageHead k="chain" res={res} badge={res.data ? `${res.data.upline.length} 级上溯` : undefined} />
      <FilterRow>
        <span className="text-[11.5px] text-muted-foreground">红点窗口</span>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={days}
          onValueChange={(v) => { if (v) setDays(v); }}
          aria-label="同 IP 聚集判定的时间窗"
        >
          {DAY_OPTIONS.map((o) => (
            <ToggleGroupItem key={o.value} value={o.value} className="text-[12px]">{o.label}</ToggleGroupItem>
          ))}
        </ToggleGroup>
        <span className="text-[11px] text-muted-foreground">只影响下钻树上的风控红点；关系与团队统计始终全量</span>
        <Button type="button" variant="outline" size="sm" className="ml-auto" onClick={() => onOpenChain('')}>换个人</Button>
      </FilterRow>
      <GrowthState res={res} skeleton="stats">{(d: ChainData) => (
        <div className="space-y-3">
          <SelfCard data={d} onOpenUser={onOpenUser} onOpenDistributor={onOpenDistributor} />
          <UplineSection data={d} onOpenChain={onOpenChain} />
          <TeamSection team={d.team} isDistributor={!!d.distributor} />
          <DownlineSection data={d} onOpenChain={onOpenChain} />
        </div>
      )}</GrowthState>
    </ScRoot>
  );
}

/* ══════════════ 找人（无 id 时的空态） ══════════════ */

/**
 * 找人复用 `/admin/users`（一次拉全量、前端过滤），与命令面板同一条路子——
 * 邀请链没有自己的搜索端点，为它单开一个不值当。列表读失败要显示成可重试错误，
 * 不能渲染成「没有匹配的用户」（那是业务空态）。
 */
function ChainPicker({ onPick }: { onPick: (userId: string) => void }) {
  const [q, setQ] = useState('');
  const kw = useDebounced(q).trim().toLowerCase();
  const res = useResource(useCallback(() => api.users(), []), []);
  const matched = useMemo(() => {
    const all = res.data ?? [];
    if (!kw) return [];
    return all.filter((u) =>
      u.name?.toLowerCase().includes(kw)
      || u.phone?.includes(kw)
      || u.id.toLowerCase().includes(kw),
    ).slice(0, 20);
  }, [res.data, kw]);

  return (
    <>
      <PageHead k="chain" res={res} />
      <Section
        title="先找到人"
        desc="按姓名 / 手机号 / userId 搜一个人，再看他的上溯链、团队统计与三级下钻。也可以从「邀请关系」「用户」两页的行内动作直接跳进来。"
      >
        <FilterRow>
          <GrowthSearch value={q} onChange={setQ} placeholder="姓名 / 手机号 / userId" className="sm:max-w-96" />
        </FilterRow>
        <GrowthState res={res} skeleton="rows">{(all: AdminUserItem[]) => (
          !kw ? (
            <GrowthEmpty msg="输入姓名或手机号开始搜索" hint={`当前共 ${all.length} 个注册用户`} />
          ) : matched.length === 0 ? (
            <GrowthEmpty msg={`没有匹配「${q.trim()}」的用户`} hint="换个关键词；手机号可只输后四位。" />
          ) : (
            <div className="space-y-1.5">
              {matched.map((u) => (
                <button
                  key={u.id}
                  type="button"
                  className="flex w-full items-center gap-3 rounded-lg border bg-card px-3 py-2.5 text-left transition-colors hover:bg-accent"
                  onClick={() => onPick(u.id)}
                >
                  <Users className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-foreground">{u.name || '未填姓名'}</span>
                    <span className="block truncate font-mono text-[10.5px] text-muted-foreground">
                      {[u.phone, u.tenantName, shortId(u.id)].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                </button>
              ))}
            </div>
          )
        )}</GrowthState>
      </Section>
    </>
  );
}

/* ══════════════ 本人 ══════════════ */

function SelfCard({ data, onOpenUser, onOpenDistributor }: {
  data: ChainData;
  onOpenUser: (userId: string) => void;
  onOpenDistributor: (distributorId: string) => void;
}) {
  const { user, distributor } = data;
  return (
    <Section
      title={personText(user.name, user.phone, user.userId)}
      desc={
        <>
          注册于 {fmtTime(user.createdAt)} · 租户 {user.tenantId}
          {user.inviteCode ? <> · 本人邀请码 <span className="font-mono">{user.inviteCode}</span></> : <> · 还没生成邀请码</>}
        </>
      }
      actions={
        <>
          <ToneBadge tone={user.status === 'activated' ? 'ok' : 'muted'}>
            {ACTIVATION_LABEL[user.status] ?? user.status}
          </ToneBadge>
          {distributor && (
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenDistributor(distributor.id)}>
              <Crown className="size-3.5" /> 代理档案
            </Button>
          )}
          <Button type="button" variant="outline" size="sm" onClick={() => onOpenUser(user.userId)}>用户详情</Button>
        </>
      }
    >
      {distributor ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md bg-muted/40 px-3 py-2 text-[12.5px]">
          <ToneBadge tone="gold">代理</ToneBadge>
          <span className="text-foreground">{distributor.displayName || '未填对外名称'}</span>
          <span className="text-muted-foreground">等级 {distributor.tier?.name ?? '未分级'}</span>
          <span className="font-mono text-[11px] text-muted-foreground">{distributor.status}</span>
        </div>
      ) : (
        <div className="text-xs text-muted-foreground">本人不是签约代理，下面的团队统计里没有佣金一栏。</div>
      )}
    </Section>
  );
}

/* ══════════════ 上溯链 ══════════════ */

function UplineSection({ data, onOpenChain }: { data: ChainData; onOpenChain: (userId: string) => void }) {
  // 契约里 upline 按 depth 升序（1 = 直接邀请人）。界面从**根**往下读更接近「这条链怎么长出来的」。
  const rootFirst = useMemo(() => [...data.upline].reverse(), [data.upline]);
  return (
    <Section
      title="上溯链"
      desc={
        data.upline.length === 0
          ? '本人是根：没有推荐人。'
          : `从根往下到本人共 ${data.upline.length} 跳。上溯不限三级——物化路径只存三级，但 referrerId 可以一直往上追。`
      }
    >
      {data.uplineTruncated && (
        <div className="mb-3 flex items-start gap-2 rounded-md border border-warning/40 bg-warning-soft/60 p-2.5 text-xs text-warning" role="alert">
          <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden="true" />
          上溯撞到了 64 跳上限就停了——正常数据不该出现，可能有环或异常长链，请反馈。
        </div>
      )}
      {data.upline.length === 0 ? (
        <GrowthEmpty msg="这个人没有推荐人" hint="他是自己这条链的根。若确认应该有推荐人，可在「邀请关系」页做运营补绑。" />
      ) : (
        <Breadcrumb>
          <BreadcrumbList className="flex-col items-stretch gap-0 text-[13px] sm:gap-0">
            {rootFirst.map((a, i) => (
              <BreadcrumbItem key={a.userId} className="block">
                <AncestorRow ancestor={a} indent={i} onOpenChain={onOpenChain} isRoot={i === 0} />
              </BreadcrumbItem>
            ))}
            <BreadcrumbItem className="block">
              <div className="flex items-center gap-2 rounded-md bg-accent px-2.5 py-2" style={{ marginLeft: `${rootFirst.length * 14}px` }}>
                <span className="font-mono text-[10.5px] text-accent-foreground">本人</span>
                <span className="min-w-0 truncate text-[12.5px] text-accent-foreground">
                  {personText(data.user.name, data.user.phone, data.user.userId)}
                </span>
              </div>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      )}
    </Section>
  );
}

function AncestorRow({ ancestor, indent, onOpenChain, isRoot }: {
  ancestor: AdminChainAncestor;
  indent: number;
  onOpenChain: (userId: string) => void;
  isRoot: boolean;
}) {
  return (
    // 缩进随层级递增：这是随数据变化的布局，按 DESIGN.md 只有这类值允许走 inline style。
    <div className="flex flex-wrap items-center gap-2 py-1" style={{ marginLeft: `${indent * 14}px` }}>
      <Badge variant="outline" className="shrink-0 font-mono text-[10.5px]">
        {isRoot ? '根' : `第 ${ancestor.depth} 跳`}
      </Badge>
      <span className="min-w-0 truncate text-[12.5px] text-foreground" title={`userId ${ancestor.userId}`}>
        {personText(ancestor.name, ancestor.phone, ancestor.userId)}
      </span>
      <ToneBadge tone={ancestor.status === 'activated' ? 'ok' : 'muted'}>
        {ACTIVATION_LABEL[ancestor.status] ?? ancestor.status}
      </ToneBadge>
      {ancestor.isDistributor && <ToneBadge tone="gold">代理</ToneBadge>}
      <span className="font-mono text-[10.5px] text-muted-foreground">
        {sourceText(ancestor.source)} · {fmtTime(ancestor.boundAt)}
      </span>
      <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={() => onOpenChain(ancestor.userId)}>
        看他的链
      </Button>
    </div>
  );
}

/* ══════════════ 团队四卡 ══════════════ */

function TeamSection({ team, isDistributor }: { team: AdminChainLevelStat[]; isDistributor: boolean }) {
  const byLevel = (level: 1 | 2 | 3) => team.find((t) => t.level === level);
  const sum = (pick: (t: AdminChainLevelStat) => number) => team.reduce((n, t) => n + pick(t), 0);
  const levels: (1 | 2 | 3)[] = [1, 2, 3];
  const breakdown = (pick: (t: AdminChainLevelStat) => string) => (
    <span className="font-mono">
      {levels.map((l) => {
        const row = byLevel(l);
        return `L${l} ${row ? pick(row) : '—'}`;
      }).join(' · ')}
    </span>
  );

  return (
    <Section
      title="团队统计"
      desc="只统计 lv1/lv2/lv3（与物化路径同深），全量、不带时间窗。GMV 只算已支付且未退款的订单。"
    >
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="团队人数" value={sum((t) => t.users)} sub={breakdown((t) => String(t.users))} />
        <StatCard label="已开通付费" value={sum((t) => t.activated)} sub={breakdown((t) => String(t.activated))} />
        <StatCard
          label="团队已支付 GMV"
          value={<Money fen={sum((t) => t.paidGmv)} className="text-[19px]" />}
          sub={breakdown((t) => t.paidGmv === 0 ? '¥0' : `¥${(t.paidGmv / 100).toFixed(0)}`)}
        />
        <StatCard
          label="佣金合计"
          value={isDistributor ? <Money fen={sum((t) => t.commission ?? 0)} className="text-[19px]" /> : <span className="text-[14px] text-muted-foreground">非代理</span>}
          sub={isDistributor
            ? breakdown((t) => t.commission === null ? '—' : (t.commission === 0 ? '¥0' : `¥${(t.commission / 100).toFixed(0)}`))
            : '只有签约代理才计提佣金；普通邀请人不计提。'}
        />
      </div>
    </Section>
  );
}

/* ══════════════ 下钻三级 ══════════════ */

/** 数一棵子树里除根之外的节点数。 */
function countDescendants(node: AdminReferralTreeNode): number {
  return node.children.reduce((n, c) => n + 1 + countDescendants(c), 0);
}

function DownlineSection({ data, onOpenChain }: { data: ChainData; onOpenChain: (userId: string) => void }) {
  const root = data.downline.roots[0] ?? null;
  /* 徽标必须数**本人这棵子树**里的人，不能直接用 `downline.edgeTotal`——那是「作用域内的关系边总数」
     （全量口径），在这一页会出现「团队人数 1」旁边写着「3 条边」的自相矛盾。 */
  const total = root ? countDescendants(root) : 0;
  return (
    <Section
      title="下钻（三级）"
      desc={
        <>
          节点口径与「邀请增长」的关系树完全一致：底色标开通状态、红点标同 IP 聚集预警
          （窗口 {data.downline.riskWindowDays} 天）。预警不阻断——关系照常有效。
        </>
      }
      actions={<Badge variant="outline" className="font-mono text-[10.5px]">下游 {total} 人</Badge>}
    >
      {data.downline.truncated && (
        <div className="mb-3 flex items-start gap-2 rounded-md border border-warning/40 bg-warning-soft/60 p-2.5 text-xs text-warning" role="alert">
          <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden="true" />
          子树被截断了，下面显示的不是全部。
        </div>
      )}
      {!root || root.children.length === 0 ? (
        <GrowthEmpty msg="这个人还没有邀请过任何人" hint="他自己也可能是别人邀来的——看上面的上溯链。" />
      ) : (
        <div className="space-y-0.5">
          {root.children.map((n) => <TreeNode key={n.userId} node={n} onOpenChain={onOpenChain} defaultOpen />)}
        </div>
      )}
    </Section>
  );
}

function TreeNode({ node, onOpenChain, defaultOpen = false }: {
  node: AdminReferralTreeNode;
  onOpenChain: (userId: string) => void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const hasKids = node.children.length > 0;
  const label = (
    <>
      <Badge variant="outline" className="shrink-0 font-mono text-[10px]">L{node.depth}</Badge>
      <span className="min-w-0 truncate text-[12.5px] text-foreground" title={`userId ${node.userId}`}>
        {personText(node.name, node.phone, node.userId)}
      </span>
      <ToneBadge tone={node.status === 'activated' ? 'ok' : 'muted'}>
        {ACTIVATION_LABEL[node.status] ?? node.status}
      </ToneBadge>
      {node.risk && (
        <span className="inline-flex items-center gap-1 text-[10.5px] text-destructive" title="落在超阈值的同 IP 聚集组里（预警，不阻断）">
          <span className="size-1.5 rounded-full bg-destructive" aria-hidden="true" /> 聚集预警
        </span>
      )}
      <span className="ml-auto shrink-0 font-mono text-[10.5px] text-muted-foreground">
        直邀 {node.directCount}
        {node.boundAt ? ` · ${sourceText(node.source ?? '')} · ${fmtTime(node.boundAt)}` : ''}
      </span>
    </>
  );

  if (!hasKids) {
    return (
      <div className="flex items-center gap-2 rounded-md py-1.5 pr-2 pl-7 hover:bg-muted/50">
        {label}
        <Button type="button" variant="ghost" size="sm" className="h-6 shrink-0 px-2 text-[11px]" onClick={() => onOpenChain(node.userId)}>看链</Button>
      </div>
    );
  }
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="flex items-center gap-2 rounded-md py-1.5 pr-2 hover:bg-muted/50">
        <CollapsibleTrigger asChild>
          <Button type="button" variant="ghost" size="icon" className="size-6 shrink-0" aria-label={open ? '折叠下级' : '展开下级'}>
            {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          </Button>
        </CollapsibleTrigger>
        {label}
        <Button type="button" variant="ghost" size="sm" className="h-6 shrink-0 px-2 text-[11px]" onClick={() => onOpenChain(node.userId)}>看链</Button>
      </div>
      <CollapsibleContent>
        <div className="ml-3 border-l pl-2">
          {node.children.map((c) => <TreeNode key={c.userId} node={c} onOpenChain={onOpenChain} />)}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
