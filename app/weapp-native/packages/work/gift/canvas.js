function render(page, canvasId, width, height, paint) {
  return new Promise((resolve, reject) => {
    try {
      const context = wx.createCanvasContext(canvasId, page);
      paint(context, width, height);
      context.draw(false, () => {
        setTimeout(() => wx.canvasToTempFilePath({ canvasId, width, height, destWidth: width * 2, destHeight: height * 2, success: (result) => resolve(result.tempFilePath), fail: reject }, page), 80);
      });
    } catch (error) { reject(error); }
  });
}

function wrapText(context, text, x, y, maxWidth, lineHeight) {
  const chars = Array.from(String(text || ''));
  let line = '';
  let cursor = y;
  chars.forEach((char) => {
    const next = line + char;
    if (line && context.measureText(next).width > maxWidth) { context.fillText(line, x, cursor); line = char; cursor += lineHeight; }
    else line = next;
  });
  if (line) { context.fillText(line, x, cursor); cursor += lineHeight; }
  return cursor;
}

function save(filePath) {
  if (!filePath) return;
  wx.saveImageToPhotosAlbum({ filePath, success: () => wx.showToast({ title: '已保存到相册', icon: 'none' }), fail: (error) => { if (!/cancel/i.test(String(error.errMsg || ''))) wx.showToast({ title: '保存失败，请在设置中允许相册权限', icon: 'none' }); } });
}

function share(filePath) {
  if (!filePath) return;
  if (wx.showShareImageMenu) wx.showShareImageMenu({ path: filePath, fail: () => wx.previewImage({ urls: [filePath] }) });
  else wx.previewImage({ urls: [filePath] });
}

module.exports = { render, wrapText, save, share };
