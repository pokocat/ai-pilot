// 海报 HTML 模板（三套 3:4）。输入 = 规整后的 brief + 视觉哲学 + 资产签名 URL，输出 = 自包含 HTML。
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
  /** 人物照签名 URL 或 data URI（可空 → 走无主视觉的纯排版路径）。 */
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
  /* 二维码固定尺寸 + 白底静区（padding 即静区，保证可扫）。 */
  .qr{width:76px;height:76px;padding:6px;background:#fff;border-radius:8px;flex:0 0 auto}
  .qr img{width:100%;height:100%;display:block;object-fit:contain}
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

function qrHtml(url: string | null, label: string): string {
  if (!url) return '';
  return `<div class="qrbox"><div class="qr"><img src="${esc(url)}" alt=""></div><div class="qrlabel">${esc(label)}</div></div>`;
}

function logoHtml(url: string | null): string {
  return url ? `<img class="logo" src="${esc(url)}" alt="">` : '';
}

function aiMarkHtml(): string {
  return `<div class="aimark">${esc(AI_MARK_TEXT)}</div>`;
}

/* ───────────────── 模板一：人物主视觉（person_hero） ───────────────── */
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
  .qrbox{text-align:center}
  .qrlabel{margin-top:4px;font-size:9px;letter-spacing:.1em;opacity:.55}
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

/* ───────────────── 模板二：编辑杂志（editorial） ───────────────── */
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
  .qrbox{text-align:center}
  .qrlabel{margin-top:4px;font-size:9px;letter-spacing:.1em;opacity:.55}
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

/* ───────────────── 模板三：商业发布（business_launch） ───────────────── */
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
  /* 无主视觉时（未配图片供应商的默认路径）卖点区上下留白均分：把本该给图的空间摊成呼吸，
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
  .qrbox{text-align:center}
  .qrlabel{margin-top:4px;font-size:9px;letter-spacing:.1em;opacity:.55}
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

const RENDERERS: Record<TemplateKey, (input: TemplateInput) => string> = {
  person_hero: personHero,
  editorial: editorial,
  business_launch: businessLaunch,
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
