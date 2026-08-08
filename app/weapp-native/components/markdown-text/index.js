function asText(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try { return JSON.stringify(value); } catch (_) { return ''; }
}

function cleanInline(value) {
  return asText(value)
    .replace(/^#+\s+/, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .trim();
}

function inlineParts(value) {
  const source = cleanInline(value);
  const pattern = /(\*\*[^*\n]+\*\*|`[^`\n]+`|==[^=\n]+==|!![^!\n]+!!|##[^#\n]+##)/g;
  const parts = [];
  let last = 0;
  let match;
  while ((match = pattern.exec(source))) {
    if (match.index > last) parts.push({ text: source.slice(last, match.index), className: '' });
    const token = match[0];
    if (token.startsWith('**')) parts.push({ text: token.slice(2, -2), className: 'md-strong' });
    else if (token.startsWith('`')) parts.push({ text: token.slice(1, -1), className: 'md-code' });
    else if (token.startsWith('==')) parts.push({ text: token.slice(2, -2), className: 'md-hl' });
    else if (token.startsWith('!!')) parts.push({ text: token.slice(2, -2), className: 'md-risk' });
    else parts.push({ text: token.slice(2, -2), className: 'md-big' });
    last = match.index + token.length;
  }
  if (last < source.length) parts.push({ text: source.slice(last), className: '' });
  return (parts.length ? parts : [{ text: source, className: '' }]).map((item, key) => Object.assign({ key }, item));
}

function matchListLine(line, ordered) {
  return ordered ? /^\d+[.)]\s+(.+)$/.exec(line) : /^[-*]\s+(.+)$/.exec(line);
}

function isBlockStart(line) {
  return /^(#{1,3})\s+/.test(line)
    || line.startsWith('```')
    || /^>\s?/.test(line)
    || /^[-*]\s+/.test(line)
    || /^\d+[.)]\s+/.test(line)
    || /^\|.*\|$/.test(line);
}

function nextContentLine(lines, start) {
  for (let index = start; index < lines.length; index += 1) if (lines[index].trim()) return index;
  return -1;
}

function parseBlocks(input) {
  const normalized = asText(input).replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];
  const lines = normalized.split('\n');
  const blocks = [];
  let index = 0;
  let key = 0;
  while (index < lines.length) {
    const line = lines[index].trim();
    if (!line) { index += 1; continue; }
    if (line.startsWith('```')) {
      const body = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith('```')) { body.push(lines[index]); index += 1; }
      blocks.push({ key: key += 1, type: 'code', text: body.join('\n') });
      index += 1;
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      blocks.push({ key: key += 1, type: 'heading', levelClass: heading[1].length === 1 ? 'md-h2' : 'md-h3', parts: inlineParts(heading[2]) });
      index += 1;
      continue;
    }
    if (/^\|.*\|$/.test(line)) {
      const rows = [];
      while (index < lines.length && /^\|.*\|$/.test(lines[index].trim())) {
        const row = lines[index].trim();
        if (!/^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?$/.test(row)) {
          rows.push(row.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell, cellIndex) => ({ key: cellIndex, parts: inlineParts(cell.trim()) })));
        }
        index += 1;
      }
      if (rows.length) blocks.push({ key: key += 1, type: 'table', rows: rows.map((cells, rowIndex) => ({ key: rowIndex, head: rowIndex === 0, cells })) });
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quote = [];
      while (index < lines.length && /^>\s?/.test(lines[index].trim())) {
        quote.push(lines[index].trim().replace(/^>\s?/, ''));
        index += 1;
      }
      blocks.push({ key: key += 1, type: 'quote', parts: inlineParts(quote.join(' ')) });
      continue;
    }
    const unordered = /^[-*]\s+(.+)$/.exec(line);
    const ordered = /^\d+[.)]\s+(.+)$/.exec(line);
    if (unordered || ordered) {
      const items = [];
      const isOrdered = Boolean(ordered);
      while (index < lines.length) {
        const current = lines[index].trim();
        if (!current) {
          const next = nextContentLine(lines, index + 1);
          if (next >= 0 && matchListLine(lines[next].trim(), isOrdered)) { index = next; continue; }
          break;
        }
        const matched = matchListLine(current, isOrdered);
        if (!matched) break;
        const itemLines = [matched[1]];
        index += 1;
        while (index < lines.length) {
          const next = lines[index].trim();
          if (!next || matchListLine(next, isOrdered) || isBlockStart(next)) break;
          itemLines.push(next);
          index += 1;
        }
        items.push({ key: items.length, marker: isOrdered ? `${items.length + 1}.` : '•', parts: inlineParts(itemLines.join(' ')) });
      }
      blocks.push({ key: key += 1, type: 'list', items });
      continue;
    }
    const paragraph = [line];
    index += 1;
    while (index < lines.length && lines[index].trim() && !isBlockStart(lines[index].trim())) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    blocks.push({ key: key += 1, type: 'paragraph', parts: inlineParts(paragraph.join(' ')) });
  }
  return blocks;
}

Component({
  properties: {
    text: { type: String, value: '' },
    streaming: { type: Boolean, value: false },
    copyable: { type: Boolean, value: false },
  },
  data: { blocks: [], tailText: '' },
  observers: {
    'text,streaming': function sync(text, streaming) {
      const source = asText(text);
      const splitAt = streaming ? source.lastIndexOf('\n\n') : -1;
      const stable = streaming ? (splitAt >= 0 ? source.slice(0, splitAt) : '') : source;
      const tailText = streaming ? (splitAt >= 0 ? source.slice(splitAt + 2) : source) : '';
      if (stable === this._stableText) { this.setData({ tailText }); return; }
      this._stableText = stable;
      this.setData({ blocks: parseBlocks(stable), tailText });
    },
  },
});

module.exports = { parseBlocks, inlineParts };
