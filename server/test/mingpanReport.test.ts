// 命盘报告（八字 × 紫微综合印证）路由 + 计算层回归。
// 铁律：全部结论确定性可复算、零外部服务（纯计算，天然满足）。用固定生辰锚定：
// 公历 1988-03-15 10:30 男（= 农历 1988 正月廿八），与 paipan.test 同一命例。
// 覆盖：无生辰 needBazi / 有时辰全盘（12 宫齐全且互异、四化恰 4 条禄权科忌各一、时间轴与关键转折年抽查）
//      / 缺时辰（ziwei·yinzheng 为 null，八字照常三柱）/ fortune 关 → 403 / 同输入同输出。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, closeApp, seedBaseline, cleanBusiness, login, uniquePhone, api } from './helpers.ts';
import { setFeatureFlag } from '../src/services/featureFlag.ts';
import { buildMingpanReport, MINGPAN_DISCLAIMER, type MingpanReport } from '../src/services/mingpan.ts';
import type { PaipanInput } from '../src/services/paipan.ts';

const BIRTH = { calendar: 'solar', year: 1988, month: 3, day: 15, hour: 10, minute: 30, gender: 'male' } as const;
const BIRTH_INPUT: PaipanInput = { ...BIRTH };

describe('命盘报告 GET /profile/chart/report', () => {
  before(async () => {
    await getApp();
    await cleanBusiness();
    await seedBaseline();
    await setFeatureFlag('fortune', true);
  });
  after(async () => { await setFeatureFlag('fortune', true); await closeApp(); });

  test('无生辰（无 NatalChart）→ { needBazi: true }', async () => {
    const token = await login(uniquePhone(), '无生辰用户');
    const r = await api('GET', '/api/profile/chart/report', { token });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { needBazi: true });
  });

  test('有时辰全盘：八字盘 + 紫微十二宫 + 综合印证逐项校验', async () => {
    const token = await login(uniquePhone(), '全盘用户');
    const put = await api('PUT', '/api/profile/bazi', { token, body: BIRTH });
    assert.equal(put.status, 200, '排盘落库成功');

    const r = await api<MingpanReport>('GET', '/api/profile/chart/report', { token });
    assert.equal(r.status, 200);
    const rep = r.body;

    // —— 档头 ——
    assert.equal(rep.engineVersion, 'paipan-v6');
    assert.equal(rep.base.gender, '男');
    assert.equal(rep.base.hourKnown, true);
    assert.equal(rep.base.inputTime, '10:30');
    assert.equal(rep.base.chartTime, '1988-03-15 10:30');
    assert.equal(rep.base.timePrecision, 'exact');
    assert.equal(rep.base.timeStandard, 'civil');
    assert.equal(rep.base.dayBoundary, 'zichu');
    assert.equal(rep.base.hourLabel, '巳时');
    assert.equal(rep.base.solarDate, '1988-03-15');
    assert.equal(rep.disclaimer, MINGPAN_DISCLAIMER);
    assert.match(rep.disclaimer, /不构成任何决策依据/);

    // —— 八字侧 ——
    assert.equal(rep.bazi.pattern.name, '七杀格');
    assert.equal(rep.bazi.dayMaster.gan, '己');
    // 五行统计：天干本气 戊乙己己=土木土土 + 地支本气 辰卯巳巳=土木火火 → 木2火2土4
    assert.deepEqual(rep.bazi.wuxingCount.counts, { 木: 2, 火: 2, 土: 4, 金: 0, 水: 0 });
    assert.match(rep.bazi.wuxingCount.basis, /地支本气/);

    // —— 紫微盘元信息 ——
    assert.ok(rep.ziwei, '有时辰应出紫微全盘');
    const zw = rep.ziwei!;
    assert.equal(zw.fiveElementsClass, '木三局');
    assert.equal(zw.soulStar, '文曲');
    assert.equal(zw.bodyStar, '文昌');
    assert.equal(zw.yinYang, '阳男'); // 年干戊(阳) + 男
    assert.equal(zw.soulBranch, '酉');
    assert.equal(zw.bodyBranch, '未');

    // —— 十二宫齐全且宫名互异 ——
    assert.equal(zw.palaces.length, 12, '十二宫齐全');
    assert.equal(new Set(zw.palaces.map((p) => p.name)).size, 12, '宫名各异');
    assert.equal(zw.palaces.filter((p) => p.isBody).length, 1, '身宫恰一');
    const soul = zw.palaces.find((p) => p.isSoul)!;
    assert.ok(soul, '有命宫');
    assert.equal(soul.branch, '酉');
    const soulMajorNames = soul.majorStars.map((s) => s.name);
    assert.ok(soulMajorNames.includes('武曲') && soulMajorNames.includes('七杀'), '命宫武曲七杀');
    assert.ok(soul.majorStars.every((s) => s.brightness.length > 0), '主星带亮度');
    assert.deepEqual(soul.decadal, { start: 3, end: 12 }, '命宫大限虚岁 3-12');

    // —— 生年四化恰 4 条，禄权科忌各一，落宫正确 ——
    const sihua = rep.yinzheng!.sihua;
    assert.equal(sihua.length, 4, '四化恰 4 条');
    assert.deepEqual(new Set(sihua.map((s) => s.hua)), new Set(['禄', '权', '科', '忌']), '禄权科忌各一');
    assert.deepEqual(sihua.find((s) => s.hua === '禄'), { star: '贪狼', hua: '禄', palace: '财帛' });
    assert.deepEqual(sihua.find((s) => s.hua === '权'), { star: '太阴', hua: '权', palace: '疾厄' });
    assert.deepEqual(sihua.find((s) => s.hua === '科'), { star: '右弼', hua: '科', palace: '父母' });
    assert.deepEqual(sihua.find((s) => s.hua === '忌'), { star: '天机', hua: '忌', palace: '田宅' });

    // —— 五行对照：木三局之木 ∈ 喜用(金水木)+调候(木水火) → 同气对齐 ——
    const ec = rep.yinzheng!.elementCheck;
    assert.equal(ec.ju, '木三局');
    assert.equal(ec.juElement, '木');
    assert.equal(ec.aligned, true);
    assert.ok(ec.favorable.includes('木'));
    assert.match(ec.note, /同气相求/);

    // —— 时间轴：八字大运 8 步为脊，逐步挂紫微大限 ——
    const tl = rep.yinzheng!.timeline;
    assert.equal(tl.length, 8, '大运 8 步 8 行');
    for (const row of tl) assert.match(row.years, /^\d{4}–\d{4}$/);
    assert.equal(tl[0].daYun?.startYear, 1995);      // 首步丙辰 8 岁 1995 起运
    assert.equal(tl[0].daXian?.palace, '命宫');       // 1995 落命宫大限(虚岁3-12→1990-1999)
    const tian = tl.find((row) => row.daXian?.palace === '田宅');
    assert.ok(tian && tian.daYun?.startYear === 2025, '田宅大限对齐 2025 起大运');
    assert.ok(tl.filter((row) => row.isCurrent).length <= 1, '当前段至多一行');

    // —— 关键转折年：换运/换限，本命例两轴错开 5 年，无重合 ——
    const ky = rep.yinzheng!.keyYears;
    assert.ok(ky.every((k) => ['换运', '换限', '换运换限重合'].includes(k.reason)), 'reason 合法');
    assert.ok(ky.every((k) => k.overlap === false), '本命例无换运换限重合');
    const y1995 = ky.find((k) => k.year === 1995);
    assert.deepEqual(y1995, { year: 1995, age: 8, reason: '换运', overlap: false });
    const y2020 = ky.find((k) => k.year === 2020);
    assert.ok(y2020 && y2020.reason === '换限', '2020 换大限');

    // —— 主轴速览（模板填充，带 basis） ——
    assert.match(rep.yinzheng!.baziAxis.text, /以「七杀格」立局/);
    assert.match(rep.yinzheng!.baziAxis.text, /日主己土中和/);
    assert.ok(rep.yinzheng!.baziAxis.basis.length > 0);
    assert.match(rep.yinzheng!.ziweiAxis.text, /命宫酉/);
    assert.match(rep.yinzheng!.ziweiAxis.text, /武曲、七杀/);
    assert.match(rep.yinzheng!.ziweiAxis.text, /身宫落夫妻宫/);
    assert.match(rep.yinzheng!.ziweiAxis.text, /化禄归贪狼/);
    assert.ok(rep.yinzheng!.ziweiAxis.basis.length > 0);
  });

  test('缺时辰：ziwei/yinzheng 为 null，八字侧照常三柱', async () => {
    const token = await login(uniquePhone(), '缺时辰用户');
    const put = await api('PUT', '/api/profile/bazi', { token, body: { ...BIRTH, hour: null } });
    assert.equal(put.status, 200);

    const r = await api<MingpanReport>('GET', '/api/profile/chart/report', { token });
    assert.equal(r.status, 200);
    const rep = r.body;
    assert.equal(rep.base.hourKnown, false);
    assert.equal(rep.base.hourLabel, null, '缺时辰无时辰名');
    assert.equal(rep.ziwei, null, '缺时辰无紫微盘');
    assert.equal(rep.yinzheng, null, '缺时辰无印证');
    // 八字侧仍完整（三柱）：格局不变、时柱为空、五行按六字统计
    assert.equal(rep.bazi.pattern.name, '七杀格');
    assert.equal(rep.bazi.pillars.time, null);
    assert.deepEqual(rep.bazi.wuxingCount.counts, { 木: 2, 火: 1, 土: 3, 金: 0, 水: 0 });
    assert.match(rep.bazi.wuxingCount.basis, /三柱计六字/);
    assert.match(rep.bazi.dayMaster.basis, /缺时辰/);
    assert.equal(rep.disclaimer, MINGPAN_DISCLAIMER);
  });

  test('fortune 关闭 → 403 FEATURE_DISABLED', async () => {
    const token = await login(uniquePhone(), '门控用户');
    await api('PUT', '/api/profile/bazi', { token, body: BIRTH });
    await setFeatureFlag('fortune', false);
    try {
      const r = await api('GET', '/api/profile/chart/report', { token });
      assert.equal(r.status, 403);
      assert.equal(r.body.code, 'FEATURE_DISABLED');
    } finally {
      await setFeatureFlag('fortune', true);
    }
  });
});

