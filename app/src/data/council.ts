// 军师参谋室 · 总军师 / 专业军师协同结构。
// 只描述「谁负责什么、结论如何回流」这类产品结构，不预置任何用户业务结论；
// 线程的最近内容一律取真实会话（api.sessions）。

export interface SpecialistMeta {
  agentKey: string;   // 对应 data/agents.ts / GET /agents 里的 key
  duty: string;       // 线程职责（列表行的角色说明）
  syncDesc: string;   // 与总军师的同步说明
}

// 军师花名（拟人化称谓，对齐设计稿：玄衡/观澜/青衍/鸣璋/照微/云枢…）。
export const ADVISOR_ALIAS: Record<string, string> = {
  general: '玄衡',
  strat: '观澜',
  growth: '青衍',
  ip: '鸣璋',
  ops: '照微',
  org: '云枢',
  intel: '察远',
  fund: '泓策',
  model: '构衡',
  brand: '声澜',
  promo: '影湛',
  poster: '绘章',
  shortvideo: '流光',
  copy: '墨言',
};

// 常驻专业军师（参谋室置顶线程）：战略 / 增长 / IP / 经营复盘。
export const CORE_SPECIALISTS: SpecialistMeta[] = [
  { agentKey: 'strat', duty: '主要矛盾 · 取舍', syncDesc: '战略判断沉淀为战局主线' },
  { agentKey: 'growth', duty: '获客 · 转化 · 复购', syncDesc: '转化路径直通执行指标' },
  { agentKey: 'ip', duty: '定位 · 内容 · 发布', syncDesc: '内容任务写入每日军令' },
  { agentKey: 'ops', duty: '数据 · 复盘 · 节奏', syncDesc: '数据更新，明日打法随调' },
];

// 更多专业军师（顾问目录的其余 advisory 智能体按需展开）。
export const MORE_SPECIALIST_KEYS = ['intel', 'fund', 'model', 'org', 'brand'];

// 总军师对话里的「派给专业军师」建议 chips。
export const DISPATCH_SUGGESTIONS = [
  { agentKey: 'strat', icon: 'target', name: '派给战略军师', prompt: '把我刚才的问题交给你重新判断：主要矛盾是什么，该攻该守该等？' },
  { agentKey: 'growth', icon: 'trend', name: '派给增长军师', prompt: '把我刚才的问题拆成获客、转化、复购和可验证的执行指标。' },
  { agentKey: 'ip', icon: 'crown', name: '派给 IP 军师', prompt: '围绕我刚才的问题，拆成定位、选题和发布任务。' },
  { agentKey: 'ops', icon: 'clock', name: '派给经营复盘', prompt: '基于我刚才的问题，生成今天的复盘清单和需要补充的数据。' },
];

// 参谋室「快速诊断」起手式。
export const QUICK_STARTERS = [
  {
    agentKey: 'general',
    icon: 'spark',
    title: '生成战略案卷',
    prompt: '基于我们最近认可的方案，生成一份战略案卷：拆成目标、任务、报告、提醒和复盘节点。',
  },
  {
    agentKey: 'ip',
    icon: 'crown',
    title: '打造个人 IP',
    prompt: '帮我做一份创始人个人 IP 打造方案，并拆成每日可执行的内容任务。',
  },
  {
    agentKey: 'ops',
    icon: 'clock',
    title: '做月度复盘',
    prompt: '帮我做一次月度经营复盘，重点看主要矛盾有没有变化，以及下月作战重点。',
  },
];
