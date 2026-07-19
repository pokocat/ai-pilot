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
// 正文：空行分段为 <p class="b">，段内单换行转 <br>。
function bodyHtml(b: string): string {
  const paras = esc(b).split(/\n{2,}/).map((p) => p.replace(/\n/g, '<br>')).filter(Boolean);
  return paras.map((p) => `<p class="b">${p}</p>`).join('');
}

// callout tone(中文) → 语义色 class。
const TONE_CLASS: Record<string, string> = { '机会': 'win', '风险': 'risk', '行动': 'order', '布局': 'def', '时机': 'adv' };

// 章节头（汉字序号 + 标题 + 可选副标题）。
function secHead(no: string, h: string, sub?: string): string {
  return `<div class="sec-head"><div class="sec-num serif">${esc(no)}</div><div><div class="sec-title">${esc(h)}</div>${sub ? `<div class="sec-sub">${esc(sub)}</div>` : ''}</div></div>`;
}

/* ───────── per-type 渲染 ───────── */
function heroHtml(s: Extract<DeliverableSection, { type: 'hero' }>): string {
  const paras = (s.paras ?? []).map((p) => `<p class="hero-p">${inlineHtml(p)}</p>`).join('');
  return `<div class="hero"><div class="hero-kicker">定 调</div><h2 class="hero-h">${inlineHtml(s.h)}</h2>${paras}</div>`;
}
function calloutHtml(s: Extract<DeliverableSection, { type: 'callout' }>): string {
  const cls = TONE_CLASS[s.tone] ?? 'def';
  return `<section><div class="callout ${cls}"><span class="tag">${esc(s.tone)}</span><div class="ct">${esc(s.h)}</div><div class="cp">${inlineHtml(s.b)}</div></div></section>`;
}
function statsHtml(s: Extract<DeliverableSection, { type: 'stats' }>): string {
  const cells = s.items.map((it) => `<div class="stat"><div class="num">${esc(it.num)}${it.unit ? `<small>${esc(it.unit)}</small>` : ''}</div><div class="lbl">${esc(it.label)}</div></div>`).join('');
  return `<div class="stats">${cells}</div>`;
}
function rosterHtml(s: Extract<DeliverableSection, { type: 'roster' }>): string {
  const intro = s.intro ? `<p class="roster-intro">${inlineHtml(s.intro)}</p>` : '';
  const cards = s.people.map((p) => `<div class="person"><div class="pn serif">${esc(p.name)}${p.role ? `<span class="pr">${esc(p.role)}</span>` : ''}</div>${p.desc ? `<div class="pd">${inlineHtml(p.desc)}</div>` : ''}</div>`).join('');
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
    const actions = it.actions?.length ? `<ul>${it.actions.map((a) => `<li>${inlineHtml(a)}</li>`).join('')}</ul>` : '';
    const kpi = it.kpi ? `<div class="phase-kpi"><span class="k">军令状</span><span class="v">${inlineHtml(it.kpi)}</span></div>` : '';
    return `<div class="phase"><div class="phase-tab">${esc(it.tab)}</div>${it.when ? `<div class="phase-when">${esc(it.when)}</div>` : ''}<div class="phase-h">${esc(it.h)}</div>${actions}${kpi}</div>`;
  }).join('');
}
function timelineHtml(s: Extract<DeliverableSection, { type: 'timeline' }>): string {
  const rows = s.items.map((it) => `<div class="tl${it.highlight ? ' gold' : ''}">${it.when ? `<div class="tl-when">${esc(it.when)}</div>` : ''}${it.h ? `<div class="tl-t">${esc(it.h)}</div>` : ''}${it.d ? `<div class="tl-d">${inlineHtml(it.d)}</div>` : ''}</div>`).join('');
  return `<div class="timeline">${rows}</div>`;
}
function quoteHtml(s: Extract<DeliverableSection, { type: 'quote' }>): string {
  return `<div class="quote"><div class="qr"></div><p class="qt serif">${inlineHtml(s.text)}</p><div class="qb"></div><div class="qcite">— ${esc(s.cite || '军师谨识')}</div></div>`;
}
function letterHtml(s: Extract<DeliverableSection, { type: 'letter' }>): string {
  const salute = s.salute ? `<p>${inlineHtml(s.salute)}</p>` : '';
  const paras = (s.paras ?? []).map((p) => `<p>${inlineHtml(p)}</p>`).join('');
  const close = s.close ? `<p class="close">${inlineHtml(s.close)}</p>` : '';
  const sign = s.sign ? `<div class="sign">${esc(s.sign)}</div>` : '';
  return `<div class="letter"><h3>军 师 手 书</h3>${salute}${paras}${close}${sign}</div>`;
}
// 旧版白卡（无 type）+ 未知 type 降级：纸白章节卡。
function basicHtml(s: DeliverableSection, no: string): string {
  const head = s.h ? secHead(no, s.h, s.sub) : '';
  const body = s.b ? bodyHtml(s.b) : '';
  const list = s.list?.length ? `<ul>${s.list.map((li) => `<li>${esc(li)}</li>`).join('')}</ul>` : '';
  const inner = body + list || '<p class="b muted">（本节待补充）</p>';
  return `<section>${head}<div class="pcard">${inner}</div></section>`;
}

