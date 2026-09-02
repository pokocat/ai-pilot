// 运营后台「增长」组：邀请关系账本 / 归因日志 / CSV / 运营补绑 / 邀请链（2026-09-02）。
//
// 这些断言守的是六件事：
//   ① **筛选与分页说的是实话**：`total` 是筛选后的真总数（不是「取回来几行」），`days` 缺省全量
//      （关系永久，默认套窗口会让运营以为关系丢了），`inviteeStatus` 走 planGate 口径；
//   ② **隐私不扩散**：任何响应里没有完整手机号（掩码走审计同一把 `maskAuditPhone`）、
//      **没有 userAgent**；归因日志**下发 clientIp**（那是风控原料，不是设备指纹）；
//   ③ **写操作只给超管**：导出与补绑 operator 一律 403，且 403 时库里一行不动；
//   ④ **关系不可变更公理不破**：补绑只给尚无推荐人的用户建边，`already_bound` / `self` /
//      `cycle` / `unknown_code` 原样回 outcome 并**各留一行归因**，审计必有一行；
//   ⑤ **并发互邀只允许一条成功**（原 AGENTS.md §13 的 TOCTOU）：两个未绑用户同时互相补绑，
//      恰好一条 bound、另一条 cycle/already_bound，且库里**没有环**。这条是本包的核心；
//   ⑥ **邀请链与关系树同源**：`downline` 与 `/admin/referral/tree` 的节点逐字段相等
//      （同一个子树构建函数），`upline` 超过三级仍能一路回到根（物化只存三级，上溯不受此限）。
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.ts';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, login, uniquePhone } from './helpers.ts';
import { createOperator, createSession } from '../src/services/adminAccount.ts';
import { maskAuditPhone } from '../src/services/audit.ts';
import type {
  AdminInviteList, AdminInviteAttributionList, AdminManualBindResult,
  AdminChainView, AdminReferralTree,
} from '../../shared/contracts';

process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'test-admin-token';

before(async () => { await getApp(); });
after(async () => { await closeApp(); });

