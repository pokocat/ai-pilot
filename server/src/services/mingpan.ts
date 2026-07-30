// 命盘报告（八字 × 紫微综合印证）——确定性计算层。
// 铁律：全部命理数据由算法层排出（lunar-typescript + iztro + baziEnrich），零 LLM 参与；
// 印证层为纯规则代码（模板填充 + 算术对齐），同输入同输出、可复算，每条结论带 basis 依据。
// 方法论参考 MIT 上游 bazi-ziwei-skill 的综合印证框架（主轴印证/阶段印证/关键转折/四化落宫），
// 但不复制其 LLM 提示词逻辑——此处只做双盘的确定性对账（喜用 vs 五行局、大运 vs 大限、换运换限重合）。
//
// 复用边界：八字侧完全复用 computeChart（四柱/旺衰/格局/喜用/调候/大运）；
// 紫微全盘复用 buildZiweiAstrolabe（与对话简报命宫/身宫主星同一 iztro 调用口径），保证不生第二套排盘。
import {
  computeChart, buildZiweiAstrolabe, PAIPAN_ENGINE_VERSION,
  type ChartView, type PaipanInput,
} from './paipan.js';
import type { WuXing } from './baziEnrich.js';

// —— 干支五行常量（本气口径，与 paipan.ts 内部私有表一致；此处独立声明以自洽） ——
const GAN_ELEMENT: Record<string, WuXing> = { 甲: '木', 乙: '木', 丙: '火', 丁: '火', 戊: '土', 己: '土', 庚: '金', 辛: '金', 壬: '水', 癸: '水' };
const ZHI_ELEMENT: Record<string, WuXing> = { 子: '水', 丑: '土', 寅: '木', 卯: '木', 辰: '土', 巳: '火', 午: '火', 未: '土', 申: '金', 酉: '金', 戌: '土', 亥: '水' };
const GAN_YINYANG: Record<string, '阳' | '阴'> = { 甲: '阳', 乙: '阴', 丙: '阳', 丁: '阴', 戊: '阳', 己: '阴', 庚: '阳', 辛: '阴', 壬: '阳', 癸: '阴' };

const HUA_ORDER: Record<string, number> = { 禄: 0, 权: 1, 科: 2, 忌: 3 };

// 十二时辰地支序（1-2丑…21-22亥），早子(0)/晚子(23)单列。
const SHICHEN_ZHI = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'];

/**
 * 由原始录入 birthHour 推时辰名（档头显示用户录入口径，非真太阳时校正后钟点——校正另有徽记说明）。
 * 0=早子时、23=晚子时；其余 (hour+1)/2 取地支（1-2丑…21-22亥）。null → null。
 */
export function hourLabelOf(hour: number | null | undefined): string | null {
  if (hour == null) return null;
  if (hour === 0) return '早子时';
  if (hour === 23) return '晚子时';
  return `${SHICHEN_ZHI[Math.floor((hour + 1) / 2)]}时`;
}

/** 固定免责声明（服务端下发，前端页脚直显）。 */
export const MINGPAN_DISCLAIMER =
  '本报告基于传统子平八字与紫微斗数之推演口径，由确定性算法排盘，仅供文化研究与参考，不构成任何决策依据。';

// —— 年度谶语（留存机制 #16）：由命盘确定性派生的七言两句 ——
// 口径同「天命速写」（cardHtml.fateCardContent）：命理文本全部由盘确定性派生，零 LLM。
// 「一年一句·不改不换」是这机制的全部分量所在 → 出谶必须同盘同年必同句（随机/时间戳一律不可用）。
// 结构：上句写命局本气（喜用五行 × 日主旺衰），下句写流年应期（流年天干五行与喜用/日主的生克关系）。
const GEN_TO: Record<WuXing, WuXing> = { 木: '火', 火: '土', 土: '金', 金: '水', 水: '木' }; // 我生

// 上句：喜用五行 × 身弱/身强（借势 / 泄秀两种取象）
const VERSE_OPEN: Record<WuXing, Record<'身弱' | '身强', string>> = {
  木: { 身弱: '春木得雨枝先发', 身强: '林深自有清风来' },
  火: { 身弱: '炉火添薪光渐盛', 身强: '烈焰须风方远明' },
  土: { 身弱: '厚土载物根自稳', 身强: '高原积厚待春耕' },
  金: { 身弱: '顽金入火终成器', 身强: '利刃藏锋不轻鸣' },
  水: { 身弱: '涸辙逢泉鱼自跃', 身强: '大江行舟顺水东' },
};

