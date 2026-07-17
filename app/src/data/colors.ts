// 6 套「本命色」—— 直角案卷体系（对齐 docs/prototype/junshi-app-prototype.dc.html 的 COLORS）。
// 后端 User.benmingColor 仍存旧 key（green/gold/red/blue/purple/iron），本表以 key 为主键**不改后端存储**，
// 只在展示层把旧 key 映射到新 name/motto/hex/acd/acg（见每项 protoKey / mapping）。
// 选色即注入全局本命色三件套 --ac/--acd/--acg（+ 旧别名 --accent* / --green* / --gold*）——
// 由 Screen 内联注入为主，app.scss 的 .theme-{key} 类做兜底。

export interface BenmingColor {
  key: string;       // 后端存储 key（历史值，不改）
  protoKey: string;  // 原型 key（song/hu/dan/dian/yao/shuang）
  name: string;      // 新名：松 · 谋
  short: string;     // 短名：松
  hex: string;       // 本命色 --ac
  acd: string;       // 深色 --acd
  acg: string;       // 辉光/软底 --acg（hex @ ~.12）
  motto: string;     // 军师批语
  wm: string;        // 水印字
  seal: string;      // 印章字
  en: string;        // 拉丁副名
  // —— 兼容旧字段（历史组件仍在读，勿删）——
  cn: string;        // = name
  verdict: string;   // = motto + 。
  vars: Record<string, string>; // 完整令牌注入包（新三件套 + 旧别名）
}

// 生成完整注入包：新令牌 --ac/--acd/--acg + 旧别名，单一事实源。
function pack(hex: string, acd: string, acg: string): Record<string, string> {
  return {
    // 新体系三件套
    '--ac': hex,
    '--acd': acd,
    '--acg': acg,
    // 旧别名（保旧页面不炸）
    '--accent': hex,
    '--accent-deep': acd,
    '--accent-soft': acg,
    '--accent-ink': acd,
    '--accent-bright': hex,
    '--accent-glow': acg,
    '--green': hex,
    '--green-deep': acd,
    '--green-hero': hex,
    '--green-soft': acg,
    '--gold': hex,
    '--gold-deep': acd,
    '--gold-soft': acg,
  };
}

function make(
  key: string, protoKey: string, name: string, short: string,
  hex: string, acd: string, acg: string, motto: string,
  wm: string, seal: string, en: string,
): BenmingColor {
  return {
    key, protoKey, name, short, hex, acd, acg, motto, wm, seal, en,
    cn: name, verdict: motto + '。', vars: pack(hex, acd, acg),
  };
}

// 顺序即原型 COLORS 顺序：松/琥/丹/靛/曜/霜。key 保持后端历史键，第一项默认（松＝墨绿系）。
export const COLORS: BenmingColor[] = [
  make('green', 'song', '松 · 谋', '松', '#2F5D50', '#1E3E35', 'rgba(47,93,80,.12)', '稳中求进，守正出奇', '谋', '松', 'SONG · STRATEGY'),
  make('gold', 'hu', '琥 · 势', '琥', '#B0782A', '#7A5216', 'rgba(176,120,42,.14)', '聚财为势，顺势而为', '势', '琥', 'HU · MOMENTUM'),
  make('red', 'dan', '丹 · 决', '丹', '#BC4A31', '#83301F', 'rgba(188,74,49,.12)', '当机立断，先发制人', '决', '丹', 'DAN · RESOLVE'),
  make('blue', 'dian', '靛 · 远', '靛', '#38516E', '#26374C', 'rgba(56,81,110,.12)', '高瞻远瞩，谋定后动', '远', '靛', 'DIAN · VISION'),
  make('purple', 'yao', '曜 · 局', '曜', '#6E4A66', '#4B3145', 'rgba(110,74,102,.12)', '格局为先，纵横捭阖', '局', '曜', 'YAO · GAMBIT'),
  make('iron', 'shuang', '霜 · 藏', '霜', '#3F6B67', '#294845', 'rgba(63,107,103,.12)', '大巧若拙，藏锋于鞘', '藏', '霜', 'SHUANG · RESERVE'),
];

// 旧 key ↔ 新 protoKey 映射表（供需要时双向查）。
export const KEY_TO_PROTO: Record<string, string> = Object.fromEntries(COLORS.map((c) => [c.key, c.protoKey]));
export const PROTO_TO_KEY: Record<string, string> = Object.fromEntries(COLORS.map((c) => [c.protoKey, c.key]));

export function colorIndex(key: string): number {
  // 兼容传入后端 key 或原型 protoKey
  const i = COLORS.findIndex((c) => c.key === key || c.protoKey === key);
  return i < 0 ? 0 : i;
}

export function colorByKey(key: string): BenmingColor {
  return COLORS[colorIndex(key)];
}

/** 当前主题强调色（用于 Icon 等需要显式颜色的场景） */
export function accentOf(key: string): string {
  return colorByKey(key).hex;
}

/** 本命色令牌注入包（内联到页面根，作为 hex 注入主通道） */
export function benmingVars(key: string): Record<string, string> {
  return colorByKey(key).vars;
}
