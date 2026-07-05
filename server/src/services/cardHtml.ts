// B 级卡片渲染（M4 PR-15 第一批）：每日战报 / 天时日历 / 天命速写。
// 原则：卡片上的每个数字都来自真实账本（军令/回填/复盘/命盘），读不到就整块不显示——绝不造假；
// 品牌一律「军师参谋部」（AGENTS §0 #10 红线）；样式对齐小程序设计体系（暖纸底/深绿/金/宋体标题）。
// 骨架语义源自 V6.0 §19（V6.0 原稿外置 CSS 未随文档保留，此处按品牌设计系统重制）。
import { prisma } from '../db.js';
import { now } from './clock.js';
import { activeCasefile, todayStr } from './casefile.js';
import { reviewStreak } from './reviewLog.js';
import { syncProgress } from './progress.js';
import { loadChart, computeChart, type ChartView, type PaipanInput } from './paipan.js';
import { miniCodeDataUri } from './wechat.js';
import { env } from '../env.js';
import type { FateCardContent } from '../../../shared/contracts';

// 经典语录（V6.0 §18 语录库，公版内容）：按日期确定性轮换。
const QUOTES = [
  '集中优势兵力，各个歼灭。', '没有调查，就没有发言权。', '善战者，求之于势，不责于人。',
  '伤其十指，不如断其一指。', '不打无准备之仗。', '知己知彼，百战不殆。', '兵贵神速。',
];