// 章节型（stats/roster/table/phases/timeline）：有 h 则配汉字序号章节头。
function chapter(s: DeliverableSection, no: () => string, inner: string): string {
  const head = s.h ? secHead(no(), s.h, s.sub) : '';
  return `<section>${head}${inner}</section>`;
}

function renderSection(s: DeliverableSection, nextNo: () => string): string {
  switch (s.type) {
    case 'hero': return heroHtml(s);
    case 'callout': return calloutHtml(s);
    case 'quote': return quoteHtml(s);
    case 'letter': return letterHtml(s);
    case 'stats': return chapter(s, nextNo, statsHtml(s));
    case 'roster': return chapter(s, nextNo, rosterHtml(s));
    case 'table': return chapter(s, nextNo, tableHtml(s));
    case 'phases': return chapter(s, nextNo, phasesHtml(s));
    case 'timeline': return chapter(s, nextNo, timelineHtml(s));
    default: return basicHtml(s, s.h ? nextNo() : ''); // 白卡 + 未知 type 降级
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
  const nextNo = () => cnIndex((chapterNo += 1));
  const sections = (d.sections ?? []).map((s) => renderSection(s, nextNo)).join('\n');
  const body = sections || '<section><div class="pcard"><p class="b muted">（暂无内容）</p></div></section>';
  const trust = (d.trust && d.trust.trim()) || DEFAULT_TRUST;
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>${esc(d.title)} · 军师参谋部</title>
<style>
:root{
  --paper:#ECE7DA;--card:#FBFAF6;--green:#1E5A43;--green-cover:linear-gradient(150deg,#1E5A43,#163F30);
  --gold:#9B7C3F;--ink:#2A2E2A;--ink2:#6B6F66;
  --win:#9B7C3F;--risk:#8C3B2E;--order:#A63D2F;--def:#2F4C5C;--adv:#3F6B4F;
  --line:rgba(42,46,42,.14);
  --serif:"Songti SC","STSong","SimSun","Noto Serif SC",serif;
  --sans:-apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",sans-serif;
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:var(--paper)}
html{-webkit-text-size-adjust:100%}
body{font-family:var(--sans);color:var(--ink);line-height:1.9;font-size:14px;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
.wrap{max-width:720px;margin:0 auto;background:var(--paper)}
.serif{font-family:var(--serif)}
section{padding:38px 22px}
.sec-head{display:flex;align-items:baseline;gap:14px;margin-bottom:24px;border-bottom:1px solid var(--line);padding-bottom:14px}
.sec-num{font-family:var(--serif);font-size:40px;line-height:1;color:rgba(155,124,63,.55);flex:0 0 auto}
.sec-title{font-family:var(--serif);font-size:21px;color:var(--ink);letter-spacing:1px}
.sec-sub{font-size:12px;color:var(--ink2);margin-top:3px;letter-spacing:.5px}
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
@media print{html,body{background:#fff}.cover{min-height:auto}}
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
