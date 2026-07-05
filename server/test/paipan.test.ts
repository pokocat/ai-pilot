// 排盘引擎 v1 回归测试（M1 PR-1）：已知八字校验、两次排盘一致、农历输入等价、
// 缺时辰兜底、真太阳时校正、命盘落库 upsert。铁律验证：全部结论由代码算出、可复算。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, closeApp, seedBaseline, cleanBusiness, login, uniquePhone } from './helpers.ts';
import { prisma } from '../src/db.ts';
import { computeChart, computeAndStoreChart, loadChart, PAIPAN_ENGINE_VERSION, type PaipanInput } from '../src/services/paipan.ts';

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
  // 格局：月支卯藏干乙 → 七杀 → 七杀格（打法映射自 V6.0 表）
  assert.equal(c.pattern.name, '七杀格');
  assert.ok(c.pattern.suits.includes('闪电战'));
  assert.ok(c.pattern.avoid.length > 0);
  // 日主：己土；v1 计分 50/100 → 身强（得地×3 + 得助×2）
  assert.equal(c.dayMaster.gan, '己');
  assert.equal(c.dayMaster.element, '土');
  assert.equal(c.dayMaster.strengthScore, 50);
  assert.equal(c.dayMaster.strength, '身强');
  assert.deepEqual(c.favorableElements, ['金', '水', '木']);
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

test('真太阳时：乌鲁木齐(东经87.6°)正午出生 → 校正约-130分钟，时辰午变巳', () => {
  const noon = computeChart({ ...KNOWN, hour: 12, minute: 0 }, 2026);
  const urumqi = computeChart({ ...KNOWN, hour: 12, minute: 0, longitude: 87.6 }, 2026);
  assert.equal(noon.trueSolarApplied, false);
  assert.equal(noon.pillars.time?.ganZhi, '庚午');
  assert.equal(urumqi.trueSolarApplied, true);
  assert.equal(urumqi.pillars.time?.ganZhi, '己巳');
  // 时柱之外（年月日柱）不受影响
  assert.equal(urumqi.pillars.day.ganZhi, noon.pillars.day.ganZhi);
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
