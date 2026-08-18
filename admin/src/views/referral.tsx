// 经营 · 邀请增长：本体 Schema 说明图 / 邀请关系树 / IP 风控关联（三视图全只读）。
//
// 为什么单独成文件而不是并进 views/revenue.tsx（它才是 `revenue` 组的归属文件）：
//   ① revenue.tsx 359 行且正被并行改动（P2 埋点那边在里面补 ActivationEvent 读数口径说明），
//      两边同时写同一个文件必然互相覆盖；
//   ② 三个视图各自带一套手写 SVG 布局计算，塞进去会让「订单/漏斗/钻石/Token」四屏被图形代码淹没。
// nav.ts 仍把 `referral` 归在 `revenue` 组，导航上它就在订单/漏斗旁边——分组归位与文件拆分是两件事。
//
// ── 为什么是这三种图（视图选型有理由，不是审美偏好）────────────────────────────
//   ① 本体 Schema 用 **UML 类图**：它回答「模型长什么样」，读者要看的是字段与基数，
//      **刻意不用力导向图**——实例一多就是毛球，且力导向的布局每次刷新都不一样，没有阅读逻辑。
//   ② 邀请关系树用 **从左到右的层级树**：邀请关系天然有方向（谁邀谁）和层级（L1→L2→L3），
//      树布局可预测、可折叠、可下钻；节点大小编码直邀人数，颜色编码状态。
//   ③ 风控用 **二部图**（IP ↔ 新号）：正常用户分散在不同 IP 上、每个 IP 一两个人，刷号会聚集成
//      一个 IP 连着一串新号的扇形——这个形状要一眼可见，散点或表格都做不到。
//
// 零第三方图表库（admin 的 dependencies 只有 react/react-dom）：三张图都是手写 SVG，
// **颜色全部在 admin.css 的 `.rf-*` 组件类里用 token 定义，这里只算几何**（x/y/r/width）。
import { useCallback, useMemo, useState } from 'react';
import {
  api,
  type AdminReferralOverview, type AdminReferralRisk, type AdminReferralRiskGroup,
  type AdminReferralTenantOption, type AdminReferralTree, type AdminReferralTreeNode,
} from '../api';
import { PageHead, ViewState } from '../components';
import { useResource } from '../useResource';
import { fmtTime } from '../format';

type Tab = 'schema' | 'tree' | 'risk' | 'funnel';

const TABS: [Tab, string][] = [
  ['schema', '本体 Schema'],
  ['tree', '邀请关系树'],
  ['risk', '风控关联'],
  ['funnel', '转化漏斗'],
];

/** 归因结果的人话（服务端回的是机器可读的 outcome 值）。 */
const OUTCOME_LABEL: Record<string, string> = {
  bound: '成功建边',
  self: '自己的码',
  cycle: '会成环',
  unknown_code: '码不存在',
  expired: '超出归因窗口',
  already_bound: '已绑过别人',
  config_unavailable: '配置读取失败（未建边）',
  no_timestamp: '缺捕获时间（未建边）',
};

const SOURCE_LABEL: Record<string, string> = {
  share_friend: '转发好友',
  share_timeline: '朋友圈',
  poster_qr: '海报扫码',
  manual: '运营补绑',
};

function outcomeText(k: string): string { return OUTCOME_LABEL[k] ?? k; }
function sourceText(k: string): string { return SOURCE_LABEL[k] ?? k; }
function personText(name: string | null, phone: string | null, userId: string): string {
  return name?.trim() || phone || userId.slice(0, 8);
}

/* ══════════════ 外壳：tab + 租户筛选 + 天数窗口 ══════════════ */

