// 海报 HTML 模板（3:4 版式池，按信息密度分档）。输入 = 规整后的 brief + 视觉哲学 + 资产签名 URL，
// 输出 = 自包含 HTML。密度定义见 config.TEMPLATE_CATALOG（名称/描述/密度的唯一真源）。
//
// 硬约束（design-philosophy.md §3 / 方案 §8.3）：
//   ① 画布固定 540×720（渲染时 @2x → 1080×1440 PNG），**不引用任何外链资源**：
//      图片只能是 OSS 短签名 URL 或 data URI，字体只用镜像内置字型栈（不 @import、不下载）；
//   ② 布局用**固定网格 + 文档流**（flex column / grid），不用绝对定位堆叠——绝对定位一旦文案变长
//      就会重叠，而重叠是最难在测试里发现、最容易在真机上出丑的缺陷；
//   ③ 主标题最多两行溢出省略、卖点最多 3 条、二维码固定右下角带静区、Logo 等比限高不拉伸；
//   ④ 底部「AI 生成」标识默认渲染、不可整体关闭（《人工智能生成合成内容标识办法》2025-09-01 施行）。
// 文字排版手法参考 services/cardHtml.ts（同一套品牌 CSS 习惯：宋体标题 + 无衬线正文 + 金色点睛）。
import type { NormalizedPosterBrief } from './schema.js';
import type { VisualPhilosophy } from './philosophy.js';
import type { TemplateKey } from './config.js';

/** 画布逻辑尺寸（3:4）。真实像素 = 本值 × deviceScaleFactor。 */
export const CANVAS = { width: 540, height: 720, scale: 2 } as const;
/** 画布根元素 class。渲染器的溢出量测要对准它（不是 document），改名务必同步 renderer.ts。 */
export const CANVAS_CLASS = 'poster';

/** 中文字体栈：全部为镜像内置或系统自带；不下载、不外链。
 *  必须同时写 Pan-CJK 名（"Noto Sans CJK SC"）和 Google Fonts 子集名（"Noto Sans SC"）——
 *  它们是两个不同的 family，装了前者不代表后者能命中。2026-07-29 在生产 ECS
 *  （Alibaba Cloud Linux 4 + google-noto-cjk 包）实测：
 *    fc-match "Noto Sans SC"   -> NotoSans-VF.ttf（纯拉丁，无中文字形）
 *    fc-match "Noto Serif SC"  -> NotoSans-VF.ttf（同上，连衬线都不是）
 *    fc-match "Noto Sans CJK SC" -> NotoSansCJKsc-Regular.otf ✓
 *  只写子集名会让整个栈落空到通用 sans-serif（也是纯拉丁），中文全靠 Chromium
 *  逐字回退，衬线/无衬线的版式区分随之丢失。 */
/** ★ 同时也是 AI 排版引擎提示词里唯一允许的两个字体栈（canvasEngine 直接引用本常量，
 *  绝不在提示词里另抄一份——抄一份就等于给「生产字体栈落空」这个已经踩过的坑留了第二个入口）。 */
export const FONT_SANS = '"Noto Sans SC", "Noto Sans CJK SC", "Source Han Sans SC", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
export const FONT_SERIF = '"Noto Serif SC", "Noto Serif CJK SC", "Source Han Serif SC", "Songti SC", "STSong", "SimSun", serif';

/** AI 生成标识文案（默认渲染，样式可配，整体不可关）。 */
export const AI_MARK_TEXT = 'AI 生成内容 · 军师参谋部';

export interface TemplateAssets {
  /** 人物照签名 URL 或 data URI（可空；standard 可做无主视觉纯排版）。 */
  portraitUrl?: string | null;
  logoUrl?: string | null;
  qrUrl?: string | null;
  /** 图片模型产出的主视觉（无文字）签名 URL；有它时优先于 portraitUrl 作背景。 */
  visualUrl?: string | null;
}

export interface TemplateInput {
  brief: NormalizedPosterBrief;
  philosophy: VisualPhilosophy;
  assets: TemplateAssets;
}

/**
 * 落款（常量）。曾是 `TemplateInput.signature?` 可选入参 + `signatureOf()` 截断到 SIGNATURE_MAX ——
 * 注释写着「P4 可传用户/企业名」，但 P4 已上线且没有任何调用点传值，等于一个只有兜底分支的参数。
 * 二期真要放开自定义落款，必须连着"每个文字块都有上界"这条版面预算一起做：当年真实渲染验证里，
 * 一个 600 字落款把主视觉带整条挤没了（未裁字，但画面已不是设计的样子）——所以那时要重新加回截断。
 */
const SIGNATURE = '军师参谋部';

function esc(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * 图片 URL 只允许 https / http / data:image。
 * 这是渲染期最后一道防线：签名 URL 来自服务端自己，但模板同时接受 P4 传入的值，
 * 放行 `javascript:` 之类的伪协议等于把无头浏览器变成执行环境。
 */
function safeUrl(u?: string | null): string | null {
  const s = (u ?? '').trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/i.test(s)) return s;
  return null;
}

/** 色板取用：深色承重 / 中间色铺陈 / 金属色点睛 / 纸底。不足位用同色系兜底。 */
function palette(p: VisualPhilosophy): { ink: string; mid: string; accent: string; paper: string } {
  const c = p.palette.filter(Boolean);
  return {
    ink: c[0] ?? '#16191D',
    mid: c[1] ?? '#1E5A43',
    accent: c[2] ?? '#9B7C3F',
    paper: c[3] ?? '#F5F3EE',
  };
}

/* ───────────────── 公共 CSS ───────────────── */