/** operator（非 owner/master）会话 token —— 用来验证 requireSuper 把写操作挡在门外。 */
async function operatorToken(): Promise<string> {
  const acc = await createOperator(`op_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, 'pw-123456', 'operator');
  return createSession(acc.id);
}

/** 走真实注册链路建号（可带邀请码）——物化路径由 services/referral.ts 写，不由本测试捏造。 */
async function register(opts: { inviteCode?: string; name?: string } = {}): Promise<string> {
  const body: Record<string, unknown> = { phone: uniquePhone(), name: opts.name ?? '邀请账本用户' };
  if (opts.inviteCode) {
    const captured = await api<{ token: string }>('POST', '/api/auth/referral-capture', {
      body: { inviteCode: opts.inviteCode, source: 'share_friend' },
    });
    assert.equal(captured.status, 200);
    body.inviteCode = opts.inviteCode;
    body.referralToken = captured.body.token;
  }
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

async function phoneOf(userId: string): Promise<string> {
  return (await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { phone: true } })).phone;
}

/** 直接落一笔已支付订单：本组用例验的是**读投影**，不需要重跑支付状态机。 */
async function seedPaidOrder(userId: string, amount: number, opts: { refunded?: boolean } = {}): Promise<string> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { tenantId: true } });
  const plan = await prisma.plan.findFirstOrThrow({ orderBy: { sort: 'asc' } });
  const outTradeNo = `T${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
  await prisma.paymentOrder.create({
    data: {
      outTradeNo, tenantId: u.tenantId, userId, planId: plan.id, amount,
      status: opts.refunded ? 'refunded' : 'paid',
      paidAt: new Date(),
      refundedAt: opts.refunded ? new Date() : null,
    },
  });
  return outTradeNo;
}

describe('鉴权：五个端点都在 requireAdmin 之后', () => {
  for (const [method, path] of [
    ['GET', '/api/admin/invites'],
    ['GET', '/api/admin/invites/attributions'],
    ['GET', '/api/admin/invites/export'],
    ['POST', '/api/admin/invites/manual-bind'],
    ['GET', '/api/admin/invites/chain/whatever'],
  ] as const) {
    test(`无凭证访问 ${method} ${path} → 401`, async () => {
      const r = await api(method, path, { adminToken: false, ...(method === 'POST' ? { body: {} } : {}) });
      assert.equal(r.status, 401, `应 401，实际 ${r.status} ${JSON.stringify(r.body)}`);
      assert.equal(r.body.code, 'ADMIN_UNAUTHORIZED');
    });
  }

  test('已登录的普通小程序用户（非管理员）→ 403，不是 401', async () => {
    await cleanBusiness();
    await seedBaseline();
    const uid = await register();
    const r = await api('GET', '/api/admin/invites', { token: uid, adminToken: false });
    assert.equal(r.status, 403, `应 403，实际 ${r.status} ${JSON.stringify(r.body)}`);
  });
});

describe('① 关系账本 GET /admin/invites', () => {
  beforeEach(async () => { await cleanBusiness(); await seedBaseline(); });

  test('两侧姓名与掩码手机、码、来源、绑定时间、开通状态、首笔付费一次给全', async () => {
    const inviter = await register({ name: '带人的军师' });
    const code = await inviteCodeOf(inviter);
    const invitee = await register({ inviteCode: code, name: '被带来的' });
    const outTradeNo = await seedPaidOrder(invitee, 6800);

    const r = await api<AdminInviteList>('GET', '/api/admin/invites');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.total, 1);
    assert.equal(r.body.page, 1);
    const edge = r.body.items[0];
    assert.equal(edge.invitee.userId, invitee);
    assert.equal(edge.invitee.name, '被带来的');
    assert.equal(edge.inviter.userId, inviter);
    assert.equal(edge.inviter.name, '带人的军师');
    assert.equal(edge.inviteCode, code);
    assert.equal(edge.source, 'share_friend');
    assert.ok(edge.boundAt, '必须带建边时刻');
    // 测试期 login() 默认开入门版（helpers 的 TEST_DEFAULT_PLAN_NAME），所以是 activated。
    assert.equal(edge.inviteeStatus, 'activated');
    assert.deepEqual(
      { no: edge.firstPaid?.outTradeNo, amount: edge.firstPaid?.amount, refunded: edge.firstPaid?.refunded },
      { no: outTradeNo, amount: 6800, refunded: false },
      '首笔付费必须批量查出来（金额单位=分）',
    );
    assert.equal(edge.inviterIsDistributor, false, '邀请人还不是代理');
  });

  test('inviterIsDistributor：只有 status=active 的代理才打徽标（suspended 不算）', async () => {
    const inviter = await register();
    const code = await inviteCodeOf(inviter);
    const invitee = await register({ inviteCode: code });
    const tenantId = (await prisma.user.findUniqueOrThrow({ where: { id: inviter } })).tenantId;

    await prisma.distributor.create({ data: { userId: inviter, tenantId, status: 'active' } });
    const on = await api<AdminInviteList>('GET', '/api/admin/invites');
    assert.equal(on.body.items[0].inviterIsDistributor, true);
    assert.equal(on.body.items[0].invitee.userId, invitee);

    // 暂停计提的代理不该继续打徽标——否则运营会以为这条边还在产生佣金。
    await prisma.distributor.update({ where: { userId: inviter }, data: { status: 'suspended' } });
    const off = await api<AdminInviteList>('GET', '/api/admin/invites');
    assert.equal(off.body.items[0].inviterIsDistributor, false);
  });

  test('手机号一律掩码，且响应里绝无完整号码与 userAgent', async () => {
    const inviter = await register();
    const invitee = await register({ inviteCode: await inviteCodeOf(inviter) });
    const [pInviter, pInvitee] = [await phoneOf(inviter), await phoneOf(invitee)];

    const r = await api<AdminInviteList>('GET', '/api/admin/invites');
    const raw = JSON.stringify(r.body);
    assert.equal(r.body.items[0].invitee.phone, maskAuditPhone(pInvitee));
    assert.equal(r.body.items[0].inviter.phone, maskAuditPhone(pInviter));
    assert.ok(!raw.includes(pInvitee), '完整手机号绝不下发');
    assert.ok(!raw.includes(pInviter), '完整手机号绝不下发');
    assert.ok(!/userAgent/i.test(raw), '关系账本不下发 userAgent');
  });

  test('首笔付费按 paidAt 最早取（不是下单顺序），已退款仍算「曾付费」但标 refunded', async () => {
    const inviter = await register();
    const invitee = await register({ inviteCode: await inviteCodeOf(inviter) });
    const u = await prisma.user.findUniqueOrThrow({ where: { id: invitee }, select: { tenantId: true } });
    const plan = await prisma.plan.findFirstOrThrow({ orderBy: { sort: 'asc' } });
    // 先落一笔「后下单但更早付款」的退款单，再落一笔更晚付款的正常单。
    await prisma.paymentOrder.create({
      data: {
        outTradeNo: 'EARLY-REFUNDED', tenantId: u.tenantId, userId: invitee, planId: plan.id, amount: 100,
        status: 'refunded', paidAt: new Date(Date.now() - 86_400_000), refundedAt: new Date(),
      },
    });
    await seedPaidOrder(invitee, 6800);

    const r = await api<AdminInviteList>('GET', '/api/admin/invites');
    assert.equal(r.body.items[0].firstPaid?.outTradeNo, 'EARLY-REFUNDED');
    assert.equal(r.body.items[0].firstPaid?.refunded, true, '退款是后来发生的事，不能让「曾付费」凭空消失');
  });

  test('q 同时匹配两侧：邀请人姓名 / 被邀人手机前缀 / 邀请码 / userId 都能命中同一条边', async () => {
    const inviter = await register({ name: '独一无二的邀请人' });
    const code = await inviteCodeOf(inviter);
    const invitee = await register({ inviteCode: code, name: '路人甲' });
    // uniquePhone() 是连号的（13800000000、13800000001…），前缀匹配会一次命中好几个人
    // ——那验不出「前缀真的在筛」。给这一位换一个不同号段的号，前缀才有区分度。
    const phone = '13977778888';
    await prisma.user.update({ where: { id: invitee }, data: { phone } });
    // 另一条无关的边，确保 q 真的在筛而不是恰好只有一条
    const other = await register({ name: '毫不相干' });
    await register({ inviteCode: await inviteCodeOf(other) });

    for (const q of ['独一无二的邀请人', phone, phone.slice(0, 7), code, invitee, inviter]) {
      const r = await api<AdminInviteList>('GET', `/api/admin/invites?q=${encodeURIComponent(q)}`);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.total, 1, `q=${q} 应只命中一条，实际 ${r.body.total}`);
      assert.equal(r.body.items[0].invitee.userId, invitee, `q=${q} 命中错了行`);
    }
    // 通配符不许穿透：一个裸 % 不该把整张表当成搜索结果
    const wild = await api<AdminInviteList>('GET', '/api/admin/invites?q=%25');
    assert.equal(wild.body.total, 0, "LIKE 通配符必须被转义（剥掉会拼出 %% 匹配所有人）");
  });

  test('分页：total 是筛选后的真总数，不是本页行数', async () => {
    const inviter = await register();
    const code = await inviteCodeOf(inviter);
    for (let i = 0; i < 3; i++) await register({ inviteCode: code });

    const p1 = await api<AdminInviteList>('GET', '/api/admin/invites?page=1&pageSize=2');
    assert.equal(p1.body.total, 3);
    assert.equal(p1.body.items.length, 2);
    assert.equal(p1.body.pageSize, 2);
    const p2 = await api<AdminInviteList>('GET', '/api/admin/invites?page=2&pageSize=2');
    assert.equal(p2.body.total, 3);
    assert.equal(p2.body.items.length, 1);
    const ids = new Set([...p1.body.items, ...p2.body.items].map((e) => e.invitee.userId));
    assert.equal(ids.size, 3, '两页不许重叠或漏人');
  });

  test('source 筛选 + days 缺省全量（关系永久，不该被默认窗口吃掉）', async () => {
    const inviter = await register();
    const code = await inviteCodeOf(inviter);
    const invitee = await register({ inviteCode: code });
    // 把这条边挪到 100 天前：days 缺省时必须还在，days=7 时必须被筛掉。
    await prisma.referral.update({
      where: { userId: invitee },
      data: { boundAt: new Date(Date.now() - 100 * 86_400_000) },
    });

    assert.equal((await api<AdminInviteList>('GET', '/api/admin/invites')).body.total, 1, 'days 缺省=全量');
    assert.equal((await api<AdminInviteList>('GET', '/api/admin/invites?days=7')).body.total, 0);
    assert.equal((await api<AdminInviteList>('GET', '/api/admin/invites?days=365')).body.total, 1);
    assert.equal((await api<AdminInviteList>('GET', '/api/admin/invites?source=share_friend')).body.total, 1);
    assert.equal((await api<AdminInviteList>('GET', '/api/admin/invites?source=poster_qr')).body.total, 0);
  });

  test('status 走 planGate 口径：套餐到期的被邀人回落 registered', async () => {
    const inviter = await register();
    const code = await inviteCodeOf(inviter);
    const fresh = await register({ inviteCode: code });
    const expired = await register({ inviteCode: code });
    await prisma.user.update({ where: { id: expired }, data: { planExpiresAt: new Date(Date.now() - 1000) } });

    const act = await api<AdminInviteList>('GET', '/api/admin/invites?status=activated');
    assert.deepEqual(act.body.items.map((e) => e.invitee.userId), [fresh]);
    assert.equal(act.body.total, 1);
    const reg = await api<AdminInviteList>('GET', '/api/admin/invites?status=registered');
    assert.deepEqual(reg.body.items.map((e) => e.invitee.userId), [expired]);
    assert.equal(reg.body.total, 1);
  });

  test('空作用域回 200 + 显式 0，不是读失败', async () => {
    const r = await api<AdminInviteList>('GET', '/api/admin/invites');
    assert.equal(r.status, 200);
    assert.deepEqual({ items: r.body.items, total: r.body.total }, { items: [], total: 0 });
  });
});