const BASE_CSS = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #F4F2EC; font-family: "Noto Sans SC", -apple-system, "PingFang SC", sans-serif; color: #16191D; padding: 24px 16px; }
  .card { max-width: 420px; margin: 0 auto; border-radius: 20px; overflow: hidden; background: #FBFAF6; box-shadow: 0 18px 44px rgba(22,25,29,.12); }
  .hd { padding: 22px 20px 18px; color: #fff; background: linear-gradient(150deg, #1E5A43, #163F30); }
  .badge { display: inline-block; padding: 4px 10px; border: 1px solid rgba(255,255,255,.35); border-radius: 999px; font-size: 11px; letter-spacing: .18em; color: rgba(255,255,255,.85); }
  h1 { font-family: "Noto Serif SC", "Songti SC", serif; font-size: 26px; margin-top: 12px; font-weight: 700; }
  .date { margin-top: 6px; font-size: 12px; color: rgba(255,255,255,.6); font-weight: 600; }
  .rank { margin-top: 10px; display: inline-block; padding: 5px 11px; border-radius: 999px; background: rgba(255,255,255,.14); font-size: 12px; font-weight: 700; }
  .bd { padding: 18px 20px 6px; }
  .scores { display: flex; gap: 10px; }
  .score { flex: 1; text-align: center; padding: 13px 6px 11px; border-radius: 14px; background: #F3F1EA; }
  .score b { display: block; font-family: "Noto Serif SC", serif; font-size: 22px; color: #1E5A43; }
  .score.gold b { color: #6F5420; }
  .score span { display: block; margin-top: 4px; font-size: 11px; color: #969BA1; font-weight: 600; }
  .sec { margin-top: 16px; padding: 14px 15px; border-radius: 14px; background: #fff; border: 1px solid #E7E4DB; }
  .sec-k { font-size: 12px; font-weight: 800; letter-spacing: .14em; color: #1E5A43; }
  .sec-k.warn { color: #9C4A38; }
  .li { display: flex; gap: 9px; align-items: flex-start; padding: 8px 0; border-bottom: 1px solid #EFEDE5; font-size: 13.5px; line-height: 1.5; }
  .li:last-child { border-bottom: 0; }
  .ok { color: #1E5A43; font-weight: 800; flex-shrink: 0; }
  .no { color: #9C4A38; font-weight: 800; flex-shrink: 0; }
  .quote { margin: 16px 2px 0; padding: 13px 15px; border-left: 3px solid #9B7C3F; background: #FBF7EC; font-family: "Noto Serif SC", serif; font-size: 14px; line-height: 1.6; color: #43340F; }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 7px; margin-top: 12px; }
  .mo { padding: 11px 4px 9px; border-radius: 11px; text-align: center; background: #F3F1EA; }
  .mo b { display: block; font-size: 13px; font-weight: 800; }
  .mo span { display: block; margin-top: 3px; font-size: 10px; color: #565C63; font-weight: 600; }
  .mo.atk { background: #E7EEE9; } .mo.atk b { color: #1E5A43; }
  .mo.def { background: #F2EAD6; } .mo.def b { color: #6F5420; }
  .mo.turn { outline: 2px solid rgba(91,58,107,.35); }
  .legend { margin-top: 10px; font-size: 11px; color: #969BA1; font-weight: 600; }
  .ft { margin-top: 16px; padding: 15px 20px 20px; text-align: center; border-top: 1px solid #E7E4DB; }
  .brand { font-family: "Noto Serif SC", serif; font-size: 14px; font-weight: 700; color: #9B7C3F; letter-spacing: .12em; }
  .edition { margin-top: 4px; font-size: 10px; color: #969BA1; letter-spacing: .14em; }
  .refer { margin-top: 8px; font-size: 11px; color: #565C63; }
  .mp-code { padding: 0 20px 22px; text-align: center; }
  .mp-code img { width: 96px; height: 96px; display: block; margin: 0 auto 6px; }
  .mp-code span { font-size: 11px; color: #565C63; font-weight: 600; }
`;

function page(title: string, body: string): string {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${title} — 军师参谋部</title>
<style>${BASE_CSS}</style></head><body><div class="card">${body}</div></body></html>`;
}

function footer(refer?: string): string {
  return `<div class="ft"><div class="brand">军师参谋部</div><div class="edition">CELESTIAL MOMENTUM · V6.0</div>${refer ? `<div class="refer">${refer}</div>` : ''}</div>`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function quoteOfToday(): string {
  const d = now();
  const doy = Math.floor((d.getTime() - new Date(d.getFullYear(), 0, 0).getTime()) / 86400_000);
  return QUOTES[doy % QUOTES.length];
}

/** ⑦ 每日战报：当日军令完成/对齐/回填 + 段位/连续天数（全部服务端账本）。 */
export async function renderDailyCard(args: { tenantId: string; userId: string }): Promise<string> {
  const date = todayStr();
  const cf = await activeCasefile(args.userId);
  const orders = cf ? await prisma.casefileOrder.findMany({ where: { casefileId: cf.id, date }, orderBy: { createdAt: 'asc' } }) : [];
  const metric = cf ? await prisma.casefileMetric.findUnique({ where: { casefileId_date: { casefileId: cf.id, date } } }) : null;
  const [streak, progress] = await Promise.all([reviewStreak(args.userId), syncProgress(args.userId)]);

  const done = orders.filter((o) => o.done).length;
  const aligned = orders.filter((o) => o.aligned === true).length;
  const alignRate = orders.length ? Math.round((aligned / orders.length) * 100) : null;

  const list = orders.length
    ? orders.map((o) => `<div class="li"><span class="${o.done ? 'ok' : 'no'}">${o.done ? '✓' : '✕'}</span>${esc(o.text)}</div>`).join('')
    : '<div class="li">今天没有军令记录</div>';
  const backfillRow = metric
    ? `<div class="scores" style="margin-top:16px"><div class="score"><b>${metric.leads}</b><span>线索</span></div><div class="score"><b>${metric.consults}</b><span>咨询</span></div><div class="score"><b>${metric.deals}</b><span>成交</span></div></div>`
    : '';

  const body = `
<div class="hd"><span class="badge">◆ 军师参谋部 ◆</span><h1>每日战报</h1>
<div class="date">${date}${cf ? ` · 案卷《${esc(cf.title)}》` : ''}</div>
<span class="rank">${progress?.rank ?? '新兵'} · 连续复盘第 ${streak} 天</span></div>
<div class="bd">
<div class="scores">
<div class="score"><b>${done}/${orders.length}</b><span>军令完成</span></div>
<div class="score gold"><b>${alignRate !== null ? `${alignRate}%` : '—'}</b><span>对齐率</span></div>
<div class="score"><b>${metric ? '已回填' : '未回填'}</b><span>今日数据</span></div>
</div>
<div class="sec"><div class="sec-k">今 日 军 令</div>${list}</div>
${backfillRow}
<div class="quote">「${quoteOfToday()}」</div>
</div>${footer('身边有同样在打仗的老板？把这张卡转给他')}`;
  return page('每日战报', body);
}

/** ⑨ 天时日历：命盘年度逐月攻守（排盘引擎数据，无命盘由调用方拦 400）。 */
export function renderCalendarCard(chart: ChartView, ownerLabel: string, verse?: string | null): string {
  const months = chart.monthlyOutlook.months.map((m) => {
    const cls = m.phase === '进攻' ? 'atk' : m.phase === '防守' ? 'def' : '';
    return `<div class="mo ${cls}${m.turning ? ' turn' : ''}"><b>${m.month}月</b><span>${m.phase}${m.turning ? ' ·拐点' : ''}</span></div>`;
  }).join('');
  const key = chart.monthlyOutlook.months.filter((m) => m.turning).map((m) => `${m.month}月`).join('、') || '无明显拐点';
  const body = `
<div class="hd"><span class="badge">◆ 军师参谋部 · 天势研判 ◆</span><h1>${chart.monthlyOutlook.year} 年天时日历</h1>
<div class="date">${esc(ownerLabel)} 专属 · 引擎 ${chart.engineVersion}</div>
${verse ? `<span class="rank">「${esc(verse)}」</span>` : ''}</div>
<div class="bd">
<div class="grid">${months}</div>
<div class="legend">绿=进攻月 · 金=防守月 · 灰=平稳月 · 紫框=拐点月（${key}）</div>
<div class="sec" style="margin-top:14px"><div class="sec-k">使 用 口 径</div>
<div class="li">日主 ${chart.dayMaster.gan}${chart.dayMaster.element} · ${chart.dayMaster.strength} · 喜用 ${chart.favorableElements.join('、')}</div>
<div class="li">进攻月宜主动布局，防守月宜收缩练功；重大动作尽量避开拐点月首尾。</div></div>
</div>${footer('打印贴在办公室，每月看一眼')}`;
  return page('天时日历', body);
}

/** ⑩ 天命速写内容（命格速写 + 今年大势 + 一条建议）——全部由命盘确定性派生（非 AI）。
 *  抽成数据函数：HTML 卡（renderFateCard）与「送你一卦」小程序画图（/cards/fate/preview）同源。 */
export function fateCardContent(chart: ChartView, friendName?: string): FateCardContent {
  const atk = chart.monthlyOutlook.months.filter((m) => m.phase === '进攻').map((m) => `${m.month}月`);
  const def = chart.monthlyOutlook.months.filter((m) => m.phase === '防守').map((m) => `${m.month}月`);
  const sketch = `${chart.pattern.name}——${chart.pattern.traits}。${chart.ziwei?.soulMajorStars.length ? `命宫 ${chart.ziwei.soulMajorStars.join('、')}。` : ''}`;
  const trend = `今年${chart.monthlyOutlook.year}：${atk.length ? `${atk.slice(0, 4).join('、')}是你的进攻窗口` : '全年宜稳'}${def.length ? `；${def.slice(0, 3).join('、')}记得收着打` : ''}。`;
  const advice = chart.pattern.suits.length
    ? `你的打法在「${chart.pattern.suits[0]}」，${chart.pattern.avoid.length ? `别碰「${chart.pattern.avoid[0]}」` : '顺着天赋走'}。`
    : '先看清势，再落子。';
  return {
    friendName: friendName || '',
    subtitle: `${friendName ? `赠与 ${friendName}` : `${chart.gender === '男' ? '先生' : '女士'}命鉴`} · ${chart.solarDate} 生`,
    sketch, trend, advice,
  };
}

/** ⑩ 天命速写（送你一卦 · 裂变）HTML 版：命格速写 + 今年大势 + 一条建议——全部由命盘确定性生成。 */
export function renderFateCard(chart: ChartView, friendName?: string): string {
  const { subtitle, sketch, trend, advice } = fateCardContent(chart, friendName);
  const body = `
<div class="hd" style="background:linear-gradient(150deg,#16191D,#2A2333)"><span class="badge">◆ 军师参谋部 · 天机速写 ◆</span><h1>天命速写</h1>
<div class="date">${esc(subtitle)}</div></div>
<div class="bd">
<div class="sec"><div class="sec-k">命 格 速 写</div><div class="li">${esc(sketch)}</div></div>
<div class="sec"><div class="sec-k">今 年 大 势</div><div class="li">${esc(trend)}</div></div>
<div class="quote">「${esc(advice)}」</div>
<div class="sec" style="text-align:center;background:#F4F8F5;border-color:rgba(30,90,67,.2)">
<div style="font-size:12px;color:#969BA1">想要完整的天势 × 战略诊断？</div>
<div style="margin-top:4px;font-family:'Noto Serif SC',serif;font-size:15px;font-weight:700;color:#1E5A43">找军师参谋部</div></div>
</div>${footer()}`;
  return page('天命速写', body);
}

export type CardKind = 'daily' | 'calendar' | 'fate';

/** 生成并发布卡片，返回可分享链接。 */
/** 页脚注入小程序码（长按识别 → 直达小程序，网页卡的回流钩子）；无码（测试/未配置/接口失败）原样返回。 */
export function withMiniCode(html: string, qrDataUri: string | null): string {
  if (!qrDataUri) return html;
  const block = `<div class="mp-code"><img src="${qrDataUri}" alt="军师参谋部小程序码" /><span>长按识别小程序码 · 找军师参谋部</span></div>`;
  return html.replace('</div></body>', `${block}</div></body>`);
}

/** 卡片发布：存库留底 → 永远返回自有域名链接（{PUBLIC_BASE_URL}/api/r/:id）。
 *  刻意不走 OSS——分享出去是品牌域名、微信内直接打开；报告内打开同样走自有域名，OSS 仅作镜像。 */
async function publishCardHtml(tenantId: string, title: string, html: string, kind: CardKind): Promise<string> {
  const finalHtml = withMiniCode(html, await miniCodeDataUri(`card=${kind}`));
  const row = await prisma.reportHtml.create({ data: { tenantId, title, html: finalHtml } });
  return `${env.publicBaseUrl}/api/r/${row.id}`;
}

export async function publishCard(args: {
  tenantId: string;
  userId: string;
  kind: CardKind;
  ownerLabel?: string;
  friendName?: string;
  friendBazi?: PaipanInput; // fate 卡：朋友生辰（现算不落库）
  verse?: string | null;    // calendar 卡：年度谶语（战略档案存档）
}): Promise<string> {
  if (args.kind === 'daily') {
    return publishCardHtml(args.tenantId, '每日战报', await renderDailyCard(args), 'daily');
  }
  if (args.kind === 'calendar') {
    const chart = await loadChart(args.userId);
    if (!chart) throw Object.assign(new Error('还没有命盘，先在建档里补生辰'), { statusCode: 400, code: 'NO_CHART' });
    return publishCardHtml(args.tenantId, '天时日历', renderCalendarCard(chart, args.ownerLabel || '主理人', args.verse), 'calendar');
  }
  // fate：优先朋友生辰现算（送你一卦，不落库）；否则用自己的命盘
  const chart = args.friendBazi
    ? computeChart(args.friendBazi, now().getFullYear())
    : await loadChart(args.userId);
  if (!chart) throw Object.assign(new Error('缺少生辰：提供朋友生辰，或先补自己的命盘'), { statusCode: 400, code: 'NO_CHART' });
  return publishCardHtml(args.tenantId, '天命速写', renderFateCard(chart, args.friendName), 'fate');
}
