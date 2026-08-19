// 邀请关系链：注册时绑定、五种归因结果全留痕、深环拒绝、物化路径平移、读数口径，
// 以及邀请漏斗第四段（付费开通 → ActivationEvent.source='invite'）。
//
// 这些断言守的是三条公理（单推荐人 / 无环 / 物化三级），以及一条产品铁律：
// **归因失败绝不能阻断注册**，且失败必须留痕（否则推荐人无从解释「客户为什么没归到我」）。
// 漏斗那一段另有一条同源铁律：**归因绝不能阻断支付**，且不许覆盖既有的位子归因。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, uniquePhone, anyPlanId } from './helpers.ts';
import { prisma } from '../src/db.ts';
import { scanDataErasureJobs } from '../src/services/accountDeletion.ts';
import { bindOnRegister, isInviteCodeShape, referralConfig, ReferralAlreadyBound, traceOutsideTransaction } from '../src/services/referral.ts';
import { verifyReferralCapture } from '../src/services/referralCapture.ts';
import { markPaidAndApply, settleInviteActivations, pendingInviteActivations } from '../src/services/wechatPay.ts';
import { applyPlanPurchase } from '../src/services/purchase.ts';
import { parseAttribution, processInviteActivationOutbox, scanInviteActivationOutbox } from '../src/services/activation.ts';

before(async () => {
  await getApp();
  await cleanBusiness();
  await seedBaseline();
});

after(async () => {
  await closeApp();
});

