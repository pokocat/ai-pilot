import Taro from '@tarojs/taro';
import type { Deliverable } from './api';
import { renderCardToImage } from './canvasCard';

// D-3-4：报告分享转图片。方案库详情 / 成果卡的「分享图」= 一张品牌分享图——
// 封面标题 + 亮点概要（军师评分/行动数/机会风险计数）+ 金句 + ≤3 条脱敏核心结论 + 落款，
// **不含全文与敏感数字明细**。复用共享出图管道（renderCardToImage），weapp 出图、点对点发好友/存相册。

const CW = 600; // 逻辑宽（px）
const PAD = 44;
const INNER_W = CW - PAD * 2; // 512
const BULLET_X = PAD + 40; // 编号徽标右侧文字起点
const BULLET_MAXW = CW - BULLET_X - PAD; // 结论文字可用宽
const BULLET_LH = 40; // 结论行高
const BULLET_GAP = 22; // 条间距

// 品牌配色（固定军师参谋部色，不随本命色）
const BRAND = '#1E5A43';
const BRAND_DEEP = '#123C2C';
const GOLD = '#D9C48A';
const PAPER = '#FBFAF6';
const INK = '#16191D';
const LABEL = '#8A8570';
const LINE = '#E7E4DB';
const RISK = '#B54434'; // 朱砂：风险块数字

const FALLBACK = '这份方案的完整判断与执行动作，已在军师参谋部为你备好。';

// ── 脱敏：把报告原文里的联系方式 / 财务·规模数字隐去（纯确定性正则，顺序处理）。──
export function maskSensitive(text: string): string {
  if (!text) return '';
  let s = String(text);
  // 1. URL、邮箱 → 整体删除
  s = s.replace(/https?:\/\/[^\s，。、；;）)】」""'']+/gi, '');
  s = s.replace(/\bwww\.[^\s，。、；;）)】」""'']+/gi, '');
  s = s.replace(/[\w.+-]+@[\w-]+\.[\w.\-]+/g, '');
  // 2. 手机号 / 11 位数字串 → ✱✱✱
  s = s.replace(/\d{11}/g, '✱✱✱');
  // 3. 数字（含中文逗号/小数点，允许前置 ¥/￥/$）后跟财务/规模单位 → 数字部分替换为「✱✱」保留单位
  s = s.replace(/[¥￥$]?\d[\d,，.]*\s*(万|亿|元|美元|美金|块|%|％|倍|人|单|家|店|间|亩|平|套)/g, '✱✱$1');
  // 4. 其余 ≥2 位连续数字串 → ✱✱（单个数字如「3 个月」「第 2 步」保留）
  s = s.replace(/\d{2,}/g, '✱✱');
  return s;
}

// ── 亮点概要：军师自己的评定/统计，不脱敏、原样展示。──
export interface ShareHighlights {
  score?: { num: number; verdict?: string };
  actionCount?: number;
  toneCounts: { tone: string; n: number }[];
  quote?: { text: string; cite?: string };
}
export function shareHighlights(d: Deliverable): ShareHighlights {
  const secs = (d.sections ?? []) as any[];
  // score：首个 gauge
  const gauge = secs.find((s) => s?.type === 'gauge');
  const score = gauge && typeof gauge.score === 'number'
    ? { num: gauge.score, verdict: gauge.verdict ? String(gauge.verdict) : undefined }
    : undefined;
  // actionCount：所有 phases[].items[].actions 总数 + Deliverable.actions
  let actionCount = 0;
  secs.forEach((s) => {
    if (s?.type === 'phases') (s.items ?? []).forEach((it: any) => { actionCount += (it?.actions?.length ?? 0); });
  });
  actionCount += (d.actions?.length ?? 0);
  // toneCounts：callout 按 tone 计数，只取 机会/风险/时机，最多 3 个
  const wanted = ['机会', '风险', '时机'];
  const counts: Record<string, number> = {};
  secs.forEach((s) => {
    if (s?.type === 'callout' && wanted.includes(s.tone)) counts[s.tone] = (counts[s.tone] ?? 0) + 1;
  });
  const toneCounts = wanted.filter((t) => counts[t]).map((t) => ({ tone: t, n: counts[t] })).slice(0, 3);
  // quote：首个 quote section（脱敏 + 截断 ~40 码点）
  const q = secs.find((s) => s?.type === 'quote' && s.text);
  let quote: { text: string; cite?: string } | undefined;
  if (q) {
    let txt = maskSensitive(String(q.text)).replace(/\s+/g, ' ').trim();
    if ([...txt].length > 40) txt = `${[...txt].slice(0, 40).join('')}…`;
    if (txt) quote = { text: txt, cite: q.cite ? maskSensitive(String(q.cite)).replace(/\s+/g, ' ').trim() : undefined };
  }
  return { score, actionCount: actionCount > 0 ? actionCount : undefined, toneCounts, quote };
}

