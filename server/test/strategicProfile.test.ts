// 战略档案（M1 PR-3 统一状态层）测试：提取规则、认可回写、注入优先级、手动校准、隔离、旧城市经度兼容表。
// 另含年度谶语 #16 M1：verseYear 盖章 / 一年一句守卫 / 报告封面兜底。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, login, uniquePhone, deliverable } from './helpers.ts';
import { prisma } from '../src/db.ts';
import { extractStrategicFacts, strategicBlock, upsertStrategicProfile, loadStrategicProfile } from '../src/services/strategicProfile.ts';
import { composeAnnualVerse } from '../src/services/mingpan.ts';
import { computeChart, type PaipanInput } from '../src/services/paipan.ts';
import { setFeatureFlag } from '../src/services/featureFlag.ts';
import { buildGenContext } from '../src/services/context.ts';
import { buildSystemParts } from '../src/llm/schema.ts';
import { cityLongitude } from '../src/data/cityLongitude.ts';
import { yearOf, runWithNow } from '../src/services/clock.ts';
import { reportHtmlIdFromUrl } from '../src/services/reportHtml.ts';

before(async () => {
  await getApp();
  await cleanBusiness();
  await seedBaseline();
});

after(async () => {
  await closeApp();
});

const PLAN = deliverable('增长破局方案', [
  { h: '主要矛盾', b: '不是缺流量，是信任证明断在转化前。\n其余分析略。' },
  { h: '战略定位', b: '高净值老板的私域信任顾问' },
  { h: '聚焦赛道', list: ['美业老板增长陪跑'] },
  { h: '30 天行动清单', list: ['重做案例证明', '只投 3 个主题'] },
]);

test('提取规则：按分节标题取 主要矛盾/定位/赛道，只取首行、没有的不编', () => {
  const facts = extractStrategicFacts(PLAN);
  assert.equal(facts.mainContradiction, '不是缺流量，是信任证明断在转化前。');
  assert.equal(facts.positioning, '高净值老板的私域信任顾问');
  assert.equal(facts.track, '美业老板增长陪跑');
  assert.equal(facts.stage, undefined, '方案里没有阶段分节就不写');
  // 与战略无关的成果 → 空提取
  assert.deepEqual(extractStrategicFacts(deliverable('周报', [{ h: '本周动作', list: ['发视频'] }])), {});
});

test('认可方案 → 战略档案自动回写；再次认可只覆盖出现的字段', async () => {
  const token = await login(uniquePhone(), '档案用户');
  await api('POST', '/api/casefile/accept', { token, body: { deliverable: PLAN, agentName: '军师' } });

  const r = await api('GET', '/api/profile/strategic', { token });
  assert.equal(r.body.strategic.mainContradiction, '不是缺流量，是信任证明断在转化前。');
  assert.equal(r.body.strategic.positioning, '高净值老板的私域信任顾问');

  // 第二次认可：只带主要矛盾 → 定位保留
  const NEXT = deliverable('修补 v2', [{ h: '核心问题', b: '案例证明未结构化。' }]);
  await api('POST', '/api/casefile/accept', { token, body: { deliverable: NEXT, agentName: '军师' } });
  const r2 = await api('GET', '/api/profile/strategic', { token });
  assert.equal(r2.body.strategic.mainContradiction, '案例证明未结构化。');
  assert.equal(r2.body.strategic.positioning, '高净值老板的私域信任顾问', '未出现的字段不被清空');
});

test('注入：战略档案块出现在 dynamic 段且先于客户档案；空档案不注入', async () => {
  const token = await login(uniquePhone(), '注入档案用户');
  const user = await prisma.user.findFirstOrThrow({ where: { id: token } });
  await api('POST', '/api/casefile/accept', { token, body: { deliverable: PLAN, agentName: '军师' } });

  const { ctx } = await buildGenContext({ userId: user.id, tenantId: user.tenantId, agentKey: 'general', userMessage: '下一步怎么打' });
  const { dynamic } = buildSystemParts(ctx.systemPrompt, ctx, 'chat');
  assert.match(dynamic, /【战略档案（客户已确认的战略事实/);
  assert.match(dynamic, /信任证明断在转化前/);
  assert.ok(dynamic.indexOf('【战略档案') < dynamic.indexOf('【客户档案'), '已确认事实先于推断档案');

  // 空档案用户不注入
  const t2 = await login(uniquePhone(), '空档案用户');
  const u2 = await prisma.user.findFirstOrThrow({ where: { id: t2 } });
  const { ctx: ctx2 } = await buildGenContext({ userId: u2.id, tenantId: u2.tenantId, agentKey: 'general', userMessage: '你好' });
  assert.equal(ctx2.strategicLine ?? null, null);
});

