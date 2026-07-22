// 把结构化成果(Deliverable)渲染成一张自包含、可分享的战略报告 HTML 页面,存库并返回分享链接。
// 报告 V2：模型只产结构化 sections(可含 9 种富类型),版式/品牌/落款由这里按 type 分发渲染(防注入 + 成本可控)。
// 视觉身份取自样张 docs/[FABLE5]REPORT_V2_DEMO.html：米纸/纸白/深绿/哑金 + 直角 + 宋体 + 田字格印章 + 汉字序号。
import { prisma } from '../db.js';
import { env } from '../env.js';
import { ossConfigured, ossPutHtml } from './ossUpload.js';
import type { Deliverable, DeliverableSection, DeliverableTableCell } from '../llm/schema.js';

const DEFAULT_TRUST = '本报告为战略参考,重大决策请结合专业意见与一手数据。';

const CN = ['零', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖', '拾'];
// 1..20 的汉字序号(章节编号用),超出则回退阿拉伯数字。
function cnIndex(n: number): string {
  if (n >= 1 && n <= 10) return CN[n];
  if (n > 10 && n < 20) return '拾' + CN[n - 10];
  if (n === 20) return '贰拾';
  return String(n);
}

function esc(s: string): string {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}
// 行内文本：转义 + 单换行转 <br>（不解析 markdown，防注入）。
function inlineHtml(s: string | undefined): string {
  return esc(s ?? '').replace(/\n/g, '<br>');
}
// 正文数字强调：把「第N周/天/月…」与「N万/N%/N倍…」等数字片段轻度放大加金色（保守匹配，不碰年份/电话）。
// 入参必须是已转义/含标签的 HTML；只在数字后紧跟单位时命中，裸数字串（年份 2026、电话号）不匹配。
function emphNums(html: string): string {
  return html
    .replace(/(第\s*\d+\s*(?:周|旬|天|月|季度?|阶段|步|年|轮))/g, '<span class="num-emph">$1</span>')
    .replace(/(\d+(?:\.\d+)?\s*(?:万|亿|%|％|倍|天|家|人|个|元|块|分|单))/g, '<span class="num-emph">$1</span>');
}
// 行内强调标记（模型可控的极小子集，先转义后替换，防注入）：
//   **加粗**（关键动作/结论）  ==金底高亮==（最重要的一句话）  !!朱红警示!!（风险/红线）  ##大字强调##（点睛短语）
// 均不跨行、不嵌套解析；未闭合的记号原样保留（宁保守勿误吞）。
function inlineMarks(html: string): string {
  return html
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/==([^=\n]+)==/g, '<span class="mark-hl">$1</span>')
    .replace(/!!([^!\n]+)!!/g, '<span class="mark-risk">$1</span>')
    .replace(/##([^#\n]+)##/g, '<span class="mark-big serif">$1</span>');
}
// 标题/标签类字段：剥掉行内标记（不渲染也不显示原始符号，防模型在标题里滥用）。
function stripMarks(s: string | undefined): string {
  return String(s ?? '').replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/==([^=\n]+)==/g, '$1').replace(/!!([^!\n]+)!!/g, '$1').replace(/##([^#\n]+)##/g, '$1');
}
// 富行内文本：转义 → 行内标记 → 换行 → 数字强调。正文/要点/注记类字段统一走这里。
function richInline(s: string | undefined): string {
  return emphNums(inlineMarks(esc(s ?? '')).replace(/\n/g, '<br>'));
}
// 正文：空行分段为 <p class="b">，段内单换行转 <br>，行内标记 + 数字片段强调。
function bodyHtml(b: string): string {
  const paras = esc(b).split(/\n{2,}/).map((p) => inlineMarks(p).replace(/\n/g, '<br>')).filter(Boolean);
  return paras.map((p) => `<p class="b">${emphNums(p)}</p>`).join('');
}

// callout tone(中文) → 语义色 class。
const TONE_CLASS: Record<string, string> = { '机会': 'win', '风险': 'risk', '行动': 'order', '布局': 'def', '时机': 'adv' };

// 章节隔断带（汉字序号大字 + 细金线）：独立于章节卡之上，形成「隔断带 → 章节卡」的呼吸节奏。
function secDivider(no: string): string {
  return `<div class="sec-divider"><span class="sec-num serif">${esc(no)}</span><span class="sd-rule"></span></div>`;
}
// 章节标题（标题 + 可选副标题；序号已提到隔断带，这里不再重复）。
function secTitle(h: string, sub?: string): string {
  return `<div class="sec-head"><div><div class="sec-title">${esc(stripMarks(h))}</div>${sub ? `<div class="sec-sub">${esc(stripMarks(sub))}</div>` : ''}</div></div>`;
}

/* ───────── per-type 渲染 ───────── */
function heroHtml(s: Extract<DeliverableSection, { type: 'hero' }>): string {
  const paras = (s.paras ?? []).map((p) => `<p class="hero-p">${richInline(p)}</p>`).join('');
  return `<div class="hero"><div class="hero-kicker">定 调</div><h2 class="hero-h">${esc(stripMarks(s.h)).replace(/\n/g, '<br>')}</h2>${paras}</div>`;
}
function calloutHtml(s: Extract<DeliverableSection, { type: 'callout' }>): string {
  const cls = TONE_CLASS[s.tone] ?? 'def';
  return `<section><div class="callout ${cls}"><span class="tag">${esc(s.tone)}</span><div class="ct">${esc(stripMarks(s.h))}</div><div class="cp">${richInline(s.b)}</div></div></section>`;
}
function statsHtml(s: Extract<DeliverableSection, { type: 'stats' }>): string {
  const cells = s.items.map((it) => `<div class="stat"><div class="num">${esc(it.num)}${it.unit ? `<small>${esc(it.unit)}</small>` : ''}</div><div class="lbl">${esc(it.label)}</div></div>`).join('');
  return `<div class="stats">${cells}</div>`;
}
function rosterHtml(s: Extract<DeliverableSection, { type: 'roster' }>): string {
  const intro = s.intro ? `<p class="roster-intro">${richInline(s.intro)}</p>` : '';
  const cards = s.people.map((p) => `<div class="person"><div class="pn serif">${esc(p.name)}${p.role ? `<span class="pr">${esc(p.role)}</span>` : ''}</div>${p.desc ? `<div class="pd">${richInline(p.desc)}</div>` : ''}</div>`).join('');
  return `${intro}<div class="roster">${cards}</div>`;
}
function cellHtml(c: DeliverableTableCell, isHeader: boolean): string {
  const text = typeof c === 'string' ? c : c.text;
  const trend = typeof c === 'string' ? undefined : c.trend;
  const inner = trend ? `<span class="${trend === 'up' ? 'up' : 'dn'}">${esc(text)}</span>` : esc(text);
  return isHeader ? `<th>${inner}</th>` : `<td>${inner}</td>`;
}
function tableHtml(s: Extract<DeliverableSection, { type: 'table' }>): string {
  const thead = `<thead><tr>${s.headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>`;
  const tbody = `<tbody>${s.rows.map((r) => `<tr>${r.map((c, ci) => cellHtml(c, ci === 0)).join('')}</tr>`).join('')}</tbody>`;
  return `<div class="tbl-wrap"><table>${thead}${tbody}</table></div>`;
}
function phasesHtml(s: Extract<DeliverableSection, { type: 'phases' }>): string {
  return s.items.map((it) => {
    const actions = it.actions?.length ? `<ul>${it.actions.map((a) => `<li>${richInline(a)}</li>`).join('')}</ul>` : '';
    const kpi = it.kpi ? `<div class="phase-kpi"><span class="k">军令状</span><span class="v">${richInline(it.kpi)}</span></div>` : '';
    return `<div class="phase"><div class="phase-tab">${esc(it.tab)}</div>${it.when ? `<div class="phase-when">${esc(it.when)}</div>` : ''}<div class="phase-h">${esc(it.h)}</div>${actions}${kpi}</div>`;
  }).join('');
}
function timelineHtml(s: Extract<DeliverableSection, { type: 'timeline' }>): string {
  const rows = s.items.map((it) => `<div class="tl${it.highlight ? ' gold' : ''}">${it.when ? `<div class="tl-when">${esc(it.when)}</div>` : ''}${it.h ? `<div class="tl-t">${esc(it.h)}</div>` : ''}${it.d ? `<div class="tl-d">${richInline(it.d)}</div>` : ''}</div>`).join('');
  return `<div class="timeline">${rows}</div>`;
}
// 评分 → 语义色 CSS 变量（≥80 金 / 60-79 苍绿 / 40-59 黛青 / <40 赭赤）。
function scoreVar(score: number): string {
  if (score >= 80) return 'var(--gold)';
  if (score >= 60) return 'var(--adv)';
  if (score >= 40) return 'var(--def)';
  return 'var(--risk)';
}
// gauge 评分盘：左侧半环弧盘（深绿轨 + 哑金/语义色进度弧 + 中央大数字 + verdict），右侧分项横条。
// 弧盘用内联 SVG：同一条上半圆 path，进度弧靠 stroke-dasharray 截取，无 JS，单页长 PDF 完美兼容。
function gaugeHtml(s: Extract<DeliverableSection, { type: 'gauge' }>): string {
  const score = Math.max(0, Math.min(100, Math.round(s.score ?? 0)));
  const r = 82, cx = 100, cy = 105;
  const len = Math.PI * r; // 上半圆弧长
  const dash = ((score / 100) * len).toFixed(2);
  const arc = `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`; // sweep=1 → 上半圆
  const col = scoreVar(score);
  const dial = `<svg class="gauge-svg" viewBox="0 0 200 130" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="评分 ${score}">
<path d="${arc}" fill="none" stroke="var(--green)" stroke-width="12" stroke-linecap="butt" opacity="0.85"/>
<path d="${arc}" fill="none" stroke="${col}" stroke-width="12" stroke-linecap="round" stroke-dasharray="${dash} ${len.toFixed(2)}"/>
<text x="${cx}" y="98" text-anchor="middle" class="gauge-num" fill="${col}">${score}</text>
<text x="${cx}" y="120" text-anchor="middle" class="gauge-cap">分</text>
</svg>`;
  const verdict = s.verdict ? `<div class="gauge-verdict serif">${richInline(s.verdict)}</div>` : '';
  const bars = (s.items ?? []).map((it) => {
    const v = Math.max(0, Math.min(100, Math.round(it.score ?? 0)));
    const c = scoreVar(v);
    const note = it.note ? `<span class="gi-note">${richInline(it.note)}</span>` : '';
    return `<div class="gauge-item"><div class="gi-top"><span class="gi-label">${esc(it.label)}${note}</span><span class="gi-score" style="color:${c}">${v}</span></div><div class="gi-track"><div class="gi-fill" style="width:${v}%;background:${c}"></div></div></div>`;
  }).join('');
  const right = bars ? `<div class="gauge-items">${bars}</div>` : '';
  return `<div class="gauge"><div class="gauge-dial">${dial}${verdict}</div>${right}</div>`;
}
// matrix 四象限：2×2 直角格 + 轴标签在格外侧居中。quads 顺序 = 左上→右上→左下→右下。
function matrixHtml(s: Extract<DeliverableSection, { type: 'matrix' }>): string {
  const quads = (s.quads ?? []).slice(0, 4);
  while (quads.length < 4) quads.push({ title: '', items: [] });
  const cell = (q: { title: string; tone?: string; items: string[] }) => {
    const cls = q.tone ? TONE_CLASS[q.tone] ?? 'def' : '';
    const dot = q.title ? `<span class="mx-dot ${cls}"></span>` : '';
    const title = q.title ? `<div class="mx-title">${dot}${esc(q.title)}</div>` : '';
    const items = q.items?.length ? `<ul class="mx-list">${q.items.map((i) => `<li>${richInline(i)}</li>`).join('')}</ul>` : '';
    return `<div class="mx-quad">${title}${items}</div>`;
  };
  const grid = `<div class="mx-grid">${quads.map(cell).join('')}</div>`;
  const yTop = s.yLabels?.[0] ? `<div class="mx-axis mx-ytop">${esc(s.yLabels[0])}</div>` : '<div></div>';
  const yBot = s.yLabels?.[1] ? `<div class="mx-axis mx-ybot">${esc(s.yLabels[1])}</div>` : '<div></div>';
  const xLeft = s.xLabels?.[0] ? `<div class="mx-axis mx-xleft">${esc(s.xLabels[0])}</div>` : '<div></div>';
  const xRight = s.xLabels?.[1] ? `<div class="mx-axis mx-xright">${esc(s.xLabels[1])}</div>` : '<div></div>';
  return `<div class="matrix"><div></div>${yTop}<div></div>${xLeft}${grid}${xRight}<div></div>${yBot}<div></div></div>`;
}
// gantt 泳道条：顶部刻度行（1…total）+ 每行 label + 按 from/to 百分比定位的色条。纯百分比布局，PDF 静态可靠。
function ganttHtml(s: Extract<DeliverableSection, { type: 'gantt' }>): string {
  const rows = s.rows ?? [];
  const unit = s.unit ?? '周';
  const total = Math.max(1, s.total ?? rows.reduce((m, r) => Math.max(m, r.to), 1));
  const grid = `background-image:linear-gradient(to right,var(--line) 0 1px,transparent 1px);background-size:calc(100%/${total}) 100%`;
  const scaleCells = Array.from({ length: total }, (_, i) => `<span class="gt-tick">${i + 1}</span>`).join('');
  const scale = `<div class="gantt-scale"><span class="gt-cap">${esc(unit)}</span><div class="gt-ticks">${scaleCells}</div></div>`;
  const rowsHtml = rows.map((r) => {
    const from = Math.max(1, Math.min(total, r.from));
    const to = Math.max(from, Math.min(total, r.to));
    const left = ((from - 1) / total * 100).toFixed(3);
    const width = ((to - from + 1) / total * 100).toFixed(3);
    const cls = r.tone ? TONE_CLASS[r.tone] ?? '' : '';
    const note = r.note ? `<span class="gb-note">${esc(stripMarks(r.note))}</span>` : '';
    return `<div class="gantt-row"><span class="g-label">${esc(r.label)}</span><div class="g-track" style="${grid}"><div class="g-bar ${cls}" style="left:${left}%;width:${width}%">${note}</div></div></div>`;
  }).join('');
  return `<div class="gantt">${scale}${rowsHtml}</div>`;
}
function quoteHtml(s: Extract<DeliverableSection, { type: 'quote' }>): string {
  return `<div class="quote"><div class="qr"></div><p class="qt serif">${richInline(s.text)}</p><div class="qb"></div><div class="qcite">— ${esc(s.cite || '军师谨识')}</div></div>`;
}
function letterHtml(s: Extract<DeliverableSection, { type: 'letter' }>): string {
  const salute = s.salute ? `<p>${richInline(s.salute)}</p>` : '';
  const paras = (s.paras ?? []).map((p) => `<p>${richInline(p)}</p>`).join('');
  const close = s.close ? `<p class="close">${richInline(s.close)}</p>` : '';
  const sign = s.sign ? `<div class="sign">${esc(s.sign)}</div>` : '';
  return `<div class="letter"><h3>军 师 手 书</h3>${salute}${paras}${close}${sign}</div>`;
}
// 章节计数上下文：next() 返回下一章节的阿拉伯序号（用于汉字序号 + 交替底色奇偶判定）。
interface ChapterCtx { next: () => number; }

// 章节卡包装：有 h → 隔断带（汉字序号大字 + 金线）+ 交替底色章节卡；无 h → 裸章节卡（不占序号、不加隔断）。
function chapterWrap(s: DeliverableSection, ctx: ChapterCtx, inner: string): string {
  if (!s.h) return `<section class="chapter">${inner}</section>`;
  const n = ctx.next();
  const alt = n % 2 === 0 ? ' alt' : ''; // 奇偶交替：壹=纸白，贰=米白略深
  return `${secDivider(cnIndex(n))}<section class="chapter${alt}">${secTitle(s.h, s.sub)}${inner}</section>`;
}

// 旧版白卡（无 type）+ 未知 type 降级：纸白章节卡（正文/列表走数字强调）。
function basicHtml(s: DeliverableSection, ctx: ChapterCtx): string {
  const body = s.b ? bodyHtml(s.b) : '';
  const list = s.list?.length ? `<ul>${s.list.map((li) => `<li>${richInline(li)}</li>`).join('')}</ul>` : '';
  const inner = `<div class="pcard">${body + list || '<p class="b muted">（本节待补充）</p>'}</div>`;
  return chapterWrap(s, ctx, inner);
}

function renderSection(s: DeliverableSection, ctx: ChapterCtx): string {
  switch (s.type) {
    case 'hero': return heroHtml(s);
    case 'callout': return calloutHtml(s);
    case 'quote': return quoteHtml(s);
    case 'letter': return letterHtml(s);
    case 'stats': return chapterWrap(s, ctx, statsHtml(s));
    case 'roster': return chapterWrap(s, ctx, rosterHtml(s));
    case 'table': return chapterWrap(s, ctx, tableHtml(s));
    case 'phases': return chapterWrap(s, ctx, phasesHtml(s));
    case 'timeline': return chapterWrap(s, ctx, timelineHtml(s));
    case 'gauge': return chapterWrap(s, ctx, gaugeHtml(s));
    case 'matrix': return chapterWrap(s, ctx, matrixHtml(s));
    case 'gantt': return chapterWrap(s, ctx, ganttHtml(s));
    default: return basicHtml(s, ctx); // 白卡 + 未知 type 降级
  }
}

// 封面：cover 文案（无则用 title 兜底）；badge/印章/落款由模板固定。
function coverHtml(d: Deliverable): string {
  const title = d.cover?.title || d.title || '战略方略';
  const subtitle = d.cover?.subtitle || d.meta || '';
  const motto = d.cover?.motto || '';
  const metaLine = `呈 老板 亲启　·　密${d.meta && d.cover?.subtitle ? `　·　${esc(d.meta)}` : ''}`;
  return `<section class="cover">
<div class="cover-badge">◆ 军师参谋部 ◆</div>
<div class="cover-mid">
<div class="cover-mark"><div class="seal"><span>军</span><span>师</span><span>之</span><span>印</span></div></div>
<h1 class="cover-title">${esc(title)}</h1>
<div class="cover-rule"></div>
${subtitle ? `<div class="cover-subtitle">${esc(subtitle)}</div>` : ''}
${motto ? `<p class="cover-motto">「${inlineHtml(motto)}」</p>` : ''}
</div>
<div class="cover-meta"><span>${metaLine}</span></div>
</section>`;
}

/** Deliverable → 自包含战略报告 HTML（报告 V2 案卷视觉：米纸/深绿/哑金/直角/宋体/田字格印章）。 */
export function renderReportHtml(d: Deliverable): string {
  let chapterNo = 0;
  const ctx: ChapterCtx = { next: () => (chapterNo += 1) };
  const sections = (d.sections ?? []).map((s) => renderSection(s, ctx)).join('\n');
  const body = sections || '<section><div class="pcard"><p class="b muted">（暂无内容）</p></div></section>';
  const trust = (d.trust && d.trust.trim()) || DEFAULT_TRUST;
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>${esc(d.title)} · 军师参谋部</title>
<style>
:root{
  --paper:#ECE7DA;--card:#FBFAF6;--card2:#F6F3EA;--green:#1E5A43;--green-cover:linear-gradient(150deg,#1E5A43,#163F30);
  --gold:#9B7C3F;--ink:#2A2E2A;--ink2:#6B6F66;
  --win:#9B7C3F;--risk:#8C3B2E;--order:#A63D2F;--def:#2F4C5C;--adv:#3F6B4F;
  --line:rgba(42,46,42,.14);
  --serif:"Songti SC","Noto Serif CJK SC","Source Han Serif SC","STSong","SimSun",serif;
  --sans:-apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",sans-serif;
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:var(--paper)}
html{-webkit-text-size-adjust:100%}
body{font-family:var(--sans);color:var(--ink);line-height:1.9;font-size:14px;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
.wrap{max-width:720px;margin:0 auto;background:var(--paper)}
.serif{font-family:var(--serif)}
section{padding:38px 22px}
/* 章节隔断带（汉字序号 + 细金线）→ 章节卡：呼吸节奏 */
.sec-divider{display:flex;align-items:center;gap:16px;padding:40px 22px 0}
.sec-divider .sec-num{font-family:var(--serif);font-size:46px;line-height:.9;color:rgba(155,124,63,.5);flex:0 0 auto}
.sec-divider .sd-rule{flex:1;height:1px;background:linear-gradient(to right,rgba(155,124,63,.5),rgba(155,124,63,.05))}
/* 章节卡（交替底色：奇=纸白，偶=米白略深，长文滚动明暗呼吸） */
section.chapter{padding:18px 22px 34px;background:var(--card)}
section.chapter.alt{background:var(--card2)}
.sec-head{display:flex;align-items:baseline;gap:14px;margin-bottom:24px;border-bottom:1px solid var(--line);padding-bottom:14px}
.sec-num{font-family:var(--serif);font-size:40px;line-height:1;color:rgba(155,124,63,.55);flex:0 0 auto}
.sec-title{font-family:var(--serif);font-size:23px;font-weight:700;color:var(--ink);letter-spacing:2px}
.sec-sub{font-family:var(--serif);font-size:12.5px;color:var(--gold);margin-top:4px;letter-spacing:1.5px}
/* 正文数字强调 */
.num-emph{color:var(--gold);font-size:1.12em;letter-spacing:.3px}
/* 行内强调标记：**加粗** ==金底高亮== !!朱红警示!! ##大字强调## */
strong{font-weight:700;color:var(--ink)}
.mark-hl{background:rgba(155,124,63,.16);color:var(--ink);padding:0 4px;box-decoration-break:clone;-webkit-box-decoration-break:clone}
.mark-risk{color:var(--risk);font-weight:700}
.mark-big{font-family:var(--serif);font-size:1.22em;font-weight:700;color:var(--green);letter-spacing:.5px}
/* 深色块（hero/letter 深绿底）里的标记配色覆盖：墨色/深绿在深底上不可读 */
.hero strong,.letter strong{color:inherit}
.hero .mark-hl,.letter .mark-hl{background:rgba(228,217,184,.2);color:#F4EFDE}
.hero .mark-risk,.letter .mark-risk{color:#E8A18F}
.hero .mark-big,.letter .mark-big{color:#E4D9B8}
/* 白卡（旧版兼容） */
.pcard .b{font-size:14px;color:var(--ink);margin:0 0 12px;line-height:1.95}
.pcard .b:last-child{margin-bottom:0}
.pcard .b.muted{color:var(--ink2)}
.pcard ul{list-style:none;margin:6px 0 0;padding:0}
.pcard li{position:relative;font-size:13.5px;color:var(--ink);margin:9px 0;padding-left:20px;line-height:1.8}
.pcard li::before{content:"◇";position:absolute;left:2px;top:2px;color:var(--gold);font-size:11px}
/* 封面 */
.cover{background:var(--green-cover);color:#EFEAD9;min-height:100vh;padding:56px 30px 40px;display:flex;flex-direction:column;position:relative;overflow:hidden}
.cover::before{content:"";position:absolute;inset:14px;border:1px solid rgba(155,124,63,.45);pointer-events:none}
.cover::after{content:"";position:absolute;inset:19px;border:1px solid rgba(155,124,63,.20);pointer-events:none}
.cover-badge{font-family:var(--serif);font-size:13px;letter-spacing:3px;color:#C9A85E;align-self:center;margin-top:8px}
.cover-mid{flex:1;display:flex;flex-direction:column;justify-content:center;text-align:center}
.cover-mark{align-self:center;margin-bottom:30px}
.cover-title{font-family:var(--serif);font-size:40px;line-height:1.25;letter-spacing:3px;color:#F4EFDE}
.cover-rule{width:44px;height:1px;background:rgba(201,168,94,.7);margin:22px auto}
.cover-subtitle{font-family:var(--serif);font-size:16px;color:#C9BFA2;letter-spacing:2px}
.cover-motto{font-family:var(--serif);font-size:15px;color:#B7C4B0;margin-top:34px;line-height:2.1;font-style:normal}
.cover-meta{text-align:center;font-size:11px;color:rgba(201,168,94,.85);letter-spacing:2px;margin-top:8px}
.cover-meta span{white-space:nowrap}
/* 田字格金印 */
.seal{width:76px;height:76px;border:2px solid var(--gold);display:inline-grid;grid-template-columns:1fr 1fr;font-family:var(--serif);color:var(--gold);position:relative;background:transparent}
.seal span{display:flex;align-items:center;justify-content:center;font-size:20px;line-height:1}
.seal::before,.seal::after{content:"";position:absolute;background:rgba(155,124,63,.5)}
.seal::before{left:0;right:0;top:50%;height:1px}
.seal::after{top:0;bottom:0;left:50%;width:1px}
.seal.red{border-color:#A63D2F;color:#A63D2F}
.seal.red::before,.seal.red::after{background:rgba(166,61,47,.5)}
/* hero */
.hero{background:var(--green-cover);color:#EFEAD9;padding:40px 26px;position:relative}
.hero::before{content:"";position:absolute;inset:10px;border:1px solid rgba(155,124,63,.35);pointer-events:none}
.hero-kicker{font-family:var(--serif);font-size:12px;letter-spacing:4px;color:#C9A85E;margin-bottom:16px}
.hero-h{font-family:var(--serif);font-size:27px;line-height:1.5;letter-spacing:1px;color:#F4EFDE;margin-bottom:20px}
.hero-p{font-size:13.5px;color:#CFC7B0;line-height:2;margin-bottom:14px}
.hero-p:last-child{margin-bottom:0}
/* callout */
.callout{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--gold);padding:16px 18px 16px 16px;margin:0;position:relative}
.callout .tag{display:inline-block;font-family:var(--serif);font-size:12px;letter-spacing:2px;padding:1px 9px;color:#fff;background:var(--gold);margin-bottom:9px}
.callout .ct{font-family:var(--serif);font-size:16px;margin-bottom:6px;color:var(--ink)}
.callout .cp{font-size:13px;color:var(--ink);line-height:1.95}
.callout.win{border-left-color:var(--win)}.callout.win .tag{background:var(--win)}
.callout.risk{border-left-color:var(--risk)}.callout.risk .tag{background:var(--risk)}
.callout.order{border-left-color:var(--order)}.callout.order .tag{background:var(--order)}
.callout.def{border-left-color:var(--def)}.callout.def .tag{background:var(--def)}
.callout.adv{border-left-color:var(--adv)}.callout.adv .tag{background:var(--adv)}
/* stats */
.stats{display:grid;grid-template-columns:repeat(2,1fr);border:1px solid var(--line);border-bottom:none;border-right:none;background:var(--card)}
.stat{border-right:1px solid var(--line);border-bottom:1px solid var(--line);padding:18px 14px;text-align:center}
.stat .num{font-family:var(--serif);font-size:32px;line-height:1;color:var(--green);letter-spacing:1px}
.stat .num small{font-size:15px;color:var(--gold);margin-left:2px}
.stat .lbl{font-size:11.5px;color:var(--ink2);margin-top:8px;letter-spacing:1px}
@media(min-width:520px){.stats{grid-template-columns:repeat(3,1fr)}}
/* roster */
.roster-intro{font-size:12.5px;color:var(--ink2);margin:0 0 16px;line-height:1.9}
.roster{display:grid;gap:14px}
.person{background:var(--card);border:1px solid var(--line);padding:16px 18px;position:relative}
.person::after{content:"┐";position:absolute;top:4px;right:7px;color:rgba(155,124,63,.5);font-size:16px;line-height:1}
.person .pn{font-family:var(--serif);font-size:18px;color:var(--ink);display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.person .pr{font-size:11.5px;color:var(--gold);font-family:var(--serif);letter-spacing:1.5px}
.person .pd{font-size:12.5px;color:var(--ink2);margin-top:8px;line-height:1.9}
/* table */
.tbl-wrap{overflow-x:auto;border:1px solid var(--line)}
table{border-collapse:collapse;width:100%;min-width:340px;font-size:12.5px}
thead th{background:var(--green);color:#D9C48C;font-family:var(--serif);font-weight:400;letter-spacing:1px;padding:11px 12px;text-align:left;white-space:nowrap}
tbody td{padding:11px 12px;border-top:1px solid var(--line);color:var(--ink);vertical-align:top}
tbody th{padding:11px 12px;border-top:1px solid var(--line);text-align:left;font-family:var(--serif);font-weight:400;color:var(--green);white-space:nowrap}
tbody tr:nth-child(even){background:rgba(30,90,67,.035)}
td .up,th .up{color:var(--adv)}td .dn,th .dn{color:var(--risk)}
/* phases */
.phase{background:var(--card);border:1px solid var(--line);padding:22px 18px 16px;margin-top:22px;position:relative}
.phase:first-child{margin-top:6px}
.phase-tab{position:absolute;top:-13px;left:16px;background:var(--green);color:#D9C48C;font-family:var(--serif);font-size:12px;letter-spacing:2px;padding:3px 12px;border:1px solid rgba(155,124,63,.4)}
.phase-when{font-size:11.5px;color:var(--gold);font-family:var(--serif);letter-spacing:1px;margin-bottom:4px}
.phase-h{font-family:var(--serif);font-size:17px;color:var(--ink);margin-bottom:12px}
.phase ul{list-style:none;margin:0 0 14px;padding:0}
.phase li{font-size:12.5px;color:var(--ink);padding:5px 0 5px 20px;position:relative;line-height:1.8;border-bottom:1px dotted var(--line)}
.phase li:last-child{border-bottom:none}
.phase li::before{content:"◇";position:absolute;left:2px;top:5px;color:var(--gold);font-size:11px}
.phase-kpi{border-top:2px solid var(--green);padding-top:10px;margin-top:4px;display:flex;align-items:baseline;gap:8px;font-size:12px}
.phase-kpi .k{font-family:var(--serif);color:var(--order);letter-spacing:1px;flex:0 0 auto}
.phase-kpi .v{color:var(--ink);line-height:1.7}
/* timeline */
.timeline{position:relative;margin:8px 0 0 8px;padding-left:26px}
.timeline::before{content:"";position:absolute;left:0;top:6px;bottom:6px;width:1px;background:var(--line)}
.tl{position:relative;padding-bottom:22px}
.tl:last-child{padding-bottom:0}
.tl::before{content:"";position:absolute;left:-30px;top:4px;width:9px;height:9px;background:var(--card);border:2px solid var(--ink2)}
.tl.gold::before{border-color:var(--gold);background:var(--gold)}
.tl-when{font-family:var(--serif);font-size:13px;color:var(--green);letter-spacing:1px}
.tl.gold .tl-when{color:var(--gold)}
.tl-t{font-size:14px;color:var(--ink);margin:2px 0 3px;font-weight:600}
.tl-d{font-size:12.5px;color:var(--ink2);line-height:1.85}
/* gauge 评分盘 */
.gauge{display:flex;flex-wrap:wrap;gap:22px 26px;align-items:flex-start;background:var(--card);border:1px solid var(--line);padding:22px 20px}
.gauge-dial{flex:0 0 auto;text-align:center;width:190px;max-width:100%;margin:0 auto}
.gauge-svg{width:100%;height:auto;display:block}
.gauge-num{font-family:var(--serif);font-size:46px}
.gauge-cap{font-family:var(--serif);font-size:13px;fill:var(--ink2)}
.gauge-verdict{font-size:13px;color:var(--ink);letter-spacing:1px;margin-top:2px}
.gauge-items{flex:1 1 240px;min-width:220px;display:flex;flex-direction:column;gap:13px}
.gauge-item .gi-top{display:flex;justify-content:space-between;align-items:baseline;gap:10px;margin-bottom:5px}
.gauge-item .gi-label{font-size:13px;color:var(--ink)}
.gauge-item .gi-note{font-size:11px;color:var(--ink2);margin-left:6px}
.gauge-item .gi-score{font-family:var(--serif);font-size:16px;flex:0 0 auto}
.gauge-item .gi-track{height:6px;background:rgba(42,46,42,.09)}
.gauge-item .gi-fill{height:100%}
/* matrix 四象限 */
.matrix{display:grid;grid-template-columns:auto 1fr auto;grid-template-rows:auto 1fr auto;gap:6px 8px;align-items:center}
.matrix .mx-axis{font-family:var(--serif);font-size:12px;color:var(--gold);letter-spacing:1px;text-align:center}
.matrix .mx-xleft,.matrix .mx-xright{writing-mode:vertical-rl;justify-self:center}
.mx-grid{display:grid;grid-template-columns:1fr 1fr;border:1px solid var(--line);border-left:none;border-top:none;background:var(--card)}
.mx-quad{border-left:1px solid var(--line);border-top:1px solid var(--line);padding:13px 14px;min-height:96px}
.mx-title{font-family:var(--serif);font-size:14px;color:var(--ink);margin-bottom:8px;display:flex;align-items:center;gap:7px}
.mx-dot{width:10px;height:10px;flex:0 0 auto;background:var(--gold)}
.mx-dot.win{background:var(--win)}.mx-dot.risk{background:var(--risk)}.mx-dot.order{background:var(--order)}.mx-dot.def{background:var(--def)}.mx-dot.adv{background:var(--adv)}
.mx-list{list-style:none;margin:0;padding:0}
.mx-list li{font-size:12px;color:var(--ink2);line-height:1.75;padding-left:12px;position:relative}
.mx-list li::before{content:"·";position:absolute;left:2px;top:-1px;color:var(--gold);font-size:14px}
/* gantt 泳道条 */
.gantt{background:var(--card);border:1px solid var(--line);padding:16px 16px 18px}
.gantt-scale{display:flex;align-items:flex-end;margin-bottom:10px}
.gantt-scale .gt-cap{width:88px;flex:0 0 auto;font-family:var(--serif);font-size:11.5px;color:var(--gold);letter-spacing:1px}
.gantt-scale .gt-ticks{flex:1;display:flex}
.gantt-scale .gt-tick{flex:1;text-align:center;font-size:10.5px;color:var(--ink2);font-family:var(--serif)}
.gantt-row{display:flex;align-items:center;margin-top:9px}
.gantt-row .g-label{width:88px;flex:0 0 auto;font-size:12px;color:var(--ink);padding-right:8px;line-height:1.4}
.gantt-row .g-track{flex:1;position:relative;height:22px;background-repeat:repeat}
.gantt-row .g-bar{position:absolute;top:3px;bottom:3px;background:var(--green);display:flex;align-items:center;overflow:hidden}
.gantt-row .g-bar.win{background:var(--win)}.gantt-row .g-bar.risk{background:var(--risk)}.gantt-row .g-bar.order{background:var(--order)}.gantt-row .g-bar.def{background:var(--def)}.gantt-row .g-bar.adv{background:var(--adv)}
.gantt-row .gb-note{font-size:10.5px;color:#F1ECDD;padding:0 7px;white-space:nowrap;letter-spacing:.5px}
/* quote */
.quote{text-align:center;padding:46px 26px;background:var(--paper)}
.quote .qr{width:38px;height:1px;background:var(--gold);margin:0 auto 24px}
.quote .qt{font-family:var(--serif);font-size:23px;line-height:1.9;color:var(--green);letter-spacing:2px}
.quote .qb{width:38px;height:1px;background:var(--gold);margin:24px auto 0}
.quote .qcite{font-size:11.5px;color:var(--ink2);margin-top:16px;letter-spacing:2px}
/* letter */
.letter{background:var(--green-cover);color:#EFEAD9;padding:44px 28px;position:relative}
.letter::before{content:"";position:absolute;inset:12px;border:1px solid rgba(155,124,63,.3);pointer-events:none}
.letter h3{font-family:var(--serif);font-size:22px;letter-spacing:4px;color:#E4D9B8;text-align:center;margin-bottom:26px}
.letter p{font-family:var(--serif);font-size:14px;line-height:2.15;color:#CFC7B0;margin-bottom:16px;text-indent:2em}
.letter .close{text-align:center;font-family:var(--serif);font-size:19px;color:#F4EFDE;letter-spacing:3px;margin-top:30px;text-indent:0}
.letter .sign{text-align:right;font-family:var(--serif);font-size:13px;color:#C9A85E;margin-top:20px;text-indent:0}
/* footer */
footer{background:var(--paper);text-align:center;padding:40px 24px 52px;border-top:1px solid var(--line)}
footer .fmark{margin:0 auto 16px;display:inline-block}
footer .forg{font-family:var(--serif);font-size:15px;color:var(--green);letter-spacing:3px}
footer .fsmall{font-size:10.5px;color:var(--ink2);line-height:2;margin-top:12px;letter-spacing:.5px}
/* PDF/打印适配：卡片不跨页断裂；封面/深绿块背景保留（配合 puppeteer printBackground） */
@media print{
  html,body{background:#fff}
  .wrap{max-width:none}
  *{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .cover{min-height:auto;padding-top:72px;padding-bottom:72px;page-break-after:always}
  section{padding:28px 22px}
  section.chapter{padding:14px 22px 26px}
  .sec-divider{padding-top:26px;page-break-after:avoid}
  .sec-head{page-break-after:avoid}
  .callout,.stat,.person,.phase,.quote,.tl,.hero,.letter{page-break-inside:avoid}
  .stats,.roster,.tbl-wrap,table,tr,.timeline{page-break-inside:avoid}
  .gauge,.matrix,.mx-quad,.gantt,.gantt-row{page-break-inside:avoid}
  footer{page-break-inside:avoid}
}
</style></head>
<body>
<div class="wrap">
${coverHtml(d)}
${body}
<footer>
<div class="fmark"><div class="seal red" style="width:64px;height:64px"><span style="font-size:17px">参</span><span style="font-size:17px">谋</span><span style="font-size:17px">之</span><span style="font-size:17px">印</span></div></div>
<div class="forg">军师参谋部</div>
<div class="fsmall">${esc(trust)}<br>军师 · 网页版报告 · 密件 · 仅呈老板亲启</div>
</footer>
</div>
</body></html>`;
}

export interface PublishedHtml {
  /** 小程序 web-view 优先打开自有业务域名，避免 OSS 域名未进业务域名白名单导致打不开。 */
  htmlUrl: string;
  /** 可选 CDN/OSS 镜像；不作为小程序内打开入口。 */
  cdnUrl?: string;
}

export function publicReportUrl(id: string): string {
  return `${env.publicBaseUrl}/api/r/${id}`;
}

export function reportHtmlIdFromUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const own = new URL(env.publicBaseUrl);
    if (u.host === own.host) {
      const match = u.pathname.match(/\/api\/r\/([^/?#]+)$/);
      if (match) return decodeURIComponent(match[1]);
    }
    const ossBase = env.ossBaseUrl ? new URL(env.ossBaseUrl) : null;
    if ((ossBase && u.host === ossBase.host) || /\.aliyuncs\.com$/i.test(u.host)) {
      const last = u.pathname.split('/').filter(Boolean).pop() ?? '';
      const match = last.match(/^([A-Za-z0-9_-]+)\.html$/);
      if (match) return match[1];
    }
  } catch {
    return null;
  }
  return null;
}

export function webviewSafeReportUrl(url: string | undefined | null): string | null {
  const id = reportHtmlIdFromUrl(url);
  return id ? publicReportUrl(id) : (url || null);
}

/** 渲染 + 存库 + 返回可分享链接。失败抛出,由调用方吞掉(不影响产出)。
 *  小程序打开入口始终是自有域名 /api/r/:id；配了 OSS 时额外上传一份 CDN 镜像。
 *  DB report_html 行始终保留(留底 + 兜底服务)。 */
export async function publishReport(tenantId: string | null, d: Deliverable): Promise<PublishedHtml> {
  return publishHtml(tenantId, d.title || '咨询成果', renderReportHtml(d));
}

/** 通用 HTML 发布：存库留底 → 自有域名入口；OSS 配好时同步一份 CDN 镜像。 */
export async function publishHtml(tenantId: string | null, title: string, html: string): Promise<PublishedHtml> {
  const row = await prisma.reportHtml.create({
    data: { tenantId: tenantId ?? null, title, html },
  });
  const htmlUrl = publicReportUrl(row.id);
  let cdnUrl: string | undefined;
  if (ossConfigured()) {
    try {
      const key = `${env.ossKeyPrefix ? env.ossKeyPrefix + '/' : ''}${row.id}.html`;
      cdnUrl = await ossPutHtml(key, html);
    } catch (err) {
      console.error('[reportHtml] OSS 上传失败,继续使用自有域名链接:', (err as Error).message);
    }
  }
  return cdnUrl ? { htmlUrl, cdnUrl } : { htmlUrl };
}
