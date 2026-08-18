// 运营后台「邀请增长」三视图的只读聚合（P3）。
//
// 这些断言守的是四件事：
//   ① 树按**物化路径**正确分层（L1→L2→L3 由 bindOnRegister 真实写出来的 lv1/lv2/lv3 决定，
//      不是测试自己捏的 lv 值），且 directCount 在树末端也不谎报成 0；
//   ② 风控只回**超阈值**的组，阈值来自运营配置（`PATCH /admin/flags/referral-risk`），
//      改配置就改判定 —— 证明它没写死在代码里；
//   ③ 未授权访问一律拒绝（四个端点都在 requireAdmin 后面）；
//   ④ **读数为空 ≠ 读失败**：空作用域回 200 + 显式的零计数（还告诉你扫了多少 IP），
//      查询真的挂了回 5xx，绝不伪装成「你还没有邀请数据」；
//   ⑤ **真实规模下不许漏报**（2026-08-18 复核补）：单个 IP 的重复留痕再多也不能挤掉别的组，
//      组数触顶要如实回总组数，树的红环只按「本次返回的那批组」着色、并且按**与风控页同一个
//      天数窗口**（树接收 `?days=`；同时钉住「天数只管红环、不筛关系边」这另一半口径）；
//   ⑥ **隐私不扩散**：风控/树响应里没有完整手机号（掩码走审计同一口径）、没有 userAgent。
//
// 另外钉一条公理 5：风控只预警不阻断 —— 这组端点里不存在任何处置/封禁写操作。
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.ts';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, uniquePhone } from './helpers.ts';
import { REFERRAL_RISK_FLAG, REFERRAL_RISK_DEF, TREE_ROW_CAP } from '../src/routes/adminReferral.ts';
import { __clearFeatureCache } from '../src/services/featureFlag.ts';
import { maskAuditPhone } from '../src/services/audit.ts';
import type {
  AdminReferralOverview, AdminReferralRisk, AdminReferralRiskGroup, AdminReferralRiskMember,
  AdminReferralTenantOption, AdminReferralTree, AdminReferralTreeNode,
} from '../../shared/contracts';

/* 风控响应形状 = 契约本身（2026-08-18 已收口：`groupTotal` 已加、`members[].userAgent` 已删）。
   保留这两个别名只为少改下面的断言引用点。 */
type RiskMemberBody = AdminReferralRiskMember;
type RiskBody = AdminReferralRisk;

process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'test-admin-token';

before(async () => { await getApp(); });
after(async () => { await closeApp(); });