test('手动校准：PUT /profile/strategic 局部更新；跨用户隔离', async () => {
  const token = await login(uniquePhone(), '校准用户');
  await api('PUT', '/api/profile/strategic', { token, body: { mainContradiction: '现金流吃紧', stage: '起步期' } });
  const r = await api('GET', '/api/profile/strategic', { token });
  assert.equal(r.body.strategic.mainContradiction, '现金流吃紧');
  assert.equal(r.body.strategic.stage, '起步期');
  assert.equal(r.body.strategic.positioning, '');

  const other = await login(uniquePhone(), '别人');
  const r2 = await api('GET', '/api/profile/strategic', { token: other });
  assert.equal(r2.body.strategic, null);
});

test('strategicBlock：空/无内容返回 null，不产生空块', () => {
  assert.equal(strategicBlock(null), null);
  assert.equal(strategicBlock({ mainContradiction: '', positioning: '', track: '', stage: '', updatedAt: null }), null);
});

// —— 年度谶语（#16 M1）——
// 出谶锚定命例（与 paipan/mingpanReport 测试同一生辰）：公历 1988-03-15 10:30 男。
const VERSE_BIRTH: PaipanInput = { calendar: 'solar', year: 1988, month: 3, day: 15, hour: 10, minute: 30, gender: 'male' };

test('谶语盖章：写入即记当年，GET /profile/strategic 随档案下发 verseYear', async () => {
  const token = await login(uniquePhone(), '谶语用户');
  const r0 = await api('GET', '/api/profile/strategic', { token });
  assert.equal(r0.body.strategic, null, '未建档时无谶语');

  await api('PUT', '/api/profile/strategic', { token, body: { verse: '春水东流三尺浪，秋来始见岸边舟' } });
  const r = await api('GET', '/api/profile/strategic', { token });
  assert.equal(r.body.strategic.verse, '春水东流三尺浪，秋来始见岸边舟');
  assert.equal(r.body.strategic.verseYear, yearOf(), '盖当年');

  // 只改别的字段不动谶语的年份
  await api('PUT', '/api/profile/strategic', { token, body: { positioning: '私域信任顾问' } });
  const r2 = await api('GET', '/api/profile/strategic', { token });
  assert.equal(r2.body.strategic.verse, '春水东流三尺浪，秋来始见岸边舟');
  assert.equal(r2.body.strategic.verseYear, yearOf());
});

