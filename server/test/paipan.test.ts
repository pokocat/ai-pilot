// 排盘引擎 v1 回归测试（M1 PR-1）：已知八字校验、两次排盘一致、农历输入等价、
// 缺时辰兜底、法定钟表时间、23:00 子初换日、命盘落库 upsert。铁律验证：全部结论由代码算出、可复算。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { astro } from 'iztro';
import { getApp, closeApp, seedBaseline, cleanBusiness, login, uniquePhone } from './helpers.ts';
import { prisma } from '../src/db.ts';
import { buildZiweiAstrolabe, chartBriefing, computeChart, computeAndStoreChart, loadChart, validatePaipanInput, PAIPAN_ENGINE_VERSION, type PaipanInput } from '../src/services/paipan.ts';

before(async () => {
  await getApp();
  await cleanBusiness();
  await seedBaseline();
});

after(async () => {
  await closeApp();
});

// 已知命例：公历 1988-03-15 10:30 男（= 农历 1988 正月廿八）
const KNOWN: PaipanInput = { calendar: 'solar', year: 1988, month: 3, day: 15, hour: 10, minute: 30, gender: 'male' };

test('已知八字回归：四柱/格局/日主/大运/紫微主星逐项一致', () => {
  const c = computeChart(KNOWN, 2026);
  assert.equal(c.engineVersion, PAIPAN_ENGINE_VERSION);
  assert.equal(c.solarDate, '1988-03-15');
  // 四柱
  assert.equal(c.pillars.year.ganZhi, '戊辰');
  assert.equal(c.pillars.month.ganZhi, '乙卯');
  assert.equal(c.pillars.day.ganZhi, '己巳');
  assert.equal(c.pillars.time?.ganZhi, '己巳');
  // 十神
  assert.equal(c.pillars.year.shiShenGan, '劫财');
  assert.equal(c.pillars.month.shiShenGan, '七杀');
  assert.equal(c.pillars.day.shiShenGan, '日主');
  // 格局：月支卯为四正纯气月支，本气乙(七杀) → 七杀格（打法映射自 V6.0 表）
  assert.equal(c.pattern.name, '七杀格');
  assert.equal(c.pattern.confidence, '高');
  assert.match(c.pattern.basis, /纯气月支/);
  assert.ok(c.pattern.suits.includes('闪电战'));
  assert.ok(c.pattern.avoid.length > 0);
  // 日主：己土；v2 加权旺衰（月令-4/长生-1/得地5/得势0.5 = 0.5，中和偏上按二分作身强）
  // 注：较 v1「得令40/得地各10/得助各10 = 50 分身强」升级为子平加权法，二分结论仍为身强、喜用五行不变；
  // strengthScore 语义由 0-100 归一分改为加权原始分（约 -15..+15，正为旺）。
  assert.equal(c.dayMaster.gan, '己');
  assert.equal(c.dayMaster.element, '土');
  assert.equal(c.dayMaster.strengthScore, 0.5);
  assert.equal(c.dayMaster.strengthLevel, '中和');
  assert.equal(c.dayMaster.confidence, '高');
  assert.equal(c.dayMaster.strength, '身强');
  assert.deepEqual(c.favorableElements, ['金', '水', '木']);
  // 调候用神（穷通宝鉴 己土生卯月）：甲癸丙 → 木水火
  assert.deepEqual(c.tiaoHou.gods, ['甲', '癸', '丙']);
  assert.deepEqual(c.tiaoHou.elements, ['木', '水', '火']);
  // 大运：阳年男顺行，首步丙辰 8 岁
  assert.equal(c.daYun.direction, '顺行');
  assert.equal(c.daYun.approximate, false);
  assert.deepEqual(c.daYun.list[0], { ganZhi: '丙辰', startAge: 8, startYear: 1995 });
  // 紫微：命宫武曲、七杀
  assert.deepEqual(c.ziwei?.soulMajorStars, ['武曲', '七杀']);
  // 逐月攻守：12 个月、相位合法、reason 带依据
  assert.equal(c.monthlyOutlook.year, 2026);
  assert.equal(c.monthlyOutlook.months.length, 12);
  for (const m of c.monthlyOutlook.months) {
    assert.ok(['进攻', '平稳', '防守'].includes(m.phase));
    assert.ok(m.ganZhi.length === 2 && m.reason.length > 0);
  }
});

