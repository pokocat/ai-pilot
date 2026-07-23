// 八字解读加持层：加权旺衰 / 月令取格 / 调候用神。
//
// 算法来源：移植自开源工程 bazi-ziwei-skill（MIT License, Copyright (c) 2026 dzcmemory-web,
//   https://github.com/dzcmemory-web/bazi-ziwei-skill，calculator/bazi-enrich/{wang-shuai,ge-ju,tiao-hou,tables}.ts）。
//   其算法自包含、确定性、纯 TypeScript、无外部依赖，适合内嵌。本文件按仓库约定改写：
//   ①四柱来源换成本仓 lunar-typescript 已排好的干支（不重复排盘）；
//   ②时柱可缺（缺时辰 → 三柱评分/取格，不虚构时柱）；
//   ③导出为纯函数，喂给 paipan.ts 组装 ChartView。
//
// 相比旧版「得令40/得地各10/得助各10」的粗计分，本层改进：
//   - 旺衰 = 月令(本气十神加权 + 余气) + 长生位修正 + 得地(年日时三支藏干本/中/余气分权) + 得势(年月时三干)，
//     子平主流的月令权重最高、透根分层；输出 5 档结论(极旺/偏旺/中和/偏弱/极弱)+置信度。
//   - 格局按月令藏干「透干」取格（纯气月支直接立格；四生/四库看透干），非旧版只取本气。
//   - 新增调候用神（穷通宝鉴 120 格查表），补足寒暖燥湿的用神视角。

export type Tiangan = '甲' | '乙' | '丙' | '丁' | '戊' | '己' | '庚' | '辛' | '壬' | '癸';
export type Dizhi = '子' | '丑' | '寅' | '卯' | '辰' | '巳' | '午' | '未' | '申' | '酉' | '戌' | '亥';
export type WuXing = '木' | '火' | '土' | '金' | '水';
export type YinYang = '阳' | '阴';
export type ShiShen = '比肩' | '劫财' | '食神' | '伤官' | '偏财' | '正财' | '七杀' | '正官' | '偏印' | '正印';

const DIZHI: Dizhi[] = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'];

export const GAN_WUXING: Record<Tiangan, WuXing> = {
  甲: '木', 乙: '木', 丙: '火', 丁: '火', 戊: '土', 己: '土', 庚: '金', 辛: '金', 壬: '水', 癸: '水',
};
const GAN_YINYANG: Record<Tiangan, YinYang> = {
  甲: '阳', 乙: '阴', 丙: '阳', 丁: '阴', 戊: '阳', 己: '阴', 庚: '阳', 辛: '阴', 壬: '阳', 癸: '阴',
};

// 地支藏干 — 本气、中气、余气
const ZHI_CANG_GAN: Record<Dizhi, Array<{ gan: Tiangan; role: '本气' | '中气' | '余气' }>> = {
  子: [{ gan: '癸', role: '本气' }],
  丑: [{ gan: '己', role: '本气' }, { gan: '癸', role: '中气' }, { gan: '辛', role: '余气' }],
  寅: [{ gan: '甲', role: '本气' }, { gan: '丙', role: '中气' }, { gan: '戊', role: '余气' }],
  卯: [{ gan: '乙', role: '本气' }],
  辰: [{ gan: '戊', role: '本气' }, { gan: '乙', role: '中气' }, { gan: '癸', role: '余气' }],
  巳: [{ gan: '丙', role: '本气' }, { gan: '庚', role: '中气' }, { gan: '戊', role: '余气' }],
  午: [{ gan: '丁', role: '本气' }, { gan: '己', role: '中气' }],
  未: [{ gan: '己', role: '本气' }, { gan: '丁', role: '中气' }, { gan: '乙', role: '余气' }],
  申: [{ gan: '庚', role: '本气' }, { gan: '壬', role: '中气' }, { gan: '戊', role: '余气' }],
  酉: [{ gan: '辛', role: '本气' }],
  戌: [{ gan: '戊', role: '本气' }, { gan: '辛', role: '中气' }, { gan: '丁', role: '余气' }],
  亥: [{ gan: '壬', role: '本气' }, { gan: '甲', role: '中气' }],
};