test('一年一句：同年抽取被忽略、跨年抽取才换、PUT 改谶强制覆盖', async () => {
  const token = await login(uniquePhone(), '一年一句用户');
  const user = await prisma.user.findFirstOrThrow({ where: { id: token } });
  const base = { tenantId: user.tenantId, userId: user.id };
  const thisYear = yearOf();

  // 首谶：从未有谶 → 抽取管线可以立档
  await upsertStrategicProfile({ ...base, patch: { verse: '初谶：龙潜于渊，待时而动' } });
  assert.equal((await loadStrategicProfile(user.id))!.verse, '初谶：龙潜于渊，待时而动');

  // ① 同年再抽到新谶 → 忽略，其它字段照常合并
  await upsertStrategicProfile({ ...base, patch: { verse: '改谶：虎啸山林', mainContradiction: '现金流吃紧' } });
  const same = (await loadStrategicProfile(user.id))!;
  assert.equal(same.verse, '初谶：龙潜于渊，待时而动', '当年已有谶，抽取管线不得换');
  assert.equal(same.verseYear, thisYear);
  assert.equal(same.mainContradiction, '现金流吃紧', '谶语被拦不影响其它字段合并');

  // ② 跨年再抽 → 接受并盖新年份
  const nextYear = thisYear + 1;
  await runWithNow(new Date(Date.UTC(nextYear, 4, 1)), () =>
    upsertStrategicProfile({ ...base, patch: { verse: '新岁谶：风起于青萍之末' } }));
  const rolled = (await loadStrategicProfile(user.id))!;
  assert.equal(rolled.verse, '新岁谶：风起于青萍之末', '跨年该换新谶');
  assert.equal(rolled.verseYear, nextYear);

  // ③ PUT 显式改谶 → 同年也能覆盖并重新盖章
  await runWithNow(new Date(Date.UTC(nextYear, 5, 1)), () =>
    upsertStrategicProfile({ ...base, patch: { verse: '废旧立新：改弦更张' }, verseSource: 'manual' }));
  const forced = (await loadStrategicProfile(user.id))!;
  assert.equal(forced.verse, '废旧立新：改弦更张', '手动改谶不受守卫拦');
  assert.equal(forced.verseYear, nextYear);

  // PUT 路由本身就是显式改谶（走当前真实年份）
  await api('PUT', '/api/profile/strategic', { token, body: { verse: '路由改谶：另起一局' } });
  const viaRoute = (await loadStrategicProfile(user.id))!;
  assert.equal(viaRoute.verse, '路由改谶：另起一局');
  assert.equal(viaRoute.verseYear, thisYear, 'PUT 重新盖当前年');
});

test('谶语捕获：认「谶语」分节与封面 motto，形状不对（语录/散文）不收', () => {
  // ① 谶语分节优先（带「年度谶语：」前缀与引号都要剥掉，句末句号去掉，半角逗号归一）
  assert.equal(
    extractStrategicFacts(deliverable('交底全案', [
      { h: '年度谶语', b: '年度谶语：「蛰龙勿用待秋风,一朝破壁万山红。」\n（记住这句话，年底回头看。）' },
      { h: '主要矛盾', b: '信任证明断在转化前。' },
    ])).verse,
    '蛰龙勿用待秋风，一朝破壁万山红',
  );
  // ② 无谶语分节 → 退到封面 motto（§4.4 谶语落在 A 级报告封面）
  assert.equal(
    extractStrategicFacts({ ...deliverable('战略全案', [{ h: '主要矛盾', b: '现金流吃紧。' }]), cover: { title: '战略全案', motto: '守得寒冬三尺雪，春来百业自峥嵘' } }).verse,
    '守得寒冬三尺雪，春来百业自峥嵘',
  );
  // ③ 形状闸门：封面 motto 也可能是毛选语录/散文/五七不齐，一律不当谶收（收下就锁一整年）
  for (const motto of ['一切反动派都是纸老虎', '不打无准备之仗，不打无把握之仗，这是我们的原则', '藏锋，今岁南风助势成', 'Hold the line, wait for spring']) {
    assert.equal(extractStrategicFacts({ ...deliverable('战略全案', []), cover: { title: 'x', motto } }).verse, undefined, `不该把「${motto}」当谶`);
  }
  // ④ 抽不到谶不留 undefined 键（patch 键集要干净，否则会把库里的谶清空）
  assert.deepEqual(extractStrategicFacts(deliverable('周报', [{ h: '本周动作', list: ['发视频'] }])), {});
  // ⑤ 五言同样收（§4.4：七言或五言）
  assert.equal(
    extractStrategicFacts({ ...deliverable('全案', []), cover: { title: 'x', motto: '「潜龙宜守拙，春至自成龙」' } }).verse,
    '潜龙宜守拙，春至自成龙',
  );
});

