import Taro from '@tarojs/taro';
import type { Deliverable } from './api';
import { renderCardToImage, wrapText, roundRect } from './canvasCard';

// D-3-4：报告分享转图片。报告卡/方案库详情的「对外分享」改为生成一张品牌分享图——
// 只含标题 + 2-3 条核心结论（首节摘要）+「完整方案在军师参谋部」落款，**不含全文与敏感数字明细**。
// 复用送你一卦/天时日历的共享 canvas 出图管道（renderCardToImage），weapp 出图、点对点发好友/存相册。

const CW = 600; // 逻辑宽（px）
const PAD = 44;
const COVER_H = 176;
const BULLET_LH = 40; // 结论行高
const BULLET_GAP = 22; // 条间距
const FOOT_H = 132;

// 首节摘要 → 最多 3 条核心结论（去空白、逐条截断，规避全文与长数字明细）。
// 报告 V2：优先从 hero 段落 / callout 标题取要点，不足再回退旧的首节 list/正文分句逻辑。
export function shareBullets(d: Deliverable): string[] {
  const clean = (arr: string[]) => arr
    .map((x) => x.replace(/[*#>`_~]/g, '').replace(/\s+/g, ' ').trim())
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

// 估算卡片高度（Chinese 按码点计行数；宽松留白，宁可略空不截断）。
function estimateHeight(bullets: string[], innerW: number): number {
  const perLine = Math.floor(innerW / 25); // 25px/字，24px 正文
  let lines = 0;
  bullets.forEach((b) => { lines += Math.max(1, Math.ceil([...b].length / Math.max(8, perLine))); });
  const bodyH = 44 + bullets.length * BULLET_GAP + lines * BULLET_LH + 24;
  return Math.round(COVER_H + bodyH + FOOT_H);
}

// 画报告分享卡（固定军师参谋部品牌配色，不随本命色）。
function paintReportCard(ctx: CanvasRenderingContext2D, title: string, bullets: string[], H: number) {
  const W = CW;
  const innerW = W - PAD * 2;
  const bulletTextX = PAD + 40; // 数字徽标右侧文字起点

  // 底：暖纸
  ctx.fillStyle = '#FBFAF6';
  ctx.fillRect(0, 0, W, H);

  // 封面（深绿渐变）
  const g = ctx.createLinearGradient(0, 0, W, COVER_H);
  g.addColorStop(0, '#1E5A43');
  g.addColorStop(1, '#123C2C');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, COVER_H);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#D9C48A';
  ctx.font = '22px sans-serif';
  ctx.fillText('◆ 军师参谋部 · 军师献策 ◆', W / 2, 52);
  // 标题：过长自动降字号 + 单行截断，避免撑破封面
  let tt = title.replace(/\s+/g, ' ').trim();
  ctx.fillStyle = '#FBFAF6';
  ctx.font = 'bold 42px serif';
  if (ctx.measureText(tt).width > innerW) { ctx.font = 'bold 34px serif'; }
  while (tt && ctx.measureText(`${tt}…`).width > innerW) { tt = [...tt].slice(0, -1).join(''); }
  ctx.fillText(title.length > [...tt].length ? `${tt}…` : title, W / 2, 118);
  ctx.fillStyle = 'rgba(251,250,246,.68)';
  ctx.font = '21px sans-serif';
  ctx.fillText('核心结论摘要 · 完整推演见小程序', W / 2, 154);

  // 正文：编号结论
  let y = COVER_H + 52;
  ctx.textAlign = 'left';
  bullets.forEach((b, i) => {
    // 数字徽标
    ctx.fillStyle = '#1E5A43';
    ctx.beginPath();
    ctx.arc(PAD + 13, y - 8, 13, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#FBFAF6';
    ctx.textAlign = 'center';
    ctx.font = 'bold 18px sans-serif';
    ctx.fillText(`${i + 1}`, PAD + 13, y - 1);
    // 结论文字（换行）
    ctx.textAlign = 'left';
    ctx.fillStyle = '#16191D';
    ctx.font = '24px serif';
    const endY = wrapText(ctx, b, bulletTextX, y, W - bulletTextX - PAD, BULLET_LH);
    y = endY + BULLET_GAP;
  });
  if (!bullets.length) {
    ctx.fillStyle = '#565C63';
    ctx.font = '23px serif';
    y = wrapText(ctx, '这份方案的完整判断与执行动作，已在军师参谋部为你备好。', PAD, y, innerW, BULLET_LH) + BULLET_GAP;
  }

  // 落款
  const footY = H - FOOT_H + 40;
  ctx.strokeStyle = 'rgba(30,90,67,.22)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PAD, footY - 26);
  ctx.lineTo(W - PAD, footY - 26);
  ctx.stroke();
  ctx.fillStyle = '#1E5A43';
  ctx.textAlign = 'left';
  ctx.font = 'bold 26px serif';
  ctx.fillText('完整方案在军师参谋部', PAD, footY + 10);
  ctx.fillStyle = '#8A8570';
  ctx.font = '20px sans-serif';
  ctx.fillText('长按识别小程序 · 与你的军师对话', PAD, footY + 46);
}

// 生成分享图临时路径（canvasId 指向调用页内一块隐藏 <Canvas type="2d">）。
export async function makeReportShareImage(canvasId: string, d: Deliverable): Promise<string> {
  const bullets = shareBullets(d);
  const H = estimateHeight(bullets, CW - PAD * 2 - 40);
  return renderCardToImage(canvasId, CW, H, (ctx) => paintReportCard(ctx, d.title || '军师方案', bullets, H));
}

// 分享选单已在成果卡内先行选定动作时，直接执行——发好友 / 存相册（供 ReportCard 复用）。
export function shareReportImageToFriend(path: string) {
  Taro.showShareImageMenu({ path }).catch(() =>
    Taro.showToast({ title: '可长按图片保存后转发', icon: 'none' }),
  );
}
export function saveReportImageToAlbum(path: string) {
  Taro.saveImageToPhotosAlbum({ filePath: path })
    .then(() => Taro.showToast({ title: '已存到相册', icon: 'none' }))
    .catch(() => Taro.showToast({ title: '未获相册权限，可长按图片保存', icon: 'none' }));
}

// 出图后让用户选择发好友 / 存相册（复用共享出图管道的分享动作）。方案库详情页仍用此自带选单入口。
export function presentReportShareImage(path: string) {
  Taro.showActionSheet({ itemList: ['发给好友 / 群', '存到相册'] })
    .then((r) => {
      if (r.tapIndex === 0) {
        Taro.showShareImageMenu({ path }).catch(() =>
          Taro.showToast({ title: '可长按图片保存后转发', icon: 'none' }),
        );
      } else {
        Taro.saveImageToPhotosAlbum({ filePath: path })
          .then(() => Taro.showToast({ title: '已存到相册', icon: 'none' }))
          .catch(() => Taro.showToast({ title: '未获相册权限，可长按图片保存', icon: 'none' }));
      }
    })
    .catch(() => { /* 用户取消 */ });
}
