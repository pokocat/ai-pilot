// 运营后台「邀请增长」三视图的只读聚合（P3）。
//
// 这些断言守的是四件事：
//   ① 树按**物化路径**正确分层（L1→L2→L3 由 bindOnRegister 真实写出来的 lv1/lv2/lv3 决定，
//      不是测试自己捏的 lv 值），且 directCount 在树末端也不谎报成 0；
//   ② 风控只回**超阈值**的组，阈值来自运营配置（`PATCH /admin/flags/referral-risk`），
//      改配置就改判定 —— 证明它没写死在代码里；
//   ③ 未授权访问一律拒绝（三个端点都在 requireAdmin 后面）；
//   ④ **读数为空 ≠ 读失败**：空作用域回 200 + 显式的零计数（还告诉你扫了多少 IP），
//      查询真的挂了回 5xx，绝不伪装成「你还没有邀请数据」。
//
// 另外钉一条公理 5：风控只预警不阻断 —— 这组端点里不存在任何处置/封禁写操作。
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.ts';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, uniquePhone } from './helpers.ts';
import { REFERRAL_RISK_FLAG, REFERRAL_RISK_DEF } from '../src/routes/adminReferral.ts';
import { __clearFeatureCache } from '../src/services/featureFlag.ts';
import type {
  AdminReferralOverview, AdminReferralRisk, AdminReferralTree, AdminReferralTreeNode,
} from '../../shared/contracts';

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

describe('鉴权：三个端点都在 requireAdmin 之后', () => {
  for (const path of ['/api/admin/referral/overview', '/api/admin/referral/tree', '/api/admin/referral/risk']) {
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

  /** 造 n 个带码进线留痕，全部挂在同一个 IP 上。 */
  async function attributions(ip: string, n: number, opts: { code?: string; tenantId?: string } = {}) {
    const tenant = opts.tenantId ?? (await prisma.tenant.create({ data: { name: '风控测试租户' } })).id;
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const u = await prisma.user.create({ data: { tenantId: tenant, phone: uniquePhone(), name: `新号${i}` } });
      await prisma.referralAttribution.create({
        data: {
          tenantId: tenant, inviteCode: opts.code ?? 'JS2K7P', source: 'poster_qr',
          newUserId: u.id, referrerId: null, outcome: 'bound', clientIp: ip, userAgent: 'test-ua',
        },
      });
      ids.push(u.id);
    }
    return { tenantId: tenant, userIds: ids };
  }

  test('只回超阈值的组；阈值来自运营配置，改阈值就改结果（没有写死）', async () => {
    const cluster = await attributions(IP_CLUSTER, 4);
    await attributions(IP_NORMAL, 2, { tenantId: cluster.tenantId });

    // 默认阈值（代码兜底 5）下：4 个新号还够不上，一个组都不回
    const def = await api<AdminReferralRisk>('GET', '/api/admin/referral/risk');
    assert.equal(def.status, 200, JSON.stringify(def.body));
    assert.equal(def.body.threshold, REFERRAL_RISK_DEF);
    assert.equal(def.body.configured, false, '运营还没配 → 必须如实说这是兜底默认值');
    assert.deepEqual(def.body.groups, [], `阈值 ${REFERRAL_RISK_DEF} 时 4 个新号不该入列`);
    assert.equal(def.body.scannedIps, 2, '扫过 2 个 IP —— 这与「一条数据都没有」必须分得开');
    assert.equal(def.body.scannedAttributions, 6);

    // 运营把阈值调到 3：聚集组浮出来，正常 IP（2 个）仍不入列
    const patch = await api('PATCH', `/api/admin/flags/${REFERRAL_RISK_FLAG}`, { body: { value: 3 } });
    assert.equal(patch.status, 200, JSON.stringify(patch.body));

    const r = await api<AdminReferralRisk>('GET', '/api/admin/referral/risk');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.threshold, 3);
    assert.equal(r.body.configured, true);
    assert.equal(r.body.flagKey, REFERRAL_RISK_FLAG);
    assert.equal(r.body.groups.length, 1, '只该回超阈值的那一组');
    const g = r.body.groups[0];
    assert.equal(g.clientIp, IP_CLUSTER);
    assert.equal(g.userCount, 4);
    assert.equal(g.attributionCount, 4);
    assert.equal(g.codeCount, 1, '单码批量进线是最像刷号的形状');
    assert.equal(g.members.length, 4);
    assert.deepEqual([...g.members.map((m) => m.userId)].sort(), [...cluster.userIds].sort());
    assert.equal(r.body.flaggedUsers, 4);
    assert.ok(g.members.every((m) => m.name && m.phone), '二部图右侧要能认人（名字/手机号一次查完）');
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
    const r = await api<AdminReferralRisk>('GET', '/api/admin/referral/risk');
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

    const risk = await api<AdminReferralRisk>('GET', '/api/admin/referral/risk');
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

    const risk = await api<AdminReferralRisk>('GET', '/api/admin/referral/risk');
    assert.equal(risk.status, 200);
    assert.equal(risk.body.scannedIps, 0, '「扫了 0 个 IP」与「扫了 200 个但没聚集」是两回事');
    assert.deepEqual(risk.body.groups, []);
  });

  test('查询失败回 5xx，绝不伪装成空数据', async () => {
    // 这条用例守的是「路由里没有兜底 catch」。把聚合查询打断，端点必须把故障抛出去，
    // 而不是回一个漂亮的空结果——运营后台在出事时说谎，比没有这块屏更糟。
    const delegate = prisma.referralAttribution as unknown as { groupBy: unknown };
    const original = delegate.groupBy;
    delegate.groupBy = async () => { throw new Error('模拟数据库抖动'); };
    try {
      const r = await api('GET', '/api/admin/referral/risk');
      assert.ok(r.status >= 500, `查询失败必须回 5xx，实际 ${r.status} ${JSON.stringify(r.body)}`);
      assert.notDeepEqual(r.body?.groups, [], '不得把失败渲染成「没有聚集」');
    } finally {
      delegate.groupBy = original;
    }
    // 复原后照常可用（证明上面改的是同一个 client 实例，这条用例真的生效过）
    const ok = await api<AdminReferralRisk>('GET', '/api/admin/referral/risk');
    assert.equal(ok.status, 200);
  });
});