test('谶语优先级：算法谶可被模型谶升级一次，模型谶同年不再换，老板手改压全场', async () => {
  const token = await login(uniquePhone(), '谶语优先级用户');
  const user = await prisma.user.findFirstOrThrow({ where: { id: token } });
  const base = { tenantId: user.tenantId, userId: user.id };
  const sourceOf = async () =>
    ((await prisma.strategicProfile.findUniqueOrThrow({ where: { userId: user.id } })).extraJson as { verseSource?: string }).verseSource;

  // ① 算法兜底谶（老板首访老板页）
  await upsertStrategicProfile({ ...base, patch: { verse: '利刃藏锋不轻鸣，今岁南风助势成' } });
  assert.equal((await loadStrategicProfile(user.id))!.verse, '利刃藏锋不轻鸣，今岁南风助势成');
  assert.equal(await sourceOf(), 'auto');

  // ② 同一句原样回传（如封面兜底那句被认可时带回来）→ 不得把算法谶镀成模型谶、占掉当年升级额度
  await upsertStrategicProfile({ ...base, patch: { verse: '利刃藏锋不轻鸣，今岁南风助势成' }, verseSource: 'llm' });
  assert.equal(await sourceOf(), 'auto', '同句回传不改来源');

  // ③ 模型在交底报告里亲写的谶 → 当年升级算法谶一次（个人化的那句该赢过兜底句）
  await upsertStrategicProfile({ ...base, patch: { verse: '蛰龙勿用待秋风，一朝破壁万山红' }, verseSource: 'llm' });
  assert.equal((await loadStrategicProfile(user.id))!.verse, '蛰龙勿用待秋风，一朝破壁万山红');
  assert.equal(await sourceOf(), 'llm');

  // ④ 同年再抽到别的模型谶 → 不换（一年一句：分量全在不改不换）；算法谶更压不回来
  await upsertStrategicProfile({ ...base, patch: { verse: '守得寒冬三尺雪，春来百业自峥嵘' }, verseSource: 'llm' });
  await upsertStrategicProfile({ ...base, patch: { verse: '算法回压：不该发生' } });
  assert.equal((await loadStrategicProfile(user.id))!.verse, '蛰龙勿用待秋风，一朝破壁万山红');

  // ⑤ 老板手改 → 压得住模型谶；此后模型/算法都不得再动
  await upsertStrategicProfile({ ...base, patch: { verse: '我自己的谶：一意孤行' }, verseSource: 'manual' });
  await upsertStrategicProfile({ ...base, patch: { verse: '莫问前路多荆棘，七杀逢冲即是金' }, verseSource: 'llm' });
  await upsertStrategicProfile({ ...base, patch: { verse: '算法回压：也不该发生' } });
  const locked = (await loadStrategicProfile(user.id))!;
  assert.equal(locked.verse, '我自己的谶：一意孤行', '老板手改的谶当年不可被任何自动路覆盖');
  assert.equal(locked.verseYear, yearOf());

  // ⑥ 跨年 → 重新开局：算法谶先立，模型谶又能升级一次
  const nextYear = yearOf() + 1;
  await runWithNow(new Date(Date.UTC(nextYear, 2, 1)), async () => {
    await upsertStrategicProfile({ ...base, patch: { verse: '新岁算法谶：风起青萍' } });
    assert.equal((await loadStrategicProfile(user.id))!.verse, '新岁算法谶：风起青萍', '跨年算法谶可覆盖去年手改谶');
    await upsertStrategicProfile({ ...base, patch: { verse: '新岁模型谶：一朝破壁' }, verseSource: 'llm' });
    const rolled = (await loadStrategicProfile(user.id))!;
    assert.equal(rolled.verse, '新岁模型谶：一朝破壁', '新一年模型谶仍可升级一次');
    assert.equal(rolled.verseYear, nextYear);
  });
});