function baseCss(p: VisualPhilosophy): string {
  const c = palette(p);
  return `
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{width:${CANVAS.width}px;height:${CANVAS.height}px}
  body{font-family:${FONT_SANS};color:${c.ink};background:${c.paper};overflow:hidden;
    -webkit-font-smoothing:antialiased;text-rendering:geometricPrecision}
  /* 画布：固定尺寸 + flex 列，所有区块走文档流按序堆叠（不用绝对定位，文案变长也不会重叠）。 */
  .poster{width:${CANVAS.width}px;height:${CANVAS.height}px;display:flex;flex-direction:column;position:relative;overflow:hidden}
  /* ★ 竖向弹性契约：**文字块一律不收缩**（flex-shrink:0），高度不足时由「图片带」(.elastic) 让位。
     理由：照片矮一点没人看得出来，句子被裁掉半个笔画是硬缺陷。此前把文字块设成可收缩 +
     overflow:hidden，几像素的高度赤字就会把最后一条卖点切一半（真实渲染验证时复现）。 */
  .poster > *{flex-shrink:0}
  .elastic{flex:1 1 auto;min-height:0}
  /* 两行截断：超出以省略号收口，绝不撑破画布。 */
  .clamp2{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  .clamp1{display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden}
  .headline{font-family:${FONT_SERIF};font-weight:700;letter-spacing:.01em}
  .sub{font-weight:500;opacity:.82}
  .points{display:flex;flex-direction:column;gap:9px}
  .point{display:flex;gap:8px;align-items:flex-start;font-size:14px;line-height:1.45}
  .dot{flex:0 0 auto;width:6px;height:6px;border-radius:50%;background:${c.accent};margin-top:7px}
  .cta{display:inline-flex;align-items:center;gap:8px;font-weight:800;font-size:16px;letter-spacing:.02em}
  /* Logo 等比限高，绝不拉伸（object-fit:contain + 只限高）。 */
  .logo{height:26px;width:auto;max-width:150px;object-fit:contain;display:block}
  /* 二维码固定尺寸 + 白底静区（padding 即静区，保证可扫）。
     ★ 80px 外框 - 2×6px 静区 = **码本体 68px**，高于量测下限 64px。
     曾是 76px（本体恰好 64px，正卡在下限上）——留 4px 余量是因为亚像素取整会让"恰好合格"
     在不同渲染环境里随机变成不合格，而那种失败每次都只发生在一部分成品上，最难查。 */
  .qr{width:80px;height:80px;padding:6px;background:#fff;border-radius:8px;flex:0 0 auto}
  .qr img{width:100%;height:100%;display:block;object-fit:contain}
  /* ★ 贴码位（qrUrl 为空时）：**占位不是省略**。二维码在与不在必须占同一块面积，
     否则「有码」与「无码」是两套版面预算，长文案下只有一套被验证过。
     浅色块 + 虚线边 + 「贴码位」细字角标 —— 用户可以自行把码贴在这块白底上（静区已经留好）。
     绝不画假二维码：那是会被真的扫的东西，画一个不能用的图形比留白更糟。 */
  .qr.hold{display:flex;align-items:flex-end;justify-content:flex-end;
    border:1px dashed rgba(0,0,0,.22);background:#fff}
  .holdtag{font-size:10px;line-height:1.1;letter-spacing:.04em;color:rgba(0,0,0,.42)}
  .qrbox{flex:0 0 auto;text-align:center}
  /* 码位说明文字下限 10px：低于它印出来不可读（与量测器 minFontPx 同一口径）。 */
  .qrlabel{margin-top:4px;font-size:10px;letter-spacing:.1em;opacity:.58}
  .foot{flex:0 0 auto;display:flex;align-items:flex-end;justify-content:space-between;gap:14px}
  .sign{font-family:${FONT_SERIF};font-size:12px;letter-spacing:.14em;opacity:.72}
  /* AI 生成标识：默认渲染、不可整体关闭（合规）。样式可调，位置固定在底部。 */
  .aimark{flex:0 0 auto;height:24px;display:flex;align-items:center;justify-content:center;
    font-size:10px;letter-spacing:.16em;opacity:.62}
  `;
}

// css 已是「公共 CSS + 模板私有 CSS」的拼接（私有在后，可覆写公共）。
function page(title: string, css: string, body: string): string {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">`
    + `<meta name="viewport" content="width=${CANVAS.width}, initial-scale=1">`
    + `<title>${esc(title)}</title><style>${css}</style></head>`
    + `<body><div class="poster">${body}</div></body></html>`;
}

// 卖点一律单行截断：schema 已把每条卡到 20 字，而任何模板的文字列都 ≥ 440px
//（20 字 × 14px ≈ 280px），所以一行必然装得下。写死 clamp1 是为了把「万一换行成两行」这个
// 高度不确定性从版面预算里彻底去掉——不确定性正是上面那条弹性契约要消灭的东西。
function pointsHtml(points: string[]): string {
  if (!points.length) return '';
  return `<div class="points">${points.slice(0, 3).map((p) => `<div class="point"><span class="dot"></span><span class="clamp1">${esc(p)}</span></div>`).join('')}</div>`;
}

/** 贴码位角标文案（成品页「可自行粘贴二维码」的提示与它是同一件事，改文案要两处一起改）。 */
export const QR_HOLD_TEXT = '贴码位';

/**
 * 二维码 / 贴码位。**永远渲染**：
 *   · 有 qrUrl → 白底静区里放真码（`data-role="qr"` 供量测器验可扫性）；
 *   · 无 qrUrl → 同尺寸的浅色贴码位 + 「贴码位」角标，用户可自行把码贴上去。
 * 这个事实同时落到 resultJson.qrReserved（worker 模板路径写），成品页据它给提示。
 */
