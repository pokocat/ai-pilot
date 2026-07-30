// 年度谶语 · 周期陪伴测试（谶不是挂一年的一句话，是军师全年把真实事件对到谶上的一条线）：
// 换谶归档（旧谶连点谶一起进 verseHistory）· 点谶（严判 / 当日同来源去重 / 上限 / 各短路条件）·
// 注入块的周期上下文与半验提示 · 岁验预言幂等 · GET /profile/strategic 下发新字段。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, login, uniquePhone, deliverable } from './helpers.ts';
import { prisma } from '../src/db.ts';
import {
  upsertStrategicProfile, loadStrategicProfile, strategicBlock, maybeMarkVerseMoment,
  verseEventFromDeliverable,
  type VerseJudge, type VerseJudgement,
} from '../src/services/strategicProfile.ts';
import { setFeatureFlag } from '../src/services/featureFlag.ts';
import { runWithNow, yearOf } from '../src/services/clock.ts';

before(async () => {
  await getApp();
  await cleanBusiness();
  await seedBaseline();
  await setFeatureFlag('fortune', true); // 谶语属命理内容，整条链路以命理开关为总闸
});

after(async () => {
  await closeApp();
});

const Y = yearOf();
/** 冻结到某个上海日历日（UTC 04:00 = 上海 12:00，避免跨日抖动）。 */
const day = (month: number, d: number, year = Y) => new Date(Date.UTC(year, month - 1, d, 4, 0, 0));
const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * 确定性判官（测试注入）：测试环境 liveProvider 恒为 null → 真实 llmJson 只会返回 null，
 * 命中路径无从验证；同时 calls() 用来断言「该短路的场景一次模型都不调」。
 */
function judgeStub(result: VerseJudgement | null) {
  let calls = 0;
  const judge: VerseJudge = async () => { calls += 1; return result; };
  return { judge, calls: () => calls };
}

interface VerseExtraShape {
  verse?: string;
  verseYear?: number;
  verseSource?: string;
  verseAt?: string;
  verseMoments?: { at: string; clause: number; note: string; src?: string }[];
  verseHistory?: { verse: string; verseYear: number | null; verseSource: string; moments: { at: string; note: string }[] }[];
}
const extraOf = async (userId: string): Promise<VerseExtraShape> =>
  ((await prisma.strategicProfile.findUniqueOrThrow({ where: { userId } })).extraJson ?? {}) as VerseExtraShape;

/** 建号 + 在指定时刻盖一句谶（默认算法谶 auto）。 */
async function verseUser(name: string, verse: string, when = day(3, 1), verseSource?: 'auto' | 'llm' | 'manual') {
  const token = await login(uniquePhone(), name);
  const user = await prisma.user.findFirstOrThrow({ where: { id: token } });
  const base = { tenantId: user.tenantId, userId: user.id };
  await runWithNow(when, () => upsertStrategicProfile({ ...base, patch: { verse }, verseSource }));
  return { token, user, base };
}

// —— ① 换谶归档 ——