// 下句：流年五行 × 与命局的关系（顺=流年为喜用 / 平=帮身不入喜用 / 逆=既非喜用又不帮身）× 流年干阴阳。
// 阴阳这一维不是装饰：流年干阴阳逐年交替，有它才保证「新岁必得新谶」——
// 否则甲乙、丙丁这类同五行的相邻两年会出同一句，岁末换谶的仪式感就没了。
type VerseTrend = '顺' | '平' | '逆';
const VERSE_CLOSE: Record<WuXing, Record<VerseTrend, Record<'阳' | '阴', string>>> = {
  木: {
    顺: { 阳: '今岁东风正可乘', 阴: '今岁细雨润新枝' },
    平: { 阳: '今岁培根未见荣', 阴: '今岁静守一枝青' },
    逆: { 阳: '今岁枝繁反损精', 阴: '今岁藤缠须早剪' },
  },
  火: {
    顺: { 阳: '今岁南风助势成', 阴: '今岁一灯照夜明' },
    平: { 阳: '今岁添薪静候明', 阴: '今岁守炉勿扬声' },
    逆: { 阳: '今岁焰高须避锋', 阴: '今岁烟浮宜养神' },
  },
  土: {
    顺: { 阳: '今岁培土正堪耕', 阴: '今岁田畴宜细耘' },
    平: { 阳: '今岁固基缓图名', 阴: '今岁筑垄待雨足' },
    逆: { 阳: '今岁土重宜疏行', 阴: '今岁积尘须勤拂' },
  },
  金: {
    顺: { 阳: '今岁金鸣器已成', 阴: '今岁细锉见锋棱' },
    平: { 阳: '今岁磨砺待时鸣', 阴: '今岁敛锐守其钝' },
    逆: { 阳: '今岁锋寒宜守城', 阴: '今岁刃钝且回炉' },
  },
  水: {
    顺: { 阳: '今岁北水送舟轻', 阴: '今岁静波可稳行' },
    平: { 阳: '今岁蓄流未可行', 阴: '今岁潜渊养其鳞' },
    逆: { 阳: '今岁水泛宜筑堤', 阴: '今岁潮暗慎涉津' },
  },
};

/** 流年天干（干支纪年：天干 (year-4)%10）。 */
function liuNianGan(year: number): string {
  return '甲乙丙丁戊己庚辛壬癸'[(((year - 4) % 10) + 10) % 10];
}

/**
 * 年度谶语：同一命盘 + 同一年 → 恒为同一句（纯函数，可复算）。
 * 存量 v1 命盘快照缺字段时逐级兜底（喜用 → 调候 → 日主本气），不抛错。
 */
export function composeAnnualVerse(chart: ChartView, year: number): string {
  const dm = chart.dayMaster?.element as WuXing;
  const dmElement: WuXing = dm in VERSE_OPEN ? dm : '土'; // 快照字段异常也必出句（此函数在读档案热路径上，不许抛）
  const favorable = [...(chart.favorableElements ?? []), ...(chart.tiaoHou?.elements ?? [])] as WuXing[];
  const key = (favorable.find((e) => e in VERSE_OPEN) ?? dmElement) as WuXing;
  const open = VERSE_OPEN[key][chart.dayMaster?.strength === '身强' ? '身强' : '身弱'];

  const gan = liuNianGan(year);
  const ln = GAN_ELEMENT[gan];
  const trend: VerseTrend = favorable.includes(ln)
    ? '顺'
    : (ln === dmElement || GEN_TO[ln] === dmElement) ? '平' : '逆'; // 同我/生我 = 帮身 → 平
  return `${open}，${VERSE_CLOSE[ln][trend][GAN_YINYANG[gan]]}`;
}

export interface MingpanPalace {
  name: string;
  stem: string;
  branch: string;
  isSoul: boolean;
  isBody: boolean;
  majorStars: Array<{ name: string; brightness: string; mutagen: string | null }>;
  minorStars: string[];
  adjectiveStars: string[];
  decadal: { start: number; end: number } | null; // 虚岁区间
}

