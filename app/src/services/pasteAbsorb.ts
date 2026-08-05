/**
 * 长文粘贴 → 自动归为附卷：纯判定逻辑（不碰 Taro / 不碰网络，便于单测）。
 *
 * 由来（2026-08-05 真机实拍）：主公把腾讯会议记录粘进对话框，输入框随即清空、只留一枚写着「粘贴长文」的小签，
 * 认不出存了什么，于是判定粘贴失败、又粘了一遍——两份 2612 字的重复附卷，发出后排版还挤成一团。
 * 三件事分别归位：卡面要露内容（pasteExcerpt）、重复要认得出（isSamePaste）、diff 要切准（diffPasted）。
 */

/** 卡面摘要长度：够认出「就是刚粘那段」，又不撑破单行。 */
export const PASTE_EXCERPT_LEN = 42;

/** 判为「同一段长文」的最低重合比：短的一段须占长的一段九成以上。 */
export const PASTE_DUP_RATIO = 0.9;

/**
 * 单次插入下，用公共前缀 + 公共后缀 diff 出这回粘进来的文本段。
 * prefix：prev 与 v 的公共前缀长；suffix：剩余部分的公共后缀长（上限 = prev.length - prefix，防前后缀重叠）。
 */
export function diffPasted(prev: string, v: string): { pasted: string; kept: string } {
  const n = prev.length;
  let prefix = 0;
  while (prefix < n && prev[prefix] === v[prefix]) prefix++;
  let suffix = 0;
  const maxSuffix = n - prefix;
  while (suffix < maxSuffix && prev[n - 1 - suffix] === v[v.length - 1 - suffix]) suffix++;
  const pasted = v.slice(prefix, v.length - suffix);
  const kept = v.slice(0, prefix) + v.slice(v.length - suffix);
  return { pasted, kept };
}

/** 卡面摘要：压掉换行与连续空白（会议记录几乎全是换行），取开头一小段。 */
export function pasteExcerpt(text: string, max = PASTE_EXCERPT_LEN): string {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** 比对用归一化：整段去空白。同一份记录复制两次，中间层可能动过换行与空格，正文实质不变。 */
export function pasteNorm(text: string): string {
  return String(text ?? '').replace(/\s+/g, '');
}

/**
 * 两段粘贴是不是「实质上同一段」。
 *
 * 不能只比全等：主公第二次粘贴前往往先打了几个字（实拍那条是「还有会议记录：」），
 * diff 出的段会把这几个字裹进来——长度和首尾指纹全变，全等比对必漏。
 * 故按「去空白后互为前缀/后缀 + 长度相差不到一成」判同一段：
 * 只多了句开场白能认出来，而真心补了新内容的长文（重合不足九成）不会被吞掉。
 */
export function isSamePaste(a: string, b: string, ratio = PASTE_DUP_RATIO): boolean {
  const x = pasteNorm(a);
  const y = pasteNorm(b);
  if (!x || !y) return false;
  const short = x.length <= y.length ? x : y;
  const long = x.length <= y.length ? y : x;
  if (short.length < long.length * ratio) return false;
  return long === short || long.endsWith(short) || long.startsWith(short);
}