function shengKe(a: WuXing, b: WuXing): '生' | '克' | '同' | '被生' | '被克' {
  if (a === b) return '同';
  const sheng: Record<WuXing, WuXing> = { 木: '火', 火: '土', 土: '金', 金: '水', 水: '木' };
  const ke: Record<WuXing, WuXing> = { 木: '土', 火: '金', 土: '水', 金: '木', 水: '火' };
  if (sheng[a] === b) return '生';
  if (ke[a] === b) return '克';
  if (sheng[b] === a) return '被生';
  if (ke[b] === a) return '被克';
  return '同'; // unreachable
}

// 十神 — 以日干为基准对其他天干
function getShiShen(dayMaster: Tiangan, target: Tiangan): ShiShen {
  const sameYy = GAN_YINYANG[dayMaster] === GAN_YINYANG[target];
  switch (shengKe(GAN_WUXING[dayMaster], GAN_WUXING[target])) {
    case '同': return sameYy ? '比肩' : '劫财';
    case '生': return sameYy ? '食神' : '伤官'; // 日主生他
    case '克': return sameYy ? '偏财' : '正财'; // 日主克他
    case '被克': return sameYy ? '七杀' : '正官'; // 他克日主
    case '被生': return sameYy ? '偏印' : '正印'; // 他生日主
  }
}

// 十二长生 — 阳干顺行、阴干逆行
const CHANG_SHENG_START: Record<Tiangan, Dizhi> = {
  甲: '亥', 丙: '寅', 戊: '寅', 庚: '巳', 壬: '申',
  乙: '午', 丁: '酉', 己: '酉', 辛: '子', 癸: '卯',
};
const CHANG_SHENG_ORDER = ['长生', '沐浴', '冠带', '临官', '帝旺', '衰', '病', '死', '墓', '绝', '胎', '养'] as const;
export type ChangSheng = typeof CHANG_SHENG_ORDER[number];

function getChangSheng(gan: Tiangan, zhi: Dizhi): ChangSheng {
  const startIdx = DIZHI.indexOf(CHANG_SHENG_START[gan]);
  const zhiIdx = DIZHI.indexOf(zhi);
  const forward = GAN_YINYANG[gan] === '阳';
  const step = forward ? (zhiIdx - startIdx + 12) % 12 : (startIdx - zhiIdx + 12) % 12;
  return CHANG_SHENG_ORDER[step];
}

