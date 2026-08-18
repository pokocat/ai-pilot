// 运营后台「邀请增长」三视图的只读聚合（P3）。
//
// 为什么单独成文件而不是塞进 routes/admin.ts：admin.ts 已 2900+ 行，而这三个投影各自要做
// 一次成形（分层 / 分组 / 阈值判定），加进去等于把前端刚还完的那笔「一个文件装下所有屏」
// 的债在服务端重开一次。鉴权口径**完全照 admin.ts**（`app.addHook('preHandler', requireAdmin)`），
// 没有新发明：requireAdmin 认 ADMIN_TOKEN / 会话 token / role=admin 用户，无凭证 401、
// 已登录非管理员 403。adminRoutes 与本插件都是独立封装上下文，各挂自己的 hook 互不影响。
//
// 三个端点对应三个投影（一份数据三个视角，不做第二份存储）：
//   GET /admin/referral/overview  本体 Schema 说明图的真实行数与归因结果分布
//   GET /admin/referral/tree      邀请关系树（吃 Referral 的物化路径 lv1/lv2/lv3）
//   GET /admin/referral/risk      风控二部图（按 ReferralAttribution.clientIp 聚集）
//
// **公理 5「风控预警不阻断」**：本文件只回统计与名单，**没有任何写操作**——不提供封禁、
// 拉黑、停发奖。风控视图的产出是「让运营看见」，处置走人工判断，不由这块屏直接执行。
//
// 读失败不许伪装成空：这里不写任何 try/catch 兜底空数组。DB 抖动 / 配置读不到就让它 500，
// 前端 useResource 会渲染成「加载失败 + 重试」，而不是「你还没有邀请数据」。
import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { requireAdmin } from '../services/adminAuth.js';
import { featureFlagPayload } from '../services/featureFlag.js';
import { isExpired } from '../services/planTime.js';
import { now } from '../services/clock.js';
import type {
  AdminReferralOverview, AdminReferralRisk, AdminReferralRiskGroup, AdminReferralRiskMember,
  AdminReferralTree, AdminReferralTreeNode, AdminReferralCount,
} from '../../../shared/contracts';

/* ── 风控聚集阈值：归运营配置，代码里只留兜底 ─────────────────────────────
   单独一个 flag id 而不是复用 `referral` 的 payload：`PATCH /admin/flags/:id` 的 number 分支是
   `setFeatureFlagPayload(id, { [payloadKey]: v })`——**整块 payload 覆盖写**，把两个数值挤进同一个
   flag，运营改完归因窗口就会把阈值抹掉（反之亦然）。两个 id 各管一个数，谁都不会被对方清掉。
   这四个常量由 routes/admin.ts 的 FEATURE_FLAG_CATALOG 引用（同 REVIEW_GRACE_PER_DAY 的做法），
   保证「功能开关页能改的区间」与「本视图判定用的区间」是同一份，不会各写一遍后漂移。 */
export const REFERRAL_RISK_FLAG = 'referral-risk';
export const REFERRAL_RISK_PAYLOAD_KEY = 'ipMin';
/** 兜底默认值：同一 IP 上 5 个带码新号已经不像自然分布（家庭/公司共用出口一般 1~3 个）。 */
export const REFERRAL_RISK_DEF = 5;
export const REFERRAL_RISK_MIN = 2;
export const REFERRAL_RISK_MAX = 200;

/** 单次扫描的归因行上限：候选 IP 已按记录数预筛，正常远达不到；防一次误配阈值把内存打穿。 */
const RISK_ROW_CAP = 5000;
/** 二部图一屏能读的组数 / 每组展开的新号数上限（真实聚集度仍由 userCount 如实给出）。 */
const RISK_GROUP_CAP = 40;
const RISK_MEMBER_CAP = 40;
/** 树一次取的边数上限：超出即截断并如实告知（截断后不可达的节点直接不渲染，不会拼出错树）。 */
const TREE_ROW_CAP = 3000;
/**
 * 树上「风控标记」着色所依据的 IP 聚集窗口。
 *
 * 树本身是**全量**的（关系是永久的，没有时间窗），但风控是有窗口语义的事——「同一 IP 在窗口期内
 * 注册 ≥N 个带码新号」。两者窗口不同，所以窗口天数必须显式回给前端（`riskWindowDays`），
 * 否则运营会以为红点代表「这人历史上任何时候被标过」。
 */
