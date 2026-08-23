// 排盘引擎 v6：确定性命理/历法计算 —— 干支历用 lunar-typescript，紫微用 iztro。
// 铁律：算 → 存 → 拼指令，AI 只负责行文。本文件产出的所有结论都是可复算的（同输入同输出），
// 引擎带版本号（升级后可按版本批量复算）；启发式规则（身强弱/喜用/攻守）在 basis 字段写明依据，
// 属 v1 简化口径，后续版本细化时以版本号区分，不悄悄改变历史命盘。
//
// 引擎边界（v6）：
// - 时间口径：统一使用出生证明上的法定钟表时间；出生地仅作档案信息，不自动换算真太阳时。
// - 换日口径：EightChar.setSect(1)——23:00-23:59 自动按第二天子时排盘；
//   只取消出生地校时，不改变产品已确认的 23:00 子初换日规则。
// - 旺衰/格局/调候：移植子平法加权算法（services/baziEnrich.ts，MIT 出处见该文件头），
//   月令权重最高、透根分层；格局按月令藏干透干取格；新增调候用神。仍不处理从格/化格等特殊格局
//   （极旺/极弱会在结论标「可能从强/从弱」提示，但正格照常论）。
// - 称骨：暂缓（称骨年表 60 干支权值需可靠来源核对后再上，避免引擎带错表）。
import { Lunar, Solar } from 'lunar-typescript';
import { astro } from 'iztro';
import { prisma } from '../db.js';
import { PATTERN_PLAYBOOK, type PatternPlay } from '../data/baziPlaybook.js';
import {
  judgeWangShuai, judgeGeJu, getTiaoHou, tiaoHouElements, toBinaryStrength,
  type SiZhu, type Tiangan, type Dizhi, type WangShuaiVerdict,
} from './baziEnrich.js';

// v6 在保留 v5 精确分钟与 23:00 子初换日的基础上统一产品流派：法定钟表时间，不换真太阳时。
// 存量 v3/v4/v5 首读重算为 v6，v1/v2 继续保留历史快照。
export const PAIPAN_ENGINE_VERSION = 'paipan-v6';

export interface PaipanInput {
  calendar: 'solar' | 'lunar';
  year: number;
  month: number; // lunar 闰月传负数（lunar-typescript 约定，如闰二月 = -2）
  day: number;
  hour?: number | null;   // 0-23；null/undefined = 时辰不确定
  minute?: number;
  timePrecision?: 'exact' | 'shichen' | 'unknown'; // minute 缺省的旧端按时辰代表值兼容
  gender: 'male' | 'female';
  birthPlace?: string;
  longitude?: number;     // 旧客户端兼容字段；v6 不参与排盘
}

export type PaipanValidation = { ok: true; input: PaipanInput } | { ok: false; error: string };