function qrHtml(url: string | null, label: string): string {
  const inner = url
    ? `<div class="qr"><img data-role="qr" src="${esc(url)}" alt=""></div>`
    : `<div class="qr hold"><span class="holdtag">${esc(QR_HOLD_TEXT)}</span></div>`;
  return `<div class="qrbox">${inner}<div class="qrlabel">${esc(label)}</div></div>`;
}

function logoHtml(url: string | null): string {
  return url ? `<img class="logo" src="${esc(url)}" alt="">` : '';
}

function aiMarkHtml(): string {
  return `<div class="aimark">${esc(AI_MARK_TEXT)}</div>`;
}

/* ───────────────── 模板一：人物主视觉（person_hero · airy） ───────────────── */
// 结构：上方主视觉区（人物照/生成主视觉/无图时渐变）→ 下方信息区。两区高度固定，互不侵占。
function personHero(input: TemplateInput): string {
  const { brief, philosophy, assets } = input;
  const c = palette(philosophy);
  const hero = safeUrl(assets.visualUrl) ?? safeUrl(assets.portraitUrl);
  const qr = safeUrl(assets.qrUrl);
  const logo = safeUrl(assets.logoUrl);

  const css = baseCss(philosophy) + `
  /* 主视觉带 = 弹性块：基准 336px（按最坏情况文案量算出的余量），文案长时自动让位，下限 170px。 */
  .hero{flex:1 1 ${hero ? 336 : 288}px;min-height:170px;position:relative;overflow:hidden;
    background:linear-gradient(160deg,${c.mid},${c.ink})}
  .hero img{width:100%;height:100%;object-fit:cover;display:block}
  /* 底部压暗只是背景层，不承载文字（文字全在下方信息区，天然不可能压到人脸上的字）。 */
  .veil{position:absolute;left:0;right:0;bottom:0;height:120px;background:linear-gradient(to bottom,rgba(0,0,0,0),rgba(0,0,0,.42))}
  .heroTag{position:absolute;left:26px;bottom:18px;display:flex;align-items:center;gap:10px}
  .heroTag .tag{padding:4px 10px;border:1px solid rgba(255,255,255,.42);border-radius:999px;
    font-size:10px;letter-spacing:.18em;color:rgba(255,255,255,.9)}
  .body{display:flex;flex-direction:column;padding:20px 26px 0}
  .headline{font-size:33px;line-height:1.18}
  .sub{margin-top:8px;font-size:15px;line-height:1.45}
  .rule{margin:13px 0 12px;width:52px;height:3px;background:${c.accent};border-radius:2px}
  .points{gap:8px}
  .foot{padding:14px 26px 6px}
  .ctaWrap{display:flex;flex-direction:column;gap:10px}
  .cta{color:${c.mid}}
  .cta .arrow{color:${c.accent}}
  `;

  const body = [
    `<div class="hero elastic">`,
    hero ? `<img src="${esc(hero)}" alt="">` : '',
    `<div class="veil"></div>`,
    `<div class="heroTag"><span class="tag">${esc(philosophy.movement || '主视觉')}</span>${logoHtml(logo)}</div>`,
    `</div>`,
    `<div class="body">`,
    `<div class="headline clamp2">${esc(brief.headline)}</div>`,
    brief.subheadline ? `<div class="sub clamp2">${esc(brief.subheadline)}</div>` : '',
    `<div class="rule"></div>`,
    pointsHtml(brief.proofPoints),
    `</div>`,
    `<div class="foot">`,
    `<div class="ctaWrap"><div class="cta"><span class="clamp1">${esc(brief.cta)}</span><span class="arrow">→</span></div>`,
    `<div class="sign clamp1">${esc(SIGNATURE)}</div></div>`,
    qrHtml(qr, '扫码了解'),
    `</div>`,
    aiMarkHtml(),
  ].join('');

  return page(brief.headline, css, body);
}

/* ───────────────── 模板二：编辑杂志（editorial · balanced） ───────────────── */
// 结构：大留白 + 强标题在上、卖点居中、CTA 与二维码在下。有主视觉时作右下角图块，不作满版底。
function editorial(input: TemplateInput): string {
  const { brief, philosophy, assets } = input;
  const c = palette(philosophy);
  const art = safeUrl(assets.visualUrl) ?? safeUrl(assets.portraitUrl);
  const qr = safeUrl(assets.qrUrl);
  const logo = safeUrl(assets.logoUrl);

  const css = baseCss(philosophy) + `
  body{background:${c.paper}}
  .top{display:flex;align-items:center;justify-content:space-between;padding:30px 34px 0}
  .kicker{font-size:10px;letter-spacing:.28em;color:${c.mid};font-weight:800}
  .main{display:flex;flex-direction:column;padding:24px 34px 0}
  .headline{font-size:40px;line-height:1.14;color:${c.ink}}
  .sub{margin-top:12px;font-size:16px;line-height:1.5;max-width:400px}
  .rule{margin:18px 0;width:100%;height:1px;background:${c.ink};opacity:.16}
  .point{font-size:14.5px}
  /* 色块 / 主视觉带 = 弹性块：基准 186px，文案长时让位，下限 88px（仍是成立的构成元素而非残块）。 */
  .art{margin:16px 34px 0;flex-basis:186px;min-height:88px;border-radius:4px;overflow:hidden;
    background:linear-gradient(140deg,${c.mid},${c.ink})}
  .art img{width:100%;height:100%;object-fit:cover;display:block}
  .foot{padding:16px 34px 8px}
  .ctaWrap{display:flex;flex-direction:column;gap:9px}
  .cta{font-family:${FONT_SERIF};font-size:19px;color:${c.ink};border-bottom:2px solid ${c.accent};padding-bottom:3px}
  `;

  const body = [
    `<div class="top"><div class="kicker">${esc(philosophy.movement || 'EDITORIAL')}</div>${logoHtml(logo)}</div>`,
    `<div class="main">`,
    `<div class="headline clamp2">${esc(brief.headline)}</div>`,
    brief.subheadline ? `<div class="sub clamp2">${esc(brief.subheadline)}</div>` : '',
    `<div class="rule"></div>`,
    pointsHtml(brief.proofPoints),
    `</div>`,
    `<div class="art elastic">${art ? `<img src="${esc(art)}" alt="">` : ''}</div>`,
    `<div class="foot">`,
    `<div class="ctaWrap"><div class="cta"><span class="clamp1">${esc(brief.cta)}</span></div>`,
    `<div class="sign clamp1">${esc(SIGNATURE)}</div></div>`,
    qrHtml(qr, '扫码咨询'),
    `</div>`,
    aiMarkHtml(),
  ].join('');

  return page(brief.headline, css, body);
}