// 调候用神 — 穷通宝鉴 120 格（日干 × 月支），主用神在前。子平派主流取用，流派间有微调。
const TIAO_HOU: Record<Tiangan, Record<Dizhi, string[]>> = {
  甲: {
    子: ['丁', '庚', '丙'], 丑: ['丁', '庚', '丙'], 寅: ['丙', '癸'],
    卯: ['庚', '丙', '丁', '戊', '己'], 辰: ['庚', '丁', '壬'], 巳: ['癸', '丁', '庚'],
    午: ['癸', '丁', '庚'], 未: ['癸', '丁', '庚'], 申: ['庚', '丁', '壬'],
    酉: ['庚', '丙', '丁'], 戌: ['庚', '甲', '壬', '癸'], 亥: ['庚', '丁', '戊', '丙'],
  },
  乙: {
    子: ['丙', '戊'], 丑: ['丙'], 寅: ['丙', '癸'],
    卯: ['丙', '癸'], 辰: ['癸', '丙', '戊'], 巳: ['癸'],
    午: ['癸', '丙'], 未: ['癸', '丙'], 申: ['丙', '癸', '己'],
    酉: ['癸', '丁', '丙'], 戌: ['癸', '辛'], 亥: ['丙', '戊'],
  },
  丙: {
    子: ['壬', '戊', '己'], 丑: ['壬', '甲'], 寅: ['壬', '庚'],
    卯: ['壬', '己'], 辰: ['壬', '甲'], 巳: ['壬', '庚', '癸'],
    午: ['壬', '庚'], 未: ['壬', '庚'], 申: ['壬', '戊'],
    酉: ['壬', '癸'], 戌: ['甲', '壬'], 亥: ['甲', '戊', '庚', '壬'],
  },
  丁: {
    子: ['甲', '庚'], 丑: ['甲', '庚'], 寅: ['庚', '壬'],
    卯: ['庚', '甲'], 辰: ['甲', '庚'], 巳: ['甲', '庚'],
    午: ['壬', '庚', '癸'], 未: ['甲', '壬', '庚'], 申: ['甲', '庚', '丙', '戊'],
    酉: ['甲', '庚', '丙', '戊'], 戌: ['甲', '庚', '戊'], 亥: ['甲', '庚'],
  },
  戊: {
    子: ['丙', '甲'], 丑: ['丙', '甲'], 寅: ['丙', '甲', '癸'],
    卯: ['丙', '甲', '癸'], 辰: ['甲', '丙', '癸'], 巳: ['甲', '丙', '癸'],
    午: ['壬', '甲', '丙'], 未: ['癸', '丙', '甲'], 申: ['丙', '癸', '甲'],
    酉: ['丙', '癸'], 戌: ['甲', '丙', '癸'], 亥: ['甲', '丙'],
  },
  己: {
    子: ['丙', '甲', '戊'], 丑: ['丙', '甲', '戊'], 寅: ['丙', '庚', '甲'],
    卯: ['甲', '癸', '丙'], 辰: ['丙', '癸', '甲'], 巳: ['癸', '丙'],
    午: ['癸', '丙'], 未: ['癸', '丙'], 申: ['丙', '癸'],
    酉: ['丙', '癸'], 戌: ['甲', '丙', '癸'], 亥: ['丙', '甲', '戊'],
  },
  庚: {
    子: ['丁', '甲', '丙'], 丑: ['丙', '丁', '甲'], 寅: ['丙', '甲', '壬'],
    卯: ['丁', '甲', '庚', '丙'], 辰: ['甲', '丁', '壬', '癸'], 巳: ['壬', '戊', '丙', '丁'],
    午: ['壬', '癸'], 未: ['丁', '甲'], 申: ['丁', '甲'],
    酉: ['丁', '甲', '丙'], 戌: ['甲', '壬'], 亥: ['丁', '丙'],
  },
  辛: {
    子: ['丙', '戊', '壬', '甲'], 丑: ['丙', '壬', '戊', '己'], 寅: ['己', '壬', '庚'],
    卯: ['壬', '甲'], 辰: ['壬', '甲'], 巳: ['壬', '甲', '癸'],
    午: ['壬', '己', '癸'], 未: ['壬', '庚', '甲'], 申: ['壬', '甲', '戊'],
    酉: ['壬', '甲'], 戌: ['壬', '甲'], 亥: ['壬', '丙'],
  },
  壬: {
    子: ['戊', '丙'], 丑: ['丙', '丁', '甲'], 寅: ['庚', '丙', '戊'],
    卯: ['戊', '辛', '庚'], 辰: ['甲', '庚'], 巳: ['壬', '辛', '庚', '癸'],
    午: ['癸', '庚', '辛'], 未: ['辛', '甲'], 申: ['戊', '丁'],
    酉: ['甲', '庚'], 戌: ['甲', '丙'], 亥: ['戊', '丙', '庚'],
  },
  癸: {
    子: ['丙', '辛'], 丑: ['丙', '丁'], 寅: ['辛', '丙'],
    卯: ['庚', '辛'], 辰: ['丙', '辛', '甲'], 巳: ['辛'],
    午: ['庚', '辛', '壬', '癸'], 未: ['庚', '辛', '壬', '癸'], 申: ['丁'],
    酉: ['辛', '丙'], 戌: ['辛', '甲', '壬', '癸'], 亥: ['庚', '辛', '戊', '丁'],
  },
};

// —— 四柱输入：时柱可缺（缺时辰按三柱评分/取格） ——
export type GanZhi = { gan: Tiangan; zhi: Dizhi };
export interface SiZhu {
  年: GanZhi;
  月: GanZhi;
  日: GanZhi;
  时?: GanZhi | null;
}