test('换谶归档：同年 auto→llm 升级 / manual 改谶 / 跨年换谶，三条路都把旧谶推进 verseHistory 并清空点谶', async () => {
  const { user, base } = await verseUser('谶语归档用户', '利刃藏锋不轻鸣，今岁南风助势成', day(1, 20));
  const first = await extraOf(user.id);
  assert.equal(first.verseAt?.slice(0, 10), `${Y}-01-20`, '盖章即记获谶时刻');
  assert.deepEqual(first.verseMoments ?? [], []);
  assert.equal(first.verseHistory, undefined, '首谶无旧谶可归档');

  // 先点一次谶（它属于第一句谶）
  const h1 = judgeStub({ hit: true, clause: 1, note: '第一个大客户落地，藏锋这半句应了' });
  await runWithNow(day(2, 10), () => maybeMarkVerseMoment({ ...base, source: 'accept', eventText: '拿下年度第一个大客户', judge: h1.judge }));
  assert.equal((await extraOf(user.id)).verseMoments?.length, 1);

  // ① 同年 auto→llm 升级
  await runWithNow(day(3, 5), () => upsertStrategicProfile({ ...base, patch: { verse: '蛰龙勿用待秋风，一朝破壁万山红' }, verseSource: 'llm' }));
  const afterUpgrade = await extraOf(user.id);
  assert.equal(afterUpgrade.verse, '蛰龙勿用待秋风，一朝破壁万山红');
  assert.equal(afterUpgrade.verseAt?.slice(0, 10), `${Y}-03-05`, '换谶重记获谶时刻（半验从新谶起算）');
  assert.deepEqual(afterUpgrade.verseMoments, [], '点谶属于那一句谶，换谶即清空');
  assert.deepEqual(afterUpgrade.verseHistory?.map((h) => h.verse), ['利刃藏锋不轻鸣，今岁南风助势成']);
  assert.equal(afterUpgrade.verseHistory?.[0].verseSource, 'auto');
  assert.equal(afterUpgrade.verseHistory?.[0].moments.length, 1, '旧谶的点谶随它一起归档，不丢账');

  // ② manual 改谶（老板最终解释权）
  await runWithNow(day(4, 1), () => upsertStrategicProfile({ ...base, patch: { verse: '我自己的谶：一意孤行' }, verseSource: 'manual' }));
  const afterManual = await extraOf(user.id);
  assert.equal(afterManual.verse, '我自己的谶：一意孤行');
  assert.deepEqual(afterManual.verseHistory?.map((h) => h.verse), [
    '利刃藏锋不轻鸣，今岁南风助势成', '蛰龙勿用待秋风，一朝破壁万山红',
  ]);

  // ③ 跨年 auto 兜底谶落库 → 旧谶必须先归档（岁验要对的是「去年那句」）
  await runWithNow(day(2, 1, Y + 1), () => upsertStrategicProfile({ ...base, patch: { verse: '新岁算法谶：风起青萍' } }));
  const rolled = await extraOf(user.id);
  assert.equal(rolled.verse, '新岁算法谶：风起青萍');
  assert.equal(rolled.verseYear, Y + 1);
  assert.deepEqual(rolled.verseHistory?.map((h) => h.verse).slice(-1), ['我自己的谶：一意孤行']);
  assert.equal(rolled.verseHistory?.slice(-1)[0].verseYear, Y, '归档保留旧谶的谶年');

  // 同句同年重复盖章不算换谶：不归档、不清点谶、不改获谶时刻
  const h2 = judgeStub({ hit: true, clause: 2, note: '风真起来了' });
  await runWithNow(day(3, 3, Y + 1), () => maybeMarkVerseMoment({ ...base, source: 'review', eventText: '本月复购翻倍', judge: h2.judge }));
  const before = await extraOf(user.id);
  await runWithNow(day(4, 4, Y + 1), () => upsertStrategicProfile({ ...base, patch: { verse: '新岁算法谶：风起青萍' }, verseSource: 'manual' }));
  const same = await extraOf(user.id);
  assert.equal(same.verseAt, before.verseAt, '同句同年重新盖章不该重记获谶时刻');
  assert.equal(same.verseMoments?.length, 1, '同句同年重新盖章不该清掉点谶');
  assert.equal(same.verseHistory?.length, before.verseHistory?.length, '同句同年不产生归档');
});

test('归档上限 10：连换 12 句只留最近 10 条，最旧的被丢', async () => {
  const { user, base } = await verseUser('谶语归档上限用户', '第 0 句谶：起手', day(1, 5));
  for (let i = 1; i <= 12; i++) {
    await runWithNow(day(1, 5 + i), () => upsertStrategicProfile({ ...base, patch: { verse: `第 ${i} 句谶：改弦` }, verseSource: 'manual' }));
  }
  const extra = await extraOf(user.id);
  assert.equal(extra.verse, '第 12 句谶：改弦');
  assert.equal(extra.verseHistory?.length, 10);
  assert.equal(extra.verseHistory?.[0].verse, '第 2 句谶：改弦', '超出上限丢最旧（第 0/1 句已滚出）');
});

// —— ② 点谶 ——

