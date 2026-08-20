// 邀请卡出图。
//
// 这张图是要**印出去**的（名片背面、台卡、提案封底），取舍与分享卡完全不同：
//   · 二维码必须够大且四周留白——小程序码没有静区会扫不动；
//   · 邀请码要用大字重复一遍：物料被拍照转发、或码印花了时，人还能手输；
//   · 码取不到就整张作废，所以降级画「大字版」，而不是留个空框。
// 配色沿用品牌：米底 #FBFAF6 / 墨 #16191D / 深绿 #143726 / 烫金 #A07D2C。
//
// **文案刻意不接分享文案库（BUILTIN_COPY），也刻意不随机**：
// 那 12 条是给微信聊天流的——一闪而过、每次不同才不显假。这张卡是**印出去的静态物料**
// （名片背面、门店台卡、提案封底），同一批物料每张字不一样很怪，而且印错了召不回。
// 所以这里是固定一套，但口径与分享文案一致：**有钩子也有召唤**，不能只罗列痛点。

const INK = '#16191D';
const GREEN = '#143726';
const GOLD = '#A07D2C';
const CREAM = '#FBFAF6';

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fill();
}

function centerText(ctx, text, cx, y, size, color) {
  ctx.setFillStyle(color);
  ctx.setFontSize(size);
  ctx.setTextAlign('center');
  ctx.fillText(text, cx, y);
  ctx.setTextAlign('left');
}

/**
 * @param {{code:string, qr:string, slotLabel:string}} data
 *   `qr` 为空 = 服务端没给出码（凭据未配/限流），走大字降级版。
 */
function card(ctx, w, h, data) {
  const cx = w / 2;

  ctx.setFillStyle(CREAM);
  ctx.fillRect(0, 0, w, h);
  ctx.setFillStyle(GREEN);
  ctx.fillRect(0, 0, w, 12);

  centerText(ctx, '军师参谋部', cx, 110, 44, INK);
  centerText(ctx, '生意上的难题，扫码问问 AI 军师', cx, 162, 24, GOLD);

  // 码区：白底 + 静区（贴满边会扫不动）
  const boxW = 460;
  const boxX = (w - boxW) / 2;
  const boxY = 220;
  ctx.setFillStyle('#FFFFFF');
  roundRect(ctx, boxX, boxY, boxW, boxW, 16);

  if (data.qr) {
    const pad = 34;
    ctx.drawImage(data.qr, boxX + pad, boxY + pad, boxW - pad * 2, boxW - pad * 2);
    centerText(ctx, '微信扫码，直接开始问策', cx, boxY + boxW + 54, 26, INK);
    // 邀请码重复一次：物料被拍照或印花时人还能手输
    centerText(ctx, `邀请码 ${data.code || '——'}`, cx, boxY + boxW + 104, 30, GREEN);
  } else {
    centerText(ctx, '邀请码', cx, boxY + 150, 28, GOLD);
    centerText(ctx, data.code || '——', cx, boxY + 250, 88, GREEN);
    centerText(ctx, '在小程序「主公」页手动输入', cx, boxY + 330, 24, INK);
    centerText(ctx, '微信搜索「军师参谋部」', cx, boxY + boxW + 54, 26, INK);
  }

  ctx.setFillStyle(GREEN);
  ctx.fillRect(0, h - 132, w, 132);
  centerText(ctx, '获客贵 · 现金流紧 · 招人难 · 不知下一步押哪', cx, h - 82, 22, CREAM);
  centerText(ctx, '这些事，找军师陪你拆一遍', cx, h - 52, 24, GOLD);
  centerText(ctx, `${data.slotLabel} · 军师参谋部`, cx, h - 24, 20, CREAM);
}

module.exports = { card };