export interface MingpanReport {
  engineVersion: string;
  base: {
    solarDate: string;
    lunarDate: string;
    gender: '男' | '女';
    hourKnown: boolean;
    hourLabel: string | null; // 时辰名（由原始录入 birthHour 推，非真太阳时校正后钟点）；缺时辰为 null
    trueSolarApplied: boolean;
    birthPlace?: string | null;
  };
  bazi: {
    pillars: ChartView['pillars'];
    dayMaster: ChartView['dayMaster'];
    favorableElements: string[];
    tiaoHou: { gods: string[]; elements: string[] };
    pattern: ChartView['pattern'];
    daYun: ChartView['daYun'];
    wuxingCount: { counts: Record<WuXing, number>; basis: string };
  };
  ziwei: null | {
    fiveElementsClass: string;
    soulStar: string;
    bodyStar: string;
    yinYang: string;
    soulBranch: string;
    bodyBranch: string;
    palaces: MingpanPalace[];
  };
  yinzheng: null | {
    baziAxis: { text: string; basis: string };
    ziweiAxis: { text: string; basis: string };
    elementCheck: { favorable: string[]; ju: string; juElement: string; aligned: boolean; note: string };
    timeline: Array<{
      years: string; // '2025–2034'
      daYun: { ganZhi: string; startAge: string; startYear: number } | null;
      daXian: { palace: string; start: number; end: number } | null;
      isCurrent: boolean;
    }>;
    keyYears: Array<{ year: number; age: number; reason: string; overlap: boolean }>;
    sihua: Array<{ star: string; hua: '禄' | '权' | '科' | '忌'; palace: string }>;
  };
  disclaimer: string;
}

type Astrolabe = NonNullable<ReturnType<typeof buildZiweiAstrolabe>>;
type ZiweiView = NonNullable<MingpanReport['ziwei']>;

/** 八字五行统计：四柱天干本气 + 地支本气（不计藏干余气），缺时辰按三柱六字。 */
function countWuXing(chart: ChartView): MingpanReport['bazi']['wuxingCount'] {
  const counts: Record<WuXing, number> = { 木: 0, 火: 0, 土: 0, 金: 0, 水: 0 };
  const bump = (el?: WuXing) => { if (el) counts[el] += 1; };
  const pillars = [chart.pillars.year, chart.pillars.month, chart.pillars.day, chart.pillars.time]
    .filter((p): p is ChartView['pillars']['year'] => p != null);
  for (const p of pillars) {
    bump(GAN_ELEMENT[p.ganZhi[0]]);
    bump(ZHI_ELEMENT[p.ganZhi[1]]);
  }
  const n = pillars.length;
  return {
    counts,
    basis: `口径：四柱各取天干本气 + 地支本气（不计藏干中气余气），凡 ${n} 柱 ${n * 2} 字${chart.hourKnown ? '' : '；缺时辰按年月日三柱计六字'}`,
  };
}

/** 展开紫微十二宫为报告视图（宫名/干支/主辅杂曜/亮度四化/大限虚岁）。 */
function buildZiweiView(astro: Astrolabe, chart: ChartView): ZiweiView {
  const palaces: MingpanPalace[] = astro.palaces.map((p) => ({
    name: p.name,
    stem: p.heavenlyStem,
    branch: p.earthlyBranch,
    isSoul: p.name === '命宫',
    isBody: p.isBodyPalace,
    majorStars: p.majorStars.map((s) => ({ name: s.name, brightness: s.brightness ?? '', mutagen: s.mutagen ?? null })),
    minorStars: p.minorStars.map((s) => s.name),
    adjectiveStars: p.adjectiveStars.map((s) => s.name),
    decadal: p.decadal?.range ? { start: p.decadal.range[0], end: p.decadal.range[1] } : null,
  }));
  const yearGan = chart.pillars.year.ganZhi[0];
  return {
    fiveElementsClass: astro.fiveElementsClass,
    soulStar: astro.soul,
    bodyStar: astro.body,
    yinYang: `${GAN_YINYANG[yearGan] ?? ''}${chart.gender}`, // 年干阴阳 + 性别 → 阳男/阴男/阳女/阴女
    soulBranch: astro.earthlyBranchOfSoulPalace,
    bodyBranch: astro.earthlyBranchOfBodyPalace,
    palaces,
  };
}