test('点谶：判官命中才落一条（clause/note 落库，note 截 40 字）；不命中什么也不发生', async () => {
  const { user, base } = await verseUser('点谶用户', '守得寒冬三尺雪，春来百业自峥嵘', day(2, 2));

  const miss = judgeStub({ hit: false, clause: 1, note: '牵强' });
  const r0 = await runWithNow(day(2, 20), () => maybeMarkVerseMoment({ ...base, source: 'accept', eventText: '今天开了个会', judge: miss.judge }));
  assert.equal(r0, null, '不命中不返回点谶');
  assert.equal(miss.calls(), 1, '有当年谶就该判一次');
  assert.deepEqual((await extraOf(user.id)).verseMoments, [], '不命中不落库');

  const long = '春' + '真'.repeat(60);
  const hit = judgeStub({ hit: true, clause: 2, note: long });
  const r1 = await runWithNow(day(3, 8), () => maybeMarkVerseMoment({ ...base, source: 'accept', eventText: '春节后老客户集体回头，营收回正', judge: hit.judge }));
  assert.equal(r1?.clause, 2);
  assert.equal(r1?.at, `${Y}-03-08`);
  assert.equal(r1?.note.length, 40, 'note 截到 40 字');
  const moments = (await extraOf(user.id)).verseMoments!;
  assert.equal(moments.length, 1);
  assert.equal(moments[0].src, 'accept', '来源只存不下发（去重要按来源判）');
  // 下发形状不带内部去重键
  const view = await loadStrategicProfile(user.id);
  assert.deepEqual(Object.keys(view!.verseMoments![0]).sort(), ['at', 'clause', 'note']);
});

test('点谶去重：当日同来源只点一次（不调模型），不同来源当日仍可点', async () => {
  const { user, base } = await verseUser('点谶去重用户', '莫问前路多荆棘，七杀逢冲即是金', day(2, 2));
  const first = judgeStub({ hit: true, clause: 1, note: '认可方案当天就见效' });
  await runWithNow(day(4, 10), () => maybeMarkVerseMoment({ ...base, source: 'accept', eventText: '认可了增长方案', judge: first.judge }));

  const again = judgeStub({ hit: true, clause: 1, note: '同一天又来一次' });
  const dup = await runWithNow(day(4, 10), () => maybeMarkVerseMoment({ ...base, source: 'accept', eventText: '又认可了一份方案', judge: again.judge }));
  assert.equal(dup, null);
  assert.equal(again.calls(), 0, '当日同来源已点过 → 连模型都不调');

  const other = judgeStub({ hit: true, clause: 2, note: '复盘对上了后半句' });
  const ok = await runWithNow(day(4, 10), () => maybeMarkVerseMoment({ ...base, source: 'review', eventText: '今日复盘：三条军令全完成', judge: other.judge }));
  assert.equal(ok?.clause, 2, '同一天换来源仍可点（复盘与认可是两件事）');
  assert.equal((await extraOf(user.id)).verseMoments?.length, 2);
});

test('点谶上限：全年 12 条封顶，满了直接短路不调模型', async () => {
  const { user, base } = await verseUser('点谶上限用户', '利刃藏锋不轻鸣，今岁南风助势成', day(1, 3));
  const extra = await extraOf(user.id);
  await prisma.strategicProfile.update({
    where: { userId: user.id },
    data: {
      extraJson: {
        ...extra,
        verseMoments: Array.from({ length: 12 }, (_, i) => ({ at: `${Y}-05-${pad2(i + 1)}`, clause: 1, note: `第 ${i + 1} 次点谶`, src: 'accept' })),
      } as object,
    },
  });
  const stub = judgeStub({ hit: true, clause: 2, note: '第 13 次' });
  assert.equal(await runWithNow(day(6, 1), () => maybeMarkVerseMoment({ ...base, source: 'review', eventText: '又发生了一件大事', judge: stub.judge })), null);
  assert.equal(stub.calls(), 0);
  assert.equal((await extraOf(user.id)).verseMoments?.length, 12);
});

