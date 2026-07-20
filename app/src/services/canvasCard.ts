import Taro from '@tarojs/taro';

// 小程序 canvas 2d 画卡 → 导出临时图片路径的共享管道（送你一卦 / 天时日历 / 后续战报卡复用）。
// 卡片以「图片文件」交付：用户点对点发好友/存相册，无公开可爬 URL、渲染自带（免 webview 字体/CDN/域名白名单问题）。
// paint 拿到已按 dpr scale 的 ctx，在 w×h 逻辑坐标系里作画。

export function renderCardToImage(
  canvasId: string,
  w: number,
  h: number,
  paint: (ctx: CanvasRenderingContext2D) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const q = Taro.createSelectorQuery();
    q.select(`#${canvasId}`).fields({ node: true, size: true }).exec((res) => {
      const node = res?.[0]?.node;
      if (!node) { reject(new Error('canvas 未就绪')); return; }
      const dpr = Taro.getWindowInfo().pixelRatio || 2;
      node.width = w * dpr;
      node.height = h * dpr;
      const ctx = node.getContext('2d');
      ctx.scale(dpr, dpr);
      paint(ctx);
      // 等一帧确保绘制入队完成再导出（真机上偶发导出空白的兜底）
      setTimeout(() => {
        Taro.canvasToTempFilePath({
          canvas: node, x: 0, y: 0, width: w * dpr, height: h * dpr, destWidth: w * 2, destHeight: h * 2,
          success: (r) => resolve(r.tempFilePath),
          fail: (e) => reject(e),
        });
      }, 60);
    });
  });
}

// 发给朋友/群/朋友圈（系统转发面板，图片文件）
export function shareCardImage(path: string) {
  Taro.showShareImageMenu({ path }).catch(() =>
    Taro.showToast({ title: '可长按图片保存后转发', icon: 'none' }),
  );
}

// 存相册（供打印/二次分享）
export function saveCardImage(path: string) {
  Taro.saveImageToPhotosAlbum({ filePath: path })
    .then(() => Taro.showToast({ title: '已存到相册', icon: 'none' }))
    .catch(() => Taro.showToast({ title: '未获相册权限，可长按图片保存', icon: 'none' }));
}

// 逐字换行绘制，返回结束 y（中文按字断行）
export function wrapText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxW: number, lineH: number): number {
  let line = '';
  let curY = y;
  for (const ch of text) {
    const test = line + ch;
    if (ctx.measureText(test).width > maxW && line) {
      ctx.fillText(line, x, curY);
      line = ch;
      curY += lineH;
    } else {
      line = test;
    }
  }
  if (line) { ctx.fillText(line, x, curY); curY += lineH; }
  return curY;
}

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
