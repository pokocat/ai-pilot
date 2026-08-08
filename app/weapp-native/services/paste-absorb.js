const PASTE_EXCERPT_LEN = 42;
const PASTE_DUP_RATIO = 0.9;

function diffPasted(previous, value) {
  const before = String(previous || '');
  const next = String(value || '');
  const size = before.length;
  let prefix = 0;
  while (prefix < size && before[prefix] === next[prefix]) prefix += 1;
  let suffix = 0;
  const maxSuffix = size - prefix;
  while (suffix < maxSuffix && before[size - 1 - suffix] === next[next.length - 1 - suffix]) suffix += 1;
  return {
    pasted: next.slice(prefix, next.length - suffix),
    kept: next.slice(0, prefix) + next.slice(next.length - suffix),
  };
}

function pasteExcerpt(value, max) {
  const limit = Number.isFinite(Number(max)) ? Number(max) : PASTE_EXCERPT_LEN;
  const flat = String(value || '').replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

function pasteNorm(value) { return String(value || '').replace(/\s+/g, ''); }

function isSamePaste(left, right, ratio) {
  const x = pasteNorm(left);
  const y = pasteNorm(right);
  if (!x || !y) return false;
  const short = x.length <= y.length ? x : y;
  const long = x.length <= y.length ? y : x;
  const threshold = Number.isFinite(Number(ratio)) ? Number(ratio) : PASTE_DUP_RATIO;
  if (short.length < long.length * threshold) return false;
  return long === short || long.startsWith(short) || long.endsWith(short);
}

module.exports = { PASTE_EXCERPT_LEN, PASTE_DUP_RATIO, diffPasted, pasteExcerpt, pasteNorm, isSamePaste };