test('点谶短路：无谶 / 跨年旧谶 / 命理开关关 / 空事件文本，一律不调模型', async () => {
  // 无谶用户（连档案行都没有）
  const bare = await login(uniquePhone(), '无谶点谶用户');
  const bareUser = await prisma.user.findFirstOrThrow({ where: { id: bare } });
  const s0 = judgeStub({ hit: true, clause: 1, note: '不该被调用' });
  assert.equal(await maybeMarkVerseMoment({ tenantId: bareUser.tenantId, userId: bareUser.id, source: 'accept', eventText: '认可了方案', judge: s0.judge }), null);
  assert.equal(s0.calls(), 0);

  // 有谶但是去年那句（跨年还没换谶）→ 不点（那些点谶属于去年）
  const { base } = await verseUser('跨年点谶用户', '去年那句谶：静水流深', day(6, 1, Y - 1));
  const s1 = judgeStub({ hit: true, clause: 1, note: '不该被调用' });
  assert.equal(await runWithNow(day(6, 1), () => maybeMarkVerseMoment({ ...base, source: 'review', eventText: '今日复盘：全部完成', judge: s1.judge })), null);
  assert.equal(s1.calls(), 0);

  // 命理开关关闭 → 整条谶语链路静默
  const { base: onBase } = await verseUser('命理关点谶用户', '守得寒冬三尺雪，春来百业自峥嵘', day(2, 2));
  const s2 = judgeStub({ hit: true, clause: 1, note: '不该被调用' });
  await setFeatureFlag('fortune', false);
  try {
    assert.equal(await runWithNow(day(5, 5), () => maybeMarkVerseMoment({ ...onBase, source: 'accept', eventText: '认可了方案', judge: s2.judge })), null);
    assert.equal(s2.calls(), 0);
  } finally {
    await setFeatureFlag('fortune', true);
  }

  // 空事件文本
  const s3 = judgeStub({ hit: true, clause: 1, note: '不该被调用' });
  assert.equal(await runWithNow(day(5, 6), () => maybeMarkVerseMoment({ ...onBase, source: 'accept', eventText: '   ', judge: s3.judge })), null);
  assert.equal(s3.calls(), 0);
});

test('点谶 fire-safe：无真实 provider（测试/mock）时走真实 llmJson → 不点谶、不抛错', async () => {
  const { user, base } = await verseUser('点谶兜底用户', '蛰龙勿用待秋风，一朝破壁万山红', day(2, 2));
  const r = await runWithNow(day(5, 20), () => maybeMarkVerseMoment({ ...base, source: 'review', eventText: '本月成交翻了一倍' }));
  assert.equal(r, null, 'llmJson 返回 null → 宁缺毋滥');
  assert.deepEqual((await extraOf(user.id)).verseMoments, []);
});

test('认可成果 → 点谶事件文本含标题与分节正文（判定素材来自真实成果，不是空壳）', () => {
  const text = verseEventFromDeliverable(deliverable('增长破局方案', [
    { h: '主要矛盾', b: '信任证明断在转化前。' },
    { h: '30 天行动清单', list: ['重做案例证明', '只投 3 个主题'] },
  ]));
  assert.match(text, /增长破局方案/);
  assert.match(text, /信任证明断在转化前/);
  assert.match(text, /重做案例证明；只投 3 个主题/);
});

test('认可方案端到端：/casefile/accept 不因点谶变慢或报错（无真实 provider → 无点谶）', async () => {
  const token = await login(uniquePhone(), '认可点谶用户');
  await api('PUT', '/api/profile/strategic', { token, body: { verse: '守得客心三尺暖，何愁门前客不还' } });
  const r = await api('POST', '/api/casefile/accept', {
    token,
    body: { deliverable: deliverable('增长破局方案', [{ h: '主要矛盾', b: '信任证明断在转化前。' }]), agentName: '总军师' },
  });
  assert.equal(r.status, 200);
  const strategic = (await api('GET', '/api/profile/strategic', { token })).body.strategic;
  assert.deepEqual(strategic.verseMoments, [], '测试环境判不出命中 → 不落点谶（也不报错）');
});