/* ───────────────── 模板三：商业发布（business_launch · balanced） ───────────────── */
// 结构：深色信息头（标题+副标）→ 纸底卖点卡 → CTA 条 → 落款/二维码。信息最明确，适合活动与课程。
function businessLaunch(input: TemplateInput): string {
  const { brief, philosophy, assets } = input;
  const c = palette(philosophy);
  const art = safeUrl(assets.visualUrl) ?? safeUrl(assets.portraitUrl);
  const qr = safeUrl(assets.qrUrl);
  const logo = safeUrl(assets.logoUrl);

  const css = baseCss(philosophy) + `
  .head{padding:28px 30px 24px;background:linear-gradient(150deg,${c.mid},${c.ink});color:#fff}
  .badge{display:inline-block;padding:4px 11px;border:1px solid rgba(255,255,255,.38);border-radius:999px;
    font-size:10px;letter-spacing:.2em;color:rgba(255,255,255,.9)}
  .headRow{display:flex;align-items:center;justify-content:space-between;gap:12px}
  .headline{margin-top:14px;font-size:32px;line-height:1.18;color:#fff}
  .sub{margin-top:9px;font-size:14.5px;line-height:1.45;color:rgba(255,255,255,.86)}
  /* 主视觉带 = 弹性块。这里 min-height 给 0：深色信息头本身会随文案长高，
     信息明确度优先于配图，极端情况下图带可以被压没，也绝不许挤掉卖点或 CTA。 */
  .art{flex-basis:158px;min-height:0;overflow:hidden;background:${c.ink}}
  .art img{width:100%;height:100%;object-fit:cover;display:block}
  .main{padding:18px 30px 0;display:flex;flex-direction:column}
  /* standard 无主视觉时，卖点区上下留白均分：把本该给图的空间摊成呼吸，
     而不是在卖点与 CTA 条之间留一大块死白。
     ⚠️ 用「1 0 auto」（可涨不可缩）而非「1 1 auto」：它是文字块，一旦允许收缩就会在文案顶到
     上限时把卖点压到 CTA 条底下（本模板没有 overflow:hidden，压出来是重叠而不是裁切，更糟）。 */
  .main.noart{flex:1 0 auto;justify-content:center;padding-bottom:18px}
  .points{gap:8px}
  .point{padding:9px 13px;border-radius:11px;background:#fff;border:1px solid rgba(0,0,0,.07);font-size:14px}
  .ctaBar{margin:14px 30px 0;padding:12px 18px;border-radius:12px;
    background:${c.accent};color:#fff;display:flex;align-items:center;justify-content:space-between;gap:10px}
  .ctaBar .cta{color:#fff}
  .foot{padding:14px 30px 6px}
  `;

  const body = [
    `<div class="head">`,
    `<div class="headRow"><span class="badge">${esc(philosophy.movement || '重磅发布')}</span>${logoHtml(logo)}</div>`,
    `<div class="headline clamp2">${esc(brief.headline)}</div>`,
    brief.subheadline ? `<div class="sub clamp2">${esc(brief.subheadline)}</div>` : '',
    `</div>`,
    art ? `<div class="art elastic"><img src="${esc(art)}" alt=""></div>` : '',
    `<div class="main${art ? '' : ' noart'}">${pointsHtml(brief.proofPoints)}</div>`,
    `<div class="ctaBar"><div class="cta"><span class="clamp1">${esc(brief.cta)}</span></div><span>→</span></div>`,
    `<div class="foot"><div class="sign clamp1">${esc(SIGNATURE)}</div>${qrHtml(qr, '扫码报名')}</div>`,
    aiMarkHtml(),
  ].join('');

  return page(brief.headline, css, body);
}

/* ───────────────── 新版式共用的小工具 ───────────────── */

/**
 * 装饰性叠层标记（值与 canvasMeasure.DECOR_ATTR 一致）。**写字面量而不是 import**：
 * canvasMeasure 已经 import 本模块的 AI_MARK_TEXT，反向再引一次就成了循环依赖。
 * 用途：大引号这类排印元素是图形不是信息，量测器的压字判定不该误伤它。
 */
const DECOR_MARK = 'data-poster-decor="1"';

/**
 * 从卖点里抽一个「主数据」（data_stat 用）。取第一条含数字的卖点，数字连同紧邻单位作大字，
 * **整条原文作注释**（不把数字从句子中间抠掉——「平均降佣 9 个点」抠完会变成「平均降佣点」）。
 * 一条数字都抽不到就返回 null：那时 data_stat 退成纯排印，**绝不编一个数字**，
 * 海报上的数据是会被人当真的。
 */