test('认可交底报告 → 封面谶语落档案，覆盖算法兜底谶（#16 捕获链路端到端）', async () => {
  await setFeatureFlag('fortune', true);
  const token = await login(uniquePhone(), '交底捕获用户');
  await api('PUT', '/api/profile/bazi', { token, body: VERSE_BIRTH });

  // 首访老板页 → 算法兜底谶（此前唯一的谶来源）
  const auto = (await api('GET', '/api/profile/strategic', { token })).body.strategic.verse;
  assert.equal(auto, composeAnnualVerse(computeChart(VERSE_BIRTH, yearOf()), yearOf()));

  // 认可交底全案（封面带模型亲写的谶）→ 升级为模型谶
  const FINAL = {
    ...deliverable('天势战略全案', [{ h: '主要矛盾', b: '不是缺流量，是信任证明断在转化前。' }]),
    cover: { title: '天势战略全案', motto: '蛰龙勿用待秋风，一朝破壁万山红' },
  };
  const acc = await api('POST', '/api/casefile/accept', { token, body: { deliverable: FINAL, agentName: '总军师' } });
  assert.equal(acc.status, 200);
  const after = (await api('GET', '/api/profile/strategic', { token })).body.strategic;
  assert.equal(after.verse, '蛰龙勿用待秋风，一朝破壁万山红', '模型亲写的谶该赢过算法兜底谶');
  assert.equal(after.verseYear, yearOf());
  assert.equal(after.mainContradiction, '不是缺流量，是信任证明断在转化前。', '其它战略事实照常回写');

  // 同年再认可另一份带谶的报告 → 不换（一年一句）
  await api('POST', '/api/casefile/accept', {
    token,
    body: {
      deliverable: { ...deliverable('复盘全案', [{ h: '30 天行动清单', list: ['重做案例证明'] }]), cover: { title: '复盘全案', motto: '守得寒冬三尺雪，春来百业自峥嵘' } },
      agentName: '总军师',
    },
  });
  assert.equal((await api('GET', '/api/profile/strategic', { token })).body.strategic.verse, '蛰龙勿用待秋风，一朝破壁万山红');
});

test('报告封面兜底：模型没写 motto 时补当年谶语；无谶不出空括号；成果不被回写', async () => {
  const VERSE = '守得客心三尺暖，何愁门前客不还';
  const token = await login(uniquePhone(), '封面谶语用户');
  await api('PUT', '/api/profile/strategic', { token, body: { verse: VERSE } });

  const gen = await api('POST', '/api/generate-sync', { token, body: { text: '帮我做一次战略体检', agentKey: 'strat' } });
  assert.equal(gen.body.kind, 'report');
  const { sessionId, messageId } = gen.body;
  const made = await api('POST', `/api/sessions/${sessionId}/messages/${messageId}/report`, { token });
  assert.equal(made.status, 200);

  const html = (await prisma.reportHtml.findUniqueOrThrow({ where: { id: reportHtmlIdFromUrl(made.body.htmlUrl)! } })).html;
  assert.match(html, new RegExp(`<p class="cover-motto">「${VERSE}」</p>`), '封面出当年谶语');
  assert.equal(html.split(VERSE).length - 1, 1, '只出一次，不叠双重括号');

  // 只补渲染入参：存库成果仍不带 motto，分享/重渲染每次都从档案重新取
  const msg = await prisma.message.findUniqueOrThrow({ where: { id: messageId } });
  assert.equal((msg.contentJson as { cover?: { motto?: string } }).cover?.motto, undefined);

  // 无谶用户：封面不出空「」
  const bare = await login(uniquePhone(), '无谶用户');
  const g2 = await api('POST', '/api/generate-sync', { token: bare, body: { text: '帮我做一次战略体检', agentKey: 'strat' } });
  const m2 = await api('POST', `/api/sessions/${g2.body.sessionId}/messages/${g2.body.messageId}/report`, { token: bare });
  const html2 = (await prisma.reportHtml.findUniqueOrThrow({ where: { id: reportHtmlIdFromUrl(m2.body.htmlUrl)! } })).html;
  assert.doesNotMatch(html2, /<p class="cover-motto">/, '无谶就不出这行（样式表里的同名类不算）');
});