test('复盘与预言应验也挂点谶：两条链路都不报错，无真实 provider 时不落点谶', async () => {
  const token = await login(uniquePhone(), '复盘点谶用户');
  await api('PUT', '/api/profile/strategic', { token, body: { verse: '守得寒冬三尺雪，春来百业自峥嵘' } });
  await api('POST', '/api/casefile/accept', {
    token,
    body: { deliverable: deliverable('增长破局方案', [{ h: '30 天行动清单', list: ['重做案例证明'] }]), agentName: '总军师' },
  });

  // 复盘：recordReview 组装事件文本（已完成军令 + 回填数字 + 老板自述）后交给点谶——组装本身在热路径上，一炸就是 500
  const rev = await api('POST', '/api/casefile/review', { token, body: { layer: 'day', note: '老客户这个月集体回头了' } });
  assert.equal(rev.status, 200);

  // 预言应验（hit）：最硬的「事实对上了」
  const p = await api('POST', '/api/prophecies', { token, body: { prophecy: '三个月内复购率回升' } });
  const v = await api('POST', `/api/prophecies/${p.body.prophecy.id}/verify`, { token, body: { outcome: 'hit', note: '复购确实回到六成' } });
  assert.equal(v.status, 200);

  assert.deepEqual((await api('GET', '/api/profile/strategic', { token })).body.strategic.verseMoments, [], '测试环境判不出命中 → 不落点谶');
});

// —— ③ 注入块（周期上下文 + 半验） ——

test('注入块：谶语行带获谶月份 + 已点谶次数 + 最近一次点谶，并给出点谶行为指引', async () => {
  const { user, base } = await verseUser('注入点谶用户', '守得寒冬三尺雪，春来百业自峥嵘', day(3, 12));
  const h1 = judgeStub({ hit: true, clause: 1, note: '寒冬里守住了老客' });
  await runWithNow(day(4, 2), () => maybeMarkVerseMoment({ ...base, source: 'accept', eventText: '老客户续约', judge: h1.judge }));
  const h2 = judgeStub({ hit: true, clause: 2, note: '五月复购回正，春来了' });
  await runWithNow(day(5, 6), () => maybeMarkVerseMoment({ ...base, source: 'review', eventText: '五月复购回正', judge: h2.judge }));

  const loaded = await loadStrategicProfile(user.id);
  const line = runWithNow(day(5, 20), () => strategicBlock(loaded))!;
  assert.match(line, /年度谶语：「守得寒冬三尺雪，春来百业自峥嵘」（3月获谶，全年沿用这一句，不要另造）/);
  assert.match(line, /已点谶 2 次；最近一次 5月：五月复购回正，春来了/);
  assert.match(line, /点谶：.*真切相应.*一次对话至多一次/);
  assert.doesNotMatch(line, /半验/, '当年已点到后半句 → 不再提半验');
});

test('注入块半验：获谶满六个月且当年还没点到后半句 → 追加半验提示；未满六个月不提', async () => {
  const { user, base } = await verseUser('半验用户', '蛰龙勿用待秋风，一朝破壁万山红', day(1, 10));
  const h = judgeStub({ hit: true, clause: 1, note: '上半年确实在蓄力' });
  await runWithNow(day(3, 1), () => maybeMarkVerseMoment({ ...base, source: 'review', eventText: '一季度复盘：在打基础', judge: h.judge }));
  const loaded = await loadStrategicProfile(user.id);

  const early = runWithNow(day(6, 30), () => strategicBlock(loaded))!;
  assert.doesNotMatch(early, /半验/, '获谶未满六个月不提半验');

  const halfway = runWithNow(day(7, 20), () => strategicBlock(loaded))!;
  assert.match(halfway, /半验（获谶已过半年，后半句尚无着落）/);
  assert.match(halfway, /谶语过半，前半句已有眉目/);
});

test('注入块兼容：无点谶时谶语行仍是旧口径（含「全年沿用」约束），只多一句点谶指引', async () => {
  const { user } = await verseUser('无点谶注入用户', '莫问前路多荆棘，七杀逢冲即是金', day(4, 9));
  const loaded = await loadStrategicProfile(user.id);
  const line = runWithNow(day(5, 9), () => strategicBlock(loaded))!;
  assert.match(line, /年度谶语：「莫问前路多荆棘，七杀逢冲即是金」/, '旧断言口径不变');
  assert.match(line, /全年沿用这一句，不要另造/);
  assert.doesNotMatch(line, /已点谶/, '没点过就不报次数');
  assert.doesNotMatch(line, /半验/);
  assert.match(line, /对不上不硬圆，平时不提/);

  // 跨年还没换谶：只报句子，不把去年的陪伴上下文当今年的账
  const stale = runWithNow(day(2, 1, Y + 1), () => strategicBlock(loaded))!;
  assert.match(stale, /年度谶语：「莫问前路多荆棘，七杀逢冲即是金」/);
  assert.doesNotMatch(stale, /点谶/);
});

