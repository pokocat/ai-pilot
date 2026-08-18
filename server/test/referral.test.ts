// 邀请关系链：注册时绑定、五种归因结果全留痕、深环拒绝、物化路径平移、读数口径。
//
// 这些断言守的是三条公理（单推荐人 / 无环 / 物化三级），以及一条产品铁律：
// **归因失败绝不能阻断注册**，且失败必须留痕（否则推荐人无从解释「客户为什么没归到我」）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, uniquePhone, anyPlanId } from './helpers.ts';
import { prisma } from '../src/db.ts';
import { bindOnRegister, isInviteCodeShape, referralConfig } from '../src/services/referral.ts';

before(async () => {
  await getApp();
  await cleanBusiness();
  await seedBaseline();
});

after(async () => {
  await closeApp();
});

/** 注册一个新账号（可带邀请码），返回 userId。 */
async function register(opts: { inviteCode?: string; inviteCodeAt?: number } = {}): Promise<string> {
  const body: Record<string, unknown> = { phone: uniquePhone(), name: '测试老板' };
  if (opts.inviteCode !== undefined) body.inviteCode = opts.inviteCode;
  if (opts.inviteCodeAt !== undefined) body.inviteCodeAt = opts.inviteCodeAt;
  const r = await api<{ token: string }>('POST', '/api/auth/login', { body });
  assert.equal(r.status, 200, `注册应成功，实际 ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.token;
}

/** 取某人的邀请码（/me 惰性生成）。 */
async function inviteCodeOf(token: string): Promise<string> {
  const me = await api<{ inviteCode?: string }>('GET', '/api/me', { token });
  assert.equal(me.status, 200);
  assert.ok(me.body.inviteCode, '/me 应返回邀请码');
  return me.body.inviteCode!;
}

async function outcomesOf(userId: string): Promise<string[]> {
  const rows = await prisma.referralAttribution.findMany({
    where: { newUserId: userId }, orderBy: { createdAt: 'asc' }, select: { outcome: true },
  });
  return rows.map((r) => r.outcome);
}

test('邀请码形状校验：只认 "JS"+4 位 Crockford（去掉 I/L/O/U），脏值一律不认', () => {
  assert.ok(isInviteCodeShape('JS2K7P'));
  assert.ok(!isInviteCodeShape('js2k7p'), '小写不认');
  assert.ok(!isInviteCodeShape('JS2K7I'), 'I 不在字母表');
  assert.ok(!isInviteCodeShape('JS2K7L'), 'L 不在字母表');
  assert.ok(!isInviteCodeShape('JS2K7O'), 'O 不在字母表');
  assert.ok(!isInviteCodeShape('JS2K7U'), 'U 不在字母表');
  assert.ok(!isInviteCodeShape('JS2K7'), '长度不足');
  assert.ok(!isInviteCodeShape('JS2K7PP'), '长度超出');
  assert.ok(!isInviteCodeShape(undefined), 'undefined 不认');
});

test('短信登录通道：新号带码注册即建边，物化路径 lv1=邀请人、lv2/lv3 为空，并落 bound 留痕', async () => {
  const inviter = await register();
  const code = await inviteCodeOf(inviter);
  const invitee = await register({ inviteCode: code, inviteCodeAt: Date.now() });

  const edge = await prisma.referral.findUnique({ where: { userId: invitee } });
  assert.ok(edge, '应建立邀请关系');
  assert.equal(edge!.referrerId, inviter);
  assert.equal(edge!.lv1, inviter, 'lv1 必须等于直接邀请人');
  assert.equal(edge!.lv2, null);
  assert.equal(edge!.lv3, null);
  assert.equal(edge!.inviteCode, code);
  assert.deepEqual(await outcomesOf(invitee), ['bound']);
});

test('微信一键通道：同一份归因参数在 /auth/wechat-phone 上同样生效（三条建号通道共用一条绑定路径）', async () => {
  // 该入口需要微信 code2Session，测试环境不可达；这里只验证「归因字段被 schema 接受、
  // 且不会因为多带两个字段就把请求打成 400 参数错误」——绑定逻辑与短信通道是同一个函数。
  const inviter = await register();
  const code = await inviteCodeOf(inviter);
  // 断言「带码与不带码的响应状态完全一致」，而不是只断言 !== 400 ——
  // 后者在接口 500 时也会绿，等于什么都没验到。这里要证明的是：多带两个归因字段
  // 不改变这个入口的既有行为（该入口在测试环境走不到微信服务，两次都会失败在同一处）。
  const withCode = await api('POST', '/api/auth/wechat-phone', {
    body: { phoneCode: 'test-phone-code', loginCode: 'test-login-code', inviteCode: code, inviteCodeAt: Date.now() },
  });
  const without = await api('POST', '/api/auth/wechat-phone', {
    body: { phoneCode: 'test-phone-code', loginCode: 'test-login-code' },
  });
  assert.equal(withCode.status, without.status, `带归因字段改变了响应：${withCode.status} vs ${without.status}`);
  assert.notEqual(withCode.status, 400, '归因字段不得导致参数校验失败');
});

test('自邀拒绝：拿自己的码注册不可能发生，但拿自己的码再绑一次要被拒并留痕 self', async () => {
  const user = await register();
  const code = await inviteCodeOf(user);
  const tenant = (await prisma.user.findUniqueOrThrow({ where: { id: user } })).tenantId;
  const outcome = await bindOnRegister({ db: prisma, userId: user, tenantId: tenant, inviteCode: code });
  assert.equal(outcome, 'self');
  assert.equal(await prisma.referral.count({ where: { userId: user } }), 0, '自邀不得建边');
  assert.ok((await outcomesOf(user)).includes('self'), 'self 必须留痕');
});

test('重复绑定拒绝：已有推荐人的用户再带别人的码，返回 already_bound 且原关系不变', async () => {
  const first = await register();
  const second = await register();
  const firstCode = await inviteCodeOf(first);
  const secondCode = await inviteCodeOf(second);
  const invitee = await register({ inviteCode: firstCode, inviteCodeAt: Date.now() });
  const tenant = (await prisma.user.findUniqueOrThrow({ where: { id: invitee } })).tenantId;

  const outcome = await bindOnRegister({ db: prisma, userId: invitee, tenantId: tenant, inviteCode: secondCode });
  assert.equal(outcome, 'already_bound');
  const edge = await prisma.referral.findUniqueOrThrow({ where: { userId: invitee } });
  assert.equal(edge.referrerId, first, '单推荐人公理：绑定后不可变更');
  assert.deepEqual(await outcomesOf(invitee), ['bound', 'already_bound']);
});

test('不存在的码：注册照常成功（绝不阻断），并留痕 unknown_code、不建边', async () => {
  const invitee = await register({ inviteCode: 'JSZZZZ', inviteCodeAt: Date.now() });
  assert.ok(invitee, '注册必须成功——归因失败不得阻断建号');
  assert.equal(await prisma.referral.count({ where: { userId: invitee } }), 0);
  assert.deepEqual(await outcomesOf(invitee), ['unknown_code']);
});

test('脏码不打断登录，但带了码就必须留痕（形状非法 → unknown_code）', async () => {
  const r = await api<{ token: string }>('POST', '/api/auth/login', {
    body: { phone: uniquePhone(), name: '脏码用户', inviteCode: 'not-a-code' },
  });
  assert.equal(r.status, 200, '分享链路不能因为一个脏参数把登录拦下来');
  assert.equal(await prisma.referral.count({ where: { userId: r.body.token } }), 0, '非法码不建边');
  // 带了码就要留痕：用户说「我填了邀请码怎么没算给他」时，运营手上得有凭据可查。
  assert.deepEqual(await outcomesOf(r.body.token), ['unknown_code']);
});

test('完全没带码：不产生任何归因行（绝大多数注册走这条，不该有噪音）', async () => {
  const clean = await register();
  assert.deepEqual(await outcomesOf(clean), []);
});

test('任何类型的脏归因参数都不得让登录 400（zod 兜住，不是靠调用方自律）', async () => {
  const cases: Array<Record<string, unknown>> = [
    { inviteCode: 123 },                              // 数字型码
    { inviteCode: 'JS2K7P', inviteCodeAt: 'abc' },    // 字符串型时间戳
    { inviteCode: 'JS2K7P', inviteCodeAt: -5 },       // 负数时间戳
    { inviteCode: 'JS2K7P', inviteCodeAt: 1.5 },      // 非整数
    { inviteCode: 'x'.repeat(500) },                  // 超长串
    { inviteCode: null, inviteCodeAt: null },         // null
  ];
  for (const extra of cases) {
    const r = await api<{ token: string }>('POST', '/api/auth/login', {
      body: { phone: uniquePhone(), name: '脏参数用户', ...extra },
    });
    assert.equal(r.status, 200, `脏参数 ${JSON.stringify(extra)} 不得让登录失败，实际 ${r.status} ${JSON.stringify(r.body)}`);
  }
});

test('超归因窗口：捕获时刻早于窗口（默认 30 天）→ expired，不建边但留痕', async () => {
  const inviter = await register();
  const code = await inviteCodeOf(inviter);
  const longAgo = Date.now() - 31 * 86_400_000;
  const invitee = await register({ inviteCode: code, inviteCodeAt: longAgo });
  assert.equal(await prisma.referral.count({ where: { userId: invitee } }), 0, '过窗口不建边');
  assert.deepEqual(await outcomesOf(invitee), ['expired']);
});

test('窗口天数读运营配置而不是写死：配 60 天读到 60，脏值/越界回落默认 30', async () => {
  // 这里直测配置层而不是端到端跑一次注册：`featureFlagPayload` 带 60s 内存缓存
  // （运营改完最多 60 秒收敛，是有意的取舍），刚 upsert 就走注册链路仍会读到旧值。
  // 端到端的窗口行为由上一条 expired 用例用默认值覆盖，这里只钉「值确实来自配置」。
  const set = async (payload: unknown) => {
    await prisma.featureFlag.upsert({
      where: { id: 'referral' },
      update: { payload: payload as never },
      create: { id: 'referral', enabled: true, payload: payload as never },
    });
  };
  try {
    await set({ window: 60 });
    assert.equal((await referralConfig({ fresh: true })).windowDays, 60);
    await set({ window: -3 });
    assert.equal((await referralConfig({ fresh: true })).windowDays, 30, '越界值必须回落默认，不能把窗口带到沟里');
    await set({ window: 'abc' });
    assert.equal((await referralConfig({ fresh: true })).windowDays, 30, '脏值同样回落');
    // 奖励类栏位本期只占位：读得到就行，代码里不许有默认数值
    const cfg = await referralConfig({ fresh: true });
    assert.equal(cfg.rewardInviter, null);
    assert.equal(cfg.dailyCap, null);
  } finally {
    await prisma.featureFlag.delete({ where: { id: 'referral' } }).catch(() => {});
  }
});

test('物化路径平移：三级链上第三代的 lv1/lv2/lv3 依次是父、祖、曾祖', async () => {
  const a = await register();
  const b = await register({ inviteCode: await inviteCodeOf(a), inviteCodeAt: Date.now() });
  const c = await register({ inviteCode: await inviteCodeOf(b), inviteCodeAt: Date.now() });
  const d = await register({ inviteCode: await inviteCodeOf(c), inviteCodeAt: Date.now() });

  const edgeC = await prisma.referral.findUniqueOrThrow({ where: { userId: c } });
  assert.equal(edgeC.lv1, b);
  assert.equal(edgeC.lv2, a);
  assert.equal(edgeC.lv3, null);

  const edgeD = await prisma.referral.findUniqueOrThrow({ where: { userId: d } });
  assert.equal(edgeD.lv1, c);
  assert.equal(edgeD.lv2, b);
  assert.equal(edgeD.lv3, a, '第四代的 lv3 应是曾祖（物化只到三级，再往上不记）');
});

test('深环拒绝：A→B→C→D 链上，A 拿 D 的码绑定必须被拒（物化只存三级，判环必须递归上溯）', async () => {
  const a = await register();
  const b = await register({ inviteCode: await inviteCodeOf(a), inviteCodeAt: Date.now() });
  const c = await register({ inviteCode: await inviteCodeOf(b), inviteCodeAt: Date.now() });
  const d = await register({ inviteCode: await inviteCodeOf(c), inviteCodeAt: Date.now() });

  // A 此时没有推荐人。若判环只比 lv1/lv2/lv3，A 会成功绑到 D 上，形成 A→D→C→B→A 的环。
  const dCode = await inviteCodeOf(d);
  const tenantA = (await prisma.user.findUniqueOrThrow({ where: { id: a } })).tenantId;
  const outcome = await bindOnRegister({ db: prisma, userId: a, tenantId: tenantA, inviteCode: dCode });
  // 断言**具体** outcome：只写 `!== 'bound'` 的话，实现哪天错成 unknown_code 也照样绿，
  // 那就掩盖了「环没被识别出来、只是恰好因为别的原因没建边」这种情况。
  assert.equal(outcome, 'cycle', '成环必须被识别为 cycle（与自邀 self 分开，排查方向不同）');
  assert.equal(await prisma.referral.count({ where: { userId: a } }), 0, 'A 不得获得推荐人');
  assert.deepEqual(await outcomesOf(a), ['cycle'], '环拒绝也要留痕，便于排查人工补绑造成的脏数据');
});

test('/me.referral 读数：直邀数与已开通数分开算（过期套餐不计入），上级姓名如实回填', async () => {
  const inviter = await register();
  const code = await inviteCodeOf(inviter);
  const active = await register({ inviteCode: code, inviteCodeAt: Date.now() });
  const expired = await register({ inviteCode: code, inviteCodeAt: Date.now() });

  // 不依赖「注册时会不会自动开通套餐」这种环境细节（它随 TEST_DEFAULT_PLAN_NAME 变化），
  // 显式把两个直邀摆成一个有效、一个已过期，这样断言的是**口径**而不是环境。
  const planId = await anyPlanId();
  await prisma.user.update({
    where: { id: active },
    data: { planId, planActivatedAt: new Date(), planExpiresAt: new Date(Date.now() + 30 * 86_400_000) },
  });
  await prisma.user.update({
    where: { id: expired },
    data: { planId, planActivatedAt: new Date(Date.now() - 60 * 86_400_000), planExpiresAt: new Date(Date.now() - 86_400_000) },
  });

  const me = await api<{ referral: { directCount: number; activatedCount: number; referrerName: string | null } | null }>(
    'GET', '/api/me', { token: inviter },
  );
  assert.equal(me.status, 200);
  assert.ok(me.body.referral, 'referral 读数不应为 null');
  assert.equal(me.body.referral!.directCount, 2, '两个直邀都要数进来');
  // 关键：这两个数必须分开算。套餐已过期的人不是「已开通」——
  // 与 planGate / getPlanStatus 同一口径（有 planId 且未过期）。
  assert.equal(me.body.referral!.activatedCount, 1, '过期套餐不得计入 activatedCount');

  // 被邀人视角：能看到自己的上级姓名与绑定时间
  const mine = await api<{ referral: { referrerName: string | null; boundAt: string | null } | null }>(
    'GET', '/api/me', { token: active },
  );
  assert.equal(mine.body.referral!.referrerName, '测试老板');
  assert.ok(mine.body.referral!.boundAt, '绑定时间应回填');
});

test('已注册用户登录不追认推荐人：老号再带码登录，不建边、不产生归因行', async () => {
  const inviter = await register();
  const code = await inviteCodeOf(inviter);
  const phone = uniquePhone();
  const first = await api<{ token: string }>('POST', '/api/auth/login', { body: { phone, name: '老用户' } });
  assert.equal(first.status, 200);
  const userId = first.body.token;

  const again = await api<{ token: string }>('POST', '/api/auth/login', {
    body: { phone, name: '老用户', inviteCode: code, inviteCodeAt: Date.now() },
  });
  assert.equal(again.status, 200);
  assert.equal(again.body.token, userId, '仍是同一个账号');
  assert.equal(await prisma.referral.count({ where: { userId } }), 0, '存量用户互相填码是最容易被薅的口子，必须不追认');
  assert.deepEqual(await outcomesOf(userId), []);
});

test('并发绑定：同一新号两次带码请求同时进来，一个 bound 一个 already_bound，绝不双写也不抛错', async () => {
  const inviter = await register();
  const code = await inviteCodeOf(inviter);
  const target = await register(); // 干净的新号，还没有推荐人
  const tenant = (await prisma.user.findUniqueOrThrow({ where: { id: target } })).tenantId;

  const [a, b] = await Promise.all([
    bindOnRegister({ db: prisma, userId: target, tenantId: tenant, inviteCode: code }),
    bindOnRegister({ db: prisma, userId: target, tenantId: tenant, inviteCode: code }),
  ]);
  // 主键冲突（P2002）必须被翻译成 already_bound 如实留痕，而不是抛给上层当「绑定失败」——
  // 那样归因日志会缺这一行，风控视图就有空洞。
  assert.deepEqual([a, b].sort(), ['already_bound', 'bound'], `实际 ${a} / ${b}`);
  assert.equal(await prisma.referral.count({ where: { userId: target } }), 1, '只能有一条边');
  const outcomes = (await outcomesOf(target)).sort();
  assert.deepEqual(outcomes, ['already_bound', 'bound'], '两次进线都要留痕');
});