type Pillar = '年' | '月' | '日' | '时';

// ============ 旺衰判定 ============

export type WangShuaiVerdict = '极旺(可能从强)' | '偏旺' | '中和' | '偏弱' | '极弱(可能从弱)';

export interface WangShuaiResult {
  score: number;
  verdict: WangShuaiVerdict;
  confidence: '高' | '中' | '低';
  breakdown: { 得令: number; 长生: number; 得地: number; 得势: number; details: string[] };
}

// 月令(月支本气)对日干的关系打分
function scoreMonthOrder(dayMaster: Tiangan, monthZhi: Dizhi): { score: number; desc: string } {
  const cangGan = ZHI_CANG_GAN[monthZhi];
  const benqi = cangGan[0].gan;
  const ss = getShiShen(dayMaster, benqi);
  let extra = 0;
  const extraDesc: string[] = [];
  for (const cg of cangGan.slice(1)) {
    const ssY = getShiShen(dayMaster, cg.gan);
    if (ssY === '比肩' || ssY === '劫财') { extra += 1; extraDesc.push(`月余气${cg.gan}比劫+1`); }
    else if (ssY === '正印' || ssY === '偏印') { extra += 0.7; extraDesc.push(`月余气${cg.gan}印+0.7`); }
  }
  let base = 0;
  let baseDesc = '';
  switch (ss) {
    case '比肩': case '劫财': base = 5; baseDesc = `月支本气${benqi}=${ss}(建禄/月刃) +5`; break;
    case '正印': case '偏印': base = 3; baseDesc = `月支本气${benqi}=${ss} +3`; break;
    case '食神': case '伤官': base = -3; baseDesc = `月支本气${benqi}=${ss} -3`; break;
    case '正官': case '七杀': base = -4; baseDesc = `月支本气${benqi}=${ss} -4`; break;
    case '偏财': case '正财': base = -5; baseDesc = `月支本气${benqi}=${ss} -5`; break;
  }
  return { score: base + extra, desc: [baseDesc, ...extraDesc].join('; ') };
}

// 日干在月支的长生位修正
function scoreChangSheng(dayMaster: Tiangan, monthZhi: Dizhi): { score: number; desc: string } {
  const cs = getChangSheng(dayMaster, monthZhi);
  let s = 0;
  if (cs === '长生' || cs === '帝旺') s = 2;
  else if (cs === '临官' || cs === '冠带') s = 1;
  else if (cs === '沐浴' || cs === '衰') s = 0;
  else if (cs === '病' || cs === '死') s = -1;
  else s = -3; // 墓/绝/胎/养
  return { score: s, desc: `日主${dayMaster}在月支${monthZhi}为${cs} (${s >= 0 ? '+' : ''}${s})` };
}

// 得地: 年/日/时三支查同行/印的根（缺时辰则只查年/日）
function scoreGround(dayMaster: Tiangan, siZhu: SiZhu): { score: number; desc: string[] } {
  const desc: string[] = [];
  let total = 0;
  const ps: Pillar[] = siZhu.时 ? ['年', '日', '时'] : ['年', '日'];
  for (const p of ps) {
    const zhi = (siZhu[p] as GanZhi).zhi;
    for (const cg of ZHI_CANG_GAN[zhi]) {
      const ss = getShiShen(dayMaster, cg.gan);
      if (ss === '比肩' || ss === '劫财') {
        const v = cg.role === '本气' ? 2 : cg.role === '中气' ? 0.8 : 0.5;
        total += v;
        desc.push(`${p}支${zhi}藏${cg.gan}(${ss}, ${cg.role}) +${v}`);
      } else if (ss === '正印' || ss === '偏印') {
        const v = cg.role === '本气' ? 1 : cg.role === '中气' ? 0.5 : 0.3;
        total += v;
        desc.push(`${p}支${zhi}藏${cg.gan}(${ss}, ${cg.role}) +${v}`);
      }
    }
  }
  return { score: total, desc };
}

