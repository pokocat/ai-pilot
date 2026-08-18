// 运营后台「邀请增长」三视图的只读聚合（P3）。
//
// 为什么单独成文件而不是塞进 routes/admin.ts：admin.ts 已 2900+ 行，而这三个投影各自要做
// 一次成形（分层 / 分组 / 阈值判定），加进去等于把前端刚还完的那笔「一个文件装下所有屏」
// 的债在服务端重开一次。鉴权口径**完全照 admin.ts**（`app.addHook('preHandler', requireAdmin)`），
// 没有新发明：requireAdmin 认 ADMIN_TOKEN / 会话 token / role=admin 用户，无凭证 401、
// 已登录非管理员 403。adminRoutes 与本插件都是独立封装上下文，各挂自己的 hook 互不影响。
//
// 四个端点对应三个投影 + 一份筛选项（一份数据三个视角，不做第二份存储）：
//   GET /admin/referral/overview  本体 Schema 说明图的真实行数与归因结果分布
//   GET /admin/referral/tree      邀请关系树（吃 Referral 的物化路径 lv1/lv2/lv3）
//   GET /admin/referral/risk      风控二部图（按 ReferralAttribution.clientIp 聚集）
//   GET /admin/referral/tenants   租户筛选项（四个 tab 都要用，不该绑在 overview 上）
//
// **公理 5「风控预警不阻断」**：本文件只回统计与名单，**没有任何写操作**——不提供封禁、
// 拉黑、停发奖。风控视图的产出是「让运营看见」，处置走人工判断，不由这块屏直接执行。
//
// 读失败不许伪装成空：这里不写任何 try/catch 兜底空数组。DB 抖动 / 配置读不到就让它 500，
// 前端 useResource 会渲染成「加载失败 + 重试」，而不是「你还没有邀请数据」。
//
// ── 隐私口径（2026-08-18 复核后收窄）────────────────────────────────────────
// 风控响应会把 IP、用户 id、身份标签放在同一行，天然是「关联后的画像」。所以：
//   ① **不下发 userAgent**：前端一处也不展示，下发等于把设备指纹摊给每一个后台账号；
//   ② 手机号一律走 `services/audit.ts` 的 `maskAuditPhone`（与审计日志同一把掩码，不另写规则），
//      树节点也照此掩码——树上同时带着风控红环，关联面与风控屏是同一类。
import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { requireAdmin } from '../services/adminAuth.js';
import { maskAuditPhone } from '../services/audit.js';
import { featureFlagPayload } from '../services/featureFlag.js';
import { isExpired } from '../services/planTime.js';
import { now } from '../services/clock.js';
import type {
  AdminReferralOverview, AdminReferralRisk, AdminReferralRiskGroup, AdminReferralRiskMember,
  AdminReferralTree, AdminReferralTreeNode, AdminReferralCount, AdminReferralTenantOption,
} from '../../../shared/contracts';

/* ── 契约待补的两处收口（本文件先用局部类型声明，contracts.d.ts 补齐后可直接删掉这段）──
   两处都已在契约里收口（`groupTotal` 已加、`userAgent` 已删），下面的别名因此不再修形。 */
// 契约已于 2026-08-18 收口（`groupTotal` 已加、`userAgent` 已删），这三个别名不再做任何修形，
// 保留只为少改下面的引用点。
type RiskMemberOut = AdminReferralRiskMember;
type RiskGroupOut = AdminReferralRiskGroup;
type RiskOut = AdminReferralRisk;

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