// —— ④ 岁验锚点（omen 登记） ——

test('岁验幂等：首谶登记一条、同年升级换句只更新同一条、跨年新谶再登记一条', async () => {
  const { user, base } = await verseUser('岁验用户', '利刃藏锋不轻鸣，今岁南风助势成', day(3, 1));
  const rows = () => prisma.prophecyLog.findMany({ where: { userId: user.id }, orderBy: { seq: 'asc' } });

  const first = await rows();
  assert.equal(first.length, 1, '谶语盖章 → 登记一条岁验预言');
  assert.equal(first[0].prophecy, '利刃藏锋不轻鸣，今岁南风助势成', '预言内容 = 谶语本句');
  assert.equal(first[0].basis, `年度谶语·岁验·${Y}`, '无 kind 字段 → basis 承载岁验语义并兼作幂等键');
  assert.equal(first[0].dueDate, `${Y + 1}-02-04`, '3 月获谶 → 到期日取次年立春（早于获谶周年）');
  assert.equal(first[0].status, 'pending');

  // 同年升级换句 → 更新同一条，不新增
  await runWithNow(day(5, 6), () => upsertStrategicProfile({ ...base, patch: { verse: '蛰龙勿用待秋风，一朝破壁万山红' }, verseSource: 'llm' }));
  const upgraded = await rows();
  assert.equal(upgraded.length, 1, '同一谶年至多一条岁验');
  assert.equal(upgraded[0].id, first[0].id);
  assert.equal(upgraded[0].prophecy, '蛰龙勿用待秋风，一朝破壁万山红', '换句更新同一条的文本');

  // 跨年新谶 → 另一条（岁验要对的是那一年那句）
  await runWithNow(day(2, 10, Y + 1), () => upsertStrategicProfile({ ...base, patch: { verse: '新岁谶：风起青萍' } }));
  const rolled = await rows();
  assert.equal(rolled.length, 2);
  assert.equal(rolled[1].basis, `年度谶语·岁验·${Y + 1}`);
  assert.equal(rolled[1].dueDate, `${Y + 2}-02-04`);
});

test('岁验到期日：立春前获谶时取「获谶周年」（谁先到算谁）；命理开关关闭不登记', async () => {
  const { user } = await verseUser('岁验立春用户', '守得寒冬三尺雪，春来百业自峥嵘', day(1, 20));
  const row = await prisma.prophecyLog.findFirstOrThrow({ where: { userId: user.id } });
  assert.equal(row.dueDate, `${Y + 1}-01-20`, '1 月 20 日获谶 → 周年早于次年立春');

  await setFeatureFlag('fortune', false);
  try {
    const { user: off } = await verseUser('岁验命理关用户', '莫问前路多荆棘，七杀逢冲即是金', day(3, 3));
    assert.equal(await prisma.prophecyLog.count({ where: { userId: off.id } }), 0, '命理下线不产生天机账本条目');
  } finally {
    await setFeatureFlag('fortune', true);
  }
});

// —— ⑤ 下发新字段 ——

test('GET /profile/strategic 随档案下发 verseAt / verseMoments', async () => {
  const token = await login(uniquePhone(), '下发点谶用户');
  const user = await prisma.user.findFirstOrThrow({ where: { id: token } });
  await api('PUT', '/api/profile/strategic', { token, body: { verse: '守得客心三尺暖，何愁门前客不还' } });

  const before = (await api('GET', '/api/profile/strategic', { token })).body.strategic;
  assert.ok(before.verseAt, '盖章即下发获谶时刻');
  assert.deepEqual(before.verseMoments, []);

  const h = judgeStub({ hit: true, clause: 1, note: '老客回头，客心真守住了' });
  await maybeMarkVerseMoment({ tenantId: user.tenantId, userId: user.id, source: 'review', eventText: '本月复购六成', judge: h.judge });
  const after = (await api('GET', '/api/profile/strategic', { token })).body.strategic;
  assert.equal(after.verseMoments.length, 1);
  assert.equal(after.verseMoments[0].clause, 1);
  assert.equal(after.verseMoments[0].note, '老客回头，客心真守住了');
  assert.match(after.verseMoments[0].at, /^\d{4}-\d{2}-\d{2}$/);
});
