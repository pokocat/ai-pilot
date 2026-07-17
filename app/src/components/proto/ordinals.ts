// CJK 序数（大写数字）—— 入帐行业列表 / 下一步等有序场景用。
// 对齐原型 renderVals 的 idxCn。
export const CJK_ORD = ['壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖', '拾'];

/** 取第 n 个大写序数（1-based）；超出返回阿拉伯数字兜底。 */
export function cjkOrd(n: number): string {
  return CJK_ORD[n - 1] ?? String(n);
}