describe('② 归因日志 GET /admin/invites/attributions', () => {
  beforeEach(async () => { await cleanBusiness(); await seedBaseline(); });

  test('下发 clientIp、不下发 userAgent；手机号掩码；outcome 可筛', async () => {
    const inviter = await register();
    const code = await inviteCodeOf(inviter);
    const invitee = await register({ inviteCode: code });
    // 注册链路把 UA 存进了库（风控原料），但响应必须不带它 —— 先确认库里真有，否则这条断言是空的
    const stored = await prisma.referralAttribution.findFirstOrThrow({ where: { newUserId: invitee } });
    assert.ok(stored.userAgent, '注册侧应采到 userAgent（否则下面的「不下发」断言没有意义）');

    const r = await api<AdminInviteAttributionList>('GET', '/api/admin/invites/attributions');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const raw = JSON.stringify(r.body);
    assert.ok(!/userAgent/i.test(raw), '归因日志绝不下发 userAgent');
    assert.ok(!raw.includes(stored.userAgent!), 'UA 内容也不许以别的字段名漏出去');
    const row = r.body.items.find((a) => a.newUser?.userId === invitee);
    assert.ok(row, '应能查到这条 bound 留痕');
    assert.equal(row!.outcome, 'bound');
    assert.equal(row!.inviteCode, code);
    assert.equal(row!.referrer?.userId, inviter);
    assert.ok('clientIp' in row!, 'clientIp 必须下发（风控原料）');
    assert.equal(row!.newUser!.phone, maskAuditPhone(await phoneOf(invitee)));

    assert.equal((await api<AdminInviteAttributionList>('GET', '/api/admin/invites/attributions?outcome=bound')).body.total, 1);
    assert.equal((await api<AdminInviteAttributionList>('GET', '/api/admin/invites/attributions?outcome=cycle')).body.total, 0);
  });

  test('q 命中邀请码与两侧 userId', async () => {
    const inviter = await register();
    const code = await inviteCodeOf(inviter);
    const invitee = await register({ inviteCode: code });
    for (const q of [code, invitee, inviter]) {
      const r = await api<AdminInviteAttributionList>('GET', `/api/admin/invites/attributions?q=${encodeURIComponent(q)}`);
      assert.equal(r.body.total, 1, `q=${q} 应命中一条`);
    }
  });
});