test('出谶纯函数：同盘同年恒同句、逐年换句、七言两句', () => {
  const chart = computeChart(VERSE_BIRTH, 2026);
  const y2026 = composeAnnualVerse(chart, 2026);
  assert.equal(y2026, '利刃藏锋不轻鸣，今岁南风助势成', '锚定命例 2026（丙午）出谶');
  assert.equal(composeAnnualVerse(chart, 2026), y2026, '同盘同年必同句——「一年一句」靠确定性守，不能随机');
  assert.match(y2026, /^.{7}，.{7}$/, '七言两句');
  // 逐年必换（含甲乙/丙丁这类同五行相邻年——阴阳维保证换谶）
  const spread = [2025, 2026, 2027, 2028, 2029, 2030].map((y) => composeAnnualVerse(chart, y));
  assert.equal(new Set(spread).size, spread.length, '连续六年六句不重复');
});

test('有八字 → 老板页读档案即得当年谶语（#16 出谶触发点）；无八字维持求谶空态', async () => {
  await setFeatureFlag('fortune', true);
  const token = await login(uniquePhone(), '求谶用户');

  // 无八字：不凭空造谶（老板页维持「你还没有今年的谶 · 去命盘」引导）
  const r0 = await api('GET', '/api/profile/strategic', { token });
  assert.equal(r0.body.strategic, null, '无命盘不出谶');

  // 录生辰立盘 → 再读档案就该有当年谶语（此前 verse 永无写入方，卡恒空）
  const put = await api('PUT', '/api/profile/bazi', { token, body: VERSE_BIRTH });
  assert.equal(put.status, 200);
  const user = await prisma.user.findFirstOrThrow({ where: { id: token } });
  const expected = composeAnnualVerse(computeChart(VERSE_BIRTH, yearOf()), yearOf());

  const r = await api('GET', '/api/profile/strategic', { token });
  assert.equal(r.body.strategic.verse, expected, '有八字 → 谶语可得');
  assert.equal(r.body.strategic.verseYear, yearOf(), '盖当年章');

  // 再读不换（一年一句：谶语的分量全在不改不换）
  const again = await api('GET', '/api/profile/strategic', { token });
  assert.equal(again.body.strategic.verse, expected);

  // 手动改谶仍是老板的最终解释权，自动出谶不得反覆盖
  await api('PUT', '/api/profile/strategic', { token, body: { verse: '我自己的谶：一意孤行' } });
  const manual = await api('GET', '/api/profile/strategic', { token });
  assert.equal(manual.body.strategic.verse, '我自己的谶：一意孤行', '出谶触发点不得回压手动改的谶');

  // 谶语随注入块带出（军师全年沿用这一句）
  assert.match(strategicBlock(await loadStrategicProfile(user.id))!, /年度谶语：「我自己的谶：一意孤行」/);
});

test('命理开关关闭 → 有八字也不出谶（谶语属命理内容，不进档案也不进注入块）', async () => {
  const token = await login(uniquePhone(), '命理关求谶用户');
  await api('PUT', '/api/profile/bazi', { token, body: VERSE_BIRTH });
  await setFeatureFlag('fortune', false);
  try {
    const r = await api('GET', '/api/profile/strategic', { token });
    assert.equal(r.body.strategic, null, '命理下线不出谶');
  } finally {
    await setFeatureFlag('fortune', true);
  }
});

test('城市经度表保留兼容查询，但 v6 采集排盘不再消费出生地经度', async () => {
  assert.equal(cityLongitude('杭州'), 120.2);
  assert.equal(cityLongitude('浙江省杭州市'), 120.2);
  assert.equal(cityLongitude('乌鲁木齐'), 87.6);
  assert.equal(cityLongitude('某个小地方'), undefined);
  assert.equal(cityLongitude(''), undefined);

  // 端到端：出生地=乌鲁木齐、正午仍按出生证明 12:00 排为午时。
  const token = await login(uniquePhone(), '经度用户');
  const r = await api('PUT', '/api/profile/bazi', {
    token,
    body: { calendar: 'solar', year: 1988, month: 3, day: 15, hour: 12, minute: 0, gender: 'male', birthPlace: '乌鲁木齐' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.matchedCity, null);
  assert.equal(r.body.chart.trueSolarApplied, false);
  assert.equal(r.body.chart.timeStandard, 'civil');
  assert.equal(r.body.chart.chartTime, '1988-03-15 12:00');
  assert.equal(r.body.chart.pillars.time.ganZhi, '庚午');
});