/** 生年四化落宫：遍历全盘星曜取 mutagen∈{禄权科忌}，按禄权科忌排序（恰四条）。 */
function collectSihua(astro: Astrolabe): NonNullable<MingpanReport['yinzheng']>['sihua'] {
  const out: NonNullable<MingpanReport['yinzheng']>['sihua'] = [];
  for (const p of astro.palaces) {
    for (const s of [...p.majorStars, ...p.minorStars, ...p.adjectiveStars]) {
      if (s.mutagen && s.mutagen in HUA_ORDER) {
        out.push({ star: s.name, hua: s.mutagen as '禄' | '权' | '科' | '忌', palace: p.name });
      }
    }
  }
  return out.sort((a, b) => HUA_ORDER[a.hua] - HUA_ORDER[b.hua]);
}

/** 综合印证（纯规则）：主轴速览 + 五行对照 + 大运大限时间轴 + 关键转折年 + 四化落宫。 */
function buildYinzheng(
  chart: ChartView,
  ziwei: ZiweiView,
  astro: Astrolabe,
  targetYear: number,
): NonNullable<MingpanReport['yinzheng']> {
  const birthYear = Number(chart.solarDate.slice(0, 4));
  const nominalYear = (age: number) => birthYear + age - 1;   // 虚岁 → 公历年
  const nominalAge = (year: number) => year - birthYear + 1;  // 公历年 → 虚岁

  const sihua = collectSihua(astro);

  // —— 主轴速览（模板填充，各带 basis） ——
  const dm = chart.dayMaster;
  const tiaoHouPhrase = chart.tiaoHou.gods.length
    ? `；调候喜${chart.tiaoHou.gods.join('、')}（${chart.tiaoHou.elements.join('、')}），得之则寒暖相济`
    : '';
  const baziAxis = {
    text: `以「${chart.pattern.name}」立局，日主${dm.gan}${dm.element}${dm.strengthLevel}，宜借${chart.favorableElements.join('、')}起势${tiaoHouPhrase}。`,
    basis: `格局依据：${chart.pattern.basis}；旺衰依据：${dm.basis}`,
  };

  const soulPalace = ziwei.palaces.find((p) => p.isSoul);
  const bodyPalace = ziwei.palaces.find((p) => p.isBody);
  const soulMajors = soulPalace?.majorStars.map((s) => s.name) ?? [];
  const soulDesc = soulMajors.length ? `${soulMajors.join('、')}坐守` : '空宫（借对宫论）';
  const lu = sihua.find((s) => s.hua === '禄');
  const luPhrase = lu ? `生年化禄归${lu.star}，落${lu.palace}宫` : '生年化禄不显';
  const yearGan = chart.pillars.year.ganZhi[0];
  const ziweiAxis = {
    text: `命宫${ziwei.soulBranch}，${soulDesc}；身宫落${bodyPalace?.name ?? '—'}宫，${ziwei.fiveElementsClass}。${luPhrase}。`,
    basis: `紫微 iztro 排盘：${ziwei.fiveElementsClass}，命主${ziwei.soulStar}、身主${ziwei.bodyStar}；生年四化按年干${yearGan}起。`,
  };

  // —— 五行对照：八字喜用（含调候）vs 紫微五行局之五行 ——
  const favorable = Array.from(new Set([...chart.favorableElements, ...chart.tiaoHou.elements]));
  const ju = ziwei.fiveElementsClass;              // 如「木三局」
  const juElement = ju.slice(0, 1);                // 局之五行「木」
  const aligned = favorable.includes(juElement as WuXing);
  const elementCheck = {
    favorable,
    ju,
    juElement,
    aligned,
    note: aligned
      ? '同气相求：紫微五行局与八字喜用同气，先天气数与后天调候相扶，可循此气借势。'
      : '局与喜用异路：五行局非喜用之气，当以八字体用为主，五行局仅作性情底色参看。',
  };

  // —— 大运大限时间轴：以八字大运 8 步为脊，逐步挂对应紫微大限段 ——
  const daXianSegs = astro.palaces
    .filter((p) => p.decadal?.range)
    .map((p) => ({
      palace: p.name,
      startAge: p.decadal.range[0],
      endAge: p.decadal.range[1],
      startYear: nominalYear(p.decadal.range[0]),
      endYear: nominalYear(p.decadal.range[1]),
    }))
    .sort((a, b) => a.startAge - b.startAge);

  const steps = chart.daYun.list;
  const timeline = steps.map((step, i) => {
    const startYear = step.startYear;
    const endYear = i + 1 < steps.length ? steps[i + 1].startYear - 1 : startYear + 9;
    const dx = daXianSegs.find((d) => startYear >= d.startYear && startYear <= d.endYear)
      ?? daXianSegs.find((d) => d.startYear >= startYear && d.startYear <= endYear)
      ?? null;
    return {
      years: `${startYear}–${endYear}`,
      daYun: { ganZhi: step.ganZhi, startAge: `${step.startAge}岁起`, startYear: step.startYear },
      daXian: dx ? { palace: dx.palace, start: dx.startAge, end: dx.endAge } : null,
      isCurrent: targetYear >= startYear && targetYear <= endYear,
    };
  });

  // —— 关键转折年：换大运年 ∪ 换大限年（限于八字大运覆盖窗内），相差≤1 年记重合（权重×2） ——
  const lastYunEnd = steps.length ? steps[steps.length - 1].startYear + 9 : birthYear;
  const events: Array<{ year: number; kind: '运' | '限' }> = [
    ...steps.map((s) => ({ year: s.startYear, kind: '运' as const })),
    ...daXianSegs
      .filter((d) => d.startYear >= birthYear && d.startYear <= lastYunEnd)
      .map((d) => ({ year: d.startYear, kind: '限' as const })),
  ].sort((a, b) => a.year - b.year);

  const used = new Array(events.length).fill(false);
  const keyYears: NonNullable<MingpanReport['yinzheng']>['keyYears'] = [];
  for (let i = 0; i < events.length; i++) {
    if (used[i]) continue;
    // 找异类（运↔限）且相差≤1 年的未用伙伴 → 判「换运换限重合」
    const partner = events.findIndex((e, j) => !used[j] && j !== i && e.kind !== events[i].kind && Math.abs(e.year - events[i].year) <= 1);
    if (partner >= 0) {
      used[i] = true;
      used[partner] = true;
      const year = Math.min(events[i].year, events[partner].year);
      keyYears.push({ year, age: nominalAge(year), reason: '换运换限重合', overlap: true });
    } else {
      used[i] = true;
      keyYears.push({ year: events[i].year, age: nominalAge(events[i].year), reason: events[i].kind === '运' ? '换运' : '换限', overlap: false });
    }
  }
  keyYears.sort((a, b) => a.year - b.year);

  return { baziAxis, ziweiAxis, elementCheck, timeline, keyYears, sihua };
}

