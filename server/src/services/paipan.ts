// 排盘引擎 v1（M1 PR-1）：确定性命理/历法计算 —— 干支历用 lunar-typescript，紫微用 iztro。
// 铁律：算 → 存 → 拼指令，AI 只负责行文。本文件产出的所有结论都是可复算的（同输入同输出），
// 引擎带版本号（升级后可按版本批量复算）；启发式规则（身强弱/喜用/攻守）在 basis 字段写明依据，
// 属 v1 简化口径，后续版本细化时以版本号区分，不悄悄改变历史命盘。
//
// 已知边界（v1）：
// - 真太阳时：仅做经度平太阳时校正（(经度-120)×4 分钟），未含均时差（±15 分钟内，影响极少数踩点时辰）。
// - 格局：月令取格（月支藏干本气的十神定格），不处理从格/化格等特殊格局。
// - 身强弱/喜用：得令(40)+得地(各10)+得助(各10) 计分法，≥50% 为身强；身强喜财官食伤、身弱喜印比。
// - 称骨：暂缓（称骨年表 60 干支权值需可靠来源核对后再上，避免引擎带错表）。
import { Lunar, Solar } from 'lunar-typescript';
import { astro } from 'iztro';
import { prisma } from '../db.js';
import { PATTERN_PLAYBOOK, type PatternPlay } from '../data/baziPlaybook.js';

export const PAIPAN_ENGINE_VERSION = 'paipan-v1';

export interface PaipanInput {
  calendar: 'solar' | 'lunar';
  year: number;
  month: number; // lunar 闰月传负数（lunar-typescript 约定，如闰二月 = -2）
  day: number;
  hour?: number | null;   // 0-23；null/undefined = 时辰不确定
  minute?: number;
  gender: 'male' | 'female';
  birthPlace?: string;
  longitude?: number;     // 东经；提供则做真太阳时校正
}

export interface PillarView {
  ganZhi: string;
  shiShenGan: string;     // 天干十神（日柱为「日主」）
  hideGan: string[];      // 地支藏干
  shiShenZhi: string[];   // 藏干十神
  naYin: string;
}

export interface MonthOutlook {
  month: number;          // 公历月 1-12
  ganZhi: string;         // 该月月柱（取当月 15 日所在节气月）
  phase: '进攻' | '平稳' | '防守';
  turning: boolean;       // 与上月攻守相反 → 拐点月
  reason: string;
}

export interface ChartView {
  engineVersion: string;
  solarDate: string;      // 校正后用于排盘的公历日期 YYYY-MM-DD
  lunarDate: string;      // 对应农历（中文）
  hourKnown: boolean;
  trueSolarApplied: boolean;
  gender: '男' | '女';
  pillars: { year: PillarView; month: PillarView; day: PillarView; time: PillarView | null };
  dayMaster: { gan: string; element: string; strength: '身强' | '身弱'; strengthScore: number; basis: string };
  favorableElements: string[];
  pattern: { name: string; monthShiShen: string } & PatternPlay;
  ziwei: { soulMajorStars: string[]; bodyMajorStars: string[] } | null; // 缺时辰 → null（紫微必须有时辰）
  daYun: {
    direction: '顺行' | '逆行';
    startAge: string;     // 「X 岁 Y 个月起运」
    approximate: boolean; // 缺时辰按 12:00 近似
    list: { ganZhi: string; startAge: number; startYear: number }[];
  };
  monthlyOutlook: { year: number; months: MonthOutlook[] };
}

// —— 五行基础表（确定性常量） ——
const GAN_ELEMENT: Record<string, string> = { 甲: '木', 乙: '木', 丙: '火', 丁: '火', 戊: '土', 己: '土', 庚: '金', 辛: '金', 壬: '水', 癸: '水' };
const ZHI_ELEMENT: Record<string, string> = { 子: '水', 丑: '土', 寅: '木', 卯: '木', 辰: '土', 巳: '火', 午: '火', 未: '土', 申: '金', 酉: '金', 戌: '土', 亥: '水' };
const GEN: Record<string, string> = { 木: '火', 火: '土', 土: '金', 金: '水', 水: '木' }; // 我生
const KE: Record<string, string> = { 木: '土', 土: '水', 水: '火', 火: '金', 金: '木' };  // 我克

