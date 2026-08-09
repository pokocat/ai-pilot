// 纯文本口径：把模型产出的行内 Markdown 标记洗掉，供「只当纯文本渲染」的位使用。
//
// 由来（2026-08-09 真机实拍）：首页「军师判断 · 主要矛盾」是一个 <text>，直接吐出了
// `==你现在的主要矛盾不是……==` —— 两侧的 == 原样显示在卡片里。模型写的是 Markdown 高亮语法，
// 而这张卡（以及老板页战略事实、记忆库条目、卡片副标题等）根本不过 Markdown 渲染器。
//
// 修法只能在服务端收口：这些字段有多个消费端（小程序 <text> / H5 <Text> / 出图 canvas /
// 提示词回填），逐端各写一份清洗必然漏。== 尤其阴险——它不是 CommonMark 标准语法，
// 前端那套 towxml 也不认，所以在任何渲染路径下都只会是四个可见字符。
//
// 只洗**行内强调**：加粗/斜体/删除/高亮/行内代码/链接文字，以及行首的标题井号与引用符。
// 不碰列表符号与换行——那些位置的语义（分条）在纯文本里同样成立，洗掉反而粘成一坨。

/** 行内强调标记 → 去壳留字。链接保留可读文字，丢掉 URL（纯文本位点不了）。 */
export function plainText(input?: string | null): string {
  let s = String(input ?? '');
  if (!s) return '';
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1'); // 图片：只留 alt
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1'); // 链接：只留文字
  s = s.replace(/==([^=]+)==/g, '$1');           // 高亮（非标准语法，端上永远渲染不了）
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '$1');
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2'); // 单星斜体：避开 ** 与裸 * 列表符
  s = s.replace(/~~([^~]+)~~/g, '$1');
  s = s.replace(/`([^`]+)`/g, '$1');
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '');      // 行首标题井号
  s = s.replace(/^\s{0,3}>\s?/gm, '');           // 行首引用符
  return s.trim();
}

/** 纯文本 + 压成一行（列表/换行会把 <text> 撑成半屏，见 pages/sessions 的 oneLine 同源教训）。 */
export function plainLine(input?: string | null, max?: number): string {
  const s = plainText(input).replace(/\s+/g, ' ').trim();
  return max && max > 0 ? s.slice(0, max) : s;
}
