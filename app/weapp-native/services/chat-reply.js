function textOf(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function normalizeAsks(value) {
  return Array.isArray(value) ? value.map((ask) => {
    const row = ask && typeof ask === 'object' ? ask : {};
    const q = textOf(row.q || row.question).trim();
    const options = Array.isArray(row.options) ? row.options.map(textOf).filter(Boolean) : [];
    return q && options.length ? { q, options } : null;
  }).filter(Boolean) : [];
}

function asksFromPayload(source) {
  try {
    const parsed = JSON.parse(source);
    return normalizeAsks(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed.asks : parsed);
  } catch (_) {
    return [];
  }
}

function sameAsks(left, right) {
  if (!left.length || left.length !== right.length) return false;
  return left.every((ask, index) => ask.q === right[index].q
    && ask.options.length === right[index].options.length
    && ask.options.every((option, optionIndex) => option === right[index].options[optionIndex]));
}

function stripSerializedAsksTail(text, asksValue) {
  const source = textOf(text);
  const expected = normalizeAsks(asksValue);
  if (!source || !expected.length) return source;

  const askFence = source.match(/```ask\s*([\s\S]*?)```\s*$/);
  if (askFence) return source.slice(0, askFence.index).trimEnd();

  const jsonFence = source.match(/```(?:json)?\s*([\s\S]*?)```\s*$/i);
  if (jsonFence && sameAsks(asksFromPayload(jsonFence[1]), expected)) {
    return source.slice(0, jsonFence.index).trimEnd();
  }

  const trimmed = source.trimEnd();
  for (let index = trimmed.length - 1; index >= 0; index -= 1) {
    const char = trimmed[index];
    if (char !== '[' && char !== '{') continue;
    const lineStart = trimmed.lastIndexOf('\n', index - 1) + 1;
    if (trimmed.slice(lineStart, index).trim()) continue;
    if (sameAsks(asksFromPayload(trimmed.slice(index)), expected)) {
      return trimmed.slice(0, lineStart).trimEnd();
    }
  }
  return source;
}

function attachmentOnlyPrompt(refs) {
  const rows = Array.isArray(refs) ? refs.filter(Boolean) : [];
  if (!rows.length) return '';
  const images = rows.filter((row) => row && row.kind === 'image').length;
  const label = rows.length === 1
    ? textOf(rows[0] && rows[0].label).trim()
    : `${rows.length}份资料`;
  if (rows.length === 1 && images === 1) return '请看我附上的图片，先说明你看到了什么，再给我最关键的判断。';
  return `请通读我附上的${label ? `《${label}》` : '资料'}，先概括重点，再告诉我最值得注意的判断。`;
}

module.exports = { stripSerializedAsksTail, attachmentOnlyPrompt };