function genOf(element: string): string { // 生我
  return Object.keys(GEN).find((k) => GEN[k] === element)!;
}
function keMe(element: string): string { // 克我
  return Object.keys(KE).find((k) => KE[k] === element)!;
}

/** 元素对日主的支持性：同我/生我 = 帮身。 */
function supports(dayElement: string, other: string): boolean {
  return other === dayElement || GEN[other] === dayElement;
}

// 小时 → iztro 时辰序号（0=早子 00-01, 1=丑 01-03, …, 11=亥 21-23, 12=晚子 23-24）
function hourToTimeIndex(hour: number): number {
  if (hour >= 23) return 12;
  return Math.floor((hour + 1) / 2);
}

function pad2(n: number): string { return `${n}`.padStart(2, '0'); }

/** 解析输入 → 排盘用公历时刻（含农历转换与真太阳时校正）。 */
function resolveSolar(input: PaipanInput): { solar: Solar; trueSolarApplied: boolean; hourKnown: boolean } {
  const hourKnown = input.hour !== null && input.hour !== undefined;
  const hour = hourKnown ? (input.hour as number) : 12; // 缺时辰按正午近似（时柱不输出）
  const minute = input.minute ?? 0;
  let solar: Solar;
  if (input.calendar === 'lunar') {
    solar = Lunar.fromYmdHms(input.year, input.month, input.day, hour, minute, 0).getSolar();
  } else {
    solar = Solar.fromYmdHms(input.year, input.month, input.day, hour, minute, 0);
  }
  // 真太阳时（v1 平太阳时）：中国标准时按东经 120° 定，每偏 1° 校正 4 分钟。
  let trueSolarApplied = false;
  if (hourKnown && typeof input.longitude === 'number' && input.longitude > 70 && input.longitude < 140) {
    const offsetMin = Math.round((input.longitude - 120) * 4);
    if (offsetMin !== 0) {
      const d = new Date(solar.getYear(), solar.getMonth() - 1, solar.getDay(), solar.getHour(), solar.getMinute() + offsetMin, 0);
      solar = Solar.fromDate(d);
      trueSolarApplied = true;
    }
  }
  return { solar, trueSolarApplied, hourKnown };
}