/* ── 取数上限：每一处都必须「按组限量」，不能全局一刀切 ─────────────────────
   历史坑（2026-08-18 复核）：明细原来是一条 `findMany({ take: 5000 })` 全局截断、再在内存里
   去重判阈值。于是「某个 IP 先攒够 5000 条重复旧留痕 → 另一个 IP 上真实的 10 个新号整组消失，
   页面显示『没有聚集』」——风控视图唯一的价值就是看见聚集，这种漏报比没有这块屏更糟。
   现在聚集判定与去重全部下推到 SQL（`COUNT(DISTINCT) + HAVING`，无行上限），明细按 IP 分区
   截断（`ROW_NUMBER() OVER (PARTITION BY "clientIp")`）：**任何一组都不会因为别的组记录多而消失，
   任何一组的名单也不会被同组的重复留痕挤掉**。组数触顶时 groupTotal 如实回总数。 */
/** 二部图一屏返回的组数上限（总组数照实回 groupTotal，页面据此说明还有多少组没返回）。 */
const RISK_GROUP_CAP = 40;
/** 每组展开的新号数上限（按 IP 分区截断；真实聚集度仍由 userCount 如实给出）。 */
const RISK_MEMBER_CAP = 40;
/** 树一次取的边数上限：超出即截断并如实告知（截断后不可达的节点直接不渲染，不会拼出错树）。 */
export const TREE_ROW_CAP = 3000;
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

/**
 * 归因扫描窗口。同一个窗口要给两种消费者用，所以同时给出 SQL 片段与 Prisma where：
 * 聚集判定必须 `COUNT(DISTINCT)`（Prisma 的 groupBy 做不到）走原生 SQL，而「这些树节点里
 * 哪些落在被报出的 IP 上」是一次普通的有界 groupBy，用 Prisma 更清楚。
 * 两者的作用域字面同源，不会各写一遍后漂移。
 */
function riskWindow(days: number, tenantId: string | null): {
  sql: Prisma.Sql; where: Prisma.ReferralAttributionWhereInput;
} {
  const since = new Date(now().getTime() - days * DAY_MS);
  return {
    // 老记录可能没采到 IP（列是后加的）：它们不参与聚集判定，也不该被算进 scannedIps 分母。
    sql: Prisma.sql`"createdAt" >= ${since} AND "clientIp" IS NOT NULL${tenantId ? Prisma.sql` AND "tenantId" = ${tenantId}` : Prisma.empty}`,
    where: {
      createdAt: { gte: since },
      clientIp: { not: null },
      ...(tenantId ? { tenantId } : {}),
    },
  };
}

/** 分母：扫过多少 IP / 多少条带 IP 的留痕。一行聚合，不再把每个 IP 拉进内存。 */
async function riskScanCounts(scope: Prisma.Sql): Promise<{ scannedIps: number; scannedAttributions: number }> {
  const rows = await prisma.$queryRaw<{ ips: bigint | number; attrs: bigint | number }[]>(Prisma.sql`
    SELECT COUNT(DISTINCT "clientIp") AS ips, COUNT(*) AS attrs
    FROM referral_attribution
    WHERE ${scope}`);
  return { scannedIps: Number(rows[0]?.ips ?? 0), scannedAttributions: Number(rows[0]?.attrs ?? 0) };
}

interface RiskGroupAgg {
  clientIp: string;
  userCount: number;
  attributionCount: number;
  codeCount: number;
  referrerCount: number;
  firstAt: Date;
  lastAt: Date;
}

/**
 * 超阈值的 IP 组（聚集判定与排序全在 DB 里做完）。
 *
 * `HAVING COUNT(DISTINCT "newUserId") >= 阈值` 是这块屏的判定式本身：去重在 SQL 里发生，
 * 所以**重复留痕再多也只顶一个新号**，不会挤掉别的组，也不需要任何行数上限。
 * `group_total` 由同一个 CTE 数一遍（一次分组、两处使用），让截断可以如实透出：
 * 页面要能说「共 N 组，本页返回前 M 组」，而不是让运营以为一共就 M 组。
 * 建号失败的留痕没有 newUserId：它算这个 IP 的一条动静（attributionCount 计），但不算一个新号。
 */
