import { renderCardToImage, roundRect } from './canvasCard';

// 每日战报卡 —— 端上 canvas 出图，交付形态是「图片」。
//
// 为什么不是链接：原实现调 POST /cards/daily 拿一条 http 链接塞进剪贴板，提示「可发朋友圈/群」。
// 小程序里这条路走不通——链接在小程序内打不开（要 web-view + 已备案业务域名），朋友圈也不接受
// 粘贴链接；用户拿到的只是一串自己都不知道该往哪贴的文本。
//
// 顺带销掉一个 P1：那条 /api/r/:id 公开页无鉴权、无有效期，且把线索/咨询/成交的**原始数字**
// 渲染在上面，等于把真实成交量挂到公网。所以本卡只画「完成率 / 连续天数」这类进度信号，
// 经营三件套一律走 blur() 转成量级描述，不出现精确数字。

const CW = 600;           // 逻辑宽
const PAD = 44;
const INNER_W = CW - PAD * 2;

// 品牌配色（与 reportShareCard 同一套，固定军师参谋部色，不随本命色）
const BRAND = '#1E5A43';
const BRAND_DEEP = '#123C2C';
const GOLD = '#D9C48A';
const PAPER = '#FBFAF6';
const INK = '#16191D';
const INK_2 = '#565C63';
const LABEL = '#8A8570';
const LINE = '#E7E4DB';

export interface DailyCardData {
  /** 展示用日期，如「8月3日」 */
  dateLabel: string;
  /** 案卷名（无则不画这一行） */
  casefileTitle?: string;
  /** 今日军令总数 / 已完成数 */
  total: number;
  done: number;
  /** 连续复盘天数（null = 未取到，整块不画） */
  streak: number | null;
  /** 今日军令文案（最多画 3 条） */
  orders: { text: string; done: boolean }[];
  /** 是否已回填今日经营数据 */
  backfilled: boolean;
}

// 经营数字模糊化：只说量级，不说具体值。分享卡是给外人看的，真实成交量不该出现在上面。
function blur(n: number): string {
  if (n <= 0) return '未开张';
  if (n < 5) return '个位数';
  if (n < 10) return '近十';
  if (n < 30) return '十几到几十';
  if (n < 100) return '数十';
  return '上百';
}

export function backfillLine(d: { leads: number; consults: number; deals: number } | null): string {
  if (!d) return '今日数据未回填';
  return `线索${blur(d.leads)} · 咨询${blur(d.consults)} · 成交${blur(d.deals)}`;
}

// 单行截断（按码点，中英文都不溢出）
function ellipsis(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('');
}

// 先算总高再画：军令条数不定，估高与绘制共用同一份计算，避免底部留白或截断。
function planHeight(d: DailyCardData): { totalH: number; orderCount: number } {
  const orderCount = Math.min(d.orders.length, 3);
  const head = 232;                       // 封面（含日期/标题/案卷行）
  const scores = 118;                     // 三格进度
  const ordersBlock = orderCount ? 56 + orderCount * 46 : 0;
  const foot = 150;                       // 回填行 + 落款
  return { totalH: head + scores + ordersBlock + foot, orderCount };
}

function paint(ctx: CanvasRenderingContext2D, d: DailyCardData, totalH: number, orderCount: number) {
  // 底
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, CW, totalH);

  // ── 封面（深绿）──
  const coverH = 232;
  const grad = ctx.createLinearGradient(0, 0, CW, coverH);
  grad.addColorStop(0, BRAND);
  grad.addColorStop(1, BRAND_DEEP);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, CW, coverH);

  ctx.fillStyle = 'rgba(255,255,255,.72)';
  ctx.font = '600 22px sans-serif';
  ctx.fillText('◆ 军师参谋部 ◆', PAD, 62);

  ctx.fillStyle = '#fff';
  ctx.font = '700 54px serif';
  ctx.fillText('每日战报', PAD, 130);

  ctx.fillStyle = 'rgba(255,255,255,.66)';
  ctx.font = '600 22px sans-serif';
  ctx.fillText(d.dateLabel, PAD, 170);

  if (d.casefileTitle) {
    ctx.fillStyle = 'rgba(255,255,255,.56)';
    ctx.font = '500 20px sans-serif';
    ctx.fillText(ellipsis(`案卷《${d.casefileTitle}》`, 22), PAD, 202);
  }

  // ── 三格进度 ──
  let y = coverH + 34;
  const gap = 14;
  const cellW = (INNER_W - gap * 2) / 3;
  const cells: { v: string; l: string; gold?: boolean }[] = [
    { v: `${d.done}/${d.total}`, l: '军令完成' },
    { v: d.total ? `${Math.round((d.done / d.total) * 100)}%` : '—', l: '完成率', gold: true },
    { v: d.streak === null ? '—' : `${d.streak} 天`, l: '连续复盘' },
  ];
  cells.forEach((c, i) => {
    const x = PAD + i * (cellW + gap);
    ctx.fillStyle = '#F3F1EA';
    roundRect(ctx, x, y, cellW, 84, 14);
    ctx.fill();
    ctx.textAlign = 'center';
    ctx.fillStyle = c.gold ? '#6F5420' : BRAND;
    ctx.font = '700 34px serif';
    ctx.fillText(c.v, x + cellW / 2, y + 44);
    ctx.fillStyle = LABEL;
    ctx.font = '600 19px sans-serif';
    ctx.fillText(c.l, x + cellW / 2, y + 70);
    ctx.textAlign = 'left';
  });
  y += 84 + 34;

  // ── 今日军令（最多 3 条）──
  if (orderCount) {
    ctx.fillStyle = BRAND;
    ctx.font = '800 21px sans-serif';
    ctx.fillText('今 日 军 令', PAD, y);
    y += 34;
    for (let i = 0; i < orderCount; i++) {
      const o = d.orders[i];
      ctx.fillStyle = o.done ? BRAND : '#B54434';
      ctx.font = '800 24px sans-serif';
      ctx.fillText(o.done ? '✓' : '·', PAD, y + 4);
      ctx.fillStyle = o.done ? INK_2 : INK;
      ctx.font = '500 24px sans-serif';
      ctx.fillText(ellipsis(o.text, 18), PAD + 30, y + 4);
      y += 46;
    }
    y += 10;
  }

  // ── 回填状态 ──
  ctx.fillStyle = d.backfilled ? '#E7EEE9' : '#F3F1EA';
  roundRect(ctx, PAD, y, INNER_W, 56, 12);
  ctx.fill();
  ctx.fillStyle = d.backfilled ? BRAND : LABEL;
  ctx.font = '600 22px sans-serif';
  ctx.fillText(d.backfilled ? '今日数据已回填 · 复盘已生成' : '今日数据待回填', PAD + 18, y + 35);
  y += 56 + 40;

  // ── 落款 ──
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PAD, y);
  ctx.lineTo(CW - PAD, y);
  ctx.stroke();
  y += 38;
  ctx.textAlign = 'center';
  ctx.fillStyle = '#9B7C3F';
  ctx.font = '700 24px serif';
  ctx.fillText('军师参谋部', CW / 2, y);
  y += 30;
  ctx.fillStyle = LABEL;
  ctx.font = '500 18px sans-serif';
  ctx.fillText('身边有同样在打仗的老板？把这张卡转给他', CW / 2, y);
  ctx.textAlign = 'left';
}

export async function makeDailyBattleImage(canvasId: string, d: DailyCardData): Promise<string> {
  const { totalH, orderCount } = planHeight(d);
  return renderCardToImage(canvasId, CW, totalH, (ctx) => paint(ctx, d, totalH, orderCount));
}
