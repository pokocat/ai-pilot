function measuredWidth(ctx, text, fontSize) {
  if (ctx && typeof ctx.measureText === 'function') {
    const measured = ctx.measureText(text);
    if (measured && Number.isFinite(measured.width)) return measured.width;
  }
  return Array.from(text).reduce((width, char) => width + (/^[\x00-\xff]$/.test(char) ? fontSize * 0.55 : fontSize), 0);
}

function wrapCanvasText(ctx, value, maxWidth, fontSize) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return [];
  const lines = [];
  let line = '';
  for (const char of Array.from(text)) {
    const next = line + char;
    if (line && measuredWidth(ctx, next, fontSize) > maxWidth) {
      lines.push(line);
      line = char;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

function fitCanvasText(ctx, value, options) {
  const opts = options || {};
  const maxWidth = Number(opts.maxWidth) || 500;
  const maxLines = Number(opts.maxLines) || 4;
  const maxFontSize = Number(opts.maxFontSize) || 36;
  const minFontSize = Number(opts.minFontSize) || 18;
  for (let fontSize = maxFontSize; fontSize >= minFontSize; fontSize -= 2) {
    if (ctx && typeof ctx.setFontSize === 'function') ctx.setFontSize(fontSize);
    const lines = wrapCanvasText(ctx, value, maxWidth, fontSize);
    if (lines.length <= maxLines) return { fontSize, lineHeight: Math.round(fontSize * 1.28), lines };
  }
  if (ctx && typeof ctx.setFontSize === 'function') ctx.setFontSize(minFontSize);
  return { fontSize: minFontSize, lineHeight: Math.round(minFontSize * 1.28), lines: wrapCanvasText(ctx, value, maxWidth, minFontSize) };
}

module.exports = { measuredWidth, wrapCanvasText, fitCanvasText };