export function ReferralView() {
  const [tab, setTab] = useState<Tab>('schema');
  const [tenantId, setTenantId] = useState('');
  const [days, setDays] = useState(30);

  // overview 在所有 tab 都取：它既是「本体 Schema」那屏的数据，也是**租户筛选项的唯一来源**
  // （树/风控两个端点不重复回一份租户列表）。代价是切到别的 tab 时多一次很轻的计数查询。
  const ov = useResource(
    useCallback(() => api.referralOverview({ days, tenantId: tenantId || undefined }), [days, tenantId]),
    [days, tenantId],
  );
  const tree = useResource(
    useCallback(() => api.referralTree({ tenantId: tenantId || undefined }), [tenantId]),
    [tenantId],
  );
  const risk = useResource(
    useCallback(() => api.referralRisk({ days, tenantId: tenantId || undefined }), [days, tenantId]),
    [days, tenantId],
  );

  const bar = (
    <FilterBar
      tab={tab} onTab={setTab}
      tenantId={tenantId} onTenant={setTenantId}
      days={days} onDays={setDays}
      tenants={ov.data?.tenants ?? []}
      tenantsLoading={ov.initial}
    />
  );

  if (tab === 'tree') {
    return (
      <>
        <PageHead k="referral" res={tree} badge={tree.data ? `${tree.data.edgeTotal} 条关系` : undefined} />
        {bar}
        {/* key=租户：换租户就是换一棵树，展开状态必须跟着重置——否则 expanded 里全是上一棵树的
            节点 id，新树会整棵折叠、看着像「这个租户没有下级」。 */}
        <ViewState res={tree} skeleton="rows">{(d: AdminReferralTree) => <TreeTab key={tenantId} data={d} />}</ViewState>
      </>
    );
  }
  if (tab === 'risk') {
    return (
      <>
        <PageHead k="referral" res={risk} badge={risk.data ? `${risk.data.groups.length} 组聚集` : undefined} />
        {bar}
        <ViewState res={risk} skeleton="rows">{(d: AdminReferralRisk) => <RiskTab data={d} />}</ViewState>
      </>
    );
  }
  if (tab === 'funnel') {
    return (
      <>
        <PageHead k="referral" />
        {bar}
        <FunnelPlaceholder />
      </>
    );
  }
  return (
    <>
      <PageHead k="referral" res={ov} badge={ov.data ? `${ov.data.edgesTotal} 条关系` : undefined} />
      {bar}
      <ViewState res={ov} skeleton="stats">{(d: AdminReferralOverview) => <SchemaTab data={d} />}</ViewState>
    </>
  );
}