async function riskGroups(scope: Prisma.Sql, threshold: number): Promise<{ groupTotal: number; groups: RiskGroupAgg[] }> {
  const rows = await prisma.$queryRaw<{
    clientIp: string;
    user_count: bigint | number; attr_count: bigint | number;
    code_count: bigint | number; referrer_count: bigint | number;
    first_at: Date; last_at: Date; group_total: bigint | number;
  }[]>(Prisma.sql`
    WITH g AS (
      SELECT "clientIp",
             COUNT(DISTINCT "newUserId") AS user_count,
             COUNT(*) AS attr_count,
             COUNT(DISTINCT "inviteCode") AS code_count,
             COUNT(DISTINCT "referrerId") AS referrer_count,
             MIN("createdAt") AS first_at,
             MAX("createdAt") AS last_at
      FROM referral_attribution
      WHERE ${scope}
      GROUP BY "clientIp"
      HAVING COUNT(DISTINCT "newUserId") >= ${threshold}
    )
    SELECT g.*, (SELECT COUNT(*) FROM g) AS group_total
    FROM g
    ORDER BY user_count DESC, attr_count DESC, "clientIp" ASC
    LIMIT ${RISK_GROUP_CAP}`);
  return {
    groupTotal: Number(rows[0]?.group_total ?? 0),
    groups: rows.map((r) => ({
      clientIp: r.clientIp,
      userCount: Number(r.user_count),
      attributionCount: Number(r.attr_count),
      codeCount: Number(r.code_count),
      referrerCount: Number(r.referrer_count),
      firstAt: r.first_at,
      lastAt: r.last_at,
    })),
  };
}

/**
 * 被报出的这些组各自的新号名单。
 *
 * `DISTINCT ON (clientIp, newUserId)` 取每人在该 IP 上**最早那条**留痕（inviteCode / outcome
 * 就是那次进线的），外面再用 `ROW_NUMBER() OVER (PARTITION BY "clientIp")` 按 IP 各取前 N ——
 * 名单上限是**按组**的，一个 IP 的重复留痕再多也不会把别的组、或同组里别人的名字挤掉。
 */
async function riskMembers(scope: Prisma.Sql, ips: string[]): Promise<{
  clientIp: string; newUserId: string; inviteCode: string; outcome: string; createdAt: Date;
}[]> {
  if (ips.length === 0) return [];
  return prisma.$queryRaw(Prisma.sql`
    SELECT r."clientIp", r."newUserId", r."inviteCode", r."outcome", r."createdAt"
    FROM (
      SELECT d.*, ROW_NUMBER() OVER (PARTITION BY d."clientIp" ORDER BY d."createdAt" ASC, d."newUserId" ASC) AS rn
      FROM (
        SELECT DISTINCT ON ("clientIp", "newUserId")
               "clientIp", "newUserId", "inviteCode", "outcome", "createdAt"
        FROM referral_attribution
        WHERE ${scope} AND "newUserId" IS NOT NULL AND "clientIp" IN (${Prisma.join(ips)})
        ORDER BY "clientIp", "newUserId", "createdAt" ASC
      ) d
    ) r
    WHERE r.rn <= ${RISK_MEMBER_CAP}
    ORDER BY r."clientIp" ASC, r.rn ASC`);
}

/**
 * 被标记的新号总数：落在**本次返回的这些组**上的去重新号数。
 * 口径必须与 groups 一致（都按截断后的组算），否则这个数会大于运营在下面清单里能找到的人数。
 * 一个新号可能同时出现在两个被报组上（换网），所以这里必须 DB 侧 DISTINCT，不能把各组相加。
 */
async function riskFlaggedUsers(scope: Prisma.Sql, ips: string[]): Promise<number> {
  if (ips.length === 0) return 0;
  const rows = await prisma.$queryRaw<{ n: bigint | number }[]>(Prisma.sql`
    SELECT COUNT(DISTINCT "newUserId") AS n
    FROM referral_attribution
    WHERE ${scope} AND "newUserId" IS NOT NULL AND "clientIp" IN (${Prisma.join(ips)})`);
  return Number(rows[0]?.n ?? 0);
}

