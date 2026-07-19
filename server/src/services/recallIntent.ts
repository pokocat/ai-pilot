// 用户显式要求回顾此前对话时，不能只依赖固定的最近消息窗口。
// 该模块保持纯函数，供会话历史与长期记忆召回共用，避免两条链路判断口径漂移。

const RECALL_INTENT =
  /(还记得|记得吗|记不记得|你忘了|忘了吗|没忘吧|之前.{0,12}(聊|说|提|讲|告诉)|前面.{0,12}(聊|说|提|讲)|刚才.{0,12}(聊|说|提|讲)|今天.{0,12}(聊|说|提|讲)|上次.{0,12}(聊|说|提|讲)|以前.{0,12}(聊|说|提|讲)|我们.{0,8}(聊过|说过|提过)|我.{0,8}(说过|提过|告诉过你)|接着.{0,8}(之前|刚才|上次))/i;

export function isRecallIntent(text: string): boolean {
  return RECALL_INTENT.test(text.trim());
}

// 中文没有天然空格，原有 keywordScore 会把整段连续中文当成一个词。
// 会话回顾使用 2 字 bigram 覆盖“公域引流/付费社群”这类复述，并过滤高频虚词，
// 再与数字、英文 token 一起计算重合度。这里只用于同一会话候选重排，不改变知识库检索口径。
const STOP_BIGRAMS = new Set([
  '我们', '你们', '他们', '这个', '那个', '就是', '之前', '前面', '刚才', '今天', '上次',
  '已经', '可以', '然后', '还是', '没有', '什么', '怎么', '一下', '一个', '那些', '这些',
  '跟你', '聊到', '说过', '提过', '记得', '忘了', '现在', '时候', '我的', '你的',
]);

function recallTerms(text: string): Set<string> {
  const out = new Set<string>();
  const lower = text.toLowerCase();
  for (const token of lower.match(/[a-z0-9]+/g) ?? []) {
    if (token.length >= 2 || /^\d+$/.test(token)) out.add(token);
  }
  for (const run of lower.match(/[\u4e00-\u9fff]+/g) ?? []) {
    for (let i = 0; i < run.length - 1; i++) {
      const gram = run.slice(i, i + 2);
      if (!STOP_BIGRAMS.has(gram)) out.add(gram);
    }
  }
  return out;
}

/** 0..1：当前回忆问题与较早消息的业务词重合度。 */
export function sessionRecallScore(query: string, candidate: string): number {
  const q = recallTerms(query);
  if (!q.size) return 0;
  const c = recallTerms(candidate);
  let hits = 0;
  for (const term of q) if (c.has(term)) hits++;
  return hits / Math.sqrt(q.size * Math.max(1, c.size));
}
