// 把结构化成果(Deliverable)渲染成一张自包含、可分享的战略报告 HTML 页面,存库并返回分享链接。
// 报告 V2：模型只产结构化 sections(可含 9 种富类型),版式/品牌/落款由这里按 type 分发渲染(防注入 + 成本可控)。
// 视觉身份取自样张 docs/[FABLE5]REPORT_V2_DEMO.html：米纸/纸白/深绿/哑金 + 直角 + 宋体 + 田字格印章 + 汉字序号。
import { prisma } from '../db.js';
import { env } from '../env.js';
import { ossConfigured, ossPutHtml } from './ossUpload.js';
import type { Deliverable, DeliverableSection, DeliverableTableCell } from '../llm/schema.js';

// DEFAULT_TRUST 是免责语；页脚另加了显式「本内容由人工智能生成」标识（《标识办法》2025-09-01 强制显式标识）。
// TODO(合规-隐式标识)：导出 PDF 时在文件元数据写入服务者名称/编码 + 内容编号（隐式水印），当前仅有显式标识。
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
// stats 数字卡：num 按字符数降档字号——手机两列时每格净宽仅 ~137px，32px 大字碰上
// 「5000-10000」这类区间数会被折成两行，读起来像两个数（2026-07-31 线上截图实证）。
function numSizeClass(num: string, unit?: string): string {
  const len = num.length + (unit ? unit.length : 0);
  if (len >= 13) return ' xxs';
  if (len >= 10) return ' xs';
  if (len >= 7) return ' sm';
  return '';
}
function statsHtml(s: Extract<DeliverableSection, { type: 'stats' }>): string {
  const cells = s.items.map((it) => `<div class="stat"><div class="num${numSizeClass(it.num, it.unit)}">${esc(it.num)}${it.unit ? `<small>${esc(it.unit)}</small>` : ''}</div><div class="lbl">${esc(it.label)}</div></div>`).join('');
  return `<div class="stats">${cells}</div>`;
}
function rosterHtml(s: Extract<DeliverableSection, { type: 'roster' }>): string {
  const intro = s.intro ? `<p class="roster-intro">${richInline(s.intro)}</p>` : '';
  const cards = s.people.map((p) => `<div class="person"><div class="pn serif">${esc(p.name)}${p.role ? `<span class="pr">${esc(p.role)}</span>` : ''}</div>${p.desc ? `<div class="pd">${richInline(p.desc)}</div>` : ''}</div>`).join('');
  return `${intro}<div class="roster">${cards}</div>`;
}
function cellHtml(c: DeliverableTableCell, isHeader: boolean, header?: string): string {
  const text = typeof c === 'string' ? c : c.text;
  const trend = typeof c === 'string' ? undefined : c.trend;
  const inner = trend ? `<span class="${trend === 'up' ? 'up' : 'dn'}">${esc(text)}</span>` : esc(text);
  // data-h 是窄屏卡片模式下的「随值走的表头」（CSS ::before 取用）；表格模式下不显示。
  return isHeader ? `<th>${inner}</th>` : `<td data-h="${esc(header ?? '')}">${inner}</td>`;
}
// table：≥3 列的表在手机上每格净宽只剩 ~100px（约 7 个汉字一行），长句会被断成两三行碎词；
// 这类表挂 cardify，窄屏改成「一行一卡、表头随值走」，宽屏与 PDF 仍是正常表格（2026-07-31 线上截图实证）。
// 但只看列数会误伤「80 里 / 高 / 中」这种短值对比表——卡片化反而把一行摊成三张卡。
// 判据取「首列之外最长单元格的实字数」：够短就仍是表格，长句才卡片化。
function shouldCardify(s: Extract<DeliverableSection, { type: 'table' }>): boolean {
  if (s.headers.length < 3) return false;
  const longest = s.rows.reduce((max, r) => r.slice(1).reduce((m, c) => {
    const text = typeof c === 'string' ? c : c.text;
    return Math.max(m, text.replace(/\s/g, '').length); // 空格不算，「7 家 · 2 家强」实为 6 字
  }, max), 0);
  return longest >= 10; // ≥10 字 ≈ 窄屏两行以上
}
function tableHtml(s: Extract<DeliverableSection, { type: 'table' }>): string {
  const thead = `<thead><tr>${s.headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>`;
  const tbody = `<tbody>${s.rows.map((r) => `<tr>${r.map((c, ci) => cellHtml(c, ci === 0, s.headers[ci])).join('')}</tr>`).join('')}</tbody>`;
  const cardify = shouldCardify(s) ? ' cardify' : '';
  return `<div class="tbl-wrap${cardify}"><table>${thead}${tbody}</table></div>`;
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
// 手机上 2×2 每格净宽只剩 ~150px，条目碎成三四行、两侧还要让位给竖排轴标签——窄屏改单列四卡，
// 象限坐标（如「高客单 · 轻交付」）写进每张卡的角标，顶替被隐藏的外侧轴标签（2026-07-31 线上截图实证）。
function matrixHtml(s: Extract<DeliverableSection, { type: 'matrix' }>): string {
  const quads = (s.quads ?? []).slice(0, 4);
  while (quads.length < 4) quads.push({ title: '', items: [] });
  const yT = s.yLabels?.[0] ?? '', yB = s.yLabels?.[1] ?? '', xL = s.xLabels?.[0] ?? '', xR = s.xLabels?.[1] ?? '';
  const coords = [[yT, xL], [yT, xR], [yB, xL], [yB, xR]]; // 与 quads 同序：左上→右上→左下→右下
  const cell = (q: { title: string; tone?: string; items: string[] }, qi: number) => {
    const cls = q.tone ? TONE_CLASS[q.tone] ?? 'def' : '';
    const dot = q.title ? `<span class="mx-dot ${cls}"></span>` : '';
    const title = q.title ? `<div class="mx-title">${dot}${esc(q.title)}</div>` : '';
    const coordText = coords[qi].filter(Boolean).join(' · ');
    const coord = coordText ? `<div class="mx-coord">${esc(coordText)}</div>` : '';
    const items = q.items?.length ? `<ul class="mx-list">${q.items.map((i) => `<li>${richInline(i)}</li>`).join('')}</ul>` : '';
    return `<div class="mx-quad">${coord}${title}${items}</div>`;
  };
  const grid = `<div class="mx-grid">${quads.map(cell).join('')}</div>`;
  const yTop = s.yLabels?.[0] ? `<div class="mx-axis mx-ytop">${esc(s.yLabels[0])}</div>` : '<div></div>';
  const yBot = s.yLabels?.[1] ? `<div class="mx-axis mx-ybot">${esc(s.yLabels[1])}</div>` : '<div></div>';
  const xLeft = s.xLabels?.[0] ? `<div class="mx-axis mx-xleft">${esc(s.xLabels[0])}</div>` : '<div></div>';
  const xRight = s.xLabels?.[1] ? `<div class="mx-axis mx-xright">${esc(s.xLabels[1])}</div>` : '<div></div>';
  return `<div class="matrix"><div></div>${yTop}<div></div>${xLeft}${grid}${xRight}<div></div>${yBot}<div></div></div>`;
}
// gantt 泳道条：顶部刻度行（1…total）+ 每行「标题 + 区间徽章」→ 整幅色条 → 条下注解。纯百分比布局，PDF 静态可靠。
// 色条内一律不放文字：手机窄屏下一格刻度只有几十 px（8 周刻度 ≈ 26px/周），条内 note 必被 overflow 裁成半个词，
// label 也被 88px 固定列挤成两行断字（2026-07-31 线上截图实证：「你出方案」只剩「你出方」）。
// 文案全部移到色条上下的整幅行里 → 任意长度都能换行显示，色条只负责「什么时候、占多久」的时间语义。
function ganttHtml(s: Extract<DeliverableSection, { type: 'gantt' }>): string {
  const rows = s.rows ?? [];
  const unit = s.unit ?? '周';
  const total = Math.max(1, s.total ?? rows.reduce((m, r) => Math.max(m, r.to), 1));
  // 刻度抽稀：schema 允许 total 到 120（如按周排一年半），逐格标数字会糊成一片、网格线会连成灰带。
  // 每 step 格标一个数字、画一条竖线，最多 12 个数字；总时长由 gt-cap 的「共 N 周」交代。
  const step = total <= 12 ? 1 : Math.ceil(total / 12);
  const grid = `background-image:linear-gradient(to right,var(--line) 0 1px,transparent 1px);background-size:calc(100%*${step}/${total}) 100%`;
  const scaleCells = Array.from({ length: total }, (_, i) => `<span class="gt-tick">${i % step === 0 ? i + 1 : ''}</span>`).join('');
  const scale = `<div class="gantt-scale"><span class="gt-cap">共 ${total} ${esc(unit)}</span><div class="gt-ticks">${scaleCells}</div></div>`;
  const rowsHtml = rows.map((r) => {
    const from = Math.max(1, Math.min(total, r.from));
    const to = Math.max(from, Math.min(total, r.to));
    const left = ((from - 1) / total * 100).toFixed(3);
    const width = ((to - from + 1) / total * 100).toFixed(3);
    const cls = r.tone ? TONE_CLASS[r.tone] ?? '' : '';
    const span = from === to ? `第 ${from} ${esc(unit)}` : `第 ${from}–${to} ${esc(unit)}`;
    const note = r.note ? `<p class="gb-note">${esc(stripMarks(r.note))}</p>` : '';
    const head = `<div class="g-head"><span class="g-label"><i class="g-dot ${cls}"></i>${esc(r.label)}</span><span class="g-span">${span}</span></div>`;
    return `<div class="gantt-row">${head}<div class="g-track" style="${grid}"><div class="g-bar ${cls}" style="left:${left}%;width:${width}%"></div></div>${note}</div>`;
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
.stat .num{font-family:var(--serif);font-size:32px;line-height:1.12;color:var(--green);letter-spacing:1px;white-space:nowrap;font-variant-numeric:tabular-nums}
/* 长数字降档：区间数（5000-10000）在两列格子里塞不下 32px，按字符数逐级收字号 */
.stat .num.sm{font-size:25px;letter-spacing:.5px}
.stat .num.xs{font-size:21px;letter-spacing:0}
.stat .num.xxs{font-size:17px;letter-spacing:0;white-space:normal;overflow-wrap:anywhere}
.stat .num small{font-size:15px;color:var(--gold);margin-left:2px}
.stat .num.xs small,.stat .num.xxs small{font-size:.62em}
.stat .lbl{font-size:11.5px;color:var(--ink2);margin-top:8px;letter-spacing:1px}
/* 落单的末项跨满整行，不留半格空白 */
.stats .stat:last-child:nth-child(odd){grid-column:1/-1}
@media(min-width:520px){
  .stats{grid-template-columns:repeat(3,1fr)}
  .stats .stat:last-child:nth-child(odd){grid-column:auto}
  .stats .stat:last-child:nth-child(3n+1){grid-column:1/-1}
}
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
/* 窄屏 ≥3 列表格 → 一行一卡、表头随值走（data-h）；宽屏与 PDF 仍是正常表格 */
@media(max-width:519px){
  .tbl-wrap.cardify{border:none;overflow:visible}
  .tbl-wrap.cardify table{display:block;min-width:0;font-size:13px}
  .tbl-wrap.cardify thead{display:none}
  .tbl-wrap.cardify tbody{display:block}
  .tbl-wrap.cardify tbody tr{display:block;border:1px solid var(--line);background:var(--card);margin-top:10px}
  .tbl-wrap.cardify tbody tr:first-child{margin-top:0}
  .tbl-wrap.cardify tbody tr:nth-child(even){background:var(--card)}
  .tbl-wrap.cardify tbody th{display:block;border-top:none;padding:9px 13px;font-size:14.5px;white-space:normal;background:rgba(30,90,67,.06)}
  .tbl-wrap.cardify tbody td{display:block;border-top:1px solid var(--line);padding:9px 13px;line-height:1.8}
  .tbl-wrap.cardify tbody td::before{content:attr(data-h);display:block;font-family:var(--serif);font-size:11px;color:var(--gold);letter-spacing:1.5px;margin-bottom:2px}
  .tbl-wrap.cardify tbody td[data-h=""]::before{display:none}
}
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
/* matrix 四象限：窄屏单列四卡（坐标角标代轴标签），≥520px 才回到 2×2 直角格 */
.matrix{display:block}
.matrix .mx-axis{display:none}
.mx-grid{display:grid;gap:10px;background:transparent}
.mx-quad{border:1px solid var(--line);background:var(--card);padding:13px 14px}
.mx-coord{font-family:var(--serif);font-size:11px;color:var(--gold);letter-spacing:1.5px;margin-bottom:6px}
.mx-title{font-family:var(--serif);font-size:15px;color:var(--ink);margin-bottom:8px;display:flex;align-items:center;gap:7px}
.mx-dot{width:10px;height:10px;flex:0 0 auto;background:var(--gold)}
.mx-dot.win{background:var(--win)}.mx-dot.risk{background:var(--risk)}.mx-dot.order{background:var(--order)}.mx-dot.def{background:var(--def)}.mx-dot.adv{background:var(--adv)}
.mx-list{list-style:none;margin:0;padding:0}
.mx-list li{font-size:13px;color:var(--ink2);line-height:1.85;padding-left:12px;position:relative;margin-top:3px}
.mx-list li::before{content:"·";position:absolute;left:2px;top:-1px;color:var(--gold);font-size:14px}
@media(min-width:520px){
  .matrix{display:grid;grid-template-columns:auto 1fr auto;grid-template-rows:auto 1fr auto;gap:6px 8px;align-items:center}
  .matrix .mx-axis{display:block;font-family:var(--serif);font-size:12px;color:var(--gold);letter-spacing:1px;text-align:center}
  .matrix .mx-xleft,.matrix .mx-xright{writing-mode:vertical-rl;justify-self:center}
  .mx-grid{grid-template-columns:1fr 1fr;gap:0;border:1px solid var(--line);border-left:none;border-top:none;background:var(--card)}
  .mx-quad{border:none;border-left:1px solid var(--line);border-top:1px solid var(--line);min-height:96px}
  .mx-coord{display:none}
  .mx-title{font-size:14px}
  .mx-list li{font-size:12px;line-height:1.75;margin-top:0}
}
/* gantt 泳道条：标题+区间徽章一行 → 整幅色条一行 → 注解一行；条内不写字，任何窄屏都不裁文案 */
.gantt{background:var(--card);border:1px solid var(--line);padding:14px 16px 4px}
.gantt-scale{margin-bottom:9px}
.gantt-scale .gt-cap{display:block;font-family:var(--serif);font-size:11.5px;color:var(--gold);letter-spacing:1px;margin-bottom:5px}
.gantt-scale .gt-ticks{display:flex}
.gantt-scale .gt-tick{flex:1;text-align:center;font-size:10.5px;color:var(--ink2);font-family:var(--serif)}
.gantt-row{padding:11px 0 13px;border-top:1px solid var(--line)}
.gantt-row .g-head{display:flex;align-items:baseline;gap:10px}
.gantt-row .g-label{flex:1;font-size:13px;color:var(--ink);line-height:1.6}
.gantt-row .g-dot{display:inline-block;width:8px;height:8px;margin-right:7px;background:var(--green);font-style:normal}
.gantt-row .g-span{flex:0 0 auto;font-family:var(--serif);font-size:11.5px;color:var(--gold);letter-spacing:.5px;white-space:nowrap}
.gantt-row .g-track{position:relative;height:13px;margin-top:8px;background-repeat:repeat}
.gantt-row .g-bar{position:absolute;top:0;bottom:0;background:var(--green)}
.gantt .g-bar.win,.gantt .g-dot.win{background:var(--win)}.gantt .g-bar.risk,.gantt .g-dot.risk{background:var(--risk)}.gantt .g-bar.order,.gantt .g-dot.order{background:var(--order)}.gantt .g-bar.def,.gantt .g-dot.def{background:var(--def)}.gantt .g-bar.adv,.gantt .g-dot.adv{background:var(--adv)}
.gantt-row .gb-note{font-size:12px;color:var(--ink2);line-height:1.75;margin-top:8px}
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
  /* gantt 整块不再 avoid：改版后一行占三段（标题/色条/注解），十几行必然超过一页，
     整块 avoid 会逼出一整页空白再溢出裁切。改成「单行不裁 + 刻度行不与首行分离」。 */
  .gauge,.matrix,.mx-quad,.gantt-row{page-break-inside:avoid}
  .gantt-scale{page-break-after:avoid}
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
<div class="fsmall"><strong>本内容由人工智能生成</strong><br>${esc(trust)}<br>军师 · 网页版报告 · 密件 · 仅呈老板亲启</div>
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
export async function publishReport(tenantId: string | null, userId: string | null, d: Deliverable): Promise<PublishedHtml> {
  return publishHtml(tenantId, userId, d.title || '咨询成果', renderReportHtml(d));
}

/** 通用 HTML 发布：存库留底 → 自有域名入口；OSS 配好时同步一份 CDN 镜像。 */
export async function publishHtml(tenantId: string | null, userId: string | null, title: string, html: string): Promise<PublishedHtml> {
  const row = await prisma.reportHtml.create({
    data: { tenantId: tenantId ?? null, userId: userId ?? null, title, html },
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
