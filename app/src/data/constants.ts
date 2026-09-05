// 全站文案口径常量（C5）：复盘时间统一 21:30，抽为单一来源，
// 各页禁止再散写 20:30/21:30，改从此处引用，避免混用。
export const REVIEW_TIME = '21:30';

// 命理免责（法律要件）。此前 calendar / gift / mingpan 三页各写各的，出现过
// 「经营参考」「经营节奏参考」「研究与参考」三种措辞；措辞以 server 的
// MINGPAN_DISCLAIMER（services/mingpan.ts）为准，各页禁止再散写。
// 分成两个常量是因为分享图的 canvas 只有 600px 宽，整句画一行会超边，必须分两行。
export const FORTUNE_DISCLAIMER = '命理内容仅供文化研究与参考，不构成任何决策依据';

/** 产品态度，不是法律要件；跟在免责后面，canvas 上单独占一行。 */
export const FORTUNE_CREDO = '「人谋可以改命」';

/** 页脚整句（正文里用这个）。 */
export const FORTUNE_DISCLAIMER_FULL = `${FORTUNE_DISCLAIMER}；${FORTUNE_CREDO}。`;