// 得势: 年/月/时干（缺时辰则只查年/月）
function scoreStems(dayMaster: Tiangan, siZhu: SiZhu): { score: number; desc: string[] } {
  const desc: string[] = [];
  let total = 0;
  const ps: Pillar[] = siZhu.时 ? ['年', '月', '时'] : ['年', '月'];
  for (const p of ps) {
    const gan = (siZhu[p] as GanZhi).gan;
    const ss = getShiShen(dayMaster, gan);
    let v = 0;
    if (ss === '比肩' || ss === '劫财') v = 1;
    else if (ss === '正印' || ss === '偏印') v = 0.7;
    else if (ss === '食神' || ss === '伤官') v = -0.5;
    else if (ss === '正财' || ss === '偏财') v = -1;
    else if (ss === '正官' || ss === '七杀') v = -1.5;
    total += v;
    desc.push(`${p}干${gan}(${ss}) ${v >= 0 ? '+' : ''}${v}`);
  }
  return { score: total, desc };
}

export function judgeWangShuai(siZhu: SiZhu): WangShuaiResult {
  const dm = siZhu.日.gan;
  const monthZhi = siZhu.月.zhi;
  const month = scoreMonthOrder(dm, monthZhi);
  const cs = scoreChangSheng(dm, monthZhi);
  const ground = scoreGround(dm, siZhu);
  const stems = scoreStems(dm, siZhu);
  const score = +(month.score + cs.score + ground.score + stems.score).toFixed(2);

  // 阈值不对称: 月令对负向影响更直接, 偏弱区门槛略宽
  let verdict: WangShuaiVerdict;
  if (score >= 8) verdict = '极旺(可能从强)';
  else if (score >= 3) verdict = '偏旺';
  else if (score > -2.5) verdict = '中和';
  else if (score > -8) verdict = '偏弱';
  else verdict = '极弱(可能从弱)';

  const dist = Math.min(Math.abs(score - 3), Math.abs(score - (-2.5)), Math.abs(score - 8), Math.abs(score - (-8)));
  const confidence: '高' | '中' | '低' = dist > 2 ? '高' : dist > 0.8 ? '中' : '低';

  return {
    score,
    verdict,
    confidence,
    breakdown: {
      得令: +month.score.toFixed(2),
      长生: cs.score,
      得地: +ground.score.toFixed(2),
      得势: +stems.score.toFixed(2),
      details: [month.desc, cs.desc, ...ground.desc, ...stems.desc],
    },
  };
}

// 5 档旺衰 → 身强/身弱 二分（前端与 chartBriefing 沿用二分口径）：
// 偏旺/极旺 → 身强；偏弱/极弱 → 身弱；中和按分数正负定（≥0 作身强，倾向自立）。
export function toBinaryStrength(r: WangShuaiResult): '身强' | '身弱' {
  if (r.verdict === '极旺(可能从强)' || r.verdict === '偏旺') return '身强';
  if (r.verdict === '偏弱' || r.verdict === '极弱(可能从弱)') return '身弱';
  return r.score >= 0 ? '身强' : '身弱';
}

// ============ 格局判定（月令取格 + 透干） ============

const SHI_SHEN_TO_GE: Record<ShiShen, string> = {
  比肩: '比肩格', 劫财: '劫财格', 食神: '食神格', 伤官: '伤官格', 偏财: '偏财格',
  正财: '正财格', 七杀: '七杀格', 正官: '正官格', 偏印: '偏印格', 正印: '正印格',
};

export interface GeJuResult {
  primary: string;       // 主格局（必属 10 个标准格之一，与 PATTERN_PLAYBOOK 兼容）
  basis: string;         // 立格依据
  透干: Tiangan[];       // 月令藏干中透出天干的列表
  confidence: '高' | '中' | '低';
  notes: string[];       // 特殊提示（建禄/羊刃/格不纯等）
}