test('确定性：同一输入两次排盘结果逐字节一致', () => {
  const a = computeChart(KNOWN, 2026);
  const b = computeChart(KNOWN, 2026);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('存量 paipan-v1 命盘缺少调候字段时仍可生成对话简报', () => {
  const legacy = JSON.parse(JSON.stringify(computeChart(KNOWN, 2026))) as ReturnType<typeof computeChart> & {
    tiaoHou?: ReturnType<typeof computeChart>['tiaoHou'];
  };
  legacy.engineVersion = 'paipan-v1';
  delete legacy.tiaoHou;
  const briefing = chartBriefing(legacy as ReturnType<typeof computeChart>, 2026);
  assert.match(briefing, /系统排盘引擎 paipan-v1/);
  assert.doesNotMatch(briefing, /调候（寒暖燥湿之需）/);
});

test('农历输入等价：1988 正月廿八 = 公历 1988-03-15，命盘一致', () => {
  const lunar = computeChart({ ...KNOWN, calendar: 'lunar', month: 1, day: 28 }, 2026);
  const solar = computeChart(KNOWN, 2026);
  assert.equal(lunar.solarDate, '1988-03-15');
  assert.equal(JSON.stringify(lunar), JSON.stringify(solar));
});

test('缺时辰：三柱排盘 + 时柱/紫微为空 + 大运标注近似，格局不受影响', () => {
  const c = computeChart({ ...KNOWN, hour: null }, 2026);
  assert.equal(c.hourKnown, false);
  assert.equal(c.pillars.time, null);
  assert.equal(c.ziwei, null);
  assert.equal(c.daYun.approximate, true);
  assert.equal(c.pattern.name, '七杀格'); // 月令取格不依赖时辰
  assert.match(c.dayMaster.basis, /缺时辰/);
  // 年月日三柱仍然正确
  assert.equal(c.pillars.day.ganZhi, '己巳');
});

test('统一法定钟表时间：出生地和经度不再改变四柱', () => {
  const noon = computeChart({ ...KNOWN, hour: 12, minute: 0 }, 2026);
  const urumqi = computeChart({ ...KNOWN, hour: 12, minute: 0, longitude: 87.6 }, 2026);
  assert.equal(noon.trueSolarApplied, false);
  assert.equal(noon.pillars.time?.ganZhi, '庚午');
  assert.equal(urumqi.trueSolarApplied, false);
  assert.equal(urumqi.timeStandard, 'civil');
  assert.equal(urumqi.chartTime, '1988-03-15 12:00');
  assert.deepEqual(urumqi.pillars, noon.pillars);
});

test('子初换日(sect 1)：3月16日23:30 按 3月17日 / 农历二月十八 / 次日日柱排盘', () => {
  const late = computeChart({ calendar: 'solar', year: 2025, month: 3, day: 16, hour: 23, minute: 30, gender: 'male' }, 2026);
  const nextEarly = computeChart({ calendar: 'solar', year: 2025, month: 3, day: 17, hour: 0, minute: 30, gender: 'male' }, 2026);
  assert.equal(late.solarDate, '2025-03-17');
  assert.equal(late.lunarDate, '二〇二五年二月十八');
  assert.equal(late.pillars.day.ganZhi, '乙酉');
  assert.equal(late.pillars.time?.ganZhi, '丙子');
  assert.equal(late.pillars.day.ganZhi, nextEarly.pillars.day.ganZhi);
  assert.equal(late.pillars.time?.ganZhi, nextEarly.pillars.time?.ganZhi);
});

test('22:45 不因出生地点提前跨入子时，统一按钟表时间排盘', () => {
  const standard = computeChart({ calendar: 'solar', year: 2025, month: 3, day: 16, hour: 22, minute: 45, gender: 'male' }, 2026);
  const withPlace = computeChart({ calendar: 'solar', year: 2025, month: 3, day: 16, hour: 22, minute: 45, gender: 'male', longitude: 126.6, birthPlace: '黑龙江' }, 2026);
  assert.equal(standard.solarDate, '2025-03-16');
  assert.equal(standard.pillars.day.ganZhi, '甲申');
  assert.equal(withPlace.solarDate, standard.solarDate);
  assert.deepEqual(withPlace.pillars, standard.pillars);
});

test('用户反馈回归：1987-03-16 23:30 瑞安直接按钟表时间，并从 23:00 计第二天子时', () => {
  const exact = validatePaipanInput({
    calendar: 'solar', year: 1987, month: 3, day: 16, hour: 23, minute: 30,
    gender: 'female', birthPlace: '浙江省 / 温州市 / 瑞安市', longitude: 120.7,
  }, 2026);
  assert.equal(exact.ok, true);
  if (!exact.ok) return;
  const chart = computeChart(exact.input, 2026);
  assert.equal(chart.inputTime, '23:30');
  assert.equal(chart.chartTime, '1987-03-16 23:30');
  assert.equal(chart.timePrecision, 'exact');
  assert.equal(chart.timeStandard, 'civil');
  assert.equal(chart.dayBoundary, 'zichu');
  assert.equal(chart.trueSolarApplied, false);
  assert.equal(chart.solarDate, '1987-03-17');
  assert.equal(chart.lunarDate, '一九八七年二月十八');
  assert.equal(chart.pillars.day.ganZhi, '乙丑');
  assert.equal(chart.pillars.time?.ganZhi, '丙子');
});

test('换日边界逐分钟锁定：22:59 当日亥时，23:00/23:59 次日子时，次日 00:00 仍为同一日早子', () => {
  const base = { calendar: 'solar', year: 1987, month: 3, day: 16, gender: 'female' } as const;
  const at2259 = computeChart({ ...base, hour: 22, minute: 59 }, 2026);
  const at2300 = computeChart({ ...base, hour: 23, minute: 0 }, 2026);
  const at2359 = computeChart({ ...base, hour: 23, minute: 59 }, 2026);
  const next0000 = computeChart({ ...base, day: 17, hour: 0, minute: 0 }, 2026);

  assert.equal(at2259.solarDate, '1987-03-16');
  assert.equal(at2259.pillars.day.ganZhi, '甲子');
  assert.equal(at2259.pillars.time?.ganZhi, '乙亥');
  for (const lateZi of [at2300, at2359]) {
    assert.equal(lateZi.solarDate, '1987-03-17');
    assert.equal(lateZi.pillars.day.ganZhi, '乙丑');
    assert.equal(lateZi.pillars.time?.ganZhi, '丙子');
  }
  assert.equal(next0000.solarDate, '1987-03-17');
  assert.equal(next0000.pillars.day.ganZhi, '乙丑');
  assert.equal(next0000.pillars.time?.ganZhi, '丙子');
});

test('紫微晚子口径不依赖 iztro 全局默认：即使先污染为当天，立盘仍恢复 forward 并与次日早子同盘', () => {
  astro.config({ dayDivide: 'current' });
  const late = buildZiweiAstrolabe({
    calendar: 'solar', year: 1987, month: 3, day: 16, hour: 23, minute: 30, gender: 'female',
  });
  const nextEarly = buildZiweiAstrolabe({
    calendar: 'solar', year: 1987, month: 3, day: 17, hour: 0, minute: 30, gender: 'female',
  });
  assert.ok(late);
  assert.ok(nextEarly);
  assert.equal(astro.getConfig().dayDivide, 'forward');
  assert.equal(late.chineseDate, '丁卯 癸卯 乙丑 丙子');
  assert.equal(late.chineseDate, nextEarly.chineseDate);
  assert.equal(late.earthlyBranchOfSoulPalace, nextEarly.earthlyBranchOfSoulPalace);
  assert.equal(late.earthlyBranchOfBodyPalace, nextEarly.earthlyBranchOfBodyPalace);
  assert.equal(late.fiveElementsClass, nextEarly.fiveElementsClass);
  const palaceFacts = (astrolabe: NonNullable<ReturnType<typeof buildZiweiAstrolabe>>) => astrolabe.palaces.map((p) => ({
    name: p.name,
    heavenlyStem: p.heavenlyStem,
    earthlyBranch: p.earthlyBranch,
    isBodyPalace: p.isBodyPalace,
    decadal: p.decadal,
    ages: p.ages,
    majorStars: p.majorStars.map((s) => ({ name: s.name, brightness: s.brightness, mutagen: s.mutagen })),
    minorStars: p.minorStars.map((s) => ({ name: s.name, brightness: s.brightness, mutagen: s.mutagen })),
    adjectiveStars: p.adjectiveStars.map((s) => s.name),
  }));
  assert.deepEqual(palaceFacts(late), palaceFacts(nextEarly));
});

test('旧时辰档位缺分钟时取半时辰中点，仍按 23:00 子初换日', () => {
  const legacy = validatePaipanInput({
    calendar: 'solar', year: 1987, month: 3, day: 16, hour: 23,
    gender: 'female', longitude: 120.7,
  }, 2026);
  assert.equal(legacy.ok, true);
  if (!legacy.ok) return;
  assert.equal(legacy.input.minute, 30);
  assert.equal(legacy.input.timePrecision, 'shichen');
  const chart = computeChart(legacy.input, 2026);
  assert.equal(chart.solarDate, '1987-03-17');
  assert.equal(chart.pillars.time?.ganZhi, '丙子');

  const exact2300 = computeChart({ ...legacy.input, minute: 0, timePrecision: 'exact' }, 2026);
  assert.equal(exact2300.chartTime, '1987-03-16 23:00');
  assert.equal(exact2300.solarDate, '1987-03-17');
  assert.equal(exact2300.pillars.time?.ganZhi, '丙子');
});

test('立春换年：2000 立春(约 2/4 傍晚)前后各一天，10 时出生年柱切换 己卯→庚辰', () => {
  const before = computeChart({ calendar: 'solar', year: 2000, month: 2, day: 4, hour: 10, gender: 'male' }, 2026);
  const after = computeChart({ calendar: 'solar', year: 2000, month: 2, day: 5, hour: 10, gender: 'male' }, 2026);
  assert.equal(before.pillars.year.ganZhi, '己卯'); // 立春前仍属己卯年
  assert.equal(after.pillars.year.ganZhi, '庚辰');  // 立春后进庚辰年
});

test('节气交接：2000 惊蛰(约 3/5)前后，10 时出生月柱由寅月转卯月 戊寅→己卯', () => {
  const before = computeChart({ calendar: 'solar', year: 2000, month: 3, day: 5, hour: 10, gender: 'male' }, 2026);
  const after = computeChart({ calendar: 'solar', year: 2000, month: 3, day: 6, hour: 10, gender: 'male' }, 2026);
  assert.equal(before.pillars.month.ganZhi, '戊寅'); // 惊蛰前寅月
  assert.equal(after.pillars.month.ganZhi, '己卯');  // 惊蛰后卯月
});

test('落库：每用户一张命盘（重排覆盖），loadChart 取回一致', async () => {
  const token = await login(uniquePhone(), '命盘用户');
  const user = await prisma.user.findFirstOrThrow({ where: { id: token } });

  const first = await computeAndStoreChart({ tenantId: user.tenantId, userId: user.id, input: KNOWN, targetYear: 2026 });
  // 重排（改时辰）→ 覆盖同一行
  await computeAndStoreChart({ tenantId: user.tenantId, userId: user.id, input: { ...KNOWN, hour: null }, targetYear: 2026 });
  const rows = await prisma.natalChart.findMany({ where: { userId: user.id } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].birthHour, null);
  assert.equal(rows[0].engineVersion, PAIPAN_ENGINE_VERSION);

  const loaded = await loadChart(user.id);
  assert.equal(loaded?.pattern.name, first.pattern.name);
  assert.equal(loaded?.hourKnown, false);
});

test('v6 升级不静默覆盖存量 v2 快照；用户主动重排才写 v6', async () => {
  const token = await login(uniquePhone(), '命盘版本用户');
  const user = await prisma.user.findFirstOrThrow({ where: { id: token } });
  const legacy = { ...computeChart(KNOWN, 2026), engineVersion: 'paipan-v2' };
  await prisma.natalChart.create({
    data: {
      tenantId: user.tenantId,
      userId: user.id,
      engineVersion: 'paipan-v2',
      gender: KNOWN.gender,
      calendar: KNOWN.calendar,
      birthDate: '1988-03-15',
      birthHour: KNOWN.hour,
      birthMinute: KNOWN.minute,
      trueSolarApplied: false,
      chartJson: legacy,
    },
  });

  assert.equal((await loadChart(user.id))?.engineVersion, 'paipan-v2', '读取存量盘不得自动升级');
  await computeAndStoreChart({ tenantId: user.tenantId, userId: user.id, input: KNOWN, targetYear: 2026 });
  assert.equal((await loadChart(user.id))?.engineVersion, 'paipan-v6', '用户主动重排写当前 v6');
});

test('存量 v3 首次读取惰性升级 v6，避免报告与对话日柱不一致', async () => {
  const token = await login(uniquePhone(), '命盘v3升级用户');
  const user = await prisma.user.findFirstOrThrow({ where: { id: token } });
  const input = { calendar: 'solar', year: 2025, month: 3, day: 16, hour: 23, minute: 30, gender: 'male' } as const;
  const old = { ...computeChart(input, 2026), engineVersion: 'paipan-v3', solarDate: '2025-03-16', lunarDate: '二〇二五年二月十七' };
  await prisma.natalChart.create({ data: {
    tenantId: user.tenantId, userId: user.id, engineVersion: 'paipan-v3', gender: 'male', calendar: 'solar',
    birthDate: '2025-03-16', birthHour: 23, birthMinute: 30, trueSolarApplied: false, chartJson: old,
  } });
  const upgraded = await loadChart(user.id);
  assert.equal(upgraded?.engineVersion, 'paipan-v6');
  assert.equal(upgraded?.solarDate, '2025-03-17');
  assert.equal(upgraded?.lunarDate, '二〇二五年二月十八');
  assert.equal(upgraded?.pillars.day.ganZhi, '乙酉');
  assert.equal((await prisma.natalChart.findUniqueOrThrow({ where: { userId: user.id } })).engineVersion, 'paipan-v6');
});

test('存量 v5 真太阳时盘首读升级 v6，恢复出生证明钟表时间并清除经度计算标记', async () => {
  const token = await login(uniquePhone(), '命盘v5钟表时间升级用户');
  const user = await prisma.user.findFirstOrThrow({ where: { id: token } });
  const input = { calendar: 'solar', year: 1988, month: 3, day: 15, hour: 12, minute: 0, gender: 'male' } as const;
  const old = {
    ...computeChart(input, 2026),
    engineVersion: 'paipan-v5',
    chartTime: '1988-03-15 09:50',
    trueSolarApplied: true,
  };
  const profile = await prisma.profile.findFirst({ where: { tenantId: user.tenantId } });
  if (profile) await prisma.profile.update({ where: { id: profile.id }, data: { extraJson: { bazi: { ...input, birthPlace: '乌鲁木齐', minute: 0 } } } });
  else await prisma.profile.create({ data: { tenantId: user.tenantId, extraJson: { bazi: { ...input, birthPlace: '乌鲁木齐', minute: 0 } } } });
  await prisma.natalChart.create({ data: {
    tenantId: user.tenantId, userId: user.id, engineVersion: 'paipan-v5', gender: 'male', calendar: 'solar',
    birthDate: '1988-03-15', birthHour: 12, birthMinute: 0, birthPlace: '乌鲁木齐', longitude: 87.6,
    trueSolarApplied: true, chartJson: old,
  } });

  const upgraded = await loadChart(user.id);
  assert.equal(upgraded?.engineVersion, 'paipan-v6');
  assert.equal(upgraded?.chartTime, '1988-03-15 12:00');
  assert.equal(upgraded?.timeStandard, 'civil');
  assert.equal(upgraded?.trueSolarApplied, false);
  assert.equal(upgraded?.pillars.time?.ganZhi, '庚午');
  const row = await prisma.natalChart.findUniqueOrThrow({ where: { userId: user.id } });
  assert.equal(row.longitude, null);
  assert.equal(row.trueSolarApplied, false);
});