export function extractStat(points: string[]): { value: string; note: string } | null {
  for (const p of points) {
    const m = /\d+(?:\.\d+)?\s*(?:%|％|万|亿|倍|\+|＋)?/.exec(p);
    if (!m) continue;
    return { value: m[0].replace(/\s+/g, ''), note: p };
  }
  return null;
}

/**
 * 议程结构位（agenda_event 用）：卖点写成「时间：8月20日 20:00」这种形态时拆成标签 + 内容两列；
 * 没有分隔符的整条进内容列，**不替用户硬造标签**（猜错标签比没有标签更误导）。
 */
export function metaRow(p: string): { label: string; value: string } {
  const m = /^([^：:｜|]{1,6})\s*[：:｜|]\s*(\S.*)$/.exec(p);
  return m ? { label: m[1].trim(), value: m[2].trim() } : { label: '', value: p };
}

/** 弹性图带：有主视觉铺图，没有就是同一个槽位的留白（两种情形共用一套版面预算）。 */
function bandHtml(url: string | null): string {
  return `<div class="band">${url ? `<img src="${esc(url)}" alt="">` : ''}</div>`;
}

/* ───────────────── 模板四：一句主张（manifesto_min · airy） ───────────────── */
// 结构：顶栏（流派 + Logo）→ 上留白 → 宣言大字 → 分隔条 → 副标 → 图带/下留白 → 行动区 → AI 标识。
// airy 的做法是「只说一句话，其余交给留白」：两个弹性槽（上留白、下图带）在短文案时把画面撑开，
// 文案变长时依次让位——让位的永远是空白与图，不是字（竖向弹性契约见文件头 ②）。
function manifestoMin(input: TemplateInput): string {
  const { brief, philosophy, assets } = input;
  const c = palette(philosophy);
  const art = safeUrl(assets.visualUrl) ?? safeUrl(assets.portraitUrl);
  const qr = safeUrl(assets.qrUrl);
  const logo = safeUrl(assets.logoUrl);

  const css = baseCss(philosophy) + `
  .top{display:flex;align-items:center;justify-content:space-between;padding:34px 36px 0}
  .kicker{font-size:10px;letter-spacing:.3em;color:${c.mid};font-weight:800}
  /* 上留白：basis 0 且可缩，文案顶到上限时第一个被压掉的就是它。 */
  .air{flex:1 1 0;min-height:0}
  .say{padding:0 36px}
  .headline{font-size:46px;line-height:1.16}
  .rule{margin:22px 36px;width:64px;height:4px;background:${c.accent};border-radius:2px}
  /* ★ 文字块的横向内缩一律用 margin，**不能用 padding**：量测器量的是包围盒，
     满宽 + 左右 padding 的文字块，包围盒仍然贴着画布两边 → 报 margin 违规（真实渲染验证抓到过）。 */
  .sub{margin:0 36px;font-size:15px;line-height:1.5}
  /* 图带只缩不涨（flex:0 1 + 固定基准）：多出来的高度全部归 .air 留白。
     若让图带跟着涨，短文案时它会长成占掉半张画的色带 —— airy 也就不 airy 了。 */
  .band{flex:0 1 ${art ? 150 : 0}px;min-height:0;margin-top:26px;overflow:hidden}
  .band img{width:100%;height:100%;object-fit:cover;display:block}
  .foot{padding:18px 36px 8px}
  .ctaWrap{display:flex;flex-direction:column;gap:9px}
  .cta{color:${c.mid}}
  .cta .arrow{color:${c.accent}}
  `;

  const body = [
    `<div class="top"><div class="kicker">${esc(philosophy.movement || '主张')}</div>${logoHtml(logo)}</div>`,
    `<div class="air"></div>`,
    `<div class="say"><div class="headline clamp2">${esc(brief.headline)}</div></div>`,
    `<div class="rule"></div>`,
    brief.subheadline ? `<div class="sub clamp2">${esc(brief.subheadline)}</div>` : '',
    bandHtml(art),
    `<div class="foot">`,
    `<div class="ctaWrap"><div class="cta"><span class="clamp1">${esc(brief.cta)}</span><span class="arrow">→</span></div>`,
    `<div class="sign clamp1">${esc(SIGNATURE)}</div></div>`,
    qrHtml(qr, '扫码了解'),
    `</div>`,
    aiMarkHtml(),
  ].join('');

  return page(brief.headline, css, body);
}