/** 租户筛选项：只列真的有邀请边的租户（空租户摆在筛选条里是噪音）。 */
async function tenantOptions(): Promise<AdminReferralTenantOption[]> {
  const rows = await prisma.referral.groupBy({ by: ['tenantId'], _count: { _all: true } });
  const ids = rows.map((r) => r.tenantId);
  const tenants = ids.length === 0 ? [] : await prisma.tenant.findMany({
    where: { id: { in: ids } }, select: { id: true, name: true },
  });
  const nameById = new Map(tenants.map((t) => [t.id, t.name]));
  return rows
    .map((r) => ({ tenantId: r.tenantId, name: nameById.get(r.tenantId) ?? '(已删除租户)', edges: r._count._all }))
    .sort((a, b) => b.edges - a.edges || a.tenantId.localeCompare(b.tenantId));
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

    const [edgesTotal, edgesInWindow, attributionsInWindow, codedUsers, outcomeRows, sourceRows, tenants] = await Promise.all([
      prisma.referral.count({ where: edgeScope }),
      prisma.referral.count({ where: { ...edgeScope, boundAt: { gte: since } } }),
      prisma.referralAttribution.count({ where: attrWindow }),
      prisma.user.count({ where: { inviteCode: { not: null }, ...(tenantId ? { tenantId } : {}) } }),
      prisma.referralAttribution.groupBy({ by: ['outcome'], where: attrWindow, _count: { _all: true } }),
      prisma.referral.groupBy({ by: ['source'], where: { ...edgeScope, boundAt: { gte: since } }, _count: { _all: true } }),
      // 契约里 tenants 仍在 overview 上（保持兼容），但筛选条已改吃 /tenants —— 那份数据
      // 与天数窗口、租户筛选都无关，挂在这个随窗口重算的端点上等于每换一次筛选就重跑一遍。
      tenantOptions(),
    ]);

    return {
      days,
      tenantId,
      edgesTotal,
      edgesInWindow,
      attributionsInWindow,
      codedUsers,
      byOutcome: countList(outcomeRows.map((r) => ({ key: r.outcome, count: r._count._all }))),
      bySource: countList(sourceRows.map((r) => ({ key: r.source, count: r._count._all }))),
      tenants,
    };
  });

  /* ── 筛选项：租户列表单独一个端点 ────────────────────────────────────────
     租户筛选条在四个 tab 上都要在，但它的内容既不随天数窗口变、也不随当前选中的租户变。
     绑在 overview 上的代价是：切一次 tab / 换一次天数，就为了一份不变的筛选项重跑 4 个 count
     + 3 个 groupBy。拆出来之后前端可以给它**自己的三态与重试**——读失败必须说「筛选项没加载
     出来，重试」，不能显示成「暂无带邀请关系的租户」（那是业务空态，两者不许混）。 */
  app.get('/admin/referral/tenants', async (): Promise<AdminReferralTenantOption[]> => tenantOptions());

  /* ── 视图② 邀请关系树：一次给全三级，不做逐层展开的 N+1 ────────────────────
     物化路径就是为这个查询写全的：`lv1/lv2/lv3` 各有索引，一条 `OR` 就把所选根的整棵
     三级子树捞出来（lv1 命中=直邀、lv2 命中=二级、lv3 命中=三级），前端只做分层与折叠，
     不再按节点回头请求。逐层展开那种写法在这里等于每展开一个节点一次查询。

     ── `?days=` 在这个端点上**只管红环、不管画哪些边**（两个窗口刻意不是同一个 days）──
     · 取数窗口（画哪些边）= **全量、无时间窗**。邀请关系是永久的（`Referral.boundAt` 只是
       建边时刻，关系本身不过期），这棵树回答的是「谁带来了谁」。若让 days 也筛边，运营切到
       「7 天」时整棵树几乎清空——那不叫筛选，那叫把这块屏关掉。
     · 红环判定窗口（标哪些人）= **必须有窗口**，因为风控命题本身带窗口（「同一 IP 在窗口期内
       注册 ≥N 个带码新号」），而且必须与风控页**此刻显示的那个窗口**同源。
     所以前端把风控页当前选中的天数原样传下来，这里只喂给 riskGroups()，并把它原样回给前端
     （`riskWindowDays`）供图例说明。2026-08-18 复审的阻断 2 正是这里写死了 30 天：
     20 天前的聚集在「7 天」风控页里消失，树却仍标红；60 天前的在「90 天」风控页里出现，
     树却不标红——运营点着红环去风控屏找那个 IP，两屏各说一套。 */
  app.get<{ Querystring: { days?: string; tenantId?: string; roots?: string } }>('/admin/referral/tree', async (req): Promise<AdminReferralTree> => {
    const tenantId = tenantOf(req.query.tenantId);
    const rootLimit = Math.min(60, Math.max(1, Number(req.query.roots) || 12));
    // 与 /risk 同一把 clampDays（同一个默认值 30、同一个 1~365 夹取），两端不会各写一遍后漂移。
    const riskDays = clampDays(req.query.days);
    const edgeScope: Prisma.ReferralWhereInput = tenantId ? { tenantId } : {};
    const at = now();

    // 一次 groupBy 同时拿到三样东西：邀请人总数、每人的直邀数（= 节点大小编码，任意深度都准）、
    // 以及排序用的权重。深度 3 的节点自己的下级不在本次 OR 的结果里，但它的直邀数在这张表里，
    // 所以树末端不会谎报成 0（前端据此提示「下级已超出三级视野」）。
    const riskAt = riskWindow(riskDays, tenantId);
    const [byInviter, { threshold }] = await Promise.all([
      prisma.referral.groupBy({ by: ['lv1'], where: edgeScope, _count: { _all: true } }),
      riskThreshold(),
    ]);
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
        riskWindowDays: riskDays, truncated: false, roots: [],
      };
    }

    // 多取一条只为判断「是不是还有」：`>= TREE_ROW_CAP` 会把「刚好完整的 3000 条」误报成已截断，
    // 让运营去缩小一个本来就不需要缩小的范围（并怀疑这棵树不全）。
    const [fetched, riskAgg] = await Promise.all([
      prisma.referral.findMany({
        where: {
          ...edgeScope,
          OR: [{ lv1: { in: rootIds } }, { lv2: { in: rootIds } }, { lv3: { in: rootIds } }],
        },
        select: { userId: true, referrerId: true, boundAt: true, source: true },
        orderBy: { boundAt: 'asc' },
        take: TREE_ROW_CAP + 1,
      }),
      // 风控标记与二部图同源：着色依据的就是 /risk **本次会返回的那批组**——同一个函数、
      // 同一个阈值、同一份截断，且**同一个 days**（由请求带下来，不再各自写死）。
      // 少任何一项都会出现「树上标红、二部图里查不到那个 IP」的鬼故事：
      // 旧代码先是拿全量组着色只返回前 40 组，改完之后又剩下窗口写死 30 天这一项。
      riskGroups(riskAt.sql, threshold),
    ]);
    const truncated = fetched.length > TREE_ROW_CAP;
    const rows = truncated ? fetched.slice(0, TREE_ROW_CAP) : fetched;

    const ids = [...new Set([...rootIds, ...rows.map((r) => r.userId)])];
    const flaggedIps = riskAgg.groups.map((g) => g.clientIp);
    // 「这些树节点里，哪些落在被报出的 IP 上」：结果集被 ids 限住（≤ 边数上限），有界。
    const [users, flaggedRows] = await Promise.all([
      prisma.user.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true, phone: true, planId: true, planExpiresAt: true },
      }),
      flaggedIps.length === 0 ? Promise.resolve([]) : prisma.referralAttribution.groupBy({
        by: ['newUserId'],
        where: { ...riskAt.where, clientIp: { in: flaggedIps }, newUserId: { in: ids } },
      }),
    ]);
    const userById = new Map(users.map((u) => [u.id, u]));
    const flagged = new Set(flaggedRows.map((r) => r.newUserId).filter((v): v is string => !!v));

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
        // 掩码：树节点身上同时挂着风控红环（IP 聚集的结论），完整号码在这里没有额外用途
        // ——它只是姓名缺失时的备用标签，138****1234 足够认人。
        phone: maskAuditPhone(u?.phone),
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
      riskWindowDays: riskDays,
      roots: rootIds.map((id) => node(id, 0, null)),
    };
  });

  /* ── 视图③ 风控二部图：只回超阈值的组 ──────────────────────────────────
     阈值归运营（FeatureFlag `referral-risk.ipMin`），代码里只有兜底默认值。
     公理 5：**只预警不阻断**——本端点没有任何处置动作，关系照常绑定、注册照常放行。 */
  app.get<{ Querystring: { days?: string; tenantId?: string } }>('/admin/referral/risk', async (req): Promise<RiskOut> => {
    const days = clampDays(req.query.days);
    const tenantId = tenantOf(req.query.tenantId);
    const { threshold, configured } = await riskThreshold();
    const at = riskWindow(days, tenantId);

    const [counts, agg] = await Promise.all([riskScanCounts(at.sql), riskGroups(at.sql, threshold)]);
    const ips = agg.groups.map((g) => g.clientIp);
    const [memberRows, flaggedUsers] = await Promise.all([
      riskMembers(at.sql, ips),
      riskFlaggedUsers(at.sql, ips),
    ]);

    // 名字/掩码手机号一次查完（二部图右侧节点要能认人），不按组逐个查。
    const memberIds = [...new Set(memberRows.map((r) => r.newUserId))];
    const users = memberIds.length === 0 ? [] : await prisma.user.findMany({
      where: { id: { in: memberIds } },
      select: { id: true, name: true, phone: true },
    });
    const userById = new Map(users.map((u) => [u.id, u]));
    const membersByIp = new Map<string, RiskMemberOut[]>();
    for (const r of memberRows) {
      const u = userById.get(r.newUserId);
      const list = membersByIp.get(r.clientIp) ?? [];
      list.push({
        userId: r.newUserId,
        name: u?.name ?? null,
        // 掩码口径复用审计日志的 maskAuditPhone（不在这里另写一套规则）：这一行已经把
        // IP + 用户 id + 归因码放在一起，再加完整号码就是把可直接触达的名单发给每个后台账号。
        phone: maskAuditPhone(u?.phone),
        inviteCode: r.inviteCode,
        outcome: r.outcome,
        createdAt: r.createdAt.toISOString(),
      });
      membersByIp.set(r.clientIp, list);
    }

    return {
      days,
      tenantId,
      threshold,
      configured,
      flagKey: REFERRAL_RISK_FLAG,
      scannedIps: counts.scannedIps,
      scannedAttributions: counts.scannedAttributions,
      flaggedUsers,
      // 超阈值组总数；> groups.length 即本页被截断，页面据此如实说明还有多少组没返回。
      groupTotal: agg.groupTotal,
      groups: agg.groups.map((g) => ({
        clientIp: g.clientIp,
        userCount: g.userCount,
        attributionCount: g.attributionCount,
        codeCount: g.codeCount,
        referrerCount: g.referrerCount,
        firstAt: g.firstAt.toISOString(),
        lastAt: g.lastAt.toISOString(),
        members: membersByIp.get(g.clientIp) ?? [],
      })),
    };
  });
}