/** 排盘主入口：同输入必同输出（monthlyOutlook 按 targetYear 计算，由调用方传入）。 */
export function computeChart(input: PaipanInput, targetYear: number): ChartView {
  const { solar, trueSolarApplied, hourKnown } = resolveSolar(input);
  const lunar = solar.getLunar();
  const ec = lunar.getEightChar();

  const pillar = (ganZhi: string, shiShenGan: string, hideGan: string[], shiShenZhi: string[], naYin: string): PillarView =>
    ({ ganZhi, shiShenGan, hideGan, shiShenZhi, naYin });

  const pillars = {
    year: pillar(ec.getYear(), ec.getYearShiShenGan(), ec.getYearHideGan(), ec.getYearShiShenZhi(), ec.getYearNaYin()),
    month: pillar(ec.getMonth(), ec.getMonthShiShenGan(), ec.getMonthHideGan(), ec.getMonthShiShenZhi(), ec.getMonthNaYin()),
    day: pillar(ec.getDay(), '日主', ec.getDayHideGan(), ec.getDayShiShenZhi(), ec.getDayNaYin()),
    time: hourKnown
      ? pillar(ec.getTime(), ec.getTimeShiShenGan(), ec.getTimeHideGan(), ec.getTimeShiShenZhi(), ec.getTimeNaYin())
      : null,
  };

  // —— 日主强弱（v1 计分）：得令 40 + 得地各 10 + 得助各 10，按可得总分归一 ——
  const dayGan = ec.getDayGan();
  const dayElement = GAN_ELEMENT[dayGan];
  let score = 0;
  let possible = 0;
  const monthZhi = ec.getMonthZhi();
  possible += 40;
  if (supports(dayElement, ZHI_ELEMENT[monthZhi])) score += 40; // 得令
  const otherZhi = [ec.getYearZhi(), ec.getDayZhi(), ...(hourKnown ? [ec.getTimeZhi()] : [])];
  for (const z of otherZhi) { possible += 10; if (supports(dayElement, ZHI_ELEMENT[z])) score += 10; } // 得地
  const otherGan = [ec.getYearGan(), ec.getMonthGan(), ...(hourKnown ? [ec.getTimeGan()] : [])];
  for (const g of otherGan) { possible += 10; if (supports(dayElement, GAN_ELEMENT[g])) score += 10; } // 得助
  const strengthScore = Math.round((score / possible) * 100);
  const strength: '身强' | '身弱' = strengthScore >= 50 ? '身强' : '身弱';
  // 喜用（v1）：身强喜泄耗（我生/我克/克我），身弱喜生扶（生我/同我）
  const favorableElements = strength === '身强'
    ? [GEN[dayElement], KE[dayElement], keMe(dayElement)]
    : [genOf(dayElement), dayElement];

  // —— 格局（月令取格）：月支藏干本气的十神定格 ——
  const monthShiShen = ec.getMonthShiShenZhi()[0] ?? ec.getMonthShiShenGan();
  const patternName = `${monthShiShen}格`;
  const play = PATTERN_PLAYBOOK[patternName] ?? { traits: '', suits: [], avoid: [] };

  // —— 紫微命宫/身宫主星（需时辰） ——
  let ziwei: ChartView['ziwei'] = null;
  if (hourKnown) {
    const chart = astro.bySolar(
      `${solar.getYear()}-${solar.getMonth()}-${solar.getDay()}`,
      hourToTimeIndex(solar.getHour()),
      input.gender === 'male' ? '男' : '女',
      true,
      'zh-CN',
    );
    ziwei = {
      soulMajorStars: chart.palace('命宫')?.majorStars.map((s) => s.name) ?? [],
      bodyMajorStars: chart.palace('身宫')?.majorStars.map((s) => s.name) ?? [],
    };
  }

  // —— 大运（缺时辰按 12:00 近似，approximate 标注） ——
  const yun = ec.getYun(input.gender === 'male' ? 1 : 0);
  const daYunList = yun.getDaYun().slice(1, 9).map((d) => ({ ganZhi: d.getGanZhi(), startAge: d.getStartAge(), startYear: d.getStartYear() }));
  const daYun: ChartView['daYun'] = {
    direction: yun.isForward() ? '顺行' : '逆行',
    startAge: `${yun.getStartYear()} 岁 ${yun.getStartMonth()} 个月起运`,
    approximate: !hourKnown,
    list: daYunList,
  };

  // —— 逐月攻守（targetYear 全年 12 个公历月，取每月 15 日所在节气月柱） ——
  const months: MonthOutlook[] = [];
  for (let m = 1; m <= 12; m++) {
    const midLunar = Solar.fromYmdHms(targetYear, m, 15, 12, 0, 0).getLunar();
    const mGanZhi = midLunar.getMonthInGanZhiExact();
    const mElement = ZHI_ELEMENT[mGanZhi[1]];
    let phase: MonthOutlook['phase'];
    let reason: string;
    if (favorableElements.includes(mElement)) {
      phase = '进攻';
      reason = `月令${mElement}为喜用（${strength}），宜主动布局`;
    } else if ((strength === '身弱' && mElement === keMe(dayElement)) || (strength === '身强' && supports(dayElement, mElement))) {
      phase = '防守';
      reason = strength === '身弱' ? `月令${mElement}克身且身弱，宜收缩防守` : `月令${mElement}助身而身已强，忌冒进宜练内功`;
    } else {
      phase = '平稳';
      reason = `月令${mElement}与日主${dayElement}无强冲突，正常推进`;
    }
    const prev = months[months.length - 1];
    months.push({ month: m, ganZhi: mGanZhi, phase, turning: !!prev && prev.phase !== phase && (prev.phase === '进攻' || phase === '进攻'), reason });
  }

  return {
    engineVersion: PAIPAN_ENGINE_VERSION,
    solarDate: `${solar.getYear()}-${pad2(solar.getMonth())}-${pad2(solar.getDay())}`,
    lunarDate: `${lunar.getYearInChinese()}年${lunar.getMonthInChinese()}月${lunar.getDayInChinese()}`,
    hourKnown,
    trueSolarApplied,
    gender: input.gender === 'male' ? '男' : '女',
    pillars,
    dayMaster: {
      gan: dayGan,
      element: dayElement,
      strength,
      strengthScore,
      basis: `v1 计分：得令40/得地各10/得助各10，得分 ${score}/${possible}${hourKnown ? '' : '（缺时辰，按三柱计）'}`,
    },
    favorableElements,
    pattern: { name: patternName, monthShiShen, ...play },
    ziwei,
    daYun,
    monthlyOutlook: { year: targetYear, months },
  };
}