/* ───────────────── 模板五：金句卡（quote_card · airy） ───────────────── */
// 结构：顶栏 → 大引号 → 金句（主标题）→ 语境（副标）→ 署名行（头像位 + 落款）→ 图带/留白 → 行动区。
// 头像位刻意**只认 portraitUrl**（与其它版式「visualUrl 优先」相反）：这一位回答的是「谁说的」，
// 只有真人照片有这个语义；没有真人照就退成品牌字母牌，绝不拿生成主视觉冒充说话人。
// 生成主视觉照旧进图带，所以高级档买到的画面在本版式里一样出得来。
function quoteCard(input: TemplateInput): string {
  const { brief, philosophy, assets } = input;
  const c = palette(philosophy);
  const face = safeUrl(assets.portraitUrl);
  const art = safeUrl(assets.visualUrl);
  const qr = safeUrl(assets.qrUrl);
  const logo = safeUrl(assets.logoUrl);

  const css = baseCss(philosophy) + `
  .top{display:flex;align-items:center;justify-content:space-between;padding:32px 36px 0}
  .kicker{font-size:10px;letter-spacing:.3em;color:${c.mid};font-weight:800}
  /* 引号是排印元素不是文字信息：给它 decor 标记，量测器的压字判定不该误伤这类叠印手法。
     ★ 横向内缩用 margin 而不是 padding：它自己带文字，padding 撑不开包围盒，量测会判它贴边。 */
  .quote{margin:10px 36px 0;font-family:${FONT_SERIF};font-size:72px;line-height:.74;
    color:${c.accent};opacity:.34}
  .say{padding:14px 36px 0}
  .headline{font-size:34px;line-height:1.34}
  .ctx{margin:14px 36px 0;font-size:14.5px;line-height:1.5;opacity:.78}
  .by{display:flex;align-items:center;gap:12px;padding:22px 36px 0}
  .face{width:52px;height:52px;border-radius:50%;overflow:hidden;flex:0 0 auto;
    background:${c.mid};display:flex;align-items:center;justify-content:center}
  .face img{width:100%;height:100%;object-fit:cover;display:block}
  .mono{font-family:${FONT_SERIF};font-size:22px;color:#fff}
  .byname{font-family:${FONT_SERIF};font-size:16px;letter-spacing:.12em}
  .air{flex:1 1 0;min-height:0}
  /* 图带只缩不涨，剩余高度归留白（理由同 manifesto_min）。
     比 manifesto_min 再矮一档：金句卡的主角是那句话与署名，图只是佐证。 */
  .band{flex:0 1 ${art ? 130 : 0}px;min-height:0;margin-top:24px;overflow:hidden}
  .band img{width:100%;height:100%;object-fit:cover;display:block}
  .foot{padding:16px 36px 8px}
  .cta{font-family:${FONT_SERIF};font-size:18px;color:${c.ink};
    border-bottom:2px solid ${c.accent};padding-bottom:3px}
  `;

  const body = [
    `<div class="top"><div class="kicker">${esc(philosophy.movement || '金句')}</div>${logoHtml(logo)}</div>`,
    `<div class="quote" ${DECOR_MARK}>“</div>`,
    `<div class="say"><div class="headline clamp2">${esc(brief.headline)}</div></div>`,
    brief.subheadline ? `<div class="ctx clamp2">${esc(brief.subheadline)}</div>` : '',
    `<div class="by"><div class="face">`,
    face ? `<img src="${esc(face)}" alt="">` : `<span class="mono">${esc(SIGNATURE.slice(0, 1))}</span>`,
    `</div><div class="byname clamp1">${esc(SIGNATURE)}</div></div>`,
    `<div class="air"></div>`,
    bandHtml(art),
    `<div class="foot">`,
    `<div class="cta"><span class="clamp1">${esc(brief.cta)}</span></div>`,
    qrHtml(qr, '扫码了解'),
    `</div>`,
    aiMarkHtml(),
  ].join('');

  return page(brief.headline, css, body);
}

/* ───────────────── 模板六：数据主视觉（data_stat · balanced） ───────────────── */
// 结构：顶栏 → 主数据大字 + 注释 → 标题 → 副标 → 分隔 → 卖点 → 图带 → 行动区。
// 降级：卖点里抽不到数字就整块去掉数据区，主标题接管画面（放大到 40px），不留一个空的数字位。
function dataStat(input: TemplateInput): string {
  const { brief, philosophy, assets } = input;
  const c = palette(philosophy);
  const art = safeUrl(assets.visualUrl) ?? safeUrl(assets.portraitUrl);
  const qr = safeUrl(assets.qrUrl);
  const logo = safeUrl(assets.logoUrl);
  const stat = extractStat(brief.proofPoints);

  const css = baseCss(philosophy) + `
  .top{display:flex;align-items:center;justify-content:space-between;padding:28px 32px 0}
  .kicker{font-size:10px;letter-spacing:.28em;color:${c.mid};font-weight:800}
  .stat{display:flex;align-items:flex-end;gap:14px;padding:14px 32px 0}
  .statNum{font-family:${FONT_SERIF};font-weight:700;font-size:80px;line-height:.94;
    letter-spacing:-.02em;color:${c.accent}}
  .statNote{flex:1 1 auto;min-width:0;padding-bottom:9px;font-size:13px;line-height:1.4;opacity:.72}
  .main{padding:18px 32px 0}
  .headline{font-size:${stat ? 30 : 40}px;line-height:1.2}
  .sub{margin-top:9px;font-size:14.5px;line-height:1.45}
  .rule{margin:14px 0 12px;width:48px;height:3px;background:${c.accent};border-radius:2px}
  .band{flex:1 1 auto;flex-basis:${art ? 130 : 0}px;min-height:0;margin-top:16px;overflow:hidden}
  .band img{width:100%;height:100%;object-fit:cover;display:block}
  .foot{padding:14px 32px 6px}
  .ctaWrap{display:flex;flex-direction:column;gap:9px}
  .cta{color:${c.mid}}
  .cta .arrow{color:${c.accent}}
  `;

  const body = [
    `<div class="top"><div class="kicker">${esc(philosophy.movement || '关键数据')}</div>${logoHtml(logo)}</div>`,
    stat
      ? `<div class="stat"><div class="statNum">${esc(stat.value)}</div>`
        + `<div class="statNote clamp2">${esc(stat.note)}</div></div>`
      : '',
    `<div class="main">`,
    `<div class="headline clamp2">${esc(brief.headline)}</div>`,
    brief.subheadline ? `<div class="sub clamp2">${esc(brief.subheadline)}</div>` : '',
    `<div class="rule"></div>`,
    pointsHtml(brief.proofPoints),
    `</div>`,
    bandHtml(art),
    `<div class="foot">`,
    `<div class="ctaWrap"><div class="cta"><span class="clamp1">${esc(brief.cta)}</span><span class="arrow">→</span></div>`,
    `<div class="sign clamp1">${esc(SIGNATURE)}</div></div>`,
    qrHtml(qr, '扫码了解'),
    `</div>`,
    aiMarkHtml(),
  ].join('');

  return page(brief.headline, css, body);
}