/** 注册一个新账号（可带邀请码），返回 userId。 */
async function captureToken(inviteCode: string, source: 'share_friend' | 'share_timeline' | 'poster_qr' = 'share_friend'): Promise<string> {
  const r = await api<{ token: string }>('POST', '/api/auth/referral-capture', { body: { inviteCode, source } });
  assert.equal(r.status, 200, `捕获凭证应签发成功，实际 ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.token;
}

async function register(opts: { inviteCode?: string; withCapture?: boolean; source?: 'share_friend' | 'share_timeline' | 'poster_qr' } = {}): Promise<string> {
  const body: Record<string, unknown> = { phone: uniquePhone(), name: '测试老板' };
  if (opts.inviteCode !== undefined) {
    body.inviteCode = opts.inviteCode;
    if (opts.withCapture !== false) body.referralToken = await captureToken(opts.inviteCode, opts.source);
  }
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

test('生产缺签名密钥时验签 fail-closed：脏 referralToken 不能把登录链打成 5xx', () => {
  const oldNodeEnv = process.env.NODE_ENV;
  const oldSecret = process.env.APP_JWT_SECRET;
  try {
    process.env.NODE_ENV = 'production';
    delete process.env.APP_JWT_SECRET;
    assert.equal(verifyReferralCapture('e30.'), null);
  } finally {
    if (oldNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = oldNodeEnv;
    if (oldSecret === undefined) delete process.env.APP_JWT_SECRET;
    else process.env.APP_JWT_SECRET = oldSecret;
  }
});

test('短信登录通道：新号带码注册即建边，物化路径 lv1=邀请人、lv2/lv3 为空，并落 bound 留痕', async () => {
  const inviter = await register();
  const code = await inviteCodeOf(inviter);
  const invitee = await register({ inviteCode: code });

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
    body: { phoneCode: 'test-phone-code', loginCode: 'test-login-code', inviteCode: code, referralToken: await captureToken(code) },
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
  const outcome = await bindOnRegister({ db: prisma, userId: user, tenantId: tenant, inviteCode: code, capturedAt: Date.now() });
  assert.equal(outcome, 'self');
  assert.equal(await prisma.referral.count({ where: { userId: user } }), 0, '自邀不得建边');
  assert.ok((await outcomesOf(user)).includes('self'), 'self 必须留痕');
});

test('重复绑定拒绝：已有推荐人的用户再带别人的码，返回 already_bound 且原关系不变', async () => {
  const first = await register();
  const second = await register();
  const firstCode = await inviteCodeOf(first);
  const secondCode = await inviteCodeOf(second);
  const invitee = await register({ inviteCode: firstCode });
  const tenant = (await prisma.user.findUniqueOrThrow({ where: { id: invitee } })).tenantId;

  const outcome = await bindOnRegister({ db: prisma, userId: invitee, tenantId: tenant, inviteCode: secondCode, capturedAt: Date.now() });
  assert.equal(outcome, 'already_bound');
  const edge = await prisma.referral.findUniqueOrThrow({ where: { userId: invitee } });
  assert.equal(edge.referrerId, first, '单推荐人公理：绑定后不可变更');
  assert.deepEqual(await outcomesOf(invitee), ['bound', 'already_bound']);
});

test('不存在的码：注册照常成功（绝不阻断），并留痕 unknown_code、不建边', async () => {
  const invitee = await register({ inviteCode: 'JSZZZZ' });
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
  const invitee = await register();
  const tenant = (await prisma.user.findUniqueOrThrow({ where: { id: invitee } })).tenantId;
  assert.equal(await bindOnRegister({ db: prisma, userId: invitee, tenantId: tenant, inviteCode: code, capturedAt: longAgo }), 'expired');
  assert.equal(await prisma.referral.count({ where: { userId: invitee } }), 0, '过窗口不建边');
  assert.deepEqual(await outcomesOf(invitee), ['expired']);
});

test('窗口天数读运营配置而不是写死：配 60 天读到 60，脏值/越界回落默认 30', async () => {
  // 这里直测配置层而不是端到端跑一次注册：`featureFlagPayload` 带 60s 内存缓存
  // （运营改完最多 60 秒收敛，是有意的取舍），刚 upsert 就走注册链路仍会读到旧值。
  // 端到端的窗口行为由上一条 expired 用例用默认值覆盖，这里只钉「值确实来自配置」。
  const set = async (payload: unknown) => {
    await prisma.featureFlag.upsert({
      where: { id: 'referral-window' },
      update: { payload: payload as never },
      create: { id: 'referral-window', enabled: true, payload: payload as never },
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
    await prisma.featureFlag.delete({ where: { id: 'referral-window' } }).catch(() => {});
  }
});

test('物化路径平移：三级链上第三代的 lv1/lv2/lv3 依次是父、祖、曾祖', async () => {
  const a = await register();
  const b = await register({ inviteCode: await inviteCodeOf(a) });
  const c = await register({ inviteCode: await inviteCodeOf(b) });
  const d = await register({ inviteCode: await inviteCodeOf(c) });

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
  const b = await register({ inviteCode: await inviteCodeOf(a) });
  const c = await register({ inviteCode: await inviteCodeOf(b) });
  const d = await register({ inviteCode: await inviteCodeOf(c) });

  // A 此时没有推荐人。若判环只比 lv1/lv2/lv3，A 会成功绑到 D 上，形成 A→D→C→B→A 的环。
  const dCode = await inviteCodeOf(d);
  const tenantA = (await prisma.user.findUniqueOrThrow({ where: { id: a } })).tenantId;
  const outcome = await bindOnRegister({ db: prisma, userId: a, tenantId: tenantA, inviteCode: dCode, capturedAt: Date.now() });
  // 断言**具体** outcome：只写 `!== 'bound'` 的话，实现哪天错成 unknown_code 也照样绿，
  // 那就掩盖了「环没被识别出来、只是恰好因为别的原因没建边」这种情况。
  assert.equal(outcome, 'cycle', '成环必须被识别为 cycle（与自邀 self 分开，排查方向不同）');
  assert.equal(await prisma.referral.count({ where: { userId: a } }), 0, 'A 不得获得推荐人');
  assert.deepEqual(await outcomesOf(a), ['cycle'], '环拒绝也要留痕，便于排查人工补绑造成的脏数据');
});

test('/me.referral 读数：直邀数与已开通数分开算（过期套餐不计入），上级姓名如实回填', async () => {
  const inviter = await register();
  const code = await inviteCodeOf(inviter);
  const active = await register({ inviteCode: code });
  const expired = await register({ inviteCode: code });

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
    body: { phone, name: '老用户', inviteCode: code, referralToken: await captureToken(code) },
  });
  assert.equal(again.status, 200);
  assert.equal(again.body.token, userId, '仍是同一个账号');
  assert.equal(await prisma.referral.count({ where: { userId } }), 0, '存量用户互相填码是最容易被薅的口子，必须不追认');
  assert.deepEqual(await outcomesOf(userId), []);
});

test('并发绑定走生产形态（事务内）：只建一条边，且两条路径都有留痕', async () => {
  const inviter = await register();
  const code = await inviteCodeOf(inviter);
  const target = await register();
  const tenant = (await prisma.user.findUniqueOrThrow({ where: { id: target } })).tenantId;
  const args = { userId: target, tenantId: tenant, inviteCode: code, capturedAt: Date.now() };

  // **用 prisma.$transaction 包**——生产里 bindReferralAfterRegister 就是这么调的。
  // 之前这条用例传裸 prisma，压根没覆盖「事务内主键冲突」这条真实分支。
  const results = await Promise.allSettled([
    prisma.$transaction((tx) => bindOnRegister({ db: tx, ...args })),
    prisma.$transaction((tx) => bindOnRegister({ db: tx, ...args })),
  ]);

  // 并发时序有两种合法结果，都要接受（断言写死一种就是在赌调度）：
  //   · 后到的那次读到了 existing → 返回 already_bound；
  //   · 两次都越过 existing 检查 → 后写的撞主键，抛 ReferralAlreadyBound（事务已失败，
  //     留痕只能由调用方在事务外补，见 auth.ts 的 catch）。
  const bound = results.filter((r) => r.status === 'fulfilled' && r.value === 'bound');
  const dupOk = results.filter((r) => r.status === 'fulfilled' && r.value === 'already_bound');
  const dupThrown = results.filter((r) => r.status === 'rejected' && r.reason instanceof ReferralAlreadyBound);
  assert.equal(bound.length, 1, `应恰好一次 bound，实际 ${JSON.stringify(results.map((r) => r.status === 'fulfilled' ? r.value : String(r.reason)))}`);
  assert.equal(dupOk.length + dupThrown.length, 1, '另一次必须是 already_bound 或抛 ReferralAlreadyBound');
  assert.equal(await prisma.referral.count({ where: { userId: target } }), 1, '绝不能双写');

  // 抛异常那条路径的留痕由调用方在事务外补——这里直接验证那个函数真的会落行
  if (dupThrown.length === 1) {
    const before = await prisma.referralAttribution.count({ where: { newUserId: target, outcome: 'already_bound' } });
    await traceOutsideTransaction({
      tenantId: tenant, userId: target, inviteCode: code, source: 'share_friend',
      outcome: 'already_bound', referrerId: (dupThrown[0].reason as ReferralAlreadyBound).referrerId,
    });
    const after = await prisma.referralAttribution.count({ where: { newUserId: target, outcome: 'already_bound' } });
    assert.equal(after, before + 1, '事务外补留痕必须真的落库（否则风控视图有空洞）');
  }
  assert.ok((await outcomesOf(target)).includes('bound'), '成功那次必须有 bound 留痕');
});

test('缺可信时间戳不建边（no_timestamp）：判不了新鲜度就不能建一条改不回来的关系', async () => {
  const inviter = await register();
  const code = await inviteCodeOf(inviter);
  const target = await register();
  const tenant = (await prisma.user.findUniqueOrThrow({ where: { id: target } })).tenantId;

  // 不传 inviteCodeAt —— 早先这里按「没时间戳就当不过期」放行，等于绕过归因窗口
  const outcome = await bindOnRegister({ db: prisma, userId: target, tenantId: tenant, inviteCode: code });
  assert.equal(outcome, 'no_timestamp');
  assert.equal(await prisma.referral.count({ where: { userId: target } }), 0, '没有可信时间戳不得建边');

  // 运营人工补绑不受此限（source='manual'）
  const manual = await bindOnRegister({ db: prisma, userId: target, tenantId: tenant, inviteCode: code, source: 'manual' });
  assert.equal(manual, 'bound', '人工补绑应放行');
});

test('脏时间戳不得成为绕过归因窗口的后门（合法码 + inviteCodeAt:"abc" → 不建边但留痕）', async () => {
  const inviter = await register();
  const code = await inviteCodeOf(inviter);
  for (const badAt of ['abc', -5, 1.5, null, {}]) {
    const r = await api<{ token: string }>('POST', '/api/auth/login', {
      body: { phone: uniquePhone(), name: '脏时间戳', inviteCode: code, inviteCodeAt: badAt },
    });
    assert.equal(r.status, 200, `脏时间戳 ${JSON.stringify(badAt)} 不得打断登录`);
    assert.equal(
      await prisma.referral.count({ where: { userId: r.body.token } }), 0,
      `脏时间戳 ${JSON.stringify(badAt)} 竟然建出了关系——这就是绕过归因窗口的后门`,
    );
    assert.deepEqual(await outcomesOf(r.body.token), ['no_timestamp'], '仍要留痕');
  }
});

test('客户端伪造未来 inviteCodeAt 也不能绕窗口：没有服务端签名 token 就只落 no_timestamp', async () => {
  const inviter = await register();
  const code = await inviteCodeOf(inviter);
  const r = await api<{ token: string; referralOutcome?: string }>('POST', '/api/auth/login', {
    body: { phone: uniquePhone(), name: '未来时间', inviteCode: code, inviteCodeAt: Date.now() + 365 * 86_400_000 },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.referralOutcome, 'no_timestamp');
  assert.equal(await prisma.referral.count({ where: { userId: r.body.token } }), 0);
});

test('首次注册因缺 token 失败后可用同一码签名凭证恢复；普通老账号仍不可补绑', async () => {
  const inviter = await register();
  const code = await inviteCodeOf(inviter);
  const phone = uniquePhone();
  const first = await api<{ token: string; referralOutcome?: string }>('POST', '/api/auth/login', {
    body: { phone, name: '可恢复注册', inviteCode: code },
  });
  assert.equal(first.body.referralOutcome, 'no_timestamp');
  const second = await api<{ token: string; referralOutcome?: string }>('POST', '/api/auth/login', {
    body: { phone, name: '可恢复注册', inviteCode: code, referralToken: await captureToken(code) },
  });
  assert.equal(second.body.token, first.body.token);
  assert.equal(second.body.referralOutcome, 'bound');
  assert.equal((await prisma.referral.findUniqueOrThrow({ where: { userId: first.body.token } })).referrerId, inviter);
  assert.deepEqual(await outcomesOf(first.body.token), ['no_timestamp', 'bound']);
});

test('签名捕获凭证保留真实来源，且伪造 X-Forwarded-For 首段不会直接写入归因', async () => {
  const inviter = await register();
  const code = await inviteCodeOf(inviter);
  const token = await captureToken(code, 'share_timeline');
  const app = await getApp();
  const phone = uniquePhone();
  const res = await app.inject({
    method: 'POST', url: '/api/auth/login',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.77, 203.0.113.66' },
    payload: { phone, name: '来源验证', inviteCode: code, referralToken: token },
  });
  assert.equal(res.statusCode, 200);
  const userId = res.json().token as string;
  const edge = await prisma.referral.findUniqueOrThrow({ where: { userId } });
  const trace = await prisma.referralAttribution.findFirstOrThrow({ where: { newUserId: userId, outcome: 'bound' } });
  assert.equal(edge.source, 'share_timeline');
  assert.equal(trace.source, 'share_timeline');
  assert.equal(trace.clientIp, '203.0.113.66', '应取可信代理链解析出的最近公网地址，而不是客户端伪造的第一段');
});

test('非字符串邀请码也要留痕（inviteCode:123 不能被悄悄当成没传）', async () => {
  const r = await api<{ token: string }>('POST', '/api/auth/login', {
    body: { phone: uniquePhone(), name: '数字码', inviteCode: 123, inviteCodeAt: Date.now() },
  });
  assert.equal(r.status, 200);
  assert.deepEqual(await outcomesOf(r.body.token), ['unknown_code'], '带了码就要能查到，哪怕类型不对');
});

/**
 * 注销后驱动到期清理。
 *
 * 注销是**保留期模型**：`DELETE /me` 只停用账号并登记 DataErasureJob（至少 30 天后才到期），
 * PII 清理发生在到期任务里。所以这两条用例必须显式把 purgeAfter / nextAttemptAt 拨到过去再跑
 * scan——否则它们测的只是「接口返回 200」，IP/UA 到底抹没抹根本看不出来。
 * 拨时间的手法与 test/accountDeletion.test.ts 一致，两处别各写一套。
 */
async function drivePurge(userId: string): Promise<void> {
  const job = await prisma.dataErasureJob.findUniqueOrThrow({ where: { subjectUserId: userId } });
  await prisma.dataErasureJob.update({ where: { id: job.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
  await prisma.user.update({ where: { id: userId }, data: { purgeAfter: new Date(Date.now() - 1000) } });
  await scanDataErasureJobs();
}

test('注销只抹个人字段：A→B→C→D 删 A 后整条关系链与三级路径一行不动', async () => {
  // 2026-08-19 改口径：原先注销会删掉「本人的上级边 + 直接指向本人的边」并重算后代路径。
  // 那是错的——邀请关系是**邀请人的**账本，下级注销不该让上级业绩缩水、更不该截断三级链条。
  // 而且 Referral 里只有内部 cuid / 邀请码 / 时间戳，user 一删它天然就是去标识化的。
  const a = await register();
  const b = await register({ inviteCode: await inviteCodeOf(a) });
  const c = await register({ inviteCode: await inviteCodeOf(b) });
  const d = await register({ inviteCode: await inviteCodeOf(c) });

  const del = await api('DELETE', '/api/me', { token: a });
  assert.equal(del.status, 200, `注销应成功，实际 ${del.status} ${JSON.stringify(del.body)}`);
  await drivePurge(a); // 保留期模型：清理在到期任务里，不在 DELETE 响应里

  const edgeB = await prisma.referral.findUniqueOrThrow({ where: { userId: b } });
  assert.equal(edgeB.referrerId, a, '指向已注销 A 的边必须保留：那是 A 的邀请业绩');
  const edgeC = await prisma.referral.findUniqueOrThrow({ where: { userId: c } });
  assert.equal(edgeC.referrerId, b);
  assert.equal(edgeC.lv2, a, '三级路径不因上级注销而截断');
  const edgeD = await prisma.referral.findUniqueOrThrow({ where: { userId: d } });
  assert.equal(edgeD.referrerId, c);
  assert.equal(edgeD.lv2, b);
  assert.equal(edgeD.lv3, a, 'lv3 同样保留');

  // 归因记录整行保留，只有 IP / UA 被抹掉（隐私政策承诺「期满后删除或匿名化」）。
  const attrs = await prisma.referralAttribution.findMany({ where: { referrerId: a } });
  assert.ok(attrs.length > 0, '归因历史必须保留，否则邀请人无从解释客户是怎么来的');
  for (const row of attrs) {
    assert.equal(row.clientIp, null, 'clientIp 是网络标识符，注销后必须抹掉');
    assert.equal(row.userAgent, null, 'userAgent 是设备标识符，注销后必须抹掉');
    assert.ok(row.inviteCode && row.outcome, '邀请码与 outcome 要留着，归因链路才完整');
  }
});

test('多人租户注销分支口径一致：关系边保留，只抹 IP/UA', async () => {
  const inviter = await register();
  const tenantId = (await prisma.user.findUniqueOrThrow({ where: { id: inviter } })).tenantId;
  await prisma.user.create({
    data: { tenantId, phone: uniquePhone(), name: '同租户成员', role: 'member', benmingColor: 'green' },
  });
  const invitee = await register({ inviteCode: await inviteCodeOf(inviter) });
  const del = await api('DELETE', '/api/me', { token: inviter });
  assert.equal(del.status, 200);
  await drivePurge(inviter);
  // 两条分支必须同一口径：租户还在与否，都不改变「关系链保留、只抹个人字段」这件事。
  const edge = await prisma.referral.findUniqueOrThrow({ where: { userId: invitee } });
  assert.equal(edge.referrerId, inviter, '多人租户下同样保留邀请边');
  const attrs = await prisma.referralAttribution.findMany({ where: { referrerId: inviter } });
  assert.ok(attrs.length > 0, '归因历史保留');
  assert.ok(attrs.every((r) => r.clientIp === null && r.userAgent === null), 'IP/UA 必须抹掉');
});

// ── 邀请漏斗第四段：付费开通 → ActivationEvent(source='invite')（2026-08-18 接上写入方）───────
//
// 该取值 08-18 就进了枚举，但一直**没有任何写入方**，于是漏斗最后一段算不出来。写入方挂在
// `markPaidAndApply`（真金入账的唯一收口），刻意**不挂** `applyPlanPurchase`——后者还被
// 注册测试期自动开通 / 演示购买 / 运营手工开通三条非付费路径共用，挂那里会把免费白发算成邀请开通。

/** 某用户的开通事件（source → 条数），用来同时验「该有的有」「不该被覆盖的还在」。 */
async function activationSources(userId: string): Promise<Record<string, number>> {
  const rows = await prisma.activationEvent.findMany({ where: { userId }, select: { source: true } });
  return rows.reduce<Record<string, number>>((acc, r) => { acc[r.source] = (acc[r.source] ?? 0) + 1; return acc; }, {});
}

/**
 * 造一笔套餐订单并走**真实的** markPaidAndApply 入账（与线上回调同一条路径）。
 *
 * ⚠️ 返回时 invite 归因补记**很可能还在飞**：它是入账事务提交后派发出去的后台动作，
 * 生产路径刻意不 await（绝不阻断支付主链路，见 wechatPay.markPaidAndApply 的注释）。
 * 所以凡是要读 ActivationEvent 的断言，前面都必须 `await settleInviteActivations()`
 * ——那是专为可测性导出的等待句柄；不等就是竞态，绿也是碰巧。
 */
async function payPlanOrder(userId: string, outTradeNo: string, attrSource = 'prescription'): Promise<{ applied: boolean; reason?: string }> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const plan = await prisma.plan.findUniqueOrThrow({ where: { id: await anyPlanId() } });
  await prisma.paymentOrder.create({
    data: {
      outTradeNo, tenantId: user.tenantId, userId, planId: plan.id, amount: plan.price,
      provider: 'wechat', status: 'created',
      attrSource, attrRefId: attrSource === 'prescription' ? 'rx_funnel' : null,
    },
  });
  return markPaidAndApply({ outTradeNo, transactionId: `wx_${outTradeNo}`, tradeState: 'SUCCESS', rawJson: {} });
}

test('有推荐人的用户付费开通：落一条 source=invite，且原本的位子归因（处方位）一条不少', async () => {
  const inviter = await register();
  const code = await inviteCodeOf(inviter);
  const invitee = await register({ inviteCode: code });
  assert.ok(await prisma.referral.findUnique({ where: { userId: invitee } }), '前置：关系必须已建边');

  const r = await payPlanOrder(invitee, 'ot_invite_funnel_1', 'prescription');
  assert.equal(r.applied, true, `应入账，实际 ${JSON.stringify(r)}`);
  await settleInviteActivations(); // 补记是不 await 的后台派发，读库前必须等它落地

  // 两条并存：位子归因（从哪儿成交）+ 邀请归因（被谁带来）。这是两个维度，覆盖任何一条都是错。
  assert.deepEqual(await activationSources(invitee), { prescription: 1, invite: 1 });
  const ev = await prisma.activationEvent.findFirstOrThrow({ where: { userId: invitee, source: 'invite' } });
  assert.equal(ev.itemType, 'plan', 'invite 行仍指向真实成交的那件商品，便于对账');
  assert.equal(ev.refId, null, '推荐人不冗余进 refId：Referral 是不可变更账本，按 userId join 即得');
  assert.equal(ev.tenantId, (await prisma.user.findUniqueOrThrow({ where: { id: invitee } })).tenantId);
});

test('没有推荐人的用户付费开通：只有位子归因，绝不落 invite', async () => {
  const solo = await register();
  const r = await payPlanOrder(solo, 'ot_invite_funnel_2', 'catalog');
  assert.equal(r.applied, true);
  await settleInviteActivations(); // 等它真的跑完再断言「没有」，否则这条是空断言
  assert.deepEqual(await activationSources(solo), { catalog: 1 }, '没关系链就不该出现 invite（否则漏斗分子灌水）');
});

test('invite 归因按人去重：重复回调、第二笔订单、并发两笔都只留一条', async () => {
  const inviter = await register();
  const code = await inviteCodeOf(inviter);
  const invitee = await register({ inviteCode: code });

  // ① 同一订单重复回调：被 appliedAt 幂等挡在入账之前，自然也不会重复归因。
  await payPlanOrder(invitee, 'ot_invite_dedup_1', 'catalog');
  const again = await markPaidAndApply({ outTradeNo: 'ot_invite_dedup_1', tradeState: 'SUCCESS', rawJson: {} });
  assert.equal(again.applied, false);
  assert.equal(again.reason, 'already_applied');

  // ② 同一用户的第二笔订单（续费/加购）：漏斗问的是「转化成付费用户的人数」，不是订单数。
  await payPlanOrder(invitee, 'ot_invite_dedup_2', 'market');

  // ③ 并发两笔到账：ActivationEvent 上没有唯一约束，靠 activation:invite:{userId} advisory lock 串行化。
  const [a, b] = await Promise.all([
    payPlanOrder(invitee, 'ot_invite_dedup_3', 'catalog'),
    payPlanOrder(invitee, 'ot_invite_dedup_4', 'catalog'),
  ]);
  assert.equal(a.applied, true);
  assert.equal(b.applied, true);

  // 四笔派发出去的补记全部落地后再点数（含并发那两笔——等待句柄等的是「目前派发出去的全部」）。
  await settleInviteActivations();
  assert.equal(
    await prisma.activationEvent.count({ where: { userId: invitee, source: 'invite' } }), 1,
    'invite 行必须恰好一条（首次付费开通），四笔入账不许出现第二条',
  );
  // 位子归因反过来必须**每笔都有**（它记的是订单事实，不去重）。
  assert.equal(await prisma.activationEvent.count({ where: { userId: invitee, source: { not: 'invite' } } }), 4);
});

test('补记绝不挡在支付响应前面：markPaidAndApply 返回的那一刻它还在飞', async () => {
  // codex 审出的阻断 2：旧写法 `await recordInviteActivation(...)` 把统计补记挡在回调返回 200 之前。
  // 主支付事务此刻已经提交、真钱已入账，但连接池拥塞或 advisory lock 排队时这几条 SQL 照样能卡住，
  // routes/pay.ts 来不及应答，微信超时后就重投——为一条统计换一次重复回调。
  //
  // 这条断言的确定性从哪来：派发是**同步**发生的（markPaidAndApply 里 dispatch 完就 return），
  // 而补记的第一步就是一次 DB 往返；从 `await payPlanOrder(...)` 恢复到下一行之间只跑微任务，
  // 事件循环没机会把那次 I/O 的完成回调插进来。所以「返回时计数为 1」是必然，不是碰巧。
  // 谁把 await 加回去，计数就会是 0，这条当场变红。
  const inviter = await register();
  const code = await inviteCodeOf(inviter);
  const invitee = await register({ inviteCode: code });

  await settleInviteActivations(); // 先把前面用例派发的补记排空，计数才是干净的
  assert.equal(pendingInviteActivations(), 0, '前置：此刻不该有在飞的补记');

  const r = await payPlanOrder(invitee, 'ot_invite_async_1', 'catalog');
  assert.equal(r.applied, true);
  assert.equal(pendingInviteActivations(), 1, '支付主链路不得 await 统计补记（阻断 2）');

  await settleInviteActivations();
  assert.equal(pendingInviteActivations(), 0, '等待句柄必须真的等到补记落地，否则它没有可测性价值');
  assert.deepEqual(await activationSources(invitee), { catalog: 1, invite: 1 }, '不 await 不等于不做');
});

test('重投要能补上首次漏掉的 invite 行：already_applied 分支也派发补记', async () => {
  // codex 审出的阻断 3：首次回调已设 appliedAt，随后那次补记里「查 Referral / insert」短暂失败被
  // 吞成 'failed'，本次仍回成功；旧写法后续重投只拿到 already_applied 就返回、**再也不调补记**，
  // 该用户永远缺 source='invite'，漏斗持续少算。
  //
  // 不去打桩注入一次 DB 失败（要 mock prisma，脆且不像线上），而是**照那个终态造局**：
  // 订单已入账（appliedAt 已设）+ 该用户有 Referral + 但没有 invite 行 —— 与「首次补记失败」
  // 之后的库状态一模一样。然后重投同一笔回调，看它能不能补上。
  const inviter = await register();
  const invitee = await register({ inviteCode: await inviteCodeOf(inviter) });
  await payPlanOrder(invitee, 'ot_invite_retry_1', 'catalog');
  await settleInviteActivations();
  assert.deepEqual(await activationSources(invitee), { catalog: 1, invite: 1 });
  // 造出「支付/权益已提交且 outbox 意图仍在，但 invite 写入尚未成功」的持久状态。
  await prisma.activationEvent.deleteMany({ where: { userId: invitee, source: 'invite' } });
  await prisma.inviteActivationOutbox.update({
    where: { outTradeNo: 'ot_invite_retry_1' },
    data: { completedAt: null, nextAttemptAt: new Date(0), lastError: 'simulated_crash' },
  });

  const again = await markPaidAndApply({ outTradeNo: 'ot_invite_retry_1', tradeState: 'SUCCESS', rawJson: {} });
  assert.equal(again.applied, false, '权益一步都不许再发（appliedAt 仍是唯一的终态锚点）');
  assert.equal(again.reason, 'already_applied');
  await settleInviteActivations();
  assert.deepEqual(await activationSources(invitee), { catalog: 1, invite: 1 }, '重投必须把漏掉的 invite 行补上');

  // 再重投也只有一条：补记自己幂等（advisory lock + 查重），重投多少次都只回 'already_recorded'。
  // 这也是「重投补记不会把 already_applied 拖慢」的另一半——它做的是同一段有界的小事务，且不被 await。
  await markPaidAndApply({ outTradeNo: 'ot_invite_retry_1', tradeState: 'SUCCESS', rawJson: {} });
  await settleInviteActivations();
  assert.deepEqual(await activationSources(invitee), { catalog: 1, invite: 1 }, '重投再多也不许出现第二条 invite');
});

test('持久化 outbox 可由 scheduler 扫描恢复，进程退出不依赖微信再次重投', async () => {
  const inviter = await register();
  const invitee = await register({ inviteCode: await inviteCodeOf(inviter) });
  const user = await prisma.user.findUniqueOrThrow({ where: { id: invitee } });
  await prisma.inviteActivationOutbox.create({
    data: {
      outTradeNo: 'ot_invite_scheduler_recovery', tenantId: user.tenantId, userId: invitee,
      itemType: 'plan', itemKey: await anyPlanId(), nextAttemptAt: new Date(0),
    },
  });
  const scanned = await scanInviteActivationOutbox();
  assert.ok(scanned.scanned >= 1);
  assert.equal(await prisma.activationEvent.count({ where: { userId: invitee, source: 'invite' } }), 1);
  assert.ok((await prisma.inviteActivationOutbox.findUniqueOrThrow({ where: { outTradeNo: 'ot_invite_scheduler_recovery' } })).completedAt);
  assert.equal(await processInviteActivationOutbox('ot_invite_scheduler_recovery'), 'not_due', '完成行不得重复处理');
});

test('非付费开通不进邀请漏斗：applyPlanPurchase（注册自动开通 / 演示 / 运营手工）不落 invite', async () => {
  // 这条钉住 ④ 的挂点选择。挂 applyPlanPurchase 会让「开着注册自动开通时，被邀人注册当场就算首开通」，
  // 「注册 → 首开通」永远 100%，漏斗直接失去意义。
  const inviter = await register();
  const code = await inviteCodeOf(inviter);
  const invitee = await register({ inviteCode: code });
  const user = await prisma.user.findUniqueOrThrow({ where: { id: invitee } });
  const plan = await prisma.plan.findUniqueOrThrow({ where: { id: await anyPlanId() } });

  await applyPlanPurchase({ id: user.id, tenantId: user.tenantId }, plan, { reason: '测试期开通', source: 'test_default_grant' });
  assert.deepEqual(await activationSources(invitee), {}, '免费/演示/运营开通不该产生任何开通归因事件');
});

test('端上不许自称 invite：请求体里的 source=invite 一律回落 catalog（否则谁都能刷漏斗）', async () => {
  assert.equal(parseAttribution('invite', 'x').source, 'catalog');
  assert.equal(parseAttribution('prescription', 'rx_1').source, 'prescription', '真正的位子来源不受影响');

  const inviter = await register();
  const code = await inviteCodeOf(inviter);
  const invitee = await register({ inviteCode: code });
  await payPlanOrder(invitee, 'ot_invite_forge_1', 'invite');
  await settleInviteActivations();
  // 伪造的那条被打回 catalog；invite 行仍由服务端按 Referral 判定后另落一条。
  assert.deepEqual(await activationSources(invitee), { catalog: 1, invite: 1 });
});

test('归因窗口与奖励配置分属两个 flag：改窗口不得抹掉奖励配置', async () => {
  // 两者分属两个 flag id（当初为躲 PATCH /admin/flags/:id 的整块覆盖写而拆开；那条已改成合并写，
  // 见 test/featureFlagPayload.test.ts）。这条用例把「分开」这个结构钉住：读取侧各读各的 flag，
  // 改窗口不碰奖励键——不依赖写入侧是覆盖还是合并。
  await prisma.featureFlag.upsert({
    where: { id: 'referral' },
    update: { payload: { rewardInviter: { kind: 'credits', amount: 5 } } as never },
    create: { id: 'referral', enabled: true, payload: { rewardInviter: { kind: 'credits', amount: 5 } } as never },
  });
  try {
    // 模拟运营在后台改窗口：整块覆盖 referral-window 的 payload
    await prisma.featureFlag.upsert({
      where: { id: 'referral-window' },
      update: { payload: { window: 45 } as never },
      create: { id: 'referral-window', enabled: true, payload: { window: 45 } as never },
    });
    const cfg = await referralConfig({ fresh: true });
    assert.equal(cfg.windowDays, 45, '窗口应读到新值');
    assert.deepEqual(cfg.rewardInviter, { kind: 'credits', amount: 5 }, '奖励配置不得被改窗口抹掉');
  } finally {
    await prisma.featureFlag.delete({ where: { id: 'referral' } }).catch(() => {});
    await prisma.featureFlag.delete({ where: { id: 'referral-window' } }).catch(() => {});
  }
});

test('配置键搬迁的存量兼容：只有旧键 referral.window 时也要生效，不得静默回落默认', async () => {
  // 窗口原本与奖励键同住 `referral` payload，当初为躲「整块覆盖写」搬到 `referral-window`。
  // 若升级后只读新键，运营早先设的 7 天会静默变成默认 30 天——20 天前的码就从「过期」
  // 变成建立一条不可变更的关系，事后改不回来。这条用例钉住回退。
  await prisma.featureFlag.upsert({
    where: { id: 'referral' },
    update: { payload: { window: 7 } as never },
    create: { id: 'referral', enabled: true, payload: { window: 7 } as never },
  });
  try {
    assert.equal((await referralConfig({ fresh: true })).windowDays, 7, '只有旧键时必须按旧值生效');
    // 新键一旦设置就以新键为准（搬迁完成后旧值不再干扰）
    await prisma.featureFlag.upsert({
      where: { id: 'referral-window' },
      update: { payload: { window: 21 } as never },
      create: { id: 'referral-window', enabled: true, payload: { window: 21 } as never },
    });
    assert.equal((await referralConfig({ fresh: true })).windowDays, 21, '新键优先');
  } finally {
    await prisma.featureFlag.delete({ where: { id: 'referral' } }).catch(() => {});
    await prisma.featureFlag.delete({ where: { id: 'referral-window' } }).catch(() => {});
  }
});