/** 排盘并落库（每用户一张，重排覆盖）。 */
export async function computeAndStoreChart(args: {
  tenantId: string;
  userId: string;
  input: PaipanInput;
  targetYear: number;
}): Promise<ChartView> {
  const chart = computeChart(args.input, args.targetYear);
  const data = {
    tenantId: args.tenantId,
    engineVersion: PAIPAN_ENGINE_VERSION,
    gender: args.input.gender,
    calendar: args.input.calendar,
    birthDate: `${args.input.year}-${pad2(Math.abs(args.input.month))}-${pad2(args.input.day)}`,
    birthHour: args.input.hour ?? null,
    birthMinute: args.input.minute ?? null,
    birthPlace: args.input.birthPlace ?? null,
    longitude: args.input.longitude ?? null,
    trueSolarApplied: chart.trueSolarApplied,
    chartJson: chart as unknown as object,
  };
  await prisma.natalChart.upsert({
    where: { userId: args.userId },
    update: data,
    create: { userId: args.userId, ...data },
  });
  return chart;
}

/** 读取用户命盘（无则 null）。 */
export async function loadChart(userId: string): Promise<ChartView | null> {
  const row = await prisma.natalChart.findUnique({ where: { userId } });
  return row ? (row.chartJson as unknown as ChartView) : null;
}

/** 命盘 → 注入对话的【天势档案】块（结构化数据 + 使用铁律；AI 只翻译不计算）。 */
export function chartBriefing(chart: ChartView, nowYear: number): string {
  const p = chart.pillars;
  const four = [p.year.ganZhi, p.month.ganZhi, p.day.ganZhi, p.time?.ganZhi ?? '??（时辰不确定）'].join(' ');
  const cur = chart.daYun.list.filter((d) => d.startYear <= nowYear).pop();
  const byPhase = (k: MonthOutlook['phase']) =>
    chart.monthlyOutlook.months.filter((m) => m.phase === k).map((m) => `${m.month}月`).join('、') || '无';
  const turning = chart.monthlyOutlook.months.filter((m) => m.turning).map((m) => `${m.month}月`).join('、') || '无';
  const lines = [
    `【天势档案（系统排盘引擎 ${chart.engineVersion} 计算）】`,
    `四柱：${four}｜日主 ${chart.dayMaster.gan}${chart.dayMaster.element} · ${chart.dayMaster.strength}｜喜用五行：${chart.favorableElements.join('、')}`,
    `格局：${chart.pattern.name}（${chart.pattern.traits}）→ 适合打法：${chart.pattern.suits.join('、')}；要避开：${chart.pattern.avoid.join('、')}`,
    chart.ziwei
      ? `紫微：命宫 ${chart.ziwei.soulMajorStars.join('、') || '空宫'}${chart.ziwei.bodyMajorStars.length ? `；身宫 ${chart.ziwei.bodyMajorStars.join('、')}` : ''}`
      : '紫微：时辰不确定无法排盘（可建议客户补时辰解锁性格颗粒度分析）',
    `大运：${chart.daYun.direction}，${chart.daYun.startAge}${chart.daYun.approximate ? '（缺时辰按正午近似）' : ''}${cur ? `；当前大运 ${cur.ganZhi}（${cur.startYear} 年起）` : ''}`,
    `${chart.monthlyOutlook.year} 年逐月攻守：进攻月 ${byPhase('进攻')}；防守月 ${byPhase('防守')}；平稳月 ${byPhase('平稳')}；拐点月 ${turning}`,
    '（使用铁律：以上命理数据全部由系统算好——禁止你自行排八字、起大运、推流月、择日或编造任何命理数字；数据缺失时如实说明。表达时必须按翻译铁律转成剧情和比喻，不得堆砌术语。）',
  ];
  return lines.join('\n');
}

/** 客户选择不使用命理视角时的降级指令（V6.0 §16 防呆）。 */
export const TIANSHI_OPTOUT_LINE =
  '【天势表达降级】客户已选择不使用命理视角：回答中不得出现八字、命盘、大运、流月等命理术语；涉及「天势」判断时一律改用行业周期、时机窗口、经营节奏等商业语言表达。';