/**
 * 清单类版式的条目上限。**5 而不是 3**：schema 当前把 proofPoints 卡在 3 条，
 * 但这两套密集版式的版面预算是按 5 条算的，上限放开时不需要回头改模板。
 */
export const LIST_MAX_ITEMS = 5;

/* ───────────────── 模板七：要点清单（info_list · dense） ───────────────── */
// 结构：深色信息头（标题 + 副标）→ 图带 → 编号清单 → 行动条 → 落款/码位。
// 文案缺失降级：清单用 `flex:1 0 auto` + 居中，**不足 3 条时行距不变、整块居中**，
// 空出来的高度回到图带；一条都没有时整块清单不渲染（不留编号空行，那是最难看的一种空洞）。
function infoList(input: TemplateInput): string {
  const { brief, philosophy, assets } = input;
  const c = palette(philosophy);
  const art = safeUrl(assets.visualUrl) ?? safeUrl(assets.portraitUrl);
  const qr = safeUrl(assets.qrUrl);
  const logo = safeUrl(assets.logoUrl);
  const items = brief.proofPoints.slice(0, LIST_MAX_ITEMS);

  const css = baseCss(philosophy) + `
  .head{padding:24px 30px 22px;background:linear-gradient(150deg,${c.mid},${c.ink});color:#fff}
  .headRow{display:flex;align-items:center;justify-content:space-between;gap:12px}
  .badge{display:inline-block;padding:4px 11px;border:1px solid rgba(255,255,255,.38);border-radius:999px;
    font-size:10px;letter-spacing:.2em;color:rgba(255,255,255,.9)}
  .headline{margin-top:13px;font-size:26px;line-height:1.2;color:#fff}
  .sub{margin-top:8px;font-size:14px;line-height:1.45;color:rgba(255,255,255,.86)}
  /* ★ 富余高度归谁，取决于有没有主视觉 —— 这是密集版式不留空洞的关键：
     · 有图：图带可涨（flex:1 1），多出来的高度变成更大的画面，清单保持自然紧凑；
     · 无图：图带塌成 0，改由清单可涨 + 居中吸收，空白摊在清单上下两侧而不是堆在某一条边。
     两种情形都不会出现"中间一块死白"。清单一律不可收缩（0 shrink），文字块被压缩就是裁字。 */
  .band{flex:${art ? '1 1 110px' : '0 0 0'};min-height:0;overflow:hidden}
  .band img{width:100%;height:100%;object-fit:cover;display:block}
  .list{flex:${art ? '0 0 auto' : '1 0 auto'};display:flex;flex-direction:column;
    justify-content:center;gap:7px;padding:16px 30px}
  .li{display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:10px;
    background:#fff;border:1px solid rgba(0,0,0,.07)}
  .idx{flex:0 0 auto;width:20px;height:20px;border-radius:50%;background:${c.accent};color:#fff;
    display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700}
  .litext{flex:1 1 auto;min-width:0;font-size:14px;line-height:1.4}
  .ctaBar{margin:0 30px;padding:12px 18px;border-radius:12px;background:${c.accent};color:#fff;
    display:flex;align-items:center;justify-content:space-between;gap:10px}
  .ctaBar .cta{color:#fff}
  .foot{padding:12px 30px 6px}
  `;

  const list = items.length
    ? `<div class="list">${items.map((p, i) => `<div class="li"><span class="idx">${i + 1}</span>`
      + `<span class="litext clamp1">${esc(p)}</span></div>`).join('')}</div>`
    : '';

  const body = [
    `<div class="head">`,
    `<div class="headRow"><span class="badge">${esc(philosophy.movement || '要点')}</span>${logoHtml(logo)}</div>`,
    `<div class="headline clamp2">${esc(brief.headline)}</div>`,
    brief.subheadline ? `<div class="sub clamp2">${esc(brief.subheadline)}</div>` : '',
    `</div>`,
    bandHtml(art),
    list,
    // 一条卖点都没有时，清单块不存在 → 需要一个可涨的空槽接住剩余高度，否则行动条会被顶到画面中部。
    items.length ? '' : `<div class="list"></div>`,
    `<div class="ctaBar"><div class="cta"><span class="clamp1">${esc(brief.cta)}</span></div><span>→</span></div>`,
    `<div class="foot"><div class="sign clamp1">${esc(SIGNATURE)}</div>${qrHtml(qr, '扫码了解')}</div>`,
    aiMarkHtml(),
  ].join('');

  return page(brief.headline, css, body);
}