/** 走真实注册链路建号（可带邀请码）——物化路径由 services/referral.ts 写，不由本测试捏造。 */
async function register(opts: { inviteCode?: string } = {}): Promise<string> {
  const body: Record<string, unknown> = { phone: uniquePhone(), name: '邀请视图用户' };
  if (opts.inviteCode) { body.inviteCode = opts.inviteCode; body.inviteCodeAt = Date.now(); }
  const r = await api<{ token: string }>('POST', '/api/auth/login', { body });
  assert.equal(r.status, 200, `注册应成功，实际 ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.token;
}

async function inviteCodeOf(token: string): Promise<string> {
  const me = await api<{ inviteCode?: string }>('GET', '/api/me', { token });
  assert.equal(me.status, 200);
  assert.ok(me.body.inviteCode, '/me 应惰性生成邀请码');
  return me.body.inviteCode!;
}

function childOf(node: AdminReferralTreeNode, userId: string): AdminReferralTreeNode {
  const hit = node.children.find((c) => c.userId === userId);
  assert.ok(hit, `${node.userId} 的下级里应包含 ${userId}，实际 ${JSON.stringify(node.children.map((c) => c.userId))}`);
  return hit!;
}

describe('鉴权：四个端点都在 requireAdmin 之后', () => {
  for (const path of [
    '/api/admin/referral/overview', '/api/admin/referral/tree',
    '/api/admin/referral/risk', '/api/admin/referral/tenants',
  ]) {
    test(`无凭证访问 ${path} → 401`, async () => {
      const r = await api('GET', path, { adminToken: false });
      assert.equal(r.status, 401, `应 401，实际 ${r.status}`);
      assert.equal(r.body.code, 'ADMIN_UNAUTHORIZED');
    });
  }

  test('已登录的普通小程序用户（非管理员）→ 403，不是 401', async () => {
    await cleanBusiness();
    await seedBaseline();
    const uid = await register();
    const r = await api('GET', '/api/admin/referral/tree', { token: uid, adminToken: false });
    assert.equal(r.status, 403, `应 403，实际 ${r.status} ${JSON.stringify(r.body)}`);
  });
});

describe('视图② 邀请关系树', () => {
  beforeEach(async () => { await cleanBusiness(); await seedBaseline(); });

  test('按物化路径分层：A→B→C→D 在 A 的树里是 depth 1/2/3，且第三级不再往下展开', async () => {
    const a = await register();
    const b = await register({ inviteCode: await inviteCodeOf(a) });
    const c = await register({ inviteCode: await inviteCodeOf(b) });
    const d = await register({ inviteCode: await inviteCodeOf(c) });

    // 先确认物化路径真的写全了（树的分层完全依赖它）
    const edgeD = await prisma.referral.findUniqueOrThrow({ where: { userId: d } });
    assert.equal(edgeD.lv1, c);
    assert.equal(edgeD.lv2, b);
    assert.equal(edgeD.lv3, a);

    const r = await api<AdminReferralTree>('GET', '/api/admin/referral/tree');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    // 三个人各有 1 个直邀（A→B、B→C、C→D），所以 inviterTotal=3、edgeTotal=3
    assert.equal(r.body.inviterTotal, 3);
    assert.equal(r.body.edgeTotal, 3);
    assert.equal(r.body.truncated, false);
    assert.ok(r.body.riskWindowDays > 0, '必须告知风控标记依据的窗口天数');

    const rootA = r.body.roots.find((n) => n.userId === a);
    assert.ok(rootA, 'A 应作为根出现（他有直邀）');
    assert.equal(rootA!.depth, 0);
    assert.equal(rootA!.boundAt, null, '根不是本树里的一条边，没有 boundAt');

    const lv1 = childOf(rootA!, b);
    assert.equal(lv1.depth, 1);
    assert.ok(lv1.boundAt, 'L1 是一条边，必须带建边时间');
    assert.equal(lv1.source, 'share_friend');
    const lv2 = childOf(lv1, c);
    assert.equal(lv2.depth, 2);
    const lv3 = childOf(lv2, d);
    assert.equal(lv3.depth, 3);
    assert.deepEqual(lv3.children, [], '物化路径只到三级，树也只画到三级');

    // D 自己没有直邀 → 0；C 有一个（D）→ 1。第三级节点的 directCount 取自全量 groupBy，
    // 不是从本次子树数出来的，所以「超出三级视野的下级」不会被谎报成 0。
    assert.equal(lv3.directCount, 0);
    assert.equal(lv2.directCount, 1, '第三级之上的节点直邀数照常');
  });

  test('节点大小=直邀人数；颜色状态=planGate 口径（有未过期套餐才算已开通）', async () => {
    const inviter = await register();
    const code = await inviteCodeOf(inviter);
    const paid = await register({ inviteCode: code });
    const free = await register({ inviteCode: code });
    const expired = await register({ inviteCode: code });

    const plan = await prisma.plan.findFirstOrThrow({ orderBy: { sort: 'asc' } });
    await prisma.user.update({ where: { id: paid }, data: { planId: plan.id, planExpiresAt: new Date(Date.now() + 30 * 86_400_000) } });
    // 「仅注册」必须显式造：开发机上 TEST_DEFAULT_PLAN_NAME 会给新注册用户开通默认套餐
    // （见 env.ts registrationDefaultPlanName），不清掉这条用例就随机器环境变绿变红。
    await prisma.user.update({ where: { id: free }, data: { planId: null, planExpiresAt: null } });
    // 到期 = 仅注册（口径与 planGate 的 expired 一致，不能算成已开通）
    await prisma.user.update({ where: { id: expired }, data: { planId: plan.id, planExpiresAt: new Date(Date.now() - 86_400_000) } });

    const r = await api<AdminReferralTree>('GET', '/api/admin/referral/tree');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const root = r.body.roots.find((n) => n.userId === inviter);
    assert.ok(root);
    assert.equal(root!.directCount, 3, '节点大小编码 = 直邀人数');
    assert.equal(childOf(root!, paid).status, 'activated');
    assert.equal(childOf(root!, free).status, 'registered');
    assert.equal(childOf(root!, expired).status, 'registered', '套餐到期应回落成「仅注册」');
  });

  test('节点上的手机号是掩码值：树上同时挂着风控红环，不该顺带把完整号码发给每个后台账号', async () => {
    const a = await register();
    const b = await register({ inviteCode: await inviteCodeOf(a) });
    const ub = await prisma.user.findUniqueOrThrow({ where: { id: b }, select: { phone: true } });
    assert.ok(ub.phone, '注册用的是手机号，库里必须有');

    const r = await api<AdminReferralTree>('GET', '/api/admin/referral/tree');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const node = childOf(r.body.roots.find((n) => n.userId === a)!, b);
    assert.notEqual(node.phone, ub.phone, '不得下发完整号码');
    // 掩码规则不在这里重写一遍：本仓只有 services/audit.ts 一处口径，两边必须逐字一致。
    assert.equal(node.phone, maskAuditPhone(ub.phone), '必须是审计同一口径的掩码值');
  });

  test(`边数上限是「多于 ${TREE_ROW_CAP} 才算截断」：刚好 ${TREE_ROW_CAP} 条不许误报成不完整`, async () => {
    // off-by-one 的真实代价：运营看到「这棵树不是全部」就会去缩小一个本来不需要缩小的范围，
    // 并从此不信这块屏。所以边界值必须钉死：== 上限 → 完整；> 上限 → 截断。
    const inviter = await register();
    const tenant = (await prisma.user.findUniqueOrThrow({ where: { id: inviter }, select: { tenantId: true } })).tenantId;
    const edge = (i: number) => ({
      userId: `syn-edge-${i}`, tenantId: tenant, referrerId: inviter, lv1: inviter,
      inviteCode: 'JS2K7P', source: 'poster_qr' as const, boundAt: new Date(Date.now() - i * 1000),
    });
    await prisma.referral.createMany({ data: Array.from({ length: TREE_ROW_CAP }, (_, i) => edge(i)) });

    const exact = await api<AdminReferralTree>('GET', '/api/admin/referral/tree');
    assert.equal(exact.status, 200, JSON.stringify(exact.body));
    assert.equal(exact.body.edgeTotal, TREE_ROW_CAP);
    assert.equal(exact.body.truncated, false, `刚好 ${TREE_ROW_CAP} 条是完整的，不是截断`);
    assert.equal(exact.body.roots[0].children.length, TREE_ROW_CAP, '整棵树都该在响应里');

    // 再加一条 → 这次真的取不完，必须如实说截断了
    await prisma.referral.createMany({ data: [edge(TREE_ROW_CAP)] });
    const over = await api<AdminReferralTree>('GET', '/api/admin/referral/tree');
    assert.equal(over.status, 200, JSON.stringify(over.body));
    assert.equal(over.body.truncated, true, `超过 ${TREE_ROW_CAP} 条必须报截断`);
    assert.equal(over.body.roots[0].children.length, TREE_ROW_CAP, '只渲染取回来的那批，不拼半条边');
  });

  test('tenantId 可筛：另一个租户的邀请边不出现在本租户视图里', async () => {
    const a = await register();
    const b = await register({ inviteCode: await inviteCodeOf(a) });
    const userB = await prisma.user.findUniqueOrThrow({ where: { id: b }, select: { tenantId: true } });

    const all = await api<AdminReferralTree>('GET', '/api/admin/referral/tree');
    assert.equal(all.body.edgeTotal, 1);

    const mine = await api<AdminReferralTree>('GET', `/api/admin/referral/tree?tenantId=${userB.tenantId}`);
    assert.equal(mine.status, 200);
    assert.equal(mine.body.tenantId, userB.tenantId);
    assert.equal(mine.body.edgeTotal, 1, '归因跟着新号走，这条边属于被邀人的租户');

    const other = await prisma.tenant.create({ data: { name: '无邀请数据的租户' } });
    const empty = await api<AdminReferralTree>('GET', `/api/admin/referral/tree?tenantId=${other.id}`);
    assert.equal(empty.status, 200);
    assert.equal(empty.body.edgeTotal, 0);
    assert.deepEqual(empty.body.roots, []);
  });
});

describe('视图③ 风控关联（IP ↔ 新号二部图）', () => {
  const IP_CLUSTER = '203.0.113.7';   // 刷号：一个 IP 上一串新号
  const IP_NORMAL = '203.0.113.200';  // 正常：同 IP 只有一两个

  beforeEach(async () => {
    await cleanBusiness();
    await seedBaseline();
    await prisma.featureFlag.deleteMany({ where: { id: REFERRAL_RISK_FLAG } });
    __clearFeatureCache();
  });

  /** 造 n 个带码进线留痕（每条都对应一个真实用户，二部图右侧要能认人），全部挂在同一个 IP 上。 */
  async function attributions(ip: string, n: number, opts: { code?: string; tenantId?: string } = {}) {
    const tenant = opts.tenantId ?? (await prisma.tenant.create({ data: { name: '风控测试租户' } })).id;
    const users: { id: string; phone: string }[] = [];
    for (let i = 0; i < n; i++) {
      const phone = uniquePhone();
      const u = await prisma.user.create({ data: { tenantId: tenant, phone, name: `新号${i}` } });
      await prisma.referralAttribution.create({
        data: {
          tenantId: tenant, inviteCode: opts.code ?? 'JS2K7P', source: 'poster_qr',
          newUserId: u.id, referrerId: null, outcome: 'bound', clientIp: ip, userAgent: 'test-ua',
        },
      });
      users.push({ id: u.id, phone });
    }
    return { tenantId: tenant, userIds: users.map((u) => u.id), users };
  }

  /**
   * 批量灌留痕（不建 User，只为压规模）：newUserId 没有外键，风控判定只关心「有没有值、去重后几个」。
   * createdAt 显式给，用来复现「旧留痕最老、新号最新」这个真实时间分布——正是旧实现按 createdAt asc
   * 全局 take 之后会把新号整批切掉的形状。
   */
  async function bulkAttributions(tenantId: string, rows: { ip: string; userId: string | null; at: Date }[]) {
    await prisma.referralAttribution.createMany({
      data: rows.map((r) => ({
        tenantId, inviteCode: 'JS2K7P', source: 'poster_qr', newUserId: r.userId,
        referrerId: null, outcome: 'bound' as const, clientIp: r.ip, userAgent: 'test-ua', createdAt: r.at,
      })),
    });
  }

  test('只回超阈值的组；阈值来自运营配置，改阈值就改结果（没有写死）', async () => {
    const cluster = await attributions(IP_CLUSTER, 4);
    await attributions(IP_NORMAL, 2, { tenantId: cluster.tenantId });

    // 默认阈值（代码兜底 5）下：4 个新号还够不上，一个组都不回
    const def = await api<RiskBody>('GET', '/api/admin/referral/risk');
    assert.equal(def.status, 200, JSON.stringify(def.body));
    assert.equal(def.body.threshold, REFERRAL_RISK_DEF);
    assert.equal(def.body.configured, false, '运营还没配 → 必须如实说这是兜底默认值');
    assert.deepEqual(def.body.groups, [], `阈值 ${REFERRAL_RISK_DEF} 时 4 个新号不该入列`);
    assert.equal(def.body.groupTotal, 0, '一组都没超阈值 → 总组数也是 0');
    assert.equal(def.body.scannedIps, 2, '扫过 2 个 IP —— 这与「一条数据都没有」必须分得开');
    assert.equal(def.body.scannedAttributions, 6);

    // 运营把阈值调到 3：聚集组浮出来，正常 IP（2 个）仍不入列
    const patch = await api('PATCH', `/api/admin/flags/${REFERRAL_RISK_FLAG}`, { body: { value: 3 } });
    assert.equal(patch.status, 200, JSON.stringify(patch.body));

    const r = await api<RiskBody>('GET', '/api/admin/referral/risk');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.threshold, 3);
    assert.equal(r.body.configured, true);
    assert.equal(r.body.flagKey, REFERRAL_RISK_FLAG);
    assert.equal(r.body.groups.length, 1, '只该回超阈值的那一组');
    assert.equal(r.body.groupTotal, 1, '没被截断时总组数 = 返回组数');
    const g = r.body.groups[0];
    assert.equal(g.clientIp, IP_CLUSTER);
    assert.equal(g.userCount, 4);
    assert.equal(g.attributionCount, 4);
    assert.equal(g.codeCount, 1, '单码批量进线是最像刷号的形状');
    assert.equal(g.members.length, 4);
    assert.deepEqual([...g.members.map((m) => m.userId)].sort(), [...cluster.userIds].sort());
    assert.equal(r.body.flaggedUsers, 4);
    assert.ok(g.members.every((m) => m.name), '二部图右侧要能认人（名字一次查完）');

    // ── 隐私：能认人 ≠ 下发完整身份 ────────────────────────────────────────
    // 这一行已经把 IP + 用户 id + 归因码摆在一起，再加完整手机号就是把「可直接触达的名单」
    // 发给每一个后台账号；userAgent 前端一处也不展示，属纯粹的指纹扩散。
    const phoneById = new Map(cluster.users.map((u) => [u.id, u.phone]));
    for (const m of g.members) {
      const real = phoneById.get(m.userId);
      assert.ok(real, '测试自身前提：这些新号都是本用例造的');
      assert.notEqual(m.phone, real, '不得下发完整手机号');
      assert.equal(m.phone, maskAuditPhone(real), '必须是 services/audit.ts 同一口径的掩码值');
      assert.ok(!('userAgent' in m), 'userAgent 前端不用，不该出现在响应里');
    }
  });

  test('单个 IP 的重复留痕不得挤掉别的组：5000 条旧留痕之后的新聚集必须照样报出来', async () => {
    // 这是旧实现真正会漏报的形状（明细一条 findMany 全局 take 5000 之后才去重判阈值）：
    // 一个 IP 上先攒够 5000 条重复旧留痕，另一个 IP 上随后来了一批真实新号 → 排序取前 5000 后
    // 第二组整组消失，页面显示「没有聚集」，而 scannedAttributions 里明明包含这些记录。
    const patch = await api('PATCH', `/api/admin/flags/${REFERRAL_RISK_FLAG}`, { body: { value: 3 } });
    assert.equal(patch.status, 200, JSON.stringify(patch.body));
    const tenant = (await prisma.tenant.create({ data: { name: '重复留痕压规模租户' } })).id;
    const IP_HEAVY = '198.51.100.7';
    const IP_QUIET = '198.51.100.9';
    const t0 = Date.now();
    const DUPES = 4995;

    const rows: { ip: string; userId: string | null; at: Date }[] = [];
    // ① 最老：一个人在 IP_HEAVY 上反复点码 4995 次（去重后只算 1 个新号）
    for (let i = 0; i < DUPES; i++) rows.push({ ip: IP_HEAVY, userId: 'syn-heavy-loop', at: new Date(t0 - 20 * 86_400_000 + i) });
    // ② 其次：IP_HEAVY 上 10 个真实的不同新号
    for (let i = 0; i < 10; i++) rows.push({ ip: IP_HEAVY, userId: `syn-heavy-${i}`, at: new Date(t0 - 2 * 86_400_000 + i) });
    // ③ 最新：IP_QUIET 上另外 10 个新号——旧实现里被 take 切光的正是这一批
    for (let i = 0; i < 10; i++) rows.push({ ip: IP_QUIET, userId: `syn-quiet-${i}`, at: new Date(t0 - 3_600_000 + i) });
    await bulkAttributions(tenant, rows);

    const r = await api<RiskBody>('GET', '/api/admin/referral/risk');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.scannedAttributions, DUPES + 20, '分母照实：这些记录都在扫描范围内');
    assert.equal(r.body.scannedIps, 2);
    assert.equal(r.body.groupTotal, 2, '两个 IP 都超阈值 → 总组数 2');
    assert.equal(r.body.groups.length, 2, '第二组不能因为第一组记录多而消失');

    const heavy = r.body.groups.find((g) => g.clientIp === IP_HEAVY);
    const quiet = r.body.groups.find((g) => g.clientIp === IP_QUIET);
    assert.ok(heavy, `${IP_HEAVY} 应报出（11 个去重新号）`);
    assert.ok(quiet, `${IP_QUIET} 应报出 —— 它就是旧实现会整组漏掉的那一组`);
    assert.equal(heavy!.userCount, 11, '4995 条重复留痕去重后只顶 1 个新号，再加 10 个 = 11');
    assert.equal(heavy!.attributionCount, DUPES + 10, '留痕条数照实（含重复的）');
    // 同组内也不许被重复留痕挤掉名字：名单上限是按 IP 分区的，不是全局 take。
    assert.equal(heavy!.members.length, 11, '这一组的名单要完整，11 个人一个不少');
    assert.equal(new Set(heavy!.members.map((m) => m.userId)).size, 11, '名单不许重复计人');
    assert.equal(quiet!.userCount, 10);
    assert.equal(quiet!.attributionCount, 10);
    assert.equal(quiet!.members.length, 10);
    assert.equal(r.body.groups[0].clientIp, IP_HEAVY, '排序按聚集度：11 在 10 前面');
    assert.equal(r.body.flaggedUsers, 21, '被标记的新号 = 两组去重后的总人数');
  });

  test('组数触顶：41 组时如实回总组数，且树的红环只按本次返回的 40 组着色', async () => {
    // 旧实现：flagged 按**全量**超阈值组算、groups 只回前 40 组 → 第 41 组的人在树上被标红，
    // 但运营在风控屏里翻不到对应的 IP（页面还写着「完整名单见下方」）。红环与返回的组必须同一集合。
    const patch = await api('PATCH', `/api/admin/flags/${REFERRAL_RISK_FLAG}`, { body: { value: 2 } });
    assert.equal(patch.status, 200, JSON.stringify(patch.body));

    const inviter = await register();
    const code = await inviteCodeOf(inviter);
    const inGroup = await register({ inviteCode: code });   // 落在会被返回的那组里
    const outGroup = await register({ inviteCode: code });  // 落在被截断掉的第 41 组里
    const tenant = (await prisma.user.findUniqueOrThrow({ where: { id: inGroup }, select: { tenantId: true } })).tenantId;

    // 零填充保证字符串序稳定（排序兜底是 clientIp ASC，`.41` 会排在 `.5` 前面这种坑要避开）。
    const ipOf = (i: number) => `198.51.100.${String(i + 1).padStart(3, '0')}`;
    const rows: { ip: string; userId: string | null; at: Date }[] = [];
    const t0 = Date.now();
    // 前 40 组各 3 个新号；第 41 组（IP 序最大）只有 2 个 → 排序必然落在最后，被截断的就是它
    for (let g = 0; g < 40; g++) for (let i = 0; i < 3; i++) rows.push({ ip: ipOf(g), userId: `syn-${g}-${i}`, at: new Date(t0 - 3_600_000 + g * 10 + i) });
    for (let i = 0; i < 2; i++) rows.push({ ip: ipOf(40), userId: `syn-40-${i}`, at: new Date(t0 - 3_600_000 + 500 + i) });
    await bulkAttributions(tenant, rows);
    // 两个真实新号各挂到「会被返回的第 1 组」和「被截断的第 41 组」上
    await prisma.referralAttribution.updateMany({ where: { newUserId: inGroup }, data: { clientIp: ipOf(0) } });
    await prisma.referralAttribution.updateMany({ where: { newUserId: outGroup }, data: { clientIp: ipOf(40) } });

    const risk = await api<RiskBody>('GET', '/api/admin/referral/risk');
    assert.equal(risk.status, 200, JSON.stringify(risk.body));
    assert.equal(risk.body.groupTotal, 41, '总组数必须如实回，否则截断是静默的');
    assert.equal(risk.body.groups.length, 40, '一页只返回 40 组');
    const returnedIps = new Set(risk.body.groups.map((g) => g.clientIp));
    assert.ok(returnedIps.has(ipOf(0)), '聚集度最高的组必须在返回列表里');
    assert.ok(!returnedIps.has(ipOf(40)), '第 41 组按排序被截断（本用例的前提）');
    assert.equal(risk.body.flaggedUsers, 121, '被标记的新号只数返回的这 40 组（40*3 + 第 1 组多出来的那个真实新号）');

    const tree = await api<AdminReferralTree>('GET', '/api/admin/referral/tree');
    assert.equal(tree.status, 200, JSON.stringify(tree.body));
    const root = tree.body.roots.find((n) => n.userId === inviter);
    assert.ok(root);
    assert.equal(childOf(root!, inGroup).risk, true, '风控屏返回了这个 IP → 树上必须标红');
    assert.equal(
      childOf(root!, outGroup).risk, false,
      '风控屏没返回第 41 组 → 树上就不能标红，否则运营找不到红环对应的 IP',
    );
  });

  test('聚集度按去重新号数算：同一个新号在同 IP 上多次留痕只算一个', async () => {
    const patch = await api('PATCH', `/api/admin/flags/${REFERRAL_RISK_FLAG}`, { body: { value: 3 } });
    assert.equal(patch.status, 200);
    const tenant = await prisma.tenant.create({ data: { name: '重复留痕租户' } });
    const u = await prisma.user.create({ data: { tenantId: tenant.id, phone: uniquePhone(), name: '反复点码的人' } });
    for (let i = 0; i < 5; i++) {
      await prisma.referralAttribution.create({
        data: {
          tenantId: tenant.id, inviteCode: 'JS2K7P', source: 'share_friend', newUserId: u.id,
          outcome: i === 0 ? 'bound' : 'already_bound', clientIp: IP_NORMAL, userAgent: 'test-ua',
        },
      });
    }
    const r = await api<RiskBody>('GET', '/api/admin/referral/risk');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.scannedAttributions, 5, '5 条留痕都在扫描范围内');
    assert.deepEqual(r.body.groups, [], '但只有 1 个去重新号 → 不是聚集，不该报警');
  });

  test('树上的风控标记与二部图同源（同一个 IP 组，两个视图不能各说一套）', async () => {
    const patch = await api('PATCH', `/api/admin/flags/${REFERRAL_RISK_FLAG}`, { body: { value: 2 } });
    assert.equal(patch.status, 200);
    const inviter = await register();
    const code = await inviteCodeOf(inviter);
    const flagged = await register({ inviteCode: code });
    const alsoFlagged = await register({ inviteCode: code });
    // 把这两个新号的归因留痕挪到同一个「可疑」IP 上（测试注入走的是同一张表、同一个字段）
    await prisma.referralAttribution.updateMany({
      where: { newUserId: { in: [flagged, alsoFlagged] } },
      data: { clientIp: IP_CLUSTER },
    });

    const risk = await api<RiskBody>('GET', '/api/admin/referral/risk');
    assert.equal(risk.status, 200, JSON.stringify(risk.body));
    const group = risk.body.groups.find((x) => x.clientIp === IP_CLUSTER);
    assert.ok(group, '二部图应报出这个 IP');

    const tree = await api<AdminReferralTree>('GET', '/api/admin/referral/tree');
    const root = tree.body.roots.find((n) => n.userId === inviter);
    assert.ok(root);
    assert.equal(childOf(root!, flagged).risk, true, '二部图里报了的新号，树上必须也标出来');
    assert.equal(childOf(root!, alsoFlagged).risk, true);
    assert.equal(root!.risk, false, '邀请人自己没有落在聚集组里，不该被标');
  });

  test('树的红环窗口跟着风控页的 days 走：20 天前的聚集在 7 天窗口里不标红、30 天窗口里标红', async () => {
    // 这是 2026-08-18 复审的阻断 2：树曾把窗口写死成 30 天，风控页却可切 7/30/90 天。
    // 于是「20 天前的聚集在 7 天风控页里消失，树上仍标红」——运营点着红环去风控屏找那个 IP
    // 却找不到，两屏各说一套。上一轮把树改成调同一个 riskGroups() 只解决了「哪批组」，
    // 没解决「哪个窗口」；41 组那条用例两个请求都用默认 30 天，正好覆盖不到这个矛盾。
    //
    // 同时钉住另一半口径：**天数只管红环，不管画哪些边**。邀请关系是永久的，树始终是全量，
    // 换窗口时树的形状不许变（否则切到 7 天就把整棵树清空了，那不叫筛选）。
    const patch = await api('PATCH', `/api/admin/flags/${REFERRAL_RISK_FLAG}`, { body: { value: 2 } });
    assert.equal(patch.status, 200, JSON.stringify(patch.body));

    const inviter = await register();
    const invitee = await register({ inviteCode: await inviteCodeOf(inviter) });
    const tenant = (await prisma.user.findUniqueOrThrow({ where: { id: invitee }, select: { tenantId: true } })).tenantId;

    // 把这个新号的归因留痕挪到 20 天前的一个聚集 IP 上，再补一个同 IP 同期的新号凑够阈值 2。
    const at20 = new Date(Date.now() - 20 * 86_400_000);
    await prisma.referralAttribution.updateMany({
      where: { newUserId: invitee }, data: { clientIp: IP_CLUSTER, createdAt: at20 },
    });
    await bulkAttributions(tenant, [{ ip: IP_CLUSTER, userId: 'syn-20d-ago', at: at20 }]);

    const nodeOf = (body: AdminReferralTree) => {
      const root = body.roots.find((n) => n.userId === inviter);
      assert.ok(root, '邀请人应作为根出现（换窗口不影响树的形状）');
      return childOf(root!, invitee);
    };

    // ── 30 天窗口：风控页报出这组 → 树上必须标红 ──
    const risk30 = await api<RiskBody>('GET', '/api/admin/referral/risk?days=30');
    assert.equal(risk30.status, 200, JSON.stringify(risk30.body));
    assert.ok(risk30.body.groups.some((g) => g.clientIp === IP_CLUSTER), '前提：30 天窗口里这组在风控页上');
    const tree30 = await api<AdminReferralTree>('GET', '/api/admin/referral/tree?days=30');
    assert.equal(tree30.status, 200, JSON.stringify(tree30.body));
    assert.equal(tree30.body.riskWindowDays, 30, '树必须如实回它实际用的窗口');
    assert.equal(nodeOf(tree30.body).risk, true, '风控页在这个窗口里报了 → 树上标红');

    // ── 7 天窗口：风控页里这组消失了 → 树上也必须跟着不标红 ──
    const risk7 = await api<RiskBody>('GET', '/api/admin/referral/risk?days=7');
    assert.equal(risk7.status, 200, JSON.stringify(risk7.body));
    assert.ok(!risk7.body.groups.some((g) => g.clientIp === IP_CLUSTER), '前提：20 天前的聚集不在 7 天窗口里');
    const tree7 = await api<AdminReferralTree>('GET', '/api/admin/referral/tree?days=7');
    assert.equal(tree7.status, 200, JSON.stringify(tree7.body));
    assert.equal(tree7.body.riskWindowDays, 7, '窗口跟着请求走，不能回一个写死的 30');
    assert.equal(
      nodeOf(tree7.body).risk, false,
      '风控页在 7 天窗口里没报这组 → 树上就不能标红，否则运营顺着红环找不到 IP',
    );

    // ── 另一半：边不随窗口变（树是全量视图，天数只管红环）──
    assert.equal(tree7.body.edgeTotal, tree30.body.edgeTotal, '换窗口不许让关系边消失');
    assert.equal(tree7.body.inviterTotal, tree30.body.inviterTotal);
    assert.equal(nodeOf(tree7.body).userId, nodeOf(tree30.body).userId, '树的形状与窗口无关');

    // 不传 days 时与 30 天等价（默认值两端同一把 clampDays）
    const treeDefault = await api<AdminReferralTree>('GET', '/api/admin/referral/tree');
    assert.equal(treeDefault.body.riskWindowDays, 30, '默认窗口仍是 30 天（与 /risk 的默认一致）');
    assert.equal(nodeOf(treeDefault.body).risk, true);
  });

  test('公理 5：只预警不阻断 —— 风控端点没有任何写方法', async () => {
    for (const method of ['POST', 'PATCH', 'DELETE'] as const) {
      const r = await api(method, '/api/admin/referral/risk', { body: {} });
      assert.equal(r.status, 404, `${method} /admin/referral/risk 不该存在（实际 ${r.status}）`);
    }
  });
});

describe('视图① 本体 Schema 的真实行数 + 空态与读失败必须分得开', () => {
  beforeEach(async () => { await cleanBusiness(); await seedBaseline(); });

  test('overview 给出三个本体类的真实行数与归因结果分布', async () => {
    const a = await register();
    const b = await register({ inviteCode: await inviteCodeOf(a) });
    // 一条失败留痕：unknown_code 也必须计入分布（失败留痕本身就是这张表存在的理由）。
    // 租户取**被邀人**的：一条归因描述的是「谁进来了」，归属跟着新号走（见 schema 注释）。
    const tb = await prisma.user.findUniqueOrThrow({ where: { id: b }, select: { tenantId: true } });
    await prisma.referralAttribution.create({
      data: { tenantId: tb.tenantId, inviteCode: 'JS9999', source: 'poster_qr', outcome: 'unknown_code', clientIp: '203.0.113.9' },
    });

    const r = await api<AdminReferralOverview>('GET', '/api/admin/referral/overview');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.edgesTotal, 1);
    assert.equal(r.body.edgesInWindow, 1);
    assert.equal(r.body.attributionsInWindow, 2, 'bound + unknown_code');
    assert.ok(r.body.codedUsers >= 1, '至少 A 已惰性生成邀请码');
    const outcomes = new Map(r.body.byOutcome.map((x) => [x.key, x.count]));
    assert.equal(outcomes.get('bound'), 1);
    assert.equal(outcomes.get('unknown_code'), 1);
    assert.deepEqual(r.body.bySource, [{ key: 'share_friend', count: 1 }]);
    assert.deepEqual(r.body.tenants, [{ tenantId: tb.tenantId, name: '', edges: 1 }], '租户筛选项只列真有邀请边的租户');
  });

  test('空作用域 = 200 + 显式零计数（不是错误，也不是沉默）', async () => {
    const overview = await api<AdminReferralOverview>('GET', '/api/admin/referral/overview');
    assert.equal(overview.status, 200);
    assert.equal(overview.body.edgesTotal, 0);
    assert.deepEqual(overview.body.byOutcome, []);
    assert.deepEqual(overview.body.tenants, []);

    const tree = await api<AdminReferralTree>('GET', '/api/admin/referral/tree');
    assert.equal(tree.status, 200);
    assert.equal(tree.body.inviterTotal, 0);
    assert.deepEqual(tree.body.roots, []);

    const risk = await api<RiskBody>('GET', '/api/admin/referral/risk');
    assert.equal(risk.status, 200);
    assert.equal(risk.body.scannedIps, 0, '「扫了 0 个 IP」与「扫了 200 个但没聚集」是两回事');
    assert.deepEqual(risk.body.groups, []);
    assert.equal(risk.body.groupTotal, 0);

    const tenants = await api<AdminReferralTenantOption[]>('GET', '/api/admin/referral/tenants');
    assert.equal(tenants.status, 200);
    assert.deepEqual(tenants.body, [], '空作用域下也是 200 + 空数组，前端据此说「确实没有租户」');
  });

  test('租户筛选项是独立端点：与 overview 里的那份同源，前端可独立三态重试', async () => {
    const a = await register();
    const b = await register({ inviteCode: await inviteCodeOf(a) });
    const tb = await prisma.user.findUniqueOrThrow({ where: { id: b }, select: { tenantId: true } });

    const tenants = await api<AdminReferralTenantOption[]>('GET', '/api/admin/referral/tenants');
    assert.equal(tenants.status, 200, JSON.stringify(tenants.body));
    assert.deepEqual(tenants.body, [{ tenantId: tb.tenantId, name: '', edges: 1 }]);

    // 与 overview 的 tenants 必须逐字相同：同一个函数算出来的，不能有第二份口径。
    const ov = await api<AdminReferralOverview>('GET', '/api/admin/referral/overview?days=7');
    assert.deepEqual(tenants.body, ov.body.tenants, '筛选项换端点取，内容不许漂移');
  });

  test('查询失败回 5xx，绝不伪装成空数据', async () => {
    // 这条用例守的是「路由里没有兜底 catch」。把聚合查询打断，端点必须把故障抛出去，
    // 而不是回一个漂亮的空结果——运营后台在出事时说谎，比没有这块屏更糟。
    // 打断的是 $queryRaw：聚集判定（COUNT(DISTINCT) + HAVING）现在下推到 SQL 里做，
    // 这是风控端点唯一的取数通道。
    const client = prisma as unknown as { $queryRaw: unknown };
    const original = client.$queryRaw;
    client.$queryRaw = async () => { throw new Error('模拟数据库抖动'); };
    try {
      const r = await api('GET', '/api/admin/referral/risk');
      assert.ok(r.status >= 500, `查询失败必须回 5xx，实际 ${r.status} ${JSON.stringify(r.body)}`);
      assert.notDeepEqual(r.body?.groups, [], '不得把失败渲染成「没有聚集」');
    } finally {
      client.$queryRaw = original;
    }
    // 复原后照常可用（证明上面改的是同一个 client 实例，这条用例真的生效过）
    const ok = await api<RiskBody>('GET', '/api/admin/referral/risk');
    assert.equal(ok.status, 200);
  });
});
