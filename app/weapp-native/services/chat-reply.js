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

/* ── 流式期间的 ask 协议块扣尾 ────────────────────────────────────────────────
 * 服务端的 token 流是模型原文：尾部的 ```ask 协议块**原样流出**，剥离只发生在完整结果处
 * （`server/src/llm/schema.ts` 的 `extractAsks`，gateway 注释亦写明「前端流式期间负责隐藏」）。
 * 而 towxml 打字机只增不减——协议块一旦被打出来，done 之后再喂短文本也收不回去，
 * 于是气泡底部就留下 `[{"q":"…","o` 这种截断 JSON。
 *
 * 所以喂给打字机的正文必须自己扣住「疑似协议块」的尾巴，等后续 token 把它证伪
 * （出现不符合协议块的内容）再放行：宁可短暂少显示几个字，也不能把协议块打出来。
 * 判定特征镜像服务端 `extractAsks` 的两类开头，流式期间只拿得到半个开头，所以做前缀比对：
 *   ① 标准 ```ask 围栏（含 ```、```a… 这类还没写完的开头）；
 *   ② 独占一行开头的裸 JSON：`[{"q"…` / `[{"question"…` / `{"asks"…`。
 * 扣掉的永远是后缀，所以「可见正文」始终是最终正文的前缀 —— 打字机据此只需继续追加。
 */
const ASK_FENCE = '```ask';
const BARE_ASK_OPENERS = ['[{"q"', '[{"question"', '{"asks"'];
// 只在尾部窗口里找起点：协议块规定只能出现在整条回复最末尾，窗口也避免长回复每来一个 token 就全文扫描。
const STREAM_TAIL_WINDOW = 3000;

function compactHead(value, limit) {
  let out = '';
  for (let index = 0; index < value.length && out.length < limit; index += 1) {
    const char = value[index];
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') continue;
    out += char;
  }
  return out;
}

/** 这一段尾巴像不像 ask 协议块的开头（已写全 or 还没写完都算）。 */
function looksLikeAskOpening(segment) {
  if (!segment) return false;
  if (segment[0] === '`') return segment.indexOf(ASK_FENCE) === 0 || ASK_FENCE.indexOf(segment) === 0;
  const head = compactHead(segment, 12);
  return BARE_ASK_OPENERS.some((opener) => opener.indexOf(head) === 0 || head.indexOf(opener) === 0);
}

/** 累计正文里可以安全下发给打字机的部分（疑似 ask 协议块的尾段暂扣）。 */
function streamVisibleText(text) {
  const source = textOf(text);
  if (!source) return source;
  const from = Math.max(0, source.length - STREAM_TAIL_WINDOW);
  for (let index = from; index < source.length; index += 1) {
    const char = source[index];
    if (char === '`') {
      if (index > 0 && source[index - 1] === '`') continue; // 只认反引号串的起点
    } else if (char === '[' || char === '{') {
      const lineStart = source.lastIndexOf('\n', index - 1) + 1;
      if (source.slice(lineStart, index).trim()) continue; // 裸 JSON 必须独占一行的开头（与服务端同口径）
    } else continue;
    if (looksLikeAskOpening(source.slice(index))) return source.slice(0, index).trimEnd();
  }
  return source;
}

/** 打字机只增不减：next 必须是 shown 的延长，才允许继续喂给同一个 towxml 实例。 */
function extendsShown(next, shown) {
  const head = textOf(shown);
  return !head || textOf(next).indexOf(head) === 0;
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

module.exports = { stripSerializedAsksTail, streamVisibleText, extendsShown, attachmentOnlyPrompt };