export function judgeGeJu(siZhu: SiZhu): GeJuResult {
  const dm = siZhu.日.gan;
  const monthZhi = siZhu.月.zhi;
  const cangGan = ZHI_CANG_GAN[monthZhi];
  const benqi = cangGan[0].gan;
  const benqiSS = getShiShen(dm, benqi);

  // 天干透出：年/月/时干（缺时辰则只看年/月）
  const otherGans: Tiangan[] = [siZhu.年.gan, siZhu.月.gan, ...(siZhu.时 ? [siZhu.时.gan] : [])];
  const tougan: Tiangan[] = cangGan.filter((cg) => otherGans.includes(cg.gan)).map((cg) => cg.gan);

  const notes: string[] = [];
  const isPure = ['子', '午', '卯', '酉'].includes(monthZhi); // 四正纯气月支直接立格
  let primary: string;
  let basis: string;
  let confidence: '高' | '中' | '低' = '高';

  if (isPure) {
    primary = SHI_SHEN_TO_GE[benqiSS];
    basis = `月支${monthZhi}本气${benqi}(${benqiSS}) — 纯气月支直接立格`;
  } else {
    const touSS = tougan
      .map((g) => ({ gan: g, ss: getShiShen(dm, g) }))
      .filter((x) => x.ss !== '比肩' && x.ss !== '劫财'); // 比劫一般不优先以透立格
    if (touSS.length > 0) {
      const benqiTou = touSS.find((x) => x.gan === benqi);
      if (benqiTou) {
        primary = SHI_SHEN_TO_GE[benqiTou.ss];
        basis = `月支${monthZhi}本气${benqi}透干 (${benqiTou.ss})`;
      } else {
        const first = touSS[0];
        primary = SHI_SHEN_TO_GE[first.ss];
        basis = `月支${monthZhi}藏干${first.gan}透干 (${first.ss})`;
        confidence = '中';
        notes.push(`月支本气${benqi}未透, 取藏干${first.gan}立格(${first.ss}格)`);
      }
    } else {
      primary = SHI_SHEN_TO_GE[benqiSS];
      basis = `月支${monthZhi}本气${benqi}(${benqiSS}) — 本气未透, 以本气论格`;
      if (benqiSS !== '比肩' && benqiSS !== '劫财') confidence = '中';
    }
  }

  // 比肩/劫财：按现代命名立格，同时按传统派看日干在月支长生位补 notes（建禄/羊刃）
  if (benqiSS === '比肩') {
    primary = '比肩格';
    basis = `月支本气${benqi}=日主同行(比肩) — 比肩格`;
    confidence = '高';
    notes.length = 0;
    const cs = getChangSheng(dm, monthZhi);
    notes.push(cs === '临官'
      ? `日干${dm}在月支${monthZhi}为临官 — 传统称"建禄格"`
      : `日干${dm}在月支${monthZhi}为${cs}(非临官) — 传统子平派不立建禄, 现代按比肩格论`);
  } else if (benqiSS === '劫财') {
    primary = '劫财格';
    basis = `月支本气${benqi}=日主劫财 — 劫财格`;
    confidence = '高';
    notes.length = 0;
    const cs = getChangSheng(dm, monthZhi);
    if (cs === '帝旺') {
      const trad = GAN_YINYANG[dm] === '阳' ? '羊刃格' : '月刃格(阴干月刃有争议)';
      notes.push(`日干${dm}在月支${monthZhi}为帝旺 — 传统称"${trad}"`);
    } else {
      notes.push(`日干${dm}在月支${monthZhi}为${cs}(非帝旺) — 传统不立月刃, 现代按劫财格论`);
    }
  }

  return { primary, basis, 透干: tougan, confidence, notes };
}

// ============ 调候用神 ============

export function getTiaoHou(dayMaster: Tiangan, monthZhi: Dizhi): string[] {
  return TIAO_HOU[dayMaster][monthZhi];
}

// 调候用神（天干）→ 去重五行，便于「调候五行」注入。
export function tiaoHouElements(gods: string[]): WuXing[] {
  const out: WuXing[] = [];
  for (const g of gods) {
    const wx = GAN_WUXING[g as Tiangan];
    if (wx && !out.includes(wx)) out.push(wx);
  }
  return out;
}