describe('③ CSV 导出 GET /admin/invites/export', () => {
  beforeEach(async () => { await cleanBusiness(); await seedBaseline(); });

  test('operator 403（且不落导出审计）；super 200 且是 CSV、手机掩码、文件名带 days|all', async () => {
    const inviter = await register({ name: '导出邀请人' });
    const invitee = await register({ inviteCode: await inviteCodeOf(inviter), name: '导出被邀人' });
    const phone = await phoneOf(invitee);

    const denied = await api('GET', '/api/admin/invites/export', { adminToken: await operatorToken() });
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal(denied.body.code, 'OWNER_ONLY');
    assert.equal(await prisma.auditLog.count({ where: { action: 'admin.invite.export' } }), 0, '403 不该留下导出审计');

    const app = await getApp();
    const ok = await app.inject({
      method: 'GET', url: '/api/admin/invites/export',
      headers: { 'x-admin-token': process.env.ADMIN_TOKEN! },
    });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.match(ok.headers['content-type'] as string, /text\/csv/);
    assert.equal(ok.headers['content-disposition'], 'attachment; filename="invites-all.csv"');
    assert.ok(ok.body.includes('导出邀请人') && ok.body.includes('导出被邀人'), 'CSV 要有两侧姓名');
    assert.ok(ok.body.includes(maskAuditPhone(phone)!), 'CSV 里的手机号必须是掩码');
    assert.ok(!ok.body.includes(phone), 'CSV 绝不能带完整手机号');
    assert.equal(await prisma.auditLog.count({ where: { action: 'admin.invite.export' } }), 1);

    const windowed = await app.inject({
      method: 'GET', url: '/api/admin/invites/export?days=30',
      headers: { 'x-admin-token': process.env.ADMIN_TOKEN! },
    });
    assert.equal(windowed.headers['content-disposition'], 'attachment; filename="invites-30.csv"');
  });

  test('CSV 公式注入防护：以 = 开头的昵称被前导单引号中和', async () => {
    const inviter = await register({ name: '=SUM(1,2)' });
    await register({ inviteCode: await inviteCodeOf(inviter) });
    const app = await getApp();
    const ok = await app.inject({
      method: 'GET', url: '/api/admin/invites/export',
      headers: { 'x-admin-token': process.env.ADMIN_TOKEN! },
    });
    assert.ok(ok.body.includes('"\'=SUM(1,2)"'), `应被中和，实际 ${ok.body}`);
  });
});