describe('命盘报告计算层 buildMingpanReport（纯函数）', () => {
  test('同输入同输出：两次构建逐字节一致', () => {
    const a = buildMingpanReport(BIRTH_INPUT, 2026);
    const b = buildMingpanReport(BIRTH_INPUT, 2026);
    assert.equal(JSON.stringify(a), JSON.stringify(b));
  });

  test('缺时辰分支：ziwei/yinzheng 为 null 且八字三柱', () => {
    const rep = buildMingpanReport({ ...BIRTH_INPUT, hour: null }, 2026);
    assert.equal(rep.ziwei, null);
    assert.equal(rep.yinzheng, null);
    assert.equal(rep.bazi.pillars.time, null);
    assert.equal(rep.base.hourKnown, false);
  });

  test('出生地不再改钟表时间，23:00 直接按第二天子时排盘', () => {
    const rep = buildMingpanReport({
      calendar: 'solar', year: 1987, month: 3, day: 16, hour: 23, minute: 0,
      timePrecision: 'exact', gender: 'female', longitude: 120.7,
    }, 2026);
    assert.equal(rep.base.inputTime, '23:00');
    assert.equal(rep.base.chartTime, '1987-03-16 23:00');
    assert.equal(rep.base.hourLabel, '子时（子初换日）');
    assert.equal(rep.base.solarDate, '1987-03-17');
    assert.equal(rep.bazi.pillars.time?.ganZhi, '丙子');
  });
});
