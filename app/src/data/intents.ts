// 产出意图 → 智能体 key（对齐原型 KEY2AGENT），用于首页自由文本/快捷入口路由。
export const KEY2AGENT: Record<string, string> = {
  战略体检: 'strat',
  增长方案: 'growth',
  融资准备: 'fund',
  竞品洞察: 'intel',
  商业模式画布: 'model',
  组织优化建议: 'org',
  营销内容: 'brand',
  经营分析: 'ops',
  企业IP打造: 'ip',
  企业宣传片: 'promo',
  海报设计: 'poster',
  短视频策划: 'shortvideo',
  营销文案: 'copy',
};

export function agentForText(text: string): string {
  return KEY2AGENT[text] ?? 'general';
}

// 问诊四问（新设计稿 chat 首屏 diagnosis-card）：新会话开场先让用户按这四件事讲，讲不全也没关系，军师会继续追问。
// 设计意图是把「不知道从哪说起」变成「照着讲」，所以四条都写成大白话，不出现模块名。
export const DIAGNOSIS_ASKS: [string, string][] = [
  ['你是谁', '行业、公司、项目、现在什么阶段。'],
  ['想要什么', '增长、IP、公司架构、融资、注册公司或新项目。'],
  ['最卡哪里', '流量、转化、团队、资料、账号、财务或执行。'],
  ['手里有什么', '聊天记录、表格、截图、案例、账号和历史方案。'],
];

// 开场快捷 chips（设计稿 chat-shortcuts）：按卡点进对话，而不是按功能进对话。
// label 是按钮上的短词，text 是真正发给军师的话——短词直接发出去军师拿不到上下文。
export const DIAGNOSIS_CHIPS: { label: string; text: string }[] = [
  { label: '增长卡住了', text: '我的增长卡住了：客流和成交都上不去，先帮我判断卡在哪一步。' },
  { label: '打造 IP', text: '我想打造个人 IP，但不确定先做内容还是先做产品，帮我判断顺序。' },
  { label: '公司架构', text: '我有多个公司或事业线要整理，帮我看清主体、权责和承接关系该怎么理。' },
  { label: '资料太乱', text: '我的资料很乱（聊天记录、表格、截图都有），帮我看先整理哪一类最有用。' },
  { label: '新项目落地', text: '我有个新项目想落地，帮我判断值不值得做、第一步先做什么。' },
];

// —— 补军师档案的两种意图，别混用 ——
//
// 档案缺口（understanding.nextQuestions）在三个地方露出来：军令页第 0 号军令、军情页待补证据、
// 老板页档案工作台。这些位置**显示的是一条具体问题**（如「你的公司、门店或品牌叫什么？」），
// 但此前点进对话统一发的是下面这条批量话术，等于把用户刚点的那条问题丢了，
// 让军师重新再问一遍——用户看到的是「我明明点了这条，它却装作不知道」。
//
// 现在按位置分开：点具体问题走 archiveAnswerPrompt(q)，点聚合入口（「待补资料 N」）才走批量。

/** 聚合入口用：不指定哪一条，让军师挑最关键的几条来问。 */
export const ARCHIVE_INTERVIEW_PROMPT = '帮我补齐军师档案：你先问我最关键的 1-3 个问题，我来答。';

/** 具体问题用：把用户点的那条原样带进对话，军师只问这一条，用户直接答。 */
export function archiveAnswerPrompt(question: string): string {
  const q = question.trim();
  if (!q) return ARCHIVE_INTERVIEW_PROMPT; // 问题为空时退回批量，别发一句空指令
  return `我来补一条军师档案。先问我这一条：「${q}」——问完我直接答，不用先铺垫。`;
}