/* ───────────────── 模板八：活动信息（agenda_event · dense） ───────────────── */
// 结构：深色信息头 → 图带 → 时间/地点/议程结构位 → **显著行动区**（大 CTA + 码位同框）→ AI 标识。
// 行动区是本版式与 info_list 的分野：活动海报的目的就是让人现在报名，
// 所以二维码/贴码位被拉进强调色块里与 CTA 同框，而不是缩在页脚角落。
// 结构位内容全部来自 proofPoints（见 metaRow）：**不替用户编时间地点**。
function agendaEvent(input: TemplateInput): string {
  const { brief, philosophy, assets } = input;
  const c = palette(philosophy);
  const art = safeUrl(assets.visualUrl) ?? safeUrl(assets.portraitUrl);
  const qr = safeUrl(assets.qrUrl);
  const logo = safeUrl(assets.logoUrl);
  const rows = brief.proofPoints.slice(0, LIST_MAX_ITEMS).map(metaRow);

  const css = baseCss(philosophy) + `
  .head{padding:24px 30px 20px;background:linear-gradient(155deg,${c.mid},${c.ink});color:#fff}
  .headRow{display:flex;align-items:center;justify-content:space-between;gap:12px}
  .badge{display:inline-block;padding:4px 11px;border:1px solid rgba(255,255,255,.38);border-radius:999px;
    font-size:10px;letter-spacing:.2em;color:rgba(255,255,255,.9)}
  .headline{margin-top:13px;font-size:30px;line-height:1.18;color:#fff}
  .sub{margin-top:8px;font-size:14px;line-height:1.45;color:rgba(255,255,255,.86)}
  /* 富余高度归图带还是归结构位，取决于有没有主视觉（同 info_list 的注释）。 */
  .band{flex:${art ? '1 1 110px' : '0 0 0'};min-height:0;overflow:hidden}
  .band img{width:100%;height:100%;object-fit:cover;display:block}
  .meta{flex:${art ? '0 0 auto' : '1 0 auto'};display:flex;flex-direction:column;
    justify-content:center;gap:9px;padding:18px 30px}
  .mrow{display:flex;align-items:center;gap:12px;padding-bottom:9px;border-bottom:1px solid rgba(0,0,0,.09)}
  .mlabel{flex:0 0 auto;width:52px;font-size:11px;letter-spacing:.12em;color:${c.mid};font-weight:700}
  /* 无标签的行：标签列留一小段强调色短横占位。**不放任何字符**——
     写个「·」看起来像误排的杂点，而空着又会让内容列失去那条对齐轴。 */
  .mdot{flex:0 0 auto;width:52px}
  .mdot i{display:block;width:14px;height:2px;background:${c.accent};opacity:.6}
  .mval{flex:1 1 auto;min-width:0;font-size:15px;line-height:1.4}
  /* 行动区：强调色实心块，CTA 与码位同框。 */
  .act{margin:4px 30px 10px;padding:16px;border-radius:14px;background:${c.accent};color:#fff;
    display:flex;align-items:center;justify-content:space-between;gap:14px}
  .actText{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:8px}
  .act .cta{font-size:20px;color:#fff}
  .act .sign{color:rgba(255,255,255,.86);opacity:1}
  .act .qr{background:#fff}
  .act .qr.hold{border-color:rgba(0,0,0,.2)}
  .act .qrlabel{color:rgba(255,255,255,.88);opacity:1}
  `;

  const meta = rows.length
    ? `<div class="meta">${rows.map((r) => `<div class="mrow">`
      + (r.label ? `<span class="mlabel clamp1">${esc(r.label)}</span>` : `<span class="mdot"><i></i></span>`)
      + `<span class="mval clamp1">${esc(r.value)}</span></div>`).join('')}</div>`
    : `<div class="meta"></div>`;

  const body = [
    `<div class="head">`,
    `<div class="headRow"><span class="badge">${esc(philosophy.movement || '活动')}</span>${logoHtml(logo)}</div>`,
    `<div class="headline clamp2">${esc(brief.headline)}</div>`,
    brief.subheadline ? `<div class="sub clamp2">${esc(brief.subheadline)}</div>` : '',
    `</div>`,
    bandHtml(art),
    meta,
    `<div class="act">`,
    `<div class="actText"><div class="cta"><span class="clamp1">${esc(brief.cta)}</span><span>→</span></div>`,
    `<div class="sign clamp1">${esc(SIGNATURE)}</div></div>`,
    qrHtml(qr, '扫码报名'),
    `</div>`,
    aiMarkHtml(),
  ].join('');

  return page(brief.headline, css, body);
}

const RENDERERS: Record<TemplateKey, (input: TemplateInput) => string> = {
  person_hero: personHero,
  manifesto_min: manifestoMin,
  quote_card: quoteCard,
  editorial: editorial,
  business_launch: businessLaunch,
  data_stat: dataStat,
  info_list: infoList,
  agenda_event: agendaEvent,
};

/**
 * 按 brief.templateKey 生成自包含 HTML。
 * 建单时 schema 已保证 templateKey 在白名单内，但 requestJson 是**建单当时的快照**——
 * 模板改名/下线后被 sweep 或后台重试捞起来的老任务，会带着一个不存在的 key 走到这里。
 * 那时 `RENDERERS[key]` 是 undefined，直接调用会抛 `... is not a function`（TypeError），
 * 被 worker 归成 errorCode='INTERNAL'，运营在任务台上看不出发生了什么。故显式判一次。
 */
export function renderPosterHtml(input: TemplateInput): string {
  const render = RENDERERS[input.brief.templateKey];
  if (!render) throw new Error(`未知版式 ${input.brief.templateKey}（模板已下线或改名，需重新发起）`);
  return render(input);
}

/**
 * 渲染前的确定性自检（不跑浏览器）：只能查「结构性」问题——
 * 文案是否已被上游截断到画得下、AI 标识是否在位、是否残留外链资源。
 * 像素级重叠靠固定网格从设计上排除（见文件头 ②），不靠这里事后检测。
 */
export function auditPosterHtml(html: string): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  if (!html.includes(AI_MARK_TEXT)) issues.push('缺少 AI 生成标识');
  // 外链资源：只允许 OSS 签名 URL / data URI 出现在 src；不允许 link/script/@import/字体下载。
  if (/<link\b/i.test(html)) issues.push('存在外链样式表');
  if (/<script\b/i.test(html)) issues.push('存在脚本标签');
  if (/@import\b/i.test(html)) issues.push('CSS 存在 @import 外链');
  if (/url\(\s*['"]?https?:/i.test(html)) issues.push('CSS 引用了外链资源');
  return { ok: issues.length === 0, issues };
}