describe('④ 运营补绑 POST /admin/invites/manual-bind', () => {
  beforeEach(async () => { await cleanBusiness(); await seedBaseline(); });

  const bind = (body: Record<string, unknown>, adminToken?: string) =>
    api<AdminManualBindResult>('POST', '/api/admin/invites/manual-bind', { body, ...(adminToken ? { adminToken } : {}) });

  test('operator 403，且库里一行不动', async () => {
    const inviter = await register();
    const target = await register();
    const r = await bind({ userId: target, inviteCode: await inviteCodeOf(inviter), reason: '越权尝试' }, await operatorToken());
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'OWNER_ONLY');
    assert.equal(await prisma.referral.count({ where: { userId: target } }), 0);
    assert.equal(await prisma.auditLog.count({ where: { action: 'admin.invite.manual_bind' } }), 0);
  });

  test('成功：source=manual、不受归因窗口限制、回新建的边、审计有行、归因有行', async () => {
    const inviter = await register({ name: '补绑邀请人' });
    const code = await inviteCodeOf(inviter);
    const target = await register({ name: '补绑对象' });

    const r = await bind({ userId: target, inviteCode: code, reason: '客户投诉：分享卡未带上码' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.outcome, 'bound');
    assert.equal(r.body.edge?.invitee.userId, target);
    assert.equal(r.body.edge?.inviter.userId, inviter);
    assert.equal(r.body.edge?.source, 'manual');

    const row = await prisma.referral.findUniqueOrThrow({ where: { userId: target } });
    assert.equal(row.referrerId, inviter);
    assert.equal(row.lv1, inviter);
    assert.equal(row.source, 'manual', '补绑必须能与分享通道区分开');

    const attrs = await prisma.referralAttribution.findMany({ where: { newUserId: target, source: 'manual' } });
    assert.deepEqual(attrs.map((a) => a.outcome), ['bound'], '补绑同样要落一行归因');

    const audit = await prisma.auditLog.findFirst({ where: { action: 'admin.invite.manual_bind' } });
    assert.ok(audit, '补绑必须留审计');
    const payload = audit!.payloadJson as Record<string, unknown>;
    assert.equal(payload.userId, target);
    assert.equal(payload.inviteCode, code);
    assert.equal(payload.referrerId, inviter);
    assert.equal(payload.outcome, 'bound');
    assert.equal(payload.reason, '客户投诉：分享卡未带上码');
    assert.ok(payload.by, '审计必须记得是谁做的');
  });

  test('已绑的不改绑（already_bound），原关系一字不动', async () => {
    const first = await register();
    const target = await register({ inviteCode: await inviteCodeOf(first) });
    const second = await register();

    const r = await bind({ userId: target, inviteCode: await inviteCodeOf(second), reason: '试图改绑' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.outcome, 'already_bound');
    assert.equal(r.body.edge, null, '没建边就不回边');
    const row = await prisma.referral.findUniqueOrThrow({ where: { userId: target } });
    assert.equal(row.referrerId, first, '关系不可变更公理：补绑不提供改绑');
  });

  test('自邀 self、码不存在 unknown_code、成环 cycle —— 各回 outcome 且各留一行归因', async () => {
    const a = await register();
    const b = await register({ inviteCode: await inviteCodeOf(a) });
    const c = await register({ inviteCode: await inviteCodeOf(b) });
    const d = await register({ inviteCode: await inviteCodeOf(c) });
    const loner = await register();

    const self = await bind({ userId: loner, inviteCode: await inviteCodeOf(loner), reason: '自邀' });
    assert.equal(self.body.outcome, 'self');

    const unknown = await bind({ userId: loner, inviteCode: 'JSZZZZ', reason: '瞎敲的码' });
    assert.equal(unknown.body.outcome, 'unknown_code');

    // A 用 D 的码 → D 的祖先链是 C→B→A，撞回 A 本人 = 成环。
    // 物化路径只存三级（D 的 lv3 = A），这里恰好在三级内；递归查环覆盖更深的链见 referral.test.ts。
    const cycle = await bind({ userId: a, inviteCode: await inviteCodeOf(d), reason: '会成环' });
    assert.equal(cycle.body.outcome, 'cycle');
    assert.equal(await prisma.referral.count({ where: { userId: a } }), 0, '成环绝不建边');

    const outcomes = (await prisma.referralAttribution.findMany({
      where: { source: 'manual' }, select: { outcome: true },
    })).map((x) => x.outcome).sort();
    assert.deepEqual(outcomes, ['cycle', 'self', 'unknown_code'], '失败的补绑尝试同样必须留痕');
    assert.equal(await prisma.auditLog.count({ where: { action: 'admin.invite.manual_bind' } }), 3, '失败的尝试也要有操作痕迹');
  });

  test('缺 userId / 缺原因 / 缺码 → 400（补绑没有「为什么」事后无法判断是修复还是误操作）', async () => {
    const inviter = await register();
    const code = await inviteCodeOf(inviter);
    const target = await register();
    assert.equal((await bind({ inviteCode: code, reason: 'x' })).body.code, 'USER_ID_REQUIRED');
    assert.equal((await bind({ userId: target, inviteCode: code })).body.code, 'REASON_REQUIRED');
    assert.equal((await bind({ userId: target, reason: 'x' })).body.code, 'INVITE_CODE_REQUIRED');
    assert.equal(await prisma.referral.count({ where: { userId: target } }), 0);
  });

  test('用户不存在 → 404（不是 400，也不是静默 bound）', async () => {
    const inviter = await register();
    const r = await bind({ userId: 'no-such-user', inviteCode: await inviteCodeOf(inviter), reason: '敲错了 id' });
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.equal(r.body.code, 'USER_NOT_FOUND');
  });

  /**
   * 原 AGENTS.md §13「两个未绑定用户并发互邀的 TOCTOU 未加锁」的验收用例。
   *
   * 没有那把有序 advisory lock 时：两个事务的 `wouldFormCycle` 都读不到对方尚未提交的边，
   * 于是**两条边都建成** → A→B 且 B→A 的二元环。环一旦落库，`Referral` 是不可变更账本，
   * 上溯递归只能 fail-closed，双方从此谁也绑不上，也修不回来。
   */
  test('并发互邀：恰好一条成功，另一条是 cycle 或 already_bound，且库里没有环', async () => {
    const a = await register({ name: '互邀甲' });
    const b = await register({ name: '互邀乙' });
    const [codeA, codeB] = [await inviteCodeOf(a), await inviteCodeOf(b)];

    const [ra, rb] = await Promise.all([
      bind({ userId: a, inviteCode: codeB, reason: '并发甲' }),
      bind({ userId: b, inviteCode: codeA, reason: '并发乙' }),
    ]);
    assert.equal(ra.status, 200, JSON.stringify(ra.body));
    assert.equal(rb.status, 200, JSON.stringify(rb.body));

    const outcomes = [ra.body.outcome, rb.body.outcome];
    assert.equal(
      outcomes.filter((o) => o === 'bound').length, 1,
      `应恰好一条 bound，实际 ${JSON.stringify(outcomes)}`,
    );
    const other = outcomes.find((o) => o !== 'bound');
    assert.ok(['cycle', 'already_bound'].includes(other!), `另一条应是 cycle/already_bound，实际 ${other}`);

    const rows = await prisma.referral.findMany({ where: { userId: { in: [a, b] } } });
    assert.equal(rows.length, 1, `只该有一条边，实际 ${JSON.stringify(rows)}`);
    // 环的直接判据：两条边同时存在才成环，上面已排除；这里再从关系上确认一次方向唯一。
    const edge = rows[0];
    assert.ok(
      (edge.userId === a && edge.referrerId === b) || (edge.userId === b && edge.referrerId === a),
      '边的方向必须是 A→B 或 B→A 二者之一',
    );
  });
});

describe('⑤ 邀请链 GET /admin/invites/chain/:userId', () => {
  beforeEach(async () => { await cleanBusiness(); await seedBaseline(); });

  test('用户不存在 → 404（不是一条空链）', async () => {
    const r = await api('GET', '/api/admin/invites/chain/no-such-user');
    assert.equal(r.status, 404);
    assert.equal(r.body.code, 'USER_NOT_FOUND');
  });

  test('upline 深度 > 3 仍能一路回到根（物化只存三级，上溯不受此限）', async () => {
    const a = await register({ name: '根' });
    const b = await register({ inviteCode: await inviteCodeOf(a), name: '二' });
    const c = await register({ inviteCode: await inviteCodeOf(b), name: '三' });
    const d = await register({ inviteCode: await inviteCodeOf(c), name: '四' });
    const e = await register({ inviteCode: await inviteCodeOf(d), name: '五' });

    // 先确认物化路径确实只到三级（E 的 lv3 = B，A 落在视野之外）
    const edgeE = await prisma.referral.findUniqueOrThrow({ where: { userId: e } });
    assert.deepEqual([edgeE.lv1, edgeE.lv2, edgeE.lv3], [d, c, b]);

    const r = await api<AdminChainView>('GET', `/api/admin/invites/chain/${e}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.user.userId, e);
    assert.deepEqual(r.body.upline.map((x) => x.userId), [d, c, b, a], '必须沿 referrerId 递归到根');
    assert.deepEqual(r.body.upline.map((x) => x.depth), [1, 2, 3, 4]);
    assert.equal(r.body.upline[3].name, '根');
    assert.equal(r.body.uplineTruncated, false);
    assert.equal(r.body.upline.every((x) => x.isDistributor === false), true, '这条链上还没有人是代理');
    assert.ok(r.body.upline.every((x) => x.boundAt && x.source), '每一跳要带建边时刻与来源');

    // 根自己：upline 为空数组（不是 null，也不是 404）
    const rootView = await api<AdminChainView>('GET', `/api/admin/invites/chain/${a}`);
    assert.deepEqual(rootView.body.upline, []);
    assert.equal(rootView.body.uplineTruncated, false);

    // 完整手机号不许出现在任何一层
    const raw = JSON.stringify(r.body);
    for (const uid of [a, b, c, d, e]) assert.ok(!raw.includes(await phoneOf(uid)), '邀请链不下发完整手机号');
    assert.ok(!/userAgent/i.test(raw));
  });

  test('downline 与 /admin/referral/tree 的节点口径完全一致（同一个子树构建函数）', async () => {
    const a = await register();
    const codeA = await inviteCodeOf(a);
    const b = await register({ inviteCode: codeA });
    const b2 = await register({ inviteCode: codeA });
    const c = await register({ inviteCode: await inviteCodeOf(b) });
    await register({ inviteCode: await inviteCodeOf(c) });
    void b2;

    const tree = await api<AdminReferralTree>('GET', '/api/admin/referral/tree');
    assert.equal(tree.status, 200, JSON.stringify(tree.body));
    const fromTree = tree.body.roots.find((n) => n.userId === a);
    assert.ok(fromTree, 'A 应作为根出现在关系树里');

    const chain = await api<AdminChainView>('GET', `/api/admin/invites/chain/${a}`);
    assert.equal(chain.status, 200, JSON.stringify(chain.body));
    assert.equal(chain.body.downline.rootLimit, 1);
    assert.equal(chain.body.downline.roots.length, 1);
    assert.deepEqual(
      chain.body.downline.roots[0], fromTree,
      '两屏对同一个人必须逐字段一致（否则运营点着节点在另一屏找不到人）',
    );
    assert.equal(chain.body.downline.riskWindowDays, tree.body.riskWindowDays, '红环窗口同源');
    assert.equal(chain.body.downline.edgeTotal, tree.body.edgeTotal);
  });

  test('team：三级人数 / 已开通 / 已支付 GMV（已退款不计）；非代理时 commission 为 null', async () => {
    const a = await register();
    const codeA = await inviteCodeOf(a);
    const b = await register({ inviteCode: codeA });
    const b2 = await register({ inviteCode: codeA });
    const c = await register({ inviteCode: await inviteCodeOf(b) });
    const d = await register({ inviteCode: await inviteCodeOf(c) });

    await seedPaidOrder(b, 6800);
    await seedPaidOrder(b2, 1000, { refunded: true }); // 已退款 → 不进 GMV
    await seedPaidOrder(c, 19900);
    await seedPaidOrder(d, 500);
    // b2 套餐到期 → lv1 的 activated 只数 b
    await prisma.user.update({ where: { id: b2 }, data: { planExpiresAt: new Date(Date.now() - 1000) } });

    const r = await api<AdminChainView>('GET', `/api/admin/invites/chain/${a}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(
      r.body.team.map((t) => ({ level: t.level, users: t.users, activated: t.activated, paidGmv: t.paidGmv })),
      [
        { level: 1, users: 2, activated: 1, paidGmv: 6800 },
        { level: 2, users: 1, activated: 1, paidGmv: 19900 },
        { level: 3, users: 1, activated: 1, paidGmv: 500 },
      ],
    );
    assert.equal(r.body.team.every((t) => t.commission === null), true, '非代理时「不适用」必须是 null 而不是 0');
    assert.equal(r.body.distributor, null, '非代理时档案为 null');
  });

  test('本人是代理：distributor 回档案摘要，team.commission 按级给净额（含负的 clawback，reversed 不计）', async () => {
    const a = await register({ name: '代理本人' });
    const codeA = await inviteCodeOf(a);
    const b = await register({ inviteCode: codeA });
    const c = await register({ inviteCode: await inviteCodeOf(b) });
    const tenantId = (await prisma.user.findUniqueOrThrow({ where: { id: a } })).tenantId;

    const tier = await prisma.distributorTier.create({ data: { name: `测试等级-${Date.now()}` } });
    const dist = await prisma.distributor.create({
      data: { userId: a, tenantId, status: 'active', tierId: tier.id, displayName: '某渠道商' },
    });
    const entry = (over: Record<string, unknown>) => prisma.commissionEntry.create({
      data: {
        tenantId, outTradeNo: `C${Math.random().toString(36).slice(2, 10)}`, orderId: 'o',
        buyerUserId: b, beneficiaryUserId: a, distributorId: dist.id,
        level: 1, itemType: 'plan', itemKey: 'p', baseAmount: 10000, rateBp: 1000, amount: 1000,
        holdUntil: new Date(), ...over,
      },
    });
    await entry({ level: 1, amount: 1000, status: 'confirmed' });
    await entry({ level: 1, amount: -300, kind: 'clawback', status: 'confirmed' }); // 追回要抵扣
    await entry({ level: 1, amount: 999, status: 'reversed' });                     // 已冲销不计
    await entry({ level: 2, amount: 500, status: 'pending', buyerUserId: c });

    const r = await api<AdminChainView>('GET', `/api/admin/invites/chain/${a}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.distributor, {
      id: dist.id, userId: a, status: 'active',
      tier: { id: tier.id, name: tier.name }, displayName: '某渠道商',
    });
    assert.deepEqual(r.body.team.map((t) => t.commission), [700, 500, 0], '第三级无流水应是 0（是代理但没产生），不是 null');

    // 目录表（DistributorTier）不在 resetBusinessData 里（运营目录），自己清。
    await prisma.commissionEntry.deleteMany();
    await prisma.distributor.deleteMany();
    await prisma.distributorTier.delete({ where: { id: tier.id } });
  });

  test('孤家寡人：三级全零 + 空 downline，回 200 而不是 404', async () => {
    const solo = await login(uniquePhone(), '孤家寡人');
    const r = await api<AdminChainView>('GET', `/api/admin/invites/chain/${solo}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.team.map((t) => [t.users, t.activated, t.paidGmv]), [[0, 0, 0], [0, 0, 0], [0, 0, 0]]);
    assert.deepEqual(r.body.upline, []);
    assert.equal(r.body.downline.roots.length, 1, '本人始终是那唯一一个根');
    assert.deepEqual(r.body.downline.roots[0].children, []);
    assert.equal(r.body.downline.roots[0].directCount, 0);
  });
});