// 首节摘要 → 最多 3 条核心结论（去空白、逐条截断，规避全文与长数字明细）。
// 报告 V2：优先从 hero 段落 / callout 标题取要点，不足再回退旧的首节 list/正文分句逻辑。
export function shareBullets(d: Deliverable): string[] {
  const clean = (arr: string[]) => arr
    .map((x) => x.replace(/[*#>`_~=!]/g, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 3)
    .map((x) => ([...x].length > 46 ? `${[...x].slice(0, 46).join('')}…` : x));

  const secs = d.sections ?? [];
  const hero = secs.find((s) => s.type === 'hero');
  if (hero && hero.type === 'hero' && hero.paras.length) return clean(hero.paras);
  const calloutHs = secs.filter((s) => s.type === 'callout').map((s) => (s.type === 'callout' ? s.h : '')).filter(Boolean);
  if (calloutHs.length) return clean(calloutHs);
  const first = secs.find((s) => !s.type && (s.b || (s.list?.length ?? 0) > 0)) ?? secs[0];
  if (!first) return [];
  const raw = first.list && first.list.length ? first.list : (first.b ? first.b.split(/[。；;\n]+/) : []);
  return clean(raw);
}

// 按码点定量换行（确定性：估高与绘制共用，保证不错位）。CJK 按字宽 ≈ 字号；Latin 更窄 → 只会欠满不会溢出。
function wrapByCount(text: string, perLine: number, maxLines = 99): string[] {
  const chars = [...text];
  const step = Math.max(1, perLine);
  const lines: string[] = [];
  for (let i = 0; i < chars.length; i += step) {
    let line = chars.slice(i, i + step).join('');
    if (lines.length + 1 >= maxLines && i + step < chars.length) {
      line = `${[...line].slice(0, step - 1).join('')}…`;
      lines.push(line);
      break;
    }
    lines.push(line);
  }
  return lines.length ? lines : [''];
}

// ── 排版方案：一次算清所有分段的绝对 y 与总高，绘制直接读取，杜绝估高/绘制错位。──
interface CardPlan {
  title: { lines: string[]; font: number; twoLine: boolean };
  coverH: number;
  blocks: { num: string; label: string; color: string }[];
  yBlocks: number | null;
  quote: { lines: string[]; cite?: string } | null;
  yQuote: number | null;
  bullets: string[][]; // 每条结论的换行结果
  bulletsFallback: boolean; // 无任何内容时用整段兜底文案（无编号徽标）
  yBullets: number;
  yFooter: number;
  totalH: number;
}

const BODY_TOP = 34; // 封面到正文首块的间距
const HL_H = 92; // 亮点条高
const HL_GAP = 30; // 亮点条到下一块
const QUOTE_GAP = 26; // 金句块到下一块
const FOOT_GAP = 16; // 结论到落款分隔线
const FOOT_H = 108; // 落款高

function quoteBlockH(lines: number, hasCite: boolean): number {
  // 内部基线：markBaseline=+50、text0=+86、textN=+86+(n-1)*30、cite=+30、blockBottom=+22
  return (86 + (lines - 1) * 30) + (hasCite ? 30 : 0) + 22;
}

function planCard(d: Deliverable): CardPlan {
  const hl = shareHighlights(d);

  // 标题（脱敏 + 换行，1 行 42px / 2 行 34px）
  let tt = maskSensitive(d.title || '').replace(/\s+/g, ' ').trim() || '军师方案';
  const twoLine = [...tt].length > 12;
  const title = twoLine
    ? { lines: wrapByCount(tt, 15, 2), font: 34, twoLine: true }
    : { lines: [tt], font: 42, twoLine: false };
  const coverH = twoLine ? 214 : 178;

  // 亮点块（score → actionCount → toneCounts，最多 4）
  const blocks: { num: string; label: string; color: string }[] = [];
  if (hl.score) blocks.push({ num: String(hl.score.num), label: hl.score.verdict || '军师评分', color: BRAND });
  if (hl.actionCount) blocks.push({ num: String(hl.actionCount), label: '项行动', color: BRAND });
  hl.toneCounts.forEach((tc) => blocks.push({ num: String(tc.n), label: `处${tc.tone}`, color: tc.tone === '风险' ? RISK : BRAND }));
  const hlBlocks = blocks.slice(0, 4);

  // 金句
  const quote = hl.quote
    ? { lines: wrapByCount(hl.quote.text, 26, 2), cite: hl.quote.cite }
    : null;

  // 结论（脱敏 + 与金句去重 + 换行）
  let rawBullets = shareBullets(d).map((b) => maskSensitive(b).replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (quote) {
    const qBare = quote.lines.join('').replace(/…$/, '');
    rawBullets = rawBullets.filter((b) => {
      const bBare = b.replace(/…$/, '');
      return !(qBare.includes(bBare) || bBare.includes(qBare));
    });
  }
  rawBullets = rawBullets.slice(0, 3);

  let bullets: string[][];
  let bulletsFallback = false;
  if (rawBullets.length) {
    bullets = rawBullets.map((b) => wrapByCount(b, Math.floor(BULLET_MAXW / 24)));
  } else if (!hlBlocks.length && !quote) {
    bullets = [wrapByCount(FALLBACK, Math.floor(INNER_W / 24))];
    bulletsFallback = true;
  } else {
    bullets = [];
  }

  // 纵向走位（绝对 y，单一真源）
  let y = coverH + BODY_TOP;
  const yBlocks = hlBlocks.length ? y : null;
  if (yBlocks !== null) y += HL_H + HL_GAP;
  const yQuote = quote ? y : null;
  if (yQuote !== null) y += quoteBlockH(quote!.lines.length, !!quote!.cite) + QUOTE_GAP;
  const yBullets = y;
  bullets.forEach((lines) => { y += lines.length * BULLET_LH + BULLET_GAP; });
  y += FOOT_GAP;
  const yFooter = y;
  const totalH = Math.round(yFooter + FOOT_H);

  return { title, coverH, blocks: hlBlocks, yBlocks, quote, yQuote, bullets, bulletsFallback, yBullets, yFooter, totalH };
}

// 画报告分享卡（固定军师参谋部品牌配色）。
function paintReportCard(ctx: CanvasRenderingContext2D, p: CardPlan) {
  const W = CW;

  // 底：暖纸
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, W, p.totalH);

  // ── 封面（深绿渐变）──
  const g = ctx.createLinearGradient(0, 0, W, p.coverH);
  g.addColorStop(0, BRAND);
  g.addColorStop(1, BRAND_DEEP);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, p.coverH);
  ctx.textAlign = 'center';
  ctx.fillStyle = GOLD;
  ctx.font = '22px sans-serif';
  ctx.fillText('◆ 军师参谋部 · 军师献策 ◆', W / 2, p.title.twoLine ? 48 : 50);
  ctx.fillStyle = PAPER;
  ctx.font = `bold ${p.title.font}px serif`;
  if (p.title.twoLine) {
    ctx.fillText(p.title.lines[0], W / 2, 92);
    if (p.title.lines[1]) ctx.fillText(p.title.lines[1], W / 2, 134);
  } else {
    ctx.fillText(p.title.lines[0], W / 2, 112);
  }
  ctx.fillStyle = 'rgba(251,250,246,.68)';
  ctx.font = '20px sans-serif';
  ctx.fillText('锦囊概要 · 机密已隐去', W / 2, p.title.twoLine ? 178 : 150);

  // ── 亮点条 ──
  if (p.yBlocks !== null && p.blocks.length) {
    const n = p.blocks.length;
    const cellW = INNER_W / n;
    p.blocks.forEach((b, i) => {
      const cx = PAD + cellW * i + cellW / 2;
      ctx.textAlign = 'center';
      ctx.fillStyle = b.color;
      ctx.font = 'bold 40px serif';
      ctx.fillText(b.num, cx, p.yBlocks! + 46);
      ctx.fillStyle = LABEL;
      ctx.font = '13px sans-serif';
      const maxLabel = Math.max(2, Math.floor(cellW / 13));
      const label = [...b.label].length > maxLabel ? `${[...b.label].slice(0, maxLabel).join('')}…` : b.label;
      ctx.fillText(label, cx, p.yBlocks! + 74);
      if (i < n - 1) {
        const dx = PAD + cellW * (i + 1);
        ctx.strokeStyle = LINE;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(dx, p.yBlocks! + 14);
        ctx.lineTo(dx, p.yBlocks! + 70);
        ctx.stroke();
      }
    });
  }

  // ── 金句块 ──
  if (p.yQuote !== null && p.quote) {
    const top = p.yQuote;
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(217,196,138,.9)';
    ctx.font = '56px serif';
    ctx.fillText('“', W / 2, top + 50);
    ctx.fillStyle = INK;
    ctx.font = '18px serif';
    p.quote.lines.forEach((ln, i) => ctx.fillText(ln, W / 2, top + 86 + i * 30));
    if (p.quote.cite) {
      const citeY = top + 86 + (p.quote.lines.length - 1) * 30 + 30;
      ctx.textAlign = 'right';
      ctx.fillStyle = LABEL;
      ctx.font = '13px sans-serif';
      ctx.fillText(`—— ${p.quote.cite}`, W - PAD, citeY);
    }
  }

  // ── 核心结论 ≤3 条 ──
  let y = p.yBullets;
  if (p.bulletsFallback) {
    ctx.textAlign = 'left';
    ctx.fillStyle = '#565C63';
    ctx.font = '23px serif';
    p.bullets[0].forEach((ln) => { ctx.fillText(ln, PAD, y); y += BULLET_LH; });
  } else {
    ctx.textAlign = 'left';
    p.bullets.forEach((lines, i) => {
      // 编号圆徽
      ctx.fillStyle = BRAND;
      ctx.beginPath();
      ctx.arc(PAD + 13, y - 8, 13, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = PAPER;
      ctx.textAlign = 'center';
      ctx.font = 'bold 18px sans-serif';
      ctx.fillText(`${i + 1}`, PAD + 13, y - 1);
      // 结论文字（多行）
      ctx.textAlign = 'left';
      ctx.fillStyle = INK;
      ctx.font = '24px serif';
      lines.forEach((ln, j) => ctx.fillText(ln, BULLET_X, y + j * BULLET_LH));
      y += lines.length * BULLET_LH + BULLET_GAP;
    });
  }

  // ── 落款 ──
  const divY = p.yFooter + 8;
  ctx.strokeStyle = 'rgba(30,90,67,.22)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PAD, divY);
  ctx.lineTo(W - PAD, divY);
  ctx.stroke();
  ctx.textAlign = 'left';
  ctx.fillStyle = BRAND;
  ctx.font = 'bold 26px serif';
  ctx.fillText('机密已隐 · 完整推演在军师参谋部', PAD, divY + 44);
  ctx.fillStyle = LABEL;
  ctx.font = '20px sans-serif';
  ctx.fillText('长按识别小程序 · 与你的军师对话', PAD, divY + 80);
}

// 生成分享图临时路径（canvasId 指向调用页内一块隐藏 <Canvas type="2d">）。
export async function makeReportShareImage(canvasId: string, d: Deliverable): Promise<string> {
  const plan = planCard(d);
  return renderCardToImage(canvasId, CW, plan.totalH, (ctx) => paintReportCard(ctx, plan));
}

// 分享动作（供 SharePreview 复用）——发好友 / 存相册。成功 resolve，失败抛出（调用方据此决定是否收起预览）。
export function shareReportImageToFriend(path: string) {
  return Taro.showShareImageMenu({ path }).catch(() => {
    Taro.showToast({ title: '可长按图片保存后转发', icon: 'none' });
    throw new Error('share-failed');
  });
}
export function saveReportImageToAlbum(path: string) {
  return Taro.saveImageToPhotosAlbum({ filePath: path })
    .then(() => Taro.showToast({ title: '已存入相册', icon: 'none' }))
    .catch(() => {
      Taro.showToast({ title: '未获相册权限，可长按图片保存', icon: 'none' });
      throw new Error('save-failed');
    });
}