// 生辰输入共享校验（M-打磨：/profile/bazi 与「送你一卦」fate 预览同一口径，
// 防非法/恶意生辰直进引擎——修 AUDIT P2「friendBazi 服务端零校验」）。历法合法性仍由排盘库把关。
export function validatePaipanInput(b: Partial<PaipanInput> | undefined, maxYear: number): PaipanValidation {
  const raw = b ?? {};
  const yearNum = Number(raw.year), monthNum = Number(raw.month), dayNum = Number(raw.day);
  if (raw.calendar !== 'solar' && raw.calendar !== 'lunar') return { ok: false, error: '历法必须是 solar 或 lunar' };
  if (raw.gender !== 'male' && raw.gender !== 'female') return { ok: false, error: '缺少性别' };
  if (!Number.isInteger(yearNum) || yearNum < 1920 || yearNum > maxYear) return { ok: false, error: '出生年份不合法' };
  if (!Number.isInteger(dayNum) || dayNum < 1 || dayNum > 31) return { ok: false, error: '出生日期不合法' };
  if (!Number.isInteger(monthNum) || Math.abs(monthNum) < 1 || Math.abs(monthNum) > 12 || (monthNum < 0 && raw.calendar !== 'lunar')) {
    return { ok: false, error: '出生月份不合法' };
  }
  const hourKnown = raw.hour !== null && raw.hour !== undefined;
  if (hourKnown && (!Number.isInteger(Number(raw.hour)) || Number(raw.hour) < 0 || Number(raw.hour) > 23)) {
    return { ok: false, error: '时辰不合法（0-23，或不填表示不确定）' };
  }
  const minuteProvided = raw.minute !== null && raw.minute !== undefined;
  if (minuteProvided && (!Number.isInteger(Number(raw.minute)) || Number(raw.minute) < 0 || Number(raw.minute) > 59)) {
    return { ok: false, error: '出生分钟不合法（0-59）' };
  }
  // 出生地只作档案记录并做长度上限。命盘页 region picker 会提交省/市/区全称，
  // 40 字覆盖最长行政区组合；v6 不根据它换算时间。
  if (raw.birthPlace !== undefined && raw.birthPlace !== null) {
    if (typeof raw.birthPlace !== 'string') return { ok: false, error: '出生地格式不合法' };
    if (raw.birthPlace.length > 40) return { ok: false, error: '出生地过长（不超过 40 字）' };
  }
  // 经度仅为旧客户端兼容输入；虽不参与 v6 排盘，仍拒绝非法值，避免脏数据穿透接口。
  if (raw.longitude !== undefined && raw.longitude !== null) {
    const lng = Number(raw.longitude);
    if (!Number.isFinite(lng) || lng < -180 || lng > 180) return { ok: false, error: '经度不合法' };
  }
  const place = typeof raw.birthPlace === 'string' ? raw.birthPlace.trim() : undefined;
  return {
    ok: true,
    input: {
      calendar: raw.calendar, year: yearNum, month: monthNum, day: dayNum,
      hour: hourKnown ? Number(raw.hour) : null,
      minute: hourKnown ? (minuteProvided ? Number(raw.minute) : representativeMinute(Number(raw.hour))) : 0,
      timePrecision: hourKnown ? (minuteProvided ? 'exact' : 'shichen') : 'unknown',
      gender: raw.gender,
      birthPlace: place || undefined,
      longitude: raw.longitude === undefined || raw.longitude === null ? undefined : Number(raw.longitude),
    },
  };
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
  solarDate: string;      // 法定钟表时间 + 23:00 子初换日后的排盘有效日期 YYYY-MM-DD
  lunarDate: string;      // 与日柱共用同一排盘有效日期的农历（中文）
  hourKnown: boolean;
  inputTime: string | null;       // 用户出生钟表时间 HH:mm；旧时辰档位为代表值
  chartTime: string | null;       // 实际排盘时间 YYYY-MM-DD HH:mm（法定钟表时间）
  timePrecision: 'exact' | 'shichen' | 'unknown';
  timeStandard: 'civil';
  dayBoundary: 'zichu';
  trueSolarApplied: boolean;
  gender: '男' | '女';
  pillars: { year: PillarView; month: PillarView; day: PillarView; time: PillarView | null };
  dayMaster: {
    gan: string;
    element: string;
    strength: '身强' | '身弱';        // 二分口径（前端进度条/文案沿用）
    strengthLevel: WangShuaiVerdict;   // v2 五档：极旺/偏旺/中和/偏弱/极弱
    strengthScore: number;             // v2 加权分（约 -15..+15，正为旺）
    confidence: '高' | '中' | '低';
    basis: string;
  };
  favorableElements: string[];
  tiaoHou: { gods: string[]; elements: string[] };  // 调候用神（穷通宝鉴），gods 为天干、elements 为其五行
  pattern: { name: string; monthShiShen: string; basis: string; confidence: '高' | '中' | '低' } & PatternPlay;
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

// 小时 → iztro 时辰序号（0=子正 00-01, 1=丑 01-03, …, 11=亥 21-23, 12=子初 23-24）
function hourToTimeIndex(hour: number): number {
  if (hour >= 23) return 12;
  return Math.floor((hour + 1) / 2);
}

function pad2(n: number): string { return `${n}`.padStart(2, '0'); }

/** 旧端只选择时辰档位时的代表分钟：两段半时辰取中点，其余两小时档位的代表 hour 已在中点。 */
export function representativeMinute(hour: number | null | undefined): number {
  return hour === 0 || hour === 23 ? 30 : 0;
}

function dateTimeOf(solar: Solar): string {
  return `${solar.getYear()}-${pad2(solar.getMonth())}-${pad2(solar.getDay())} ${pad2(solar.getHour())}:${pad2(solar.getMinute())}`;
}

/** 纯日历加一天：用 UTC 避开宿主时区/DST，保留时分秒。 */
function nextCalendarDay(solar: Solar): Solar {
  const utc = new Date(Date.UTC(
    solar.getYear(), solar.getMonth() - 1, solar.getDay() + 1,
    solar.getHour(), solar.getMinute(), solar.getSecond(),
  ));
  return Solar.fromYmdHms(
    utc.getUTCFullYear(), utc.getUTCMonth() + 1, utc.getUTCDate(),
    utc.getUTCHours(), utc.getUTCMinutes(), utc.getUTCSeconds(),
  );
}

/** 解析输入 → 排盘用公历时刻。v6 统一按出生证明上的法定钟表时间，不做真太阳时校正。 */
function resolveSolar(input: PaipanInput): { solar: Solar; hourKnown: boolean } {
  const hourKnown = input.hour !== null && input.hour !== undefined;
  const hour = hourKnown ? (input.hour as number) : 12; // 缺时辰按正午近似（时柱不输出）
  const minute = input.minute ?? representativeMinute(input.hour);
  let solar: Solar;
  if (input.calendar === 'lunar') {
    solar = Lunar.fromYmdHms(input.year, input.month, input.day, hour, minute, 0).getSolar();
  } else {
    solar = Solar.fromYmdHms(input.year, input.month, input.day, hour, minute, 0);
  }
  return { solar, hourKnown };
}

/**
 * 紫微全盘（十二宫展开）：与 computeChart 内命宫/身宫主星同一调用口径——
 * 同样的法定钟表时间、同样的 hourToTimeIndex（含早/晚子时映射）、fixLeap=true、zh-CN。
 * 缺时辰返回 null（紫微必须有时辰立盘）。命盘报告层（mingpan.ts）复用此函数展开全盘，
 * 保证与对话简报里的命宫/身宫主星逐字一致，不产生第二套排盘口径。
 * 返回类型由 iztro 推断（FunctionalAstrolabe），下游用 ReturnType 取用，避免深路径类型导入。
 */
export function buildZiweiAstrolabe(input: PaipanInput) {
  const { solar, hourKnown } = resolveSolar(input);
  if (!hourKnown) return null;
  // iztro 的 dayDivide 是进程级全局配置，不能只依赖当前版本默认值。
  // 产品流派已固定为 23:00 晚子计次日；每次立盘前显式恢复 forward，避免其他调用或升级把紫微悄悄切回当天。
  astro.config({ dayDivide: 'forward' });
  return astro.bySolar(
    `${solar.getYear()}-${solar.getMonth()}-${solar.getDay()}`,
    hourToTimeIndex(solar.getHour()),
    input.gender === 'male' ? '男' : '女',
    true,
    'zh-CN',
  );
}

/** 排盘主入口：同输入必同输出（monthlyOutlook 按 targetYear 计算，由调用方传入）。 */
export function computeChart(input: PaipanInput, targetYear: number): ChartView {
  const { solar, hourKnown } = resolveSolar(input);
  const lunar = solar.getLunar();
  const ec = lunar.getEightChar();
  // 用户确认：23:00-23:59 自动计为第二天子时。显式固化 sect 1，避免依赖库默认值。
  ec.setSect(1);
  const effectiveSolar = hourKnown && solar.getHour() === 23 ? nextCalendarDay(solar) : solar;
  const effectiveLunar = effectiveSolar.getLunar();

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

  // —— 四柱（干支）喂 baziEnrich 加权算法（缺时辰不传时柱，走三柱评分/取格） ——
  const dayGan = ec.getDayGan();
  const dayElement = GAN_ELEMENT[dayGan];
  const siZhu: SiZhu = {
    年: { gan: ec.getYearGan() as Tiangan, zhi: ec.getYearZhi() as Dizhi },
    月: { gan: ec.getMonthGan() as Tiangan, zhi: ec.getMonthZhi() as Dizhi },
    日: { gan: dayGan as Tiangan, zhi: ec.getDayZhi() as Dizhi },
    时: hourKnown ? { gan: ec.getTimeGan() as Tiangan, zhi: ec.getTimeZhi() as Dizhi } : null,
  };

  // —— 日主旺衰（v2 加权：月令 + 长生 + 得地 + 得势） ——
  const ws = judgeWangShuai(siZhu);
  const strength = toBinaryStrength(ws);
  const strengthScore = ws.score;
  // 喜用五行（口径不变）：身强喜泄耗（我生/我克/克我），身弱喜生扶（生我/同我）。
  const favorableElements = strength === '身强'
    ? [GEN[dayElement], KE[dayElement], keMe(dayElement)]
    : [genOf(dayElement), dayElement];

  // —— 调候用神（穷通宝鉴 日干×月支） ——
  const tiaoHouGods = getTiaoHou(dayGan as Tiangan, ec.getMonthZhi() as Dizhi);
  const tiaoHou = { gods: tiaoHouGods, elements: tiaoHouElements(tiaoHouGods) };

  // —— 格局（月令藏干透干取格；纯气月支直接立格） ——
  const geju = judgeGeJu(siZhu);
  const patternName = geju.primary;
  const monthShiShen = ec.getMonthShiShenZhi()[0] ?? ec.getMonthShiShenGan();
  const play = PATTERN_PLAYBOOK[patternName] ?? { traits: '', suits: [], avoid: [] };

  // —— 紫微命宫/身宫主星（需时辰）：与命盘报告全盘同走 buildZiweiAstrolabe，单一口径 ——
  const astrolabe = buildZiweiAstrolabe(input);
  const ziwei: ChartView['ziwei'] = astrolabe
    ? {
        soulMajorStars: astrolabe.palace('命宫')?.majorStars.map((s) => s.name) ?? [],
        bodyMajorStars: astrolabe.palace('身宫')?.majorStars.map((s) => s.name) ?? [],
      }
    : null;

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
    solarDate: `${effectiveSolar.getYear()}-${pad2(effectiveSolar.getMonth())}-${pad2(effectiveSolar.getDay())}`,
    lunarDate: `${effectiveLunar.getYearInChinese()}年${effectiveLunar.getMonthInChinese()}月${effectiveLunar.getDayInChinese()}`,
    hourKnown,
    inputTime: hourKnown ? `${pad2(solar.getHour())}:${pad2(solar.getMinute())}` : null,
    chartTime: hourKnown ? dateTimeOf(solar) : null,
    timePrecision: hourKnown ? (input.timePrecision ?? (input.minute === undefined ? 'shichen' : 'exact')) : 'unknown',
    timeStandard: 'civil',
    dayBoundary: 'zichu',
    trueSolarApplied: false,
    gender: input.gender === 'male' ? '男' : '女',
    pillars,
    dayMaster: {
      gan: dayGan,
      element: dayElement,
      strength,
      strengthLevel: ws.verdict,
      strengthScore,
      confidence: ws.confidence,
      basis: `v2 加权：得令${ws.breakdown.得令}/长生${ws.breakdown.长生}/得地${ws.breakdown.得地}/得势${ws.breakdown.得势}，合 ${ws.score}（${ws.verdict}·置信${ws.confidence}）${hourKnown ? '' : '·缺时辰按三柱'}`,
    },
    favorableElements,
    tiaoHou,
    pattern: { name: patternName, monthShiShen, basis: geju.basis, confidence: geju.confidence, ...play },
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
    longitude: null,
    trueSolarApplied: false,
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
  if (!row) return null;
  const stored = row.chartJson as unknown as ChartView;
  // v6 统一法定钟表时间并保留 23:00 子初换日，不允许报告现算 v6、对话继续读 v3/v4/v5。
  // v1/v2 仍承载更早算法差异，继续保持可追溯，不在读路径无边界重排。
  if (row.engineVersion !== 'paipan-v3' && row.engineVersion !== 'paipan-v4' && row.engineVersion !== 'paipan-v5') return stored;
  const profile = await prisma.profile.findFirst({ where: { tenantId: row.tenantId }, orderBy: { updatedAt: 'desc' } });
  const savedBazi = (profile?.extraJson as { bazi?: { minute?: unknown } } | null)?.bazi;
  const exactMinute = savedBazi && Object.prototype.hasOwnProperty.call(savedBazi, 'minute')
    ? Number(savedBazi.minute)
    : undefined;
  const [year, month, day] = row.birthDate.split('-').map(Number);
  const input: PaipanInput = {
    calendar: row.calendar === 'lunar' ? 'lunar' : 'solar',
    year, month, day,
    hour: row.birthHour,
    minute: Number.isInteger(exactMinute) ? exactMinute : undefined,
    timePrecision: row.birthHour == null ? 'unknown' : Number.isInteger(exactMinute) ? 'exact' : 'shichen',
    gender: row.gender === 'female' ? 'female' : 'male',
    birthPlace: row.birthPlace ?? undefined,
    longitude: row.longitude ?? undefined,
  };
  const upgraded = computeChart(input, stored.monthlyOutlook?.year ?? new Date().getFullYear());
  await prisma.natalChart.update({
    where: { id: row.id },
    data: {
      engineVersion: PAIPAN_ENGINE_VERSION,
      birthMinute: input.hour == null ? null : input.minute ?? representativeMinute(input.hour),
      longitude: null,
      trueSolarApplied: false,
      chartJson: upgraded as unknown as object,
    },
  });
  return upgraded;
}

/** 命盘 → 注入对话的【天势档案】块（结构化数据 + 使用铁律；AI 只翻译不计算）。 */
export function chartBriefing(chart: ChartView, nowYear: number): string {
  const p = chart.pillars;
  const four = [p.year.ganZhi, p.month.ganZhi, p.day.ganZhi, p.time?.ganZhi ?? '??（时辰不确定）'].join(' ');
  const cur = chart.daYun.list.filter((d) => d.startYear <= nowYear).pop();
  // paipan-v1 存量快照没有 tiaoHou；命盘快照不强制迁移，简报侧需向后兼容。
  const tiaoHouGods = Array.isArray(chart.tiaoHou?.gods) ? chart.tiaoHou.gods : [];
  const tiaoHouElements = Array.isArray(chart.tiaoHou?.elements) ? chart.tiaoHou.elements : [];
  const byPhase = (k: MonthOutlook['phase']) =>
    chart.monthlyOutlook.months.filter((m) => m.phase === k).map((m) => `${m.month}月`).join('、') || '无';
  const turning = chart.monthlyOutlook.months.filter((m) => m.turning).map((m) => `${m.month}月`).join('、') || '无';
  const lines = [
    `【天势档案（系统排盘引擎 ${chart.engineVersion} 计算）】`,
    `四柱：${four}｜日主 ${chart.dayMaster.gan}${chart.dayMaster.element} · ${chart.dayMaster.strength}（${chart.dayMaster.strengthLevel}）｜喜用五行：${chart.favorableElements.join('、')}`,
    ...(tiaoHouGods.length || tiaoHouElements.length
      ? [`调候（寒暖燥湿之需）：用神 ${tiaoHouGods.join('、') || '无'}（五行 ${tiaoHouElements.join('、') || '无'}）——命局逢此则通，可作喜用之参`]
      : []),
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