const TREE_RISK_WINDOW_DAYS = 30;

const DAY_MS = 86_400_000;

function clampDays(raw: unknown): number {
  return Math.min(365, Math.max(1, Number(raw) || 30));
}

/** 租户维度筛选：两张表都有 tenantId（本仓多租户行级隔离铁律），空串/缺省=全租户。 */
function tenantOf(raw: unknown): string | null {
  const v = typeof raw === 'string' ? raw.trim() : '';
  return v ? v : null;
}

function countList(rows: { key: string | null; count: number }[]): AdminReferralCount[] {
  return rows
    .map((r) => ({ key: r.key ?? '(空)', count: r.count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

/**
 * 读风控聚集阈值。
 *
 * `fresh: true` 绕过 featureFlagPayload 的 60s 缓存：运营刚在「功能开关」页把阈值从 5 调到 3，
 * 转头就来这屏看效果——缓存会让他看到旧结果并以为改动没生效。这是后台只读路径，一次主键
 * findUnique 的代价换掉一个「配置像是没生效」的误判，值得。
 * **读失败照抛**：让页面显示「加载失败」，不要用兜底默认值算出一份看着正常的名单。
 */
async function riskThreshold(): Promise<{ threshold: number; configured: boolean }> {
  const raw = (await featureFlagPayload(REFERRAL_RISK_FLAG, { fresh: true })) as Record<string, unknown> | null;
  const n = Number(raw?.[REFERRAL_RISK_PAYLOAD_KEY]);
  const ok = Number.isFinite(n) && n >= REFERRAL_RISK_MIN && n <= REFERRAL_RISK_MAX;
  return { threshold: ok ? Math.floor(n) : REFERRAL_RISK_DEF, configured: ok };
}

interface RiskScan {
  threshold: number;
  configured: boolean;
  scannedIps: number;
  scannedAttributions: number;
  groups: AdminReferralRiskGroup[];
  /** 落在超阈值 IP 上的新号集合——树视图的「风控标记」着色直接用它，两个视图口径同源。 */
  flagged: Set<string>;
}

/**
 * 按 clientIp 聚集扫描。查询形状刻意是「先 groupBy 拿候选，再只取候选的明细」两步：
 *
 * ① `groupBy(clientIp)` 的结果集大小 = 窗口内出现过的 IP 数（有界，且顺带给出 scannedIps，
 *    让「扫过 N 个 IP、没有聚集」与「一条数据都没有」在界面上分得开）；
 * ② 聚集度按**去重新号数**算，但 Prisma 的 groupBy 不能 count distinct，所以先用「记录数 ≥ 阈值」
 *    预筛候选——记录数恒 ≥ 去重新号数，是个安全的超集，不会漏判；再对候选 IP 拉明细在内存里去重。
 *
 * 全程两条查询，没有按 IP 逐个查的 N+1。
 */
async function scanRisk(days: number, tenantId: string | null): Promise<RiskScan> {
  const { threshold, configured } = await riskThreshold();
  const since = new Date(now().getTime() - days * DAY_MS);
  const scope: Prisma.ReferralAttributionWhereInput = {
    createdAt: { gte: since },
    // 老记录可能没采到 IP（列是后加的）：它们不参与聚集判定，也不该被算进 scannedIps 分母。
    clientIp: { not: null },
    ...(tenantId ? { tenantId } : {}),
  };

  const byIp = await prisma.referralAttribution.groupBy({
    by: ['clientIp'],
    where: scope,
    _count: { _all: true },
  });
  const scannedIps = byIp.length;
  const scannedAttributions = byIp.reduce((a, g) => a + g._count._all, 0);
  const candidates = byIp
    .filter((g) => g._count._all >= threshold && g.clientIp)
    .map((g) => g.clientIp as string);

  if (candidates.length === 0) {
    return { threshold, configured, scannedIps, scannedAttributions, groups: [], flagged: new Set() };
  }

  const rows = await prisma.referralAttribution.findMany({
    where: { ...scope, clientIp: { in: candidates } },
    select: {
      clientIp: true, newUserId: true, referrerId: true, inviteCode: true,
      outcome: true, userAgent: true, createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
    take: RISK_ROW_CAP,
  });

  type Bucket = {
    ip: string;
    users: Map<string, { userId: string; inviteCode: string; outcome: string; createdAt: Date; userAgent: string | null }>;
    codes: Set<string>;
    referrers: Set<string>;
    rows: number;
    first: Date;
    last: Date;
  };
  const buckets = new Map<string, Bucket>();
  for (const r of rows) {
    const ip = r.clientIp as string;
    let b = buckets.get(ip);
    if (!b) {
      b = { ip, users: new Map(), codes: new Set(), referrers: new Set(), rows: 0, first: r.createdAt, last: r.createdAt };
      buckets.set(ip, b);
    }
    b.rows += 1;
    if (r.createdAt < b.first) b.first = r.createdAt;
    if (r.createdAt > b.last) b.last = r.createdAt;
    b.codes.add(r.inviteCode);
    if (r.referrerId) b.referrers.add(r.referrerId);
    // 建号失败的留痕没有 newUserId：它算这个 IP 的一条动静，但不算一个「新号」。
    if (r.newUserId && !b.users.has(r.newUserId)) {
      b.users.set(r.newUserId, {
        userId: r.newUserId, inviteCode: r.inviteCode, outcome: r.outcome,
        createdAt: r.createdAt, userAgent: r.userAgent,
      });
    }
  }

  const over = [...buckets.values()]
    .filter((b) => b.users.size >= threshold)
    .sort((a, b) => b.users.size - a.users.size || b.rows - a.rows || a.ip.localeCompare(b.ip));

  const flagged = new Set<string>();
  for (const b of over) for (const id of b.users.keys()) flagged.add(id);

  // 名字/手机号一次查完（二部图右侧节点要能认人），不按组逐个查。
  const shown = over.slice(0, RISK_GROUP_CAP);
  const ids = [...new Set(shown.flatMap((b) => [...b.users.keys()].slice(0, RISK_MEMBER_CAP)))];
  const users = ids.length === 0 ? [] : await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, phone: true },
  });
  const userById = new Map(users.map((u) => [u.id, u]));

  const groups: AdminReferralRiskGroup[] = shown.map((b) => {
    const members: AdminReferralRiskMember[] = [...b.users.values()]
      .slice(0, RISK_MEMBER_CAP)
      .map((m) => {
        const u = userById.get(m.userId);
        return {
          userId: m.userId,
          name: u?.name ?? null,
          phone: u?.phone ?? null,
          inviteCode: m.inviteCode,
          outcome: m.outcome,
          createdAt: m.createdAt.toISOString(),
          userAgent: m.userAgent,
        };
      });
    return {
      clientIp: b.ip,
      userCount: b.users.size,
      attributionCount: b.rows,
      codeCount: b.codes.size,
      referrerCount: b.referrers.size,
      firstAt: b.first.toISOString(),
      lastAt: b.last.toISOString(),
      members,
    };
  });

  return { threshold, configured, scannedIps, scannedAttributions, groups, flagged };
}

/**
 * 「已开通付费」判定：**复用 services/planGate.ts 的口径**——无 planId = 未开通；
 * 有 planId 且 `isExpired(planExpiresAt, now())` = 已到期（视作仅注册）；否则已开通。
 * `planExpiresAt` 为 null 即不到期，这层语义在 `planTime.isExpired` 里，不在这里重写。
 *
 * 为什么不直接调 `planGateState(userId)`：它是单用户 findUnique + 进程内 30s 缓存，
 * 一棵树几百个节点就是几百次查询（N+1）。这里改成一次 findMany 拿 planId/planExpiresAt，
 * 判定表达式与 planGate 逐字相同、时钟同样走 clock.now()（沙箱 x-test-now 快进后，
 * 这里的「已开通」和套餐页、和 referralSummary 的 activatedCount 必须是同一个答案）。
 */
function planStatus(u: { planId: string | null; planExpiresAt: Date | null } | undefined, at: Date): 'activated' | 'registered' {
  if (!u?.planId) return 'registered';
  return isExpired(u.planExpiresAt, at) ? 'registered' : 'activated';
}

export async function adminReferralRoutes(app: FastifyInstance) {
  // 与 routes/admin.ts 同一把闸：本插件内所有 /admin/referral/* 都要过 requireAdmin。
  app.addHook('preHandler', requireAdmin);

  /* ── 视图① 本体 Schema：给说明图配真实行数 + 归因结果分布 ──────────────────
     说明图本身是静态的（类框与连线不随数据变），但如果它旁边没有任何真实数字，
     运营就无法判断「这张图说的表到底有没有在跑」。这里给三个类的行数与 outcome 分布。 */
  app.get<{ Querystring: { days?: string; tenantId?: string } }>('/admin/referral/overview', async (req): Promise<AdminReferralOverview> => {
    const days = clampDays(req.query.days);
    const tenantId = tenantOf(req.query.tenantId);
    const since = new Date(now().getTime() - days * DAY_MS);
    const edgeScope: Prisma.ReferralWhereInput = tenantId ? { tenantId } : {};
    const attrWindow: Prisma.ReferralAttributionWhereInput = {
      createdAt: { gte: since }, ...(tenantId ? { tenantId } : {}),
    };

    const [edgesTotal, edgesInWindow, attributionsInWindow, codedUsers, outcomeRows, sourceRows, tenantRows] = await Promise.all([
      prisma.referral.count({ where: edgeScope }),
      prisma.referral.count({ where: { ...edgeScope, boundAt: { gte: since } } }),
      prisma.referralAttribution.count({ where: attrWindow }),
      prisma.user.count({ where: { inviteCode: { not: null }, ...(tenantId ? { tenantId } : {}) } }),
      prisma.referralAttribution.groupBy({ by: ['outcome'], where: attrWindow, _count: { _all: true } }),
      prisma.referral.groupBy({ by: ['source'], where: { ...edgeScope, boundAt: { gte: since } }, _count: { _all: true } }),
      // 租户筛选项：只列真的有邀请边的租户（空租户摆在筛选条里是噪音）。全租户视图下也照给，
      // 这样运营切租户不需要先去别的页面抄 id。
      prisma.referral.groupBy({ by: ['tenantId'], _count: { _all: true } }),
    ]);

    const tenantIds = tenantRows.map((r) => r.tenantId);
    const tenants = tenantIds.length === 0 ? [] : await prisma.tenant.findMany({
      where: { id: { in: tenantIds } }, select: { id: true, name: true },
    });
    const nameById = new Map(tenants.map((t) => [t.id, t.name]));

    return {
      days,
      tenantId,
      edgesTotal,
      edgesInWindow,
      attributionsInWindow,
      codedUsers,
      byOutcome: countList(outcomeRows.map((r) => ({ key: r.outcome, count: r._count._all }))),
      bySource: countList(sourceRows.map((r) => ({ key: r.source, count: r._count._all }))),
      tenants: tenantRows
        .map((r) => ({ tenantId: r.tenantId, name: nameById.get(r.tenantId) ?? '(已删除租户)', edges: r._count._all }))
        .sort((a, b) => b.edges - a.edges || a.tenantId.localeCompare(b.tenantId)),
    };
  });

  /* ── 视图② 邀请关系树：一次给全三级，不做逐层展开的 N+1 ────────────────────
     物化路径就是为这个查询写全的：`lv1/lv2/lv3` 各有索引，一条 `OR` 就把所选根的整棵
     三级子树捞出来（lv1 命中=直邀、lv2 命中=二级、lv3 命中=三级），前端只做分层与折叠，
     不再按节点回头请求。逐层展开那种写法在这里等于每展开一个节点一次查询。 */
  app.get<{ Querystring: { tenantId?: string; roots?: string } }>('/admin/referral/tree', async (req): Promise<AdminReferralTree> => {
    const tenantId = tenantOf(req.query.tenantId);
    const rootLimit = Math.min(60, Math.max(1, Number(req.query.roots) || 12));
    const edgeScope: Prisma.ReferralWhereInput = tenantId ? { tenantId } : {};
    const at = now();

    // 一次 groupBy 同时拿到三样东西：邀请人总数、每人的直邀数（= 节点大小编码，任意深度都准）、
    // 以及排序用的权重。深度 3 的节点自己的下级不在本次 OR 的结果里，但它的直邀数在这张表里，
    // 所以树末端不会谎报成 0（前端据此提示「下级已超出三级视野」）。
    const byInviter = await prisma.referral.groupBy({
      by: ['lv1'], where: edgeScope, _count: { _all: true },
    });
    const directCountOf = new Map(byInviter.map((r) => [r.lv1, r._count._all]));
    const inviterTotal = byInviter.length;
    const edgeTotal = byInviter.reduce((a, r) => a + r._count._all, 0);

    // 根 = 直邀人数最多的前 N 个邀请人。他们自己可能也是别人的下级——这是**投影不是全景**，
    // 排序稳定（数量降序、id 升序兜平），保证同一份数据每次打开的布局一致（可预测布局）。
    const rootIds = [...byInviter]
      .sort((a, b) => b._count._all - a._count._all || a.lv1.localeCompare(b.lv1))
      .slice(0, rootLimit)
      .map((r) => r.lv1);

    if (rootIds.length === 0) {
      return {
        tenantId, rootLimit, inviterTotal, edgeTotal,
        riskWindowDays: TREE_RISK_WINDOW_DAYS, truncated: false, roots: [],
      };
    }

    const rows = await prisma.referral.findMany({
      where: {
        ...edgeScope,
        OR: [{ lv1: { in: rootIds } }, { lv2: { in: rootIds } }, { lv3: { in: rootIds } }],
      },
      select: { userId: true, referrerId: true, boundAt: true, source: true },
      orderBy: { boundAt: 'asc' },
      take: TREE_ROW_CAP,
    });
    const truncated = rows.length >= TREE_ROW_CAP;

    // 风控标记与二部图同源：一个新号被着成「风控」当且仅当它落在超阈值的 IP 组里。
    // 两个视图各算一遍就会出现「树上标红、二部图里查不到」的鬼故事。
    const { flagged } = await scanRisk(TREE_RISK_WINDOW_DAYS, tenantId);

    const ids = [...new Set([...rootIds, ...rows.map((r) => r.userId)])];
    const users = await prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, phone: true, planId: true, planExpiresAt: true },
    });
    const userById = new Map(users.map((u) => [u.id, u]));

    const childrenOf = new Map<string, typeof rows>();
    for (const r of rows) {
      const list = childrenOf.get(r.referrerId);
      if (list) list.push(r);
      else childrenOf.set(r.referrerId, [r]);
    }

    const node = (userId: string, depth: number, edge: { boundAt: Date; source: string } | null): AdminReferralTreeNode => {
      const u = userById.get(userId);
      const kids = depth >= 3 ? [] : (childrenOf.get(userId) ?? [])
        .map((c) => node(c.userId, depth + 1, { boundAt: c.boundAt, source: c.source }))
        .sort((a, b) => b.directCount - a.directCount || a.userId.localeCompare(b.userId));
      return {
        userId,
        name: u?.name ?? null,
        phone: u?.phone ?? null,
        directCount: directCountOf.get(userId) ?? 0,
        status: planStatus(u, at),
        risk: flagged.has(userId),
        depth,
        boundAt: edge ? edge.boundAt.toISOString() : null,
        source: edge ? edge.source : null,
        children: kids,
      };
    };

    return {
      tenantId, rootLimit, inviterTotal, edgeTotal, truncated,
      riskWindowDays: TREE_RISK_WINDOW_DAYS,
      roots: rootIds.map((id) => node(id, 0, null)),
    };
  });

  /* ── 视图③ 风控二部图：只回超阈值的组 ──────────────────────────────────
     阈值归运营（FeatureFlag `referral-risk.ipMin`），代码里只有兜底默认值。
     公理 5：**只预警不阻断**——本端点没有任何处置动作，关系照常绑定、注册照常放行。 */
  app.get<{ Querystring: { days?: string; tenantId?: string } }>('/admin/referral/risk', async (req): Promise<AdminReferralRisk> => {
    const days = clampDays(req.query.days);
    const tenantId = tenantOf(req.query.tenantId);
    const scan = await scanRisk(days, tenantId);
    return {
      days,
      tenantId,
      threshold: scan.threshold,
      configured: scan.configured,
      flagKey: REFERRAL_RISK_FLAG,
      scannedIps: scan.scannedIps,
      scannedAttributions: scan.scannedAttributions,
      flaggedUsers: scan.flagged.size,
      groups: scan.groups,
    };
  });
}