/**
 * 命盘报告主入口：八字侧复用 computeChart，紫微全盘复用 buildZiweiAstrolabe，再做确定性印证。
 * 缺时辰（birthHour==null）：ziwei/yinzheng 为 null，八字侧照常（三柱）。同输入同输出。
 */
export function buildMingpanReport(input: PaipanInput, targetYear: number): MingpanReport {
  const chart = computeChart(input, targetYear);
  const astro = buildZiweiAstrolabe(input);

  const base: MingpanReport['base'] = {
    solarDate: chart.solarDate,
    lunarDate: chart.lunarDate,
    gender: chart.gender,
    hourKnown: chart.hourKnown,
    hourLabel: hourLabelOf(input.hour), // 原始录入口径（真太阳时校正另有徽记说明）
    trueSolarApplied: chart.trueSolarApplied,
    birthPlace: input.birthPlace ?? null,
  };

  const bazi: MingpanReport['bazi'] = {
    pillars: chart.pillars,
    dayMaster: chart.dayMaster,
    favorableElements: chart.favorableElements,
    tiaoHou: chart.tiaoHou,
    pattern: chart.pattern,
    daYun: chart.daYun,
    wuxingCount: countWuXing(chart),
  };

  if (!astro) {
    return { engineVersion: PAIPAN_ENGINE_VERSION, base, bazi, ziwei: null, yinzheng: null, disclaimer: MINGPAN_DISCLAIMER };
  }

  const ziwei = buildZiweiView(astro, chart);
  const yinzheng = buildYinzheng(chart, ziwei, astro, targetYear);
  return { engineVersion: PAIPAN_ENGINE_VERSION, base, bazi, ziwei, yinzheng, disclaimer: MINGPAN_DISCLAIMER };
}