function FilterBar({ tab, onTab, tenantId, onTenant, days, onDays, tenants, tenantsLoading }: {
  tab: Tab; onTab: (t: Tab) => void;
  tenantId: string; onTenant: (v: string) => void;
  days: number; onDays: (v: number) => void;
  tenants: AdminReferralTenantOption[];
  tenantsLoading: boolean;
}) {
  return (
    <div className="pad">
      <div className="filter-bar">
        <div className="chip-row">
          {TABS.map(([k, label]) => (
            <button key={k} type="button" className={`chip ${tab === k ? 'on' : ''}`} onClick={() => onTab(k)} aria-current={tab === k ? 'page' : undefined}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {/* 树是全量视图（关系是永久的，没有时间窗），所以它不出现天数筛选——摆一个不生效的筛选
          比没有筛选更糟。风控与归因分布才有窗口语义。 */}
      {tab !== 'tree' && tab !== 'funnel' && (
        <div className="filter-bar">
          <div className="chip-row">
            {[7, 30, 90].map((d) => (
              <button key={d} type="button" className={`chip ${days === d ? 'on' : ''}`} onClick={() => onDays(d)}>{d} 天</button>
            ))}
          </div>
        </div>
      )}
      {/* 租户维度：两张表都有 tenantId（多租户行级隔离），运营查/导/清都要能限定范围。 */}
      <div className="filter-bar">
        <div className="chip-row">
          <button type="button" className={`chip ${tenantId === '' ? 'on' : ''}`} onClick={() => onTenant('')}>全部租户</button>
          {tenants.slice(0, 8).map((t) => (
            <button key={t.tenantId} type="button" className={`chip ${tenantId === t.tenantId ? 'on' : ''}`} onClick={() => onTenant(t.tenantId)} title={t.tenantId}>
              {t.name?.trim() || t.tenantId.slice(0, 8)} · {t.edges}
            </button>
          ))}
          {tenants.length > 8 && <span className="tag off">另有 {tenants.length - 8} 个租户未列出</span>}
          {!tenantsLoading && tenants.length === 0 && <span className="tag off">暂无带邀请关系的租户</span>}
        </div>
      </div>
    </div>
  );
}

/* ══════════════ 视图① 本体 Schema（UML 类图，静态说明性质） ══════════════
   几何写死在下面的常量里：这张图说明的是**模型**，不随数据变，所以没有布局算法，
   只有一次性摆位。行数是唯一动态的部分——一张说明图旁边不给真实行数，读者无法判断
   「这些表到底有没有在跑」。 */

interface UmlClass {
  key: string;
  title: string;
  table: string;
  x: number; y: number; w: number;
  attrs: { t: string; key?: boolean }[];
}

const UML_HEAD_H = 36;
const UML_ROW_H = 17;
const UML_PAD_Y = 9;

const UML_CLASSES: UmlClass[] = [
  {
    key: 'user', title: 'User', table: 'app_user', x: 296, y: 20, w: 268,
    attrs: [
      { t: 'id                 主键', key: true },
      { t: 'tenantId           租户' },
      { t: 'inviteCode  @unique 永久码' },
      { t: 'planId / planExpiresAt' },
      { t: 'phone / name' },
    ],
  },
  {
    key: 'referral', title: 'Referral', table: 'referral', x: 16, y: 268, w: 296,
    attrs: [
      { t: 'userId   主键 = 单推荐人公理', key: true },
      { t: 'referrerId  直接邀请人' },
      { t: 'lv1 = referrerId   物化路径' },
      { t: 'lv2 / lv3  上两级（平移得到）' },
      { t: 'inviteCode / source' },
      { t: 'boundAt   绑定后不可变更' },
    ],
  },
  {
    key: 'attr', title: 'ReferralAttribution', table: 'referral_attribution', x: 500, y: 268, w: 324,
    attrs: [
      { t: 'id                 每次进线一行', key: true },
      { t: 'newUserId?   进线新号' },
      { t: 'referrerId?  解析出的码主' },
      { t: 'outcome      成功与失败都留痕' },
      { t: 'clientIp / userAgent  风控原料' },
      { t: 'inviteCode / source / createdAt' },
    ],
  },
];

function umlHeight(c: UmlClass): number {
  return UML_HEAD_H + UML_PAD_Y * 2 + c.attrs.length * UML_ROW_H;
}

/** 连线：折线点串 + 关系名 + 两端基数。所有连线都自上而下进入目标框顶边，箭头统一朝下。 */
interface UmlEdge {
  key: string;
  points: [number, number][];
  label: string;
  card: string;
  /** 关系名标注挂在第几段（折线的第 n 个水平段）的中点 */
  labelAt: number;
}

const UML_EDGES: UmlEdge[] = [
  {
    key: 'invited',
    points: [[340, 0], [340, 214], [110, 214], [110, 268]],
    label: '被邀人（谁是我的推荐人）', card: 'User 1 —— 0..1 Referral', labelAt: 2,
  },
  {
    key: 'inviter',
    points: [[430, 0], [430, 244], [230, 244], [230, 268]],
    label: '直邀 lv1（我邀了谁）', card: 'User 1 —— 0..N Referral', labelAt: 2,
  },
  {
    key: 'codeowner',
    points: [[470, 0], [470, 214], [610, 214], [610, 268]],
    label: '码主（谁的码被用了）', card: 'User 1 —— 0..N Attribution', labelAt: 2,
  },
  {
    key: 'newcomer',
    points: [[520, 0], [520, 244], [760, 244], [760, 268]],
    label: '进线新号（谁带码进来了）', card: 'User 0..1 —— 0..N Attribution', labelAt: 2,
  },
];

function SchemaTab({ data }: { data: AdminReferralOverview }) {
  const rows: Record<string, string> = {
    user: `${data.codedUsers} 人有码`,
    referral: `${data.edgesTotal} 行`,
    attr: `${data.attributionsInWindow} 行 / 近 ${data.days} 天`,
  };
  const userBottom = UML_CLASSES[0].y + umlHeight(UML_CLASSES[0]);
  return (
    <div className="pad">
      <div className="usage-summary">
        <div><b>{data.edgesTotal}</b><span>邀请关系总数（Referral 行数）</span></div>
        <div><b>{data.edgesInWindow}</b><span>近 {data.days} 天新建关系</span></div>
        <div><b>{data.attributionsInWindow}</b><span>近 {data.days} 天进线留痕（含失败）</span></div>
        <div><b>{data.codedUsers}</b><span>已生成邀请码的用户</span></div>
      </div>

      <div className="sec-h"><span className="t">本体 Schema</span><span className="s">UML 类图 · 连线标关系名与基数</span></div>
      <div className="rf-scroll">
        <svg className="rf-svg" viewBox="0 0 840 470" width="840" height="470" role="img" aria-label="User / Referral / ReferralAttribution 三者关系的 UML 类图">
          {UML_EDGES.map((e) => {
            // 第一个点的 y=0 是占位：所有连线都从 User 框底边出发，实际 y 在这里补上，
            // 免得改框高度时要手工同步四条线的起点。
            const pts = e.points.map(([x, y], i) => [x, i === 0 ? userBottom : y] as [number, number]);
            const seg = pts[e.labelAt];
            const prev = pts[e.labelAt - 1];
            const mx = (seg[0] + prev[0]) / 2;
            const end = pts[pts.length - 1];
            return (
              <g key={e.key}>
                <polyline className="rf-edge" points={pts.map(([x, y]) => `${x},${y}`).join(' ')} />
                <polygon className="rf-edge-head" points={`${end[0] - 4},${end[1] - 7} ${end[0] + 4},${end[1] - 7} ${end[0]},${end[1]}`} />
                <text className="rf-edge-l" x={mx} y={seg[1] - 19} textAnchor="middle">{e.label}</text>
                <text className="rf-edge-c" x={mx} y={seg[1] - 6} textAnchor="middle">{e.card}</text>
              </g>
            );
          })}
          {UML_CLASSES.map((c) => {
            const h = umlHeight(c);
            return (
              <g key={c.key}>
                <rect className="rf-uml-box" x={c.x} y={c.y} width={c.w} height={h} rx={10} />
                <path className="rf-uml-head" d={`M${c.x},${c.y + 10} a10,10 0 0 1 10,-10 h${c.w - 20} a10,10 0 0 1 10,10 v${UML_HEAD_H - 10} h${-c.w} z`} />
                <text className="rf-uml-t" x={c.x + 14} y={c.y + 17}>{c.title}</text>
                <text className="rf-uml-sub" x={c.x + 14} y={c.y + 29}>{c.table}</text>
                <text className="rf-uml-n" x={c.x + c.w - 14} y={c.y + 23} textAnchor="end">{rows[c.key]}</text>
                <line className="rf-uml-div" x1={c.x} y1={c.y + UML_HEAD_H} x2={c.x + c.w} y2={c.y + UML_HEAD_H} />
                {c.attrs.map((a, i) => (
                  <text
                    key={a.t}
                    className={`rf-uml-a ${a.key ? 'key' : ''}`}
                    x={c.x + 14}
                    y={c.y + UML_HEAD_H + UML_PAD_Y + 11 + i * UML_ROW_H}
                  >{a.t}</text>
                ))}
              </g>
            );
          })}
          {/* 两条边的关系用一句话说清，比再画一条虚线可靠 */}
          <text className="rf-edge-l" x={420} y={452} textAnchor="middle">
            一次带码进线 → Attribution 必落 1 行；只有 outcome=&apos;bound&apos; 才另生成 Referral 1 行
          </text>
        </svg>
      </div>

      <div className="sec-h"><span className="t">归因结果分布</span><span className="s">近 {data.days} 天 · 失败也留痕，所以这里能看到为什么没归上</span></div>
      {data.byOutcome.length === 0
        ? <div className="empty">近 {data.days} 天没有带码进线记录。</div>
        : (
          <div className="kv-grid">
            {data.byOutcome.map((o) => (
              <div key={o.key} className="kv"><span>{outcomeText(o.key)}</span><b>{o.count}</b></div>
            ))}
          </div>
        )}

      <div className="sec-h"><span className="t">建边来源分布</span><span className="s">近 {data.days} 天新建的关系</span></div>
      {data.bySource.length === 0
        ? <div className="empty">近 {data.days} 天没有新建邀请关系。</div>
        : (
          <div className="kv-grid">
            {data.bySource.map((s) => (
              <div key={s.key} className="kv"><span>{sourceText(s.key)}</span><b>{s.count}</b></div>
            ))}
          </div>
        )}

      <div className="ai-note">
        口径说明：关系数据「存满三级」（运营侧要看完整链路），但对用户的呈现与将来的激励口径「只看一级」
        —— 多级 + 利益是微信审核最敏感的形状。绑定后不可变更（Referral.userId 主键即单推荐人公理），
        判环沿 referrerId 递归上溯而不是只比物化的三级。
      </div>
    </div>
  );
}

/* ══════════════ 视图② 邀请关系树（从左到右层级树） ══════════════
   布局：列 = 层级（根 / L1 / L2 / L3），行 = 深度优先展开顺序，每个可见节点占一行。
   这套「每节点一行 + 直角折线」的布局是**可预测**的：同一份数据每次打开完全一样，
   展开一个节点只在它下面插入行，上下文不跳动（父节点居中的 tidy tree 会整屏重排）。
   编码：半径 = 直邀人数（sqrt 压缩，避免大 V 把小节点压成看不见的点）；
   底色 = 开通状态；红环 = 风控标记（两个维度正交，不互相覆盖）。 */

const T_COL_W = 190;
const T_ROW_H = 38;
const T_LEFT = 26;
const T_TOP = 34;
const T_LABEL_GAP = 14;
/** 最后一列右侧留给标签/元信息的宽度：不留够，L3 那一列的元信息会被 viewBox 直接裁掉。 */
const T_TAIL = 380;
const T_COLS = ['邀请人', 'L1 直邀', 'L2', 'L3'];

/** parentR：父节点半径。折线要从父节点圆周下沿起笔——从圆心起笔会把线画在父节点圆上面。 */
interface Row { node: AdminReferralTreeNode; y: number; parentY: number | null; parentR: number; open: boolean; }

function radiusOf(directCount: number): number {
  return 6 + Math.min(11, Math.sqrt(directCount) * 3.2);
}

function TreeTab({ data }: { data: AdminReferralTree }) {
  // 默认只展开根：一屏先给「谁在带人」，再由运营自己往下钻。
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(data.roots.map((r) => r.userId)));

  const allWithKids = useMemo(() => {
    const acc: string[] = [];
    const walk = (n: AdminReferralTreeNode) => {
      if (n.children.length > 0) acc.push(n.userId);
      n.children.forEach(walk);
    };
    data.roots.forEach(walk);
    return acc;
  }, [data]);

  const rows = useMemo(() => {
    const out: Row[] = [];
    let i = 0;
    const walk = (n: AdminReferralTreeNode, parentY: number | null, parentR: number) => {
      const y = T_TOP + i * T_ROW_H;
      i += 1;
      const open = expanded.has(n.userId);
      out.push({ node: n, y, parentY, parentR, open });
      if (open) n.children.forEach((c) => walk(c, y, radiusOf(n.directCount)));
    };
    data.roots.forEach((r) => walk(r, null, 0));
    return out;
  }, [data, expanded]);

  const toggle = (id: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const height = Math.max(T_TOP + T_ROW_H, T_TOP + rows.length * T_ROW_H + 10);
  const width = T_LEFT + T_COL_W * (T_COLS.length - 1) + T_TAIL;

  return (
    <div className="pad">
      <div className="usage-summary">
        <div><b>{data.inviterTotal}</b><span>有直邀的邀请人</span></div>
        <div><b>{data.edgeTotal}</b><span>邀请关系边</span></div>
        <div><b>{data.roots.length}</b><span>本图展示的邀请人（直邀最多的前 {data.rootLimit}）</span></div>
        <div><b>{rows.length}</b><span>当前展开的节点</span></div>
      </div>

      <div className="rf-legend">
        <span className="rf-legend-i"><i className="rf-sw act" />已开通付费</span>
        <span className="rf-legend-i"><i className="rf-sw reg" />仅注册</span>
        <span className="rf-legend-i"><i className="rf-sw risk" />有风控标记（近 {data.riskWindowDays} 天同 IP 聚集）</span>
        <span className="rf-legend-i">圆点大小 = 直邀人数</span>
        <span className="rf-legend-i">点节点可展开 / 折叠</span>
      </div>

      <div className="filter-bar">
        <button type="button" className="mini-btn" onClick={() => setExpanded(new Set(allWithKids))}>全部展开</button>
        <button type="button" className="mini-btn" onClick={() => setExpanded(new Set())}>全部折叠</button>
        <span className="tag off">共 {allWithKids.length} 个可展开节点</span>
      </div>

      {data.truncated && (
        <div className="usage-meta">
          关系边数已达单次取数上限，下面这棵树不是全部：请用租户筛选缩小范围后再看。
        </div>
      )}

      {data.roots.length === 0 ? (
        <div className="empty">
          {data.tenantId ? '该租户下还没有邀请关系。' : '还没有任何邀请关系。'}
          <div className="usage-meta">这是「确实没有数据」；如果是接口出错，上方会显示可重试的错误提示。</div>
        </div>
      ) : (
        <div className="rf-scroll">
          <svg className="rf-svg" viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-label="邀请关系层级树">
            {T_COLS.map((label, i) => (
              <g key={label}>
                <text className="rf-t-col" x={T_LEFT + i * T_COL_W} y={16}>{label}</text>
                <line className="rf-t-guide" x1={T_LEFT + i * T_COL_W - 10} y1={22} x2={T_LEFT + i * T_COL_W - 10} y2={height - 6} />
              </g>
            ))}
            {rows.map((r) => {
              const cx = T_LEFT + r.node.depth * T_COL_W + 10;
              const rr = radiusOf(r.node.directCount);
              const hasKids = r.node.children.length > 0;
              const beyond = r.node.depth === 3 && r.node.directCount > 0;
              const label = personText(r.node.name, r.node.phone, r.node.userId);
              // 元信息压在一行里（不另起第三行）：行距只有 38px，第三行会撞到下一行的标签。
              // 建边时刻这里只给日期，完整到秒的时刻在 <title> 里。
              const meta = [
                `直邀 ${r.node.directCount}`,
                r.node.status === 'activated' ? '已开通' : '仅注册',
                r.node.source ? sourceText(r.node.source) : null,
                r.node.boundAt ? r.node.boundAt.slice(0, 10) : null,
                beyond ? '下级超出三级视野' : null,
              ].filter(Boolean).join(' · ');
              return (
                <g key={`${r.node.depth}-${r.node.userId}-${r.y}`}>
                  {r.parentY !== null && (
                    <polyline
                      className="rf-t-edge"
                      points={`${cx - T_COL_W},${r.parentY + r.parentR + 2} ${cx - T_COL_W},${r.y} ${cx - rr - 3},${r.y}`}
                    />
                  )}
                  <g
                    className={hasKids ? 'rf-n' : ''}
                    role={hasKids ? 'button' : undefined}
                    tabIndex={hasKids ? 0 : undefined}
                    aria-expanded={hasKids ? r.open : undefined}
                    onClick={hasKids ? () => toggle(r.node.userId) : undefined}
                    onKeyDown={hasKids ? (e) => {
                      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(r.node.userId); }
                    } : undefined}
                  >
                    <title>{`${label} · 直邀 ${r.node.directCount} · ${r.node.status === 'activated' ? '已开通付费' : '仅注册'}${r.node.risk ? ' · 有风控标记' : ''}${r.node.boundAt ? ` · 建边 ${fmtTime(r.node.boundAt)}` : ''}${hasKids ? (r.open ? ' · 已展开' : ' · 可展开') : ''}`}</title>
                    <circle
                      className={`rf-n-c ${r.node.status === 'activated' ? 'act' : 'reg'} ${r.node.risk ? 'risk' : ''}`}
                      cx={cx} cy={r.y} r={rr}
                    />
                    <text className={`rf-n-t ${r.node.depth === 0 ? 'root' : ''}`} x={cx + rr + T_LABEL_GAP} y={r.y - 2}>
                      {label}{hasKids && <tspan className="rf-n-x"> {r.open ? '−' : '+'}{r.node.children.length}</tspan>}
                    </text>
                    <text className="rf-n-m" x={cx + rr + T_LABEL_GAP} y={r.y + 11}>{meta}</text>
                  </g>
                </g>
              );
            })}
          </svg>
        </div>
      )}

      <div className="ai-note">
        树只画到三级：Referral 的物化路径就存三级（lv1 / lv2 / lv3），这也是运营侧能看到的全部链路。
        展示的是「直邀人数最多的前 {data.rootLimit} 个邀请人」及其子树，是投影不是全景；这些邀请人自己
        也可能是别人的下级。风控标记与「风控关联」那一屏同源（同一批超阈值 IP 组），两屏不会各说一套。
      </div>
    </div>
  );
}

/* ══════════════ 视图③ 风控关联（IP ↔ 新号二部图） ══════════════
   只画超阈值的组：阈值归运营配置（功能开关「邀请风控聚集阈值」），前端不算也不写死。
   公理 5「风控预警不阻断」——这一屏**没有任何处置动作**（不封号、不拉黑、不停发奖）：
   看见了怎么处理是人的判断，不是这块屏的权力。 */

const B_IP_X = 118;
const B_USER_X = 470;
const B_ROW_H = 22;
const B_TOP = 30;
const B_GROUP_GAP = 16;
/** 图里最多画几组 / 每组最多画几个新号——完整名单在下面的清单里，图只负责让形状可见。 */
const B_FIG_GROUPS = 8;
const B_FIG_MEMBERS = 12;

function RiskTab({ data }: { data: AdminReferralRisk }) {
  // 逐组竖向排开：一组 = 一个 IP 节点 + 它连出去的新号扇形。组间留空，扇形宽窄一眼可比。
  // 依赖取 data 而不是切出来的数组：后者每次渲染都是新引用，useMemo 会白算。
  const laid = useMemo(() => {
    let y = B_TOP;
    return data.groups.slice(0, B_FIG_GROUPS).map((g) => {
      const members = g.members.slice(0, B_FIG_MEMBERS);
      const top = y;
      const h = Math.max(B_ROW_H, members.length * B_ROW_H);
      y += h + B_GROUP_GAP;
      return { g, members, top, h, ipY: top + h / 2 - B_ROW_H / 2 };
    });
  }, [data]);
  const figHeight = laid.length === 0 ? 0 : laid[laid.length - 1].top + laid[laid.length - 1].h + 20;
  const figWidth = 840;

  return (
    <div className="pad">
      <div className="usage-summary">
        <div><b>{data.groups.length}</b><span>超阈值的 IP 组</span></div>
        <div><b>{data.flaggedUsers}</b><span>被标记的新号</span></div>
        <div><b>{data.scannedIps}</b><span>近 {data.days} 天出现过的 IP</span></div>
        <div><b>≥ {data.threshold}</b><span>聚集阈值（同 IP 去重新号数）</span></div>
      </div>

      <div className="usage-meta">
        阈值来自运营配置「功能开关 · 邀请风控聚集阈值」（<span className="tag off">{data.flagKey}</span>）
        {data.configured ? '，当前为运营已落库的值。' : `，运营尚未配置，当前用的是代码兜底默认值 ${data.threshold}。`}
        {' '}近 {data.days} 天共扫描 {data.scannedAttributions} 条带 IP 的归因记录、{data.scannedIps} 个 IP。
        <br />
        判定只预警不阻断：列在这里的关系照常有效、注册照常放行，这一屏不提供任何封禁或拉黑动作。
      </div>

      {data.groups.length === 0 ? (
        <div className="empty">
          {data.scannedIps === 0
            ? `近 ${data.days} 天没有带 IP 的进线记录。`
            : `近 ${data.days} 天的 ${data.scannedIps} 个 IP 里，没有一个达到 ${data.threshold} 个去重新号的聚集度。`}
          <div className="usage-meta">
            {data.scannedIps === 0
              ? '这是「确实没有数据」；接口出错时上方会显示可重试的错误提示。'
              : '这是正常形态：真实用户分散在各自的 IP 上。要提高灵敏度就把阈值调小。'}
          </div>
        </div>
      ) : (
        <>
          <div className="rf-legend">
            <span className="rf-legend-i"><i className="rf-sw ip" />IP</span>
            <span className="rf-legend-i"><i className="rf-sw risk" />带码进线的新号</span>
            <span className="rf-legend-i">一个 IP 连出的扇形越宽 = 聚集越严重</span>
            {(data.groups.length > B_FIG_GROUPS || data.groups.some((g) => g.members.length > B_FIG_MEMBERS)) && (
              <span className="rf-legend-i">图中最多画 {B_FIG_GROUPS} 组 × 每组 {B_FIG_MEMBERS} 个，完整名单见下方清单</span>
            )}
          </div>
          <div className="rf-scroll">
            <svg className="rf-svg" viewBox={`0 0 ${figWidth} ${figHeight}`} width={figWidth} height={figHeight} role="img" aria-label="IP 与带码新号的二部图">
              {laid.map(({ g, members, ipY }) => (
                <g key={g.clientIp}>
                  {members.map((m, i) => {
                    // 新号绕 IP 节点上下均分展开成扇形
                    const uy = ipY + (i - (members.length - 1) / 2) * B_ROW_H;
                    return (
                      <g key={m.userId}>
                        <line className="rf-b-edge" x1={B_IP_X + 96} y1={ipY + 7} x2={B_USER_X - 6} y2={uy + 7} />
                        <circle className="rf-b-u" cx={B_USER_X} cy={uy + 7} r={5} />
                        <text className="rf-b-u-t" x={B_USER_X + 12} y={uy + 11}>
                          {personText(m.name, m.phone, m.userId)} · {m.inviteCode} · {outcomeText(m.outcome)}
                        </text>
                      </g>
                    );
                  })}
                  <rect className="rf-b-ip" x={B_IP_X - 6} y={ipY - 5} width={102} height={26} rx={7} />
                  <text className="rf-b-ip-t" x={B_IP_X + 4} y={ipY + 12}>{g.clientIp}</text>
                  <text className="rf-b-ip-n" x={B_IP_X - 14} y={ipY + 12} textAnchor="end">{g.userCount} 号</text>
                </g>
              ))}
            </svg>
          </div>
        </>
      )}

      {data.groups.map((g) => <RiskGroupCard key={g.clientIp} group={g} />)}
    </div>
  );
}

function RiskGroupCard({ group }: { group: AdminReferralRiskGroup }) {
  const [open, setOpen] = useState(false);
  const hidden = group.userCount - group.members.length;
  return (
    <div className="usage-row">
      <div className="usage-h">
        <div className="usage-name">
          {group.clientIp}
          <span>
            {group.codeCount === 1 ? '单码批量进线' : `${group.codeCount} 个邀请码`} · {group.referrerCount} 个码主 ·
            {' '}{fmtTime(group.firstAt)} → {fmtTime(group.lastAt)}
          </span>
        </div>
        <div className="usage-num">{group.userCount} 个新号</div>
      </div>
      <div className="usage-meta">
        {group.attributionCount} 条归因留痕（含建号失败的，那些不计入新号数）
        {hidden > 0 ? ` · 另有 ${hidden} 个新号未展开` : ''}
      </div>
      <div className="crd-actions">
        <button type="button" className="mini-btn" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? '收起名单' : '展开名单'}
        </button>
      </div>
      {open && (
        <div className="kv-grid">
          {group.members.map((m) => (
            <div key={m.userId} className="kv">
              <span>{m.inviteCode} · {outcomeText(m.outcome)}</span>
              <b>{personText(m.name, m.phone, m.userId)}</b>
              <span>{fmtTime(m.createdAt)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ══════════════ 视图④ 转化漏斗（本期不做，留位） ══════════════ */

function FunnelPlaceholder() {
  return (
    <div className="pad">
      <div className="sec-h"><span className="t">转化漏斗</span><span className="s">待 P2 埋点落地</span></div>
      <div className="empty">
        这一屏还没有数据源。
        <div className="usage-meta">
          漏斗的四段是「分享曝光 → 落地打开 → 注册 → 首次开通」。后两段现在就能查（注册段读
          ReferralAttribution，开通段读 ActivationEvent），但前两段要读客户端埋点表 ClientEvent
          —— 它目前只写不查、还没有任何聚合读端点。所以这里先留位，而不是画一个只有后两段的假漏斗。
          <br />
          开通来源已经在「处方漏斗」那一屏（按 ActivationEvent.source 分组），邀请侧会在那里表现为
          invite 这一类 —— 不要在这里再造一个漏斗，两处各做一遍必然口径打架。
          <br />
          注意那一屏的读数口径：invite 桶与 prescription / catalog / market 三桶重叠、不能相加
          （一次开通既可能是「从处方位成交」又可能是「这人是被邀请来的」，服务端为后者另落一行）。
        </div>
      </div>
    </div>
  );
}
