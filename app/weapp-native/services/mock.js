const { setToken } = require('./token');
const { GUEST_PRELUDE, FALLBACK_HINTS } = require('../data/wence-defaults');

const DEFAULT_AGENTS = [
  { key: 'general', name: '总军师', role: '通用商业军师', type: 'general', billing: 'free', price: 0, owned: true, enabled: true, greet: '说说你的处境，我先判断主要矛盾，再调度专业军师。' },
  { key: 'strat', name: '战略诊断官', role: '定位 · 卡点 · SWOT', type: 'advisory', billing: 'free', price: 0, owned: true, enabled: true, greet: '我是观澜，专看战略取舍。' },
  { key: 'growth', name: '增长操盘手', role: '获客 · 转化 · 复购 · 定价', type: 'advisory', billing: 'free', price: 0, owned: true, enabled: true, greet: '我是青衍，负责增长。' },
  { key: 'ip', name: '企业IP打造官', role: '定位 · 人设 · 内容支柱', icon: 'crown', type: 'creative', billing: 'metered', price: 3, owned: true, enabled: true, deliverableKey: '企业IP打造', greet: '我是鸣璋，帮你做创始人和企业 IP。' },
  { key: 'ops', name: '经营参谋', role: '经营测算 · 预算 · 复盘', type: 'advisory', billing: 'unlock', price: 10, owned: false, enabled: true, greet: '我是照微，负责经营复盘。' },
  { key: 'org', name: '组织人效顾问', role: '架构 · 股权 · 激励 · 人效', type: 'advisory', billing: 'unlock', price: 10, owned: false, enabled: true, greet: '我是云枢，负责团队和组织。' },
  { key: 'intel', name: '竞争情报官', role: '对手 · 赛道 · 机会窗口', type: 'advisory', billing: 'unlock', price: 12, owned: false, enabled: true, greet: '我是察远，专看对手和赛道。' },
  { key: 'promo', name: '企业宣传片导演', role: '叙事 · 分镜 · 制作', icon: 'video', type: 'creative', billing: 'unlock', price: 15, owned: false, enabled: true, deliverableKey: '企业宣传片', greet: '我是影湛，给你一条能直接开机拍的脚本。' },
  { key: 'poster', name: '海报设计师', role: '主视觉 · 版式 · 物料', icon: 'image', type: 'creative', billing: 'unlock', price: 8, owned: false, enabled: true, deliverableKey: '海报设计', greet: '我是绘章，先把这张海报的目标和主视觉定下来。' },
  { key: 'shortvideo', name: '短视频策划', role: '选题 · 钩子 · 脚本', icon: 'video', type: 'creative', billing: 'unlock', price: 8, owned: false, enabled: true, deliverableKey: '短视频策划', greet: '我是流光，写一条开头就抓人的短视频脚本。' },
  { key: 'copy', name: '商业文案官', role: '卖点 · 多版 · 场景', icon: 'pen', type: 'creative', billing: 'unlock', price: 6, owned: false, enabled: true, deliverableKey: '营销文案', greet: '我是墨言，把复杂价值写成客户愿意行动的一句话。' },
];

function storageKey(name) {
  const token = wx.getStorageSync('junshi.userId') || 'guest';
  return `junshi.native.mock.${token}.${name}`;
}

function ownedAgentKeys() { return wx.getStorageSync(storageKey('ownedAgents')) || []; }
function agents() {
  const owned = new Set(ownedAgentKeys());
  return Promise.resolve(DEFAULT_AGENTS.map((item) => Object.assign({}, item, {
    owned: item.billing !== 'unlock' || owned.has(item.key),
  })));
}
function mockCreditBalance() {
  const stored = wx.getStorageSync(storageKey('creditBalance'));
  if (stored !== '' && stored != null) return Number(stored);
  return currentMockPlan() ? 100 : 0;
}
function purchaseAgent(key) {
  const agent = DEFAULT_AGENTS.find((item) => item.key === key);
  if (!agent) return Promise.reject(Object.assign(new Error('智能体不存在'), { code: 'AGENT_NOT_FOUND' }));
  if (agent.billing !== 'unlock') return Promise.reject(Object.assign(new Error('该智能体无需额外启用'), { code: 'AGENT_NOT_PURCHASABLE' }));
  const owned = ownedAgentKeys();
  const balance = mockCreditBalance();
  if (owned.includes(key)) return Promise.resolve({ ok: true, agentKey: key, pricePaid: 0, creditBalance: balance, alreadyOwned: true });
  if (balance >= 0 && balance < Number(agent.price || 0)) {
    return Promise.reject(Object.assign(new Error('权益点不足，无法启用该智能体'), { code: 'INSUFFICIENT_CREDITS', data: { code: 'INSUFFICIENT_CREDITS' } }));
  }
  wx.setStorageSync(storageKey('ownedAgents'), owned.concat(key));
  const nextBalance = balance < 0 ? balance : balance - Number(agent.price || 0);
  wx.setStorageSync(storageKey('creditBalance'), nextBalance);
  return Promise.resolve({ ok: true, agentKey: key, pricePaid: balance < 0 ? 0 : Number(agent.price || 0), creditBalance: nextBalance, alreadyOwned: false });
}
function sessions() { return Promise.resolve(wx.getStorageSync(storageKey('sessions')) || []); }
function session(id, before) {
  const detail = wx.getStorageSync(storageKey(`session.${id}`));
  if (!detail) return Promise.reject(Object.assign(new Error('会话不存在'), { code: 'NOT_FOUND' }));
  // 服务端读详情会写 lastReadAt（未读归零）；mock 必须同口径，否则「进过会话仍挂着红点」
  // 在刷新后依然可见，就是假的真值（§4 mock 铁律）。
  const listKey = storageKey('sessions');
  const list = wx.getStorageSync(listKey) || [];
  if (list.some((item) => item.id === id && Number(item.unreadCount) > 0)) {
    wx.setStorageSync(listKey, list.map((item) => (item.id === id ? Object.assign({}, item, { unreadCount: 0, hasUnread: false }) : item)));
  }
  const all = Array.isArray(detail.messages) ? detail.messages : [];
  const rawEnd = before && /^mock:\d+$/.test(before) ? Number(before.slice(5)) : all.length;
  const end = Math.max(0, Math.min(all.length, rawEnd));
  const start = Math.max(0, end - 100);
  return Promise.resolve(Object.assign({}, detail, {
    messages: all.slice(start, end),
    messagePage: { hasMore: start > 0, nextCursor: start > 0 ? `mock:${start}` : null, limit: 100 },
  }));
}

/** 问策提示词池：mock 直接用本地兜底池，并按 mock 包默认展示终态给出 guestForm='chat'。 */
function wenceHints() {
  return Promise.resolve({
    hints: FALLBACK_HINTS.map((text, index) => ({ id: `mock-hint-${index + 1}`, text })),
    guestForm: 'chat',
  });
}

/**
 * 进场主动消息：按账号隔离并持久化。频控幂等口径与服务端一致——
 * 已有 general 会话就回 exists（不再注入第二条），注入的会话与消息刷新/切账号后都还在。
 */
function proactiveSession() {
  const listKey = storageKey('sessions');
  const list = wx.getStorageSync(listKey) || [];
  if (list.some((item) => item.agentKey === 'general')) return Promise.resolve({ injected: false, reason: 'exists' });
  const template = GUEST_PRELUDE[0];
  if (!template) return Promise.resolve({ injected: false, reason: 'empty-pool' });
  const agent = DEFAULT_AGENTS[0];
  const id = `native-proactive-${Date.now()}`;
  const now = new Date().toISOString();
  const title = template.text.slice(0, 18);
  wx.setStorageSync(storageKey(`session.${id}`), {
    id, agentKey: 'general', agent, title,
    // chips 与服务端 present 层同构：消息级 chips 字段（contentJson 里也留一份，同后端存储形状）。
    messages: [{ id: `a-${Date.now()}`, role: 'assistant', content: { text: template.text, chips: template.chips }, chips: template.chips, at: now }],
  });
  wx.setStorageSync(listKey, [{
    id, agentKey: 'general', agentName: agent.name, title,
    snippet: template.text, updatedAt: now, unreadCount: 1, hasUnread: true,
  }].concat(list));
  return Promise.resolve({ injected: true, sessionId: id });
}

/** 埋点：mock 包不落库也不打网络，只保证调用方拿到与线上同形状的 ok。 */
function track() { return Promise.resolve({ ok: true }); }
function search(q) {
  const needle = String(q || '').trim().toLowerCase();
  if (!needle) return Promise.resolve({ hits: [] });
  return Promise.all([agents(), sessions()]).then(([allAgents, allSessions]) => ({
    hits: allAgents.filter((a) => `${a.name}${a.role}`.toLowerCase().includes(needle)).map((a) => ({
      kind: 'agent', id: a.key, title: a.name, snippet: a.role,
      route: `/packages/main/chat/index?agentKey=${a.key}&continue=1`,
    })).concat(allSessions.filter((s) => `${s.title}${s.snippet}${s.agentName}`.toLowerCase().includes(needle)).map((s) => ({
      kind: 'session', id: s.id, title: s.title, snippet: s.snippet,
      route: `/packages/main/chat/index?sessionId=${s.id}`,
    }))),
  }));
}
function deleteSession(id) {
  const key = storageKey('sessions');
  const list = (wx.getStorageSync(key) || []).filter((item) => item.id !== id);
  wx.setStorageSync(key, list);
  return Promise.resolve({ ok: true });
}
function login(phone) {
  const token = `mock-${phone}`;
  const existed = Boolean(wx.getStorageSync(`junshi.native.mock.${token}.identity`));
  setToken(token);
  const identity = Object.assign({}, wx.getStorageSync(storageKey('identity')) || {}, { phone });
  wx.setStorageSync(storageKey('identity'), identity);
  return Promise.resolve({ token, isNew: !existed, onboarded: false, user: { id: token, name: identity.name || '', phone, benmingColor: 'green', wechatLinked: true } });
}
function wechatLogin() { return login(`wx-${Date.now()}`); }
function wechatPhoneLogin(phoneCode) {
  let hash = 0;
  const source = String(phoneCode || 'dev');
  for (let index = 0; index < source.length; index += 1) hash = (hash * 31 + source.charCodeAt(index)) >>> 0;
  const phone = `139${String(hash % 100000000).padStart(8, '0')}`;
  return login(phone);
}
function sendSmsCode() { return Promise.resolve({ cooldownSec: 60, devCode: '123456' }); }
function buildBattleForces(profile) {
  const pain = String(profile && profile.pain || '当前经营主线').trim() || '当前经营主线';
  const confirmedKnowledge = getList('knowledge').filter((item) => !item.stage || item.stage === 'confirmed').length;
  const dataSourceState = wx.getStorageSync(storageKey('dataSourceStatus')) || {};
  const connectedSources = Object.values(dataSourceState).filter((status) => status === 'bound' || status === 'uploaded').length;
  const evidenceNote = `已纳入 ${confirmedKnowledge} 份资料、${connectedSources} 个数据源状态重新判断。`;
  return [
    { kind: 'sky', label: '天势', level: 'mid', conclusion: '先稳住节奏，不在信息不足时押重注。', tactic: '先验证', note: evidenceNote },
    { kind: 'market', label: '市势', level: 'mid', conclusion: `围绕「${pain}」先找出客户选择与复购的真实原因。`, tactic: '小步试', note: `用近 30 天真实成交样本校准。 ${evidenceNote}` },
    { kind: 'people', label: '人势', level: 'mid', conclusion: '人手和注意力只压在一个可验证结果上。', tactic: '先聚焦', note: `避免同时铺开多条战线。 ${evidenceNote}` },
  ];
}
function me() {
  const identity = wx.getStorageSync(storageKey('identity')) || {};
  const profile = wx.getStorageSync(storageKey('profile')) || null;
  const plan = currentMockPlan();
  const usage = mockUsage(plan);
  const sessionsCount = (wx.getStorageSync(storageKey('sessions')) || []).length;
  const projectsCount = getList('projects').length;
  const knowledgeCount = getList('knowledge').length;
  const nextQuestions = [];
  if (!identity.name) nextQuestions.push('以后军师怎么称呼你？');
  if (!identity.company) nextQuestions.push('你的公司、门店或品牌叫什么？');
  if (!profile || !profile.industry) nextQuestions.push('你现在主要做哪个行业或品类？');
  if (!profile || !profile.stage) nextQuestions.push('业务现在处在什么阶段？');
  if (!profile || !profile.pain) nextQuestions.push('这段时间最卡你的经营问题是什么？');
  const evidenceCount = { profile: profile ? 1 : 0, memories: 0, projects: projectsCount, knowledge: knowledgeCount, sessions: sessionsCount };
  const evidenceTotal = Object.values(evidenceCount).reduce((sum, value) => sum + Number(value || 0), 0);
  const pain = profile && String(profile.pain || '').trim();
  const savedForces = wx.getStorageSync(storageKey('battleForces'));
  const battleForces = Array.isArray(savedForces) && savedForces.length ? savedForces : pain ? buildBattleForces(profile) : [];
  const forcesUpdatedAt = wx.getStorageSync(storageKey('battleForcesUpdatedAt')) || null;
  const maturity = !profile ? 'empty' : nextQuestions.length > 2 ? 'forming' : 'ready';
  const summary = pain
    ? `主要矛盾集中在「${pain}」——先解决它，其余动作都围绕它排布。`
    : '我还没有足够资料下判断。把基本情况补齐，后面的建议才能贴着你的真实业务走。';
  return Promise.resolve({
    // 新账号必须保持空称呼，让注册补全页成为真实必经步骤；不能用展示兜底名
    // 冒充已完成身份资料，否则本地预览会直接跳过头像 / 称呼。
    user: Object.assign({ id: wx.getStorageSync('junshi.userId') || 'mock-user', name: '', company: '', phone: '', benmingColor: wx.getStorageSync('junshi.color') || 'green' }, identity),
    tenant: { id: `mock-tenant-${wx.getStorageSync('junshi.userId') || 'guest'}`, name: identity.company || '', industry: profile && profile.industry || null, stage: profile && profile.stage || null },
    onboarded: Boolean(profile) || wx.getStorageSync('junshi.onboarded') === '1',
    understanding: { title: '个人档案', subtitle: '军师有多了解你的生意', maturity, summary, mainContradiction: pain ? summary : null, battleForces, nextQuestions: nextQuestions.slice(0, 4), evidenceCount, sections: [], updatedAt: forcesUpdatedAt },
    plan,
    creditBalance: mockCreditBalance(),
    tokenQuota: { limit: plan ? 100 : 0, used: 0, remaining: plan ? 100 : 0, unlimited: false },
    usage,
    inviteCode: 'JS2026',
    // mock 包默认展示问策终态（对话即 tab），方便本地走查；线上形态由服务端稳定分桶下发。
    features: { fortune: true, wenceForm: 'chat', conversationContinuity: true },
    capabilities: { attachments: {
      maxAttachmentsPerMessage: 9, maxImagesPerMessage: 9, maxImagesPerBatch: 4,
      maxImageBytes: 10 * 1024 * 1024, maxImageBatchBytes: 12 * 1024 * 1024, maxImageMessageBytes: 24 * 1024 * 1024,
    } },
  });
}

function getProfile() { return Promise.resolve(wx.getStorageSync(storageKey('profile')) || null); }
function saveProfile(body) {
  const profile = Object.assign({}, wx.getStorageSync(storageKey('profile')) || {}, body || {});
  wx.setStorageSync(storageKey('profile'), profile);
  wx.setStorageSync('junshi.onboarded', '1');
  return Promise.resolve(profile);
}
function quickScan(body) {
  const req = body || {};
  const previous = wx.getStorageSync(storageKey('profile')) || {};
  const profile = Object.assign({}, previous, {
    industry: previous.industry || req.industry || '',
    stage: previous.stage || req.revenueBand || '',
    pain: previous.pain || req.pain || '',
  });
  wx.setStorageSync(storageKey('profile'), profile);
  wx.setStorageSync('junshi.onboarded', '1');
  const pain = String(req.pain || profile.pain || '增长乏力').trim().slice(0, 40);
  const industry = String(req.industry || profile.industry || '当前行业');
  const stage = String(req.revenueBand || profile.stage || '当前阶段');
  return Promise.resolve({
    contradiction: `你把力气压在「${pain}」的表象上，真正要先找的是影响结果的关键结构。`,
    judgement: `${industry} · ${stage}这个阶段，「${pain}」多半是结果不是原因。先把客户、转化和单笔收益三笔账摊开，矛盾会自己浮出来。`,
    firstMove: '今天挑近 30 天成交的 10 位客户，记下他们为什么选择你、是否会复购。',
    cardUrl: null,
  });
}
function journey() {
  const profile = wx.getStorageSync(storageKey('profile')) || null;
  return Promise.resolve(profile && profile.industry
    // route 跟服务端一样下发语义 key（不是小程序路径），页面负责映射；mock 若只发真路由，
    // 映射分支在本地永远走不到，真机连真服务端才炸。
    ? { stage: 'diagnosing', diagRound: 2, nextStep: { key: 'continue_diagnosis', title: '继续完善当前判断', desc: '把打法聊定，方案定了就自动拆成军令。', route: 'chat' } }
    : { stage: 'new', diagRound: 0, nextStep: { key: 'scan', title: '先做一次军师首判', desc: '三问形成第一份判断', route: '/packages/work/quickscan/index' } });
}
function workbench() {
  const profile = wx.getStorageSync(storageKey('profile')) || null;
  const missing = [];
  if (!profile || !profile.industry) missing.push({ key: 'next-industry', title: '主营行业或品类', desc: '用于校准客户与竞争判断。' });
  if (!profile || !profile.stage) missing.push({ key: 'next-stage', title: '当前经营阶段', desc: '用于判断进攻、验证或守成节奏。' });
  if (!profile || !profile.pain) missing.push({ key: 'next-pain', title: '当前最卡的问题', desc: '用于确定主要矛盾。' });
  const completeness = profile ? Math.max(35, 100 - missing.length * 20) : 0;
  // 严格按 WorkbenchView 契约三个键返回：mock 多给一个 title 会让本地看到线上不存在的横幅。
  return Promise.resolve({ completeness, sections: [{ key: 'profile', label: '老板与企业档案', hint: '行业、阶段、当前难题', count: profile ? 1 : 0, ready: Boolean(profile) }], missing });
}

function updateIdentity(body) {
  const next = Object.assign({}, wx.getStorageSync(storageKey('identity')) || {}, body || {});
  wx.setStorageSync(storageKey('identity'), next);
  return Promise.resolve(Object.assign({ ok: true }, next));
}
function deleteAccount() { wx.clearStorageSync(); return Promise.resolve({ ok: true }); }
function bindPhone(phone, _code, phoneCode) {
  let value = String(phone || '').trim();
  if (!value && phoneCode) {
    let hash = 0;
    const source = String(phoneCode);
    for (let index = 0; index < source.length; index += 1) hash = (hash * 31 + source.charCodeAt(index)) >>> 0;
    value = `139${String(hash % 100000000).padStart(8, '0')}`;
  }
  return updateIdentity({ phone: value }).then(() => ({ ok: true, phone: value, wechatLinked: true }));
}
function setColor(color) { wx.setStorageSync('junshi.color', color); return Promise.resolve({ ok: true }); }
function uploadAvatar(filePath) { return updateIdentity({ avatarUrl: filePath }).then(() => ({ ok: true, avatarUrl: filePath })); }

function listKey(name) { return storageKey(name); }
function getList(name) { return wx.getStorageSync(listKey(name)) || []; }
function setList(name, value) { wx.setStorageSync(listKey(name), value); }

const MOCK_PLANS = [
  { id: 'mock-month', name: '决策版', period: 'month', price: 19900, usageLabel: '标准用量', featuresJson: ['每日问策', '方案与资料库', '执行复盘'], autoRenewAvailable: false },
  // 留一档带折扣的夹具，本地 mock 包就能走查角标/划线价/立省的排版。真实折扣只由运营后台配，
  // promotion 由服务端算好下发（listPrice/discountLabel/savedFen/endsAt），端上不重算。
  {
    id: 'mock-year', name: '决策版', period: 'year', price: 199900, usageLabel: '标准用量',
    featuresJson: ['全年使用', '方案与资料库', '执行复盘'], autoRenewAvailable: false,
    promotion: { listPrice: 399800, price: 199900, savedFen: 199900, discountRate: 5, discountLabel: '5折', label: '首发价', endsAt: null },
  },
];
function currentMockPlan() {
  const id = wx.getStorageSync(storageKey('plan'));
  return MOCK_PLANS.find((item) => item.id === id) || null;
}
function mockUsage(plan) {
  if (!plan) return null;
  const resetsAt = new Date();
  resetsAt.setMonth(resetsAt.getMonth() + 1, 1);
  resetsAt.setHours(0, 0, 0, 0);
  return { usagePercent: 0, usageStatus: 'sufficient', resetsAt: resetsAt.toISOString(), unlimited: false };
}
function plans() { return Promise.resolve(MOCK_PLANS.map((item) => Object.assign({}, item))); }
function planOptions() {
  const current = currentMockPlan();
  return Promise.resolve({
    currentPlanId: current ? current.id : '',
    options: MOCK_PLANS.map((plan) => ({
      plan,
      relation: current ? (plan.id === current.id ? 'current' : 'available') : 'available',
      action: current ? (plan.id === current.id ? 'renew' : 'upgrade') : 'buy',
      canPurchase: true,
    })),
    usage: mockUsage(current),
    subscription: null,
  });
}
function quotePlan(id) {
  const targetPlan = MOCK_PLANS.find((item) => item.id === id) || MOCK_PLANS[0];
  return Promise.resolve({ currentPlan: null, targetPlan, fullPrice: targetPlan.price, remainingValue: 0, chargeAmount: targetPlan.price, quoteFingerprint: `mock-${id}` });
}
function purchasePlan(id) {
  wx.setStorageSync(storageKey('plan'), id);
  const balanceKey = storageKey('creditBalance');
  if (wx.getStorageSync(balanceKey) === '') wx.setStorageSync(balanceKey, 100);
  return Promise.resolve({ ok: true, planId: id });
}

const MOCK_SKUS = [
  { key: 'deep-organize', name: '深度整理', desc: '军师对上传资料做深度去重、提炼与补标，整理成军师能直接用上的知识。', priceFen: 3900, kind: 'service' },
  { key: 'storage-2g', name: '资料空间包', desc: '为资料库扩容约 2GB，容纳更多经营材料。', priceFen: 1900, kind: 'storage' },
  { key: 'deep-contradiction', name: '深度矛盾分析', desc: '围绕主要矛盾做一次深度拆解，给出结构化打法与验证标准。', priceFen: 2900, kind: 'module', grantsModuleKey: 'deep-contradiction' },
  { key: 'fin-checkup', name: '财务经营体检', desc: '对经营与财务数据做一次系统体检，定位现金与利润风险。', priceFen: 4900, kind: 'module', grantsModuleKey: 'fin-checkup' },
  { key: 'ip-topics-pro', name: 'IP 选题库 · 高级版', desc: '按你的定位批量产出可执行的内容选题库。', priceFen: 9900, kind: 'module', grantsModuleKey: 'ip-topics-pro' },
  { key: 'shop-dashboard', name: '店铺数据看板', desc: '搭建店铺经营数据看板，按周复盘核心经营指标。', priceFen: 19900, kind: 'module', grantsModuleKey: 'shop-dashboard' },
];

const MOCK_DATA_SOURCES = [
  { key: 'content-account', label: '内容账号数据', desc: '小红书 / 抖音 / 视频号 / 公众号：阅读、互动、私信', icon: 'content', scope: ['阅读·播放', '互动·评论', '私信关键词', '内容选题表现'], tier: 'basic' },
  { key: 'private', label: '客户与私域数据', desc: '企微、微信群、私聊记录、客户标签、咨询记录', icon: 'users', scope: ['客户标签', '跟进状态', '咨询关键词', '成交回写'], tier: 'basic' },
  { key: 'shop', label: '店铺经营数据', desc: '曝光、点击、成交、复购、退款、客单价', icon: 'store', scope: ['曝光·点击', '成交·退款', '复购·客单价', '投放花费'], tier: 'basic' },
  { key: 'funnel', label: '成交漏斗数据', desc: '线索、咨询、报价、成交、流失原因、复购', icon: 'funnel', scope: ['线索数', '咨询数', '报价数', '成交·流失原因'], tier: 'basic' },
  { key: 'finance', label: '财务经营数据', desc: '营收、成本、利润、预算、投放花费、现金流', icon: 'chart', scope: ['营收', '成本', '利润', '预算·现金流'], tier: 'basic' },
  { key: 'service', label: '服务交付数据', desc: '服务进度、客户反馈、好评截图、售后问题、案例结果', icon: 'service', scope: ['服务进度', '客户反馈', '案例结果', '售后问题'], tier: 'basic' },
  { key: 'crm', label: '企业微信 / CRM 授权', desc: '长期追踪客户标签、跟进状态和成交回写。', icon: 'briefcase', scope: ['客户标签', '跟进状态', '咨询关键词', '成交回写'], tier: 'advanced' },
  { key: 'ads', label: '广告与店铺后台授权', desc: '持续读取投放、店铺和订单变化，自动刷新复盘。', icon: 'campaign', scope: ['曝光·点击', '成交·退款', '复购·客单价', '投放花费'], tier: 'advanced' },
];

const MOCK_MODULES = [
  { key: 'trend', label: '三势初判', desc: '天势 / 市势 / 人势，先给基础判断', iconChar: 'trend', group: 'free', tier: 'free', stateLabel: '默认启用', agentKey: 'general', detail: { scene: '案卷资料齐了先跑一遍三势', input: '案卷资料', output: '三势判断', cost: '免费', writeback: '战局页' } },
  { key: 'conflict', label: '矛盾初筛', desc: '识别当前最卡住增长的主线问题', iconChar: 'target', group: 'free', tier: 'free', stateLabel: '可直接用', agentKey: 'general', detail: { scene: '拿不准最该解决什么时用', input: '对话 + 案卷', output: '主要矛盾', cost: '免费', writeback: '战局页' } },
  { key: 'deep-contradiction', label: '深度矛盾分析', desc: '输出阶段打法、风险边界和不可做清单', iconChar: 'search', group: 'deep', tier: 'sku', price: { skuKey: 'deep-contradiction', priceFen: 2900 }, stateLabel: '¥29 启用', detail: { scene: '主要矛盾已明确，要深挖打法', input: '完整案卷', output: '深度诊断', cost: '¥29', writeback: '方案库' } },
  { key: 'growth', label: '增长漏斗诊断', desc: '结合店铺、私域和内容数据做深度推演', iconChar: 'funnel', group: 'deep', tier: 'credits', price: { credits: 80 }, stateLabel: '消耗 80 算力', agentKey: 'growth', detail: { scene: '有成交漏斗数据后重算损耗', input: '成交漏斗表', output: '转化断点', cost: '80 算力', writeback: '执行页' } },
  { key: 'ip-engine', label: 'IP 内容引擎', desc: '定位、选题、脚本、发布计划一体生成', iconChar: 'spark', group: 'deep', tier: 'member', price: { planRequired: true }, stateLabel: '会员可用', agentKey: 'ip', detail: { scene: '要批量产出可执行内容', input: 'IP 资料', output: '选题脚本', cost: '会员', writeback: '执行页' } },
  { key: 'finance', label: '财务经营体检', desc: '现金流、成本结构、利润风险初步拆解', iconChar: 'chart', group: 'deep', tier: 'sku', price: { skuKey: 'fin-checkup', priceFen: 4900 }, stateLabel: '¥49 启用', detail: { scene: '担心现金和利润风险时', input: '财务表', output: '经营体检', cost: '¥49', writeback: '方案库' } },
  { key: 'daily-command', label: '每日军令', desc: '任务、提醒、复盘，承接已经定下的方案', iconChar: 'checklist', group: 'member', tier: 'free', stateLabel: '基础版免费', detail: { scene: '判断定了，自动接到执行页', input: '已定判断', output: '每日军令', cost: '免费', writeback: '执行页' } },
  { key: 'topic-bank', label: 'IP 选题库高级版', desc: '按人设、产品和渠道生成长期选题池', iconChar: 'list', group: 'member', tier: 'sku', price: { skuKey: 'ip-topics-pro', priceFen: 9900 }, stateLabel: '¥99 单独购买', detail: { scene: '需要长期内容选题储备', input: '人设产品', output: '长期选题', cost: '¥99', writeback: '知识库' } },
  { key: 'shop-board', label: '店铺数据看板', desc: '曝光、点击、转化、复购持续追踪', iconChar: 'store', group: 'member', tier: 'sku', price: { skuKey: 'shop-dashboard', priceFen: 19900 }, stateLabel: '¥199 单独购买', detail: { scene: '要持续盯店铺经营指标', input: '店铺授权', output: '数据看板', cost: '¥199', writeback: '数据源' } },
  { key: 'weekly-review', label: '周复盘增强', desc: '自动汇总执行、数据和下一周军令', iconChar: 'calendar', group: 'member', tier: 'member', price: { planRequired: true }, stateLabel: '会员可用', detail: { scene: '每周要系统复盘并排下周军令', input: '本周执行', output: '周复盘', cost: '会员', writeback: '方案库' } },
];

const MOCK_SKU_MODULE_KEY = {
  'deep-contradiction': 'deep-contradiction',
  finance: 'fin-checkup',
  'topic-bank': 'ip-topics-pro',
  'shop-board': 'shop-dashboard',
};

function mockNotFound(message, code) {
  return Object.assign(new Error(message), { code, data: { code } });
}

function dataSourceLabel(status, tier) {
  if (status === 'bound') return '已绑定';
  if (status === 'uploaded') return '待上传';
  if (status === 'auth_requested') return '待授权';
  return tier === 'advanced' ? '高级' : '上传即可';
}

function dataSources() {
  const state = wx.getStorageSync(storageKey('dataSourceStatus')) || {};
  const sources = MOCK_DATA_SOURCES.map((item) => {
    const status = state[item.key] || 'unbound';
    return Object.assign({}, item, { status, statusLabel: dataSourceLabel(status, item.tier) });
  });
  return Promise.resolve({
    bound: sources.filter((item) => item.status === 'bound').length,
    needed: sources.filter((item) => item.status === 'unbound' && item.tier === 'basic').length,
    total: sources.length,
    sources,
  });
}

function setDataSourceStatus(key, status) {
  if (!MOCK_DATA_SOURCES.some((item) => item.key === key)) return Promise.reject(mockNotFound('数据源不存在', 'DATA_SOURCE_NOT_FOUND'));
  const state = Object.assign({}, wx.getStorageSync(storageKey('dataSourceStatus')) || {}, { [key]: status });
  wx.setStorageSync(storageKey('dataSourceStatus'), state);
  return dataSources();
}
function requestDataSourceAuth(key) { return setDataSourceStatus(key, 'auth_requested'); }
function uploadDataSource(key) { return setDataSourceStatus(key, 'uploaded'); }

function moduleView(item, index, owned, state) {
  const enabled = item.tier === 'free' || owned.has(item.key);
  return Object.assign({}, item, {
    enabled,
    hidden: Boolean(state[item.key] && state[item.key].hidden),
    sortOrder: Number.isFinite(Number(state[item.key] && state[item.key].sortOrder)) ? Number(state[item.key].sortOrder) : index,
    stateLabel: enabled ? '已启用' : item.stateLabel,
  });
}
function modules() {
  const owned = new Set(getList('ownedModules'));
  const state = wx.getStorageSync(storageKey('moduleState')) || {};
  const items = MOCK_MODULES.map((item, index) => moduleView(item, index, owned, state)).sort((a, b) => a.sortOrder - b.sortOrder);
  return Promise.resolve({ recommended: items.find((item) => item.key === 'growth') || null, modules: items });
}
function skus() {
  return Promise.resolve(MOCK_SKUS.map((item) => Object.assign({}, item, { grantsModuleKey: item.grantsModuleKey || null })));
}
function createSkuOrder(key) {
  const sku = MOCK_SKUS.find((item) => item.key === key);
  if (!sku) return Promise.reject(mockNotFound('商品不存在', 'SKU_NOT_FOUND'));
  const purchased = new Set(getList('skuPurchases'));
  purchased.add(key);
  setList('skuPurchases', Array.from(purchased));
  if (sku.kind === 'module' && sku.grantsModuleKey) {
    const owned = new Set(getList('ownedModules'));
    owned.add(sku.grantsModuleKey);
    setList('ownedModules', Array.from(owned));
  }
  const outTradeNo = `mock-sku-${Date.now()}-${purchased.size}`;
  return Promise.resolve({ mock: true, demo: true, orderId: outTradeNo, outTradeNo, status: 'applied', appliedAt: new Date().toISOString() });
}
function enableModule(key) {
  const item = MOCK_MODULES.find((candidate) => candidate.key === key);
  if (!item) return Promise.reject(mockNotFound('能力不存在', 'MODULE_NOT_FOUND'));
  const owned = new Set(getList('ownedModules'));
  if (item.tier === 'credits' && !owned.has(key)) {
    const cost = Number(item.price && item.price.credits || 0);
    const balance = mockCreditBalance();
    if (balance >= 0 && balance < cost) return Promise.reject(Object.assign(new Error('算力不足'), { code: 'INSUFFICIENT_CREDITS', data: { code: 'INSUFFICIENT_CREDITS' } }));
    if (balance >= 0) wx.setStorageSync(storageKey('creditBalance'), balance - cost);
  } else if (item.tier === 'sku') {
    const skuKey = MOCK_SKU_MODULE_KEY[key] || key;
    const purchased = new Set(getList('skuPurchases'));
    if (!owned.has(key) && !owned.has(skuKey) && !purchased.has(skuKey)) {
      return Promise.reject(Object.assign(new Error('需先购买'), { code: 'SKU_REQUIRED', data: { code: 'SKU_REQUIRED', skuKey } }));
    }
  }
  owned.add(key);
  setList('ownedModules', Array.from(owned));
  return modules().then((view) => view.modules.find((candidate) => candidate.key === key));
}
function patchModule(key, body) {
  if (!MOCK_MODULES.some((item) => item.key === key)) return Promise.reject(mockNotFound('能力不存在', 'MODULE_NOT_FOUND'));
  const current = wx.getStorageSync(storageKey('moduleState')) || {};
  current[key] = Object.assign({}, current[key] || {}, body || {});
  wx.setStorageSync(storageKey('moduleState'), current);
  return modules().then((view) => view.modules.find((candidate) => candidate.key === key));
}

function projects() { return Promise.resolve(getList('projects')); }
function createProject(body) {
  const row = { id: `mock-project-${Date.now()}`, name: String(body.name || '新案卷'), slug: `mock-${Date.now()}`, summary: '', counts: { sessions: 0, reports: 0, knowledge: 0 }, sessions: [], reports: [], knowledge: [] };
  setList('projects', [row].concat(getList('projects'))); return Promise.resolve(row);
}
function project(id) {
  const row = getList('projects').find((item) => item.id === id);
  if (!row) return Promise.reject(Object.assign(new Error('案卷不存在'), { code: 'NOT_FOUND' }));
  const knowledge = getList('knowledge').filter((item) => item.projectId === id);
  return Promise.resolve(Object.assign({}, row, { knowledge, sessions: row.sessions || [], reports: row.reports || [], counts: { sessions: (row.sessions || []).length, reports: (row.reports || []).length, knowledge: knowledge.length } }));
}
function updateProject(id, body) { const rows = getList('projects').map((item) => item.id === id ? Object.assign({}, item, body) : item); setList('projects', rows); return Promise.resolve({ ok: true }); }
function deleteProject(id) { setList('projects', getList('projects').filter((item) => item.id !== id)); return Promise.resolve({ ok: true }); }
function createKnowledge(body) {
  const row = Object.assign({ id: `mock-knowledge-${Date.now()}`, title: String(body.title || body.text || '手动资料').slice(0, 30), kind: 'document', sourceType: 'manual', status: 'ready', stage: 'confirmed', fileName: '', fileType: 'txt', fileSize: 0, chunkCount: 1, summary: String(body.text || ''), textPreview: String(body.text || ''), chunks: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, body);
  setList('knowledge', [row].concat(getList('knowledge'))); return Promise.resolve(row);
}
function uploadKnowledge(name, opts) { const batchId = opts && opts.batchId || `mock-batch-${Date.now()}`; return createKnowledge({ title: name || '模拟上传资料', fileName: name || '模拟上传资料', sourceType: 'upload', status: 'ready', stage: opts && opts.staged ? 'staging' : 'confirmed', batchId, projectId: opts && opts.projectId || null }).then((row) => Object.assign({ batchId }, row)); }
function knowledgeDocs(projectId) { const rows = getList('knowledge'); return Promise.resolve(projectId ? rows.filter((item) => item.projectId === projectId) : rows); }
function knowledge(projectId, kind) {
  return Promise.resolve(getList('knowledge')
    .filter((item) => (!item.stage || item.stage === 'confirmed') && (!projectId || item.projectId === projectId) && (!kind || item.kind === kind))
    // 逐字段构造，不要 Object.assign({}, item, ...) —— 那样会把本地存的 summary / fileName /
    // category 等**契约外**字段一起透传出去，端上就会顺手消费这些真服务端永远不给的字段。
    // KnowledgeItemT 就这九个键，多一个都不给。
    .map((item) => ({
      id: item.id,
      projectId: item.projectId || null,
      kind: item.kind || 'document',
      title: item.title || item.fileName || null,
      text: item.text || item.textPreview || item.summary || '',
      sourceType: item.sourceType || 'upload',
      sourceId: item.sourceId || null,
      tags: Array.isArray(item.tags) ? item.tags : [],
      at: item.at || item.createdAt || item.updatedAt || new Date().toISOString(),
    })));
}
function knowledgeDetail(id) { const row = getList('knowledge').find((item) => item.id === id); return row ? Promise.resolve(Object.assign({ chunks: [], canAnalyze: false }, row)) : Promise.reject(Object.assign(new Error('资料不存在'), { code: 'NOT_FOUND' })); }
function deleteKnowledge(id) { setList('knowledge', getList('knowledge').filter((item) => item.id !== id)); return Promise.resolve({ ok: true }); }
function knowledgePipeline() { const rows = getList('knowledge'); const staging = rows.filter((item) => item.stage === 'staging'); const optimized = rows.filter((item) => item.stage === 'optimized'); const confirmed = rows.filter((item) => !item.stage || item.stage === 'confirmed'); const batchIds = Array.from(new Set(staging.map((item) => item.batchId).filter(Boolean))); return Promise.resolve({ counts: { staging: staging.length, optimized: optimized.length, confirmed: confirmed.length }, quota: { usedDocs: rows.length, freeDocs: 200, usedBytes: 0, freeBytes: 209715200 }, folders: [], batches: batchIds.map((id) => ({ id, files: staging.filter((item) => item.batchId === id) })), optimizedItems: optimized.map((item) => Object.assign({ preview: item.textPreview || item.summary || '' }, item)) }); }
function organizeBatch(batchId) { const rows = getList('knowledge').map((item) => item.batchId === batchId ? Object.assign({}, item, { stage: 'optimized' }) : item); setList('knowledge', rows); return Promise.resolve({ batchId, items: rows.filter((item) => item.batchId === batchId) }); }
function confirmKnowledge(body) { const ids = new Set(body.ids || []); let count = 0; const rows = getList('knowledge').map((item) => { const hit = ids.size ? ids.has(item.id) : item.batchId === body.batchId; if (hit) count += 1; return hit ? Object.assign({}, item, { stage: 'confirmed' }) : item; }); setList('knowledge', rows); return Promise.resolve({ count }); }
function seedReportContent() {
  return {
    title: '本周增长行动方案',
    icon: 'doc',
    meta: '增长操盘手 · 经营方案',
    sections: [
      { h: '先收住一个增长目标', b: '本周先验证高意向客户从咨询到成交的关键断点，暂不同时铺开多个渠道。' },
      { h: '三步行动', list: ['整理近 30 天咨询与成交记录', '挑出转化最高的两个客户来源', '为高意向客户设计一轮定向跟进'] },
      { h: '复盘标准', list: ['新增高意向咨询数', '咨询到成交转化率', '老客户复购与转介绍数'] },
    ],
    trust: '这份样例方案只用于本地预览；真实结论会以你的案卷、资料和对话为依据。',
    actions: ['save_to_library', 'export_pdf'],
  };
}
function seedReportRow() {
  const at = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const content = seedReportContent();
  return {
    id: 'mock-report-growth-plan', title: content.title, slug: 'weekly-growth-plan', type: '经营方案',
    agentKey: 'growth', agentName: '增长操盘手', projectId: null, currentVersion: 1, updatedAt: at,
    versions: [{ id: 'mock-report-growth-plan-v1', version: 1, title: content.title, content, changeSummary: '首个版本', authorKind: 'agent', sessionId: null, at }],
  };
}
function ensureReports() {
  const rows = getList('reports');
  if (rows.length) return rows;
  const seeded = [seedReportRow()];
  setList('reports', seeded);
  return seeded;
}
function reportSummary(row) {
  return {
    id: row.id, title: row.title, slug: row.slug, type: row.type, agentKey: row.agentKey || null,
    agentName: row.agentName || ((DEFAULT_AGENTS.find((item) => item.key === row.agentKey) || {}).name),
    projectId: row.projectId || null, currentVersion: Number(row.currentVersion || 1), updatedAt: row.updatedAt,
  };
}
function reports(projectId) {
  return Promise.resolve(ensureReports()
    .filter((row) => !projectId || row.projectId === projectId)
    .slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .map(reportSummary));
}
function ensureLibrary() {
  const rows = getList('library');
  if (rows.length) return rows;
  const reportRow = ensureReports()[0];
  const version = reportRow.versions[reportRow.versions.length - 1];
  const seeded = [{
    id: 'mock-library-growth-plan', title: reportRow.title, type: reportRow.type,
    agentKey: reportRow.agentKey, agentName: reportRow.agentName, sessionId: null, projectId: null,
    content: version.content, at: version.at, reportId: reportRow.id, version: version.version,
  }];
  setList('library', seeded);
  return seeded;
}
function library() { return Promise.resolve(ensureLibrary().slice().sort((a, b) => String(b.at).localeCompare(String(a.at)))); }
function saveToLibrary(body) {
  const content = body && body.content || {};
  const existing = ensureLibrary();
  const duplicate = existing.find((item) => item.sessionId === (body && body.sessionId || null) && JSON.stringify(item.content) === JSON.stringify(content));
  if (duplicate) return Promise.resolve({ id: duplicate.id, at: duplicate.at, reportId: duplicate.reportId, version: duplicate.version });
  const now = new Date().toISOString();
  const agent = DEFAULT_AGENTS.find((item) => item.key === (body && body.agentKey));
  const reportId = `mock-report-${Date.now()}`;
  const item = {
    id: `mock-library-${Date.now()}`,
    title: body && body.title || content.title || '未命名方案',
    type: body && body.type || '方案',
    agentKey: body && body.agentKey || 'general',
    agentName: agent && agent.name || '军师参谋部',
    sessionId: body && body.sessionId || null,
    projectId: body && body.projectId || null,
    content,
    at: now,
    reportId,
    version: 1,
  };
  setList('library', [item].concat(existing));
  const reportRows = ensureReports();
  const title = item.title;
  const slugBase = String(title || '方案').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\u4e00-\u9fa5-]/g, '') || `report-${Date.now()}`;
  reportRows.unshift({
    id: reportId, title, slug: `${slugBase}-${String(Date.now()).slice(-6)}`, type: item.type,
    agentKey: item.agentKey, agentName: item.agentName, projectId: item.projectId, currentVersion: 1, updatedAt: now,
    versions: [{ id: `${reportId}-v1`, version: 1, title, content, changeSummary: '首个版本', authorKind: 'user', sessionId: item.sessionId, at: now }],
  });
  setList('reports', reportRows);
  return Promise.resolve({ id: item.id, at: item.at, reportId: item.reportId, version: item.version });
}
function report(id) {
  const row = ensureReports().find((item) => item.id === id);
  if (row) return Promise.resolve(Object.assign(reportSummary(row), {
    versions: (row.versions || []).slice().sort((a, b) => Number(b.version) - Number(a.version)).map((version) => ({
      id: version.id, version: version.version, title: version.title, changeSummary: version.changeSummary,
      authorKind: version.authorKind, sessionId: version.sessionId, at: version.at,
    })),
  }));
  const saved = ensureLibrary().find((item) => item.reportId === id || item.id === id);
  if (saved) return Promise.resolve({
    id: saved.reportId, title: saved.title, slug: saved.reportId, type: saved.type, agentKey: saved.agentKey,
    agentName: saved.agentName, projectId: saved.projectId || null, currentVersion: saved.version || 1, updatedAt: saved.at,
    versions: [{ id: `${saved.reportId}-v${saved.version || 1}`, version: saved.version || 1, title: saved.title, changeSummary: '首个版本', authorKind: 'user', sessionId: saved.sessionId, at: saved.at }],
  });
  return Promise.reject(mockNotFound('方案不存在', 'NOT_FOUND'));
}
function reportVersion(id, version) {
  const row = ensureReports().find((item) => item.id === id);
  if (row) {
    const picked = version ? (row.versions || []).find((item) => Number(item.version) === Number(version)) : (row.versions || [])[row.versions.length - 1];
    if (!picked) return Promise.reject(mockNotFound('方案版本不存在', 'NOT_FOUND'));
    return Promise.resolve({ reportId: row.id, version: picked.version, title: picked.title, content: picked.content, at: picked.at });
  }
  const saved = ensureLibrary().find((item) => item.reportId === id || item.id === id);
  if (saved && (!version || Number(version) === Number(saved.version || 1))) {
    return Promise.resolve({ reportId: saved.reportId, version: saved.version || 1, title: saved.title, content: saved.content, at: saved.at });
  }
  return Promise.reject(mockNotFound('方案版本不存在', 'NOT_FOUND'));
}
function messageText(message) {
  const content = message && message.content;
  if (typeof content === 'string') return content.trim();
  return String(message && message.text || content && content.text || '').trim();
}
function summarize(sessionId) {
  const detail = wx.getStorageSync(storageKey(`session.${sessionId}`));
  if (!detail) return Promise.reject(mockNotFound('会话不存在', 'NOT_FOUND'));
  const messages = Array.isArray(detail.messages) ? detail.messages : [];
  const userPoints = [];
  const reportTitles = [];
  const replyPoints = [];
  messages.forEach((message) => {
    const content = message && message.content || {};
    const text = messageText(message);
    if (message.role === 'user' && text) userPoints.push(text.slice(0, 60));
    else if (message.role === 'report') {
      const title = content.title || content.deliverable && content.deliverable.title;
      if (title) reportTitles.push(String(title));
    } else if (message.role === 'assistant') {
      if (text) replyPoints.push(text.slice(0, 60));
      const points = Array.isArray(content.points) ? content.points : [];
      points.forEach((point) => { if (point) replyPoints.push(String(point).slice(0, 100)); });
    }
  });
  const title = `《${detail.title || '本轮问策'}》对话纪要`;
  const sections = [{ h: '讨论要点', list: (userPoints.length ? userPoints : ['（本次对话内容较少）']).slice(0, 6) }];
  if (reportTitles.length) sections.push({ h: '本次产出', list: reportTitles.map((item) => `已产出《${item}》`).slice(0, 6) });
  sections.push({ h: '关键结论', list: (replyPoints.length ? replyPoints : ['顾问已给出阶段性判断，详见对话原文。']).slice(0, 6) });
  sections.push({ h: '待办与决策', b: '将上述结论中需要跟进的事项纳入案卷推进；重大决策请结合专业意见。' });
  const agent = DEFAULT_AGENTS.find((item) => item.key === detail.agentKey) || detail.agent || DEFAULT_AGENTS[0];
  const content = {
    title, icon: 'doc', meta: `${agent.name} · 对话汇总`, sections,
    trust: '本纪要按当前对话确定性整理；重要经营决策仍需结合真实资料核验。',
    actions: ['save_to_library', 'export_pdf'],
  };
  const now = new Date().toISOString();
  const reportId = `mock-summary-${sessionId}`;
  const reportRows = ensureReports();
  let row = reportRows.find((item) => item.id === reportId);
  let version = 1;
  if (!row) {
    row = {
      id: reportId, title, slug: `chat-summary-${String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '-')}`, type: '对话纪要',
      agentKey: agent.key || detail.agentKey || 'general', agentName: agent.name || '军师参谋部', projectId: detail.projectId || null,
      currentVersion: 1, updatedAt: now,
      versions: [{ id: `${reportId}-v1`, version: 1, title, content, changeSummary: '首个版本', authorKind: 'agent', sessionId, at: now }],
    };
    reportRows.unshift(row);
  } else {
    const latest = (row.versions || [])[row.versions.length - 1];
    if (!latest || JSON.stringify(latest.content) !== JSON.stringify(content)) {
      version = Number(row.currentVersion || 0) + 1;
      (row.versions || (row.versions = [])).push({ id: `${reportId}-v${version}`, version, title, content, changeSummary: '对话新增内容，已更新纪要', authorKind: 'agent', sessionId, at: now });
      row.currentVersion = version;
      row.updatedAt = now;
      row.title = title;
    } else version = Number(latest.version || row.currentVersion || 1);
  }
  setList('reports', reportRows);

  const libraryRows = getList('library');
  const libraryItem = {
    id: `mock-library-summary-${sessionId}`, title, type: '对话纪要',
    agentKey: row.agentKey, agentName: row.agentName, sessionId, projectId: row.projectId,
    content, at: now, reportId, version,
  };
  const libraryIndex = libraryRows.findIndex((item) => item.reportId === reportId);
  if (libraryIndex >= 0) libraryRows[libraryIndex] = libraryItem; else libraryRows.unshift(libraryItem);
  setList('library', libraryRows);

  const insight = sections.flatMap((section) => (section.list || []).concat(section.b ? [section.b] : [])).join('；').slice(0, 1000);
  const knowledgeRows = getList('knowledge');
  const knowledgeItem = {
    id: `mock-summary-knowledge-${sessionId}`, projectId: detail.projectId || null, kind: 'insight', title,
    text: insight, summary: insight.slice(0, 120), textPreview: insight, sourceType: 'conversation', sourceId: sessionId,
    tags: [agent.name || '军师', '对话纪要'], status: 'ready', stage: 'confirmed', fileName: '', fileType: 'txt',
    fileSize: 0, chunkCount: 1, createdAt: now, updatedAt: now, at: now,
  };
  const knowledgeIndex = knowledgeRows.findIndex((item) => item.sourceType === 'conversation' && item.sourceId === sessionId);
  if (knowledgeIndex >= 0) knowledgeRows[knowledgeIndex] = Object.assign({}, knowledgeRows[knowledgeIndex], knowledgeItem); else knowledgeRows.unshift(knowledgeItem);
  setList('knowledge', knowledgeRows);
  return Promise.resolve({ reportId, version, title, knowledgeAdded: insight ? 1 : 0 });
}
// GET /me/credits 的契约只有 { items }（钻石流水），余额与用量归 /me。mock 从前多给
// balance/usedPercent/plan 又不给 items，正好把「端上兜底读了服务端不存在的字段」盖住。
function credits() {
  const balance = mockCreditBalance();
  const at = new Date().toISOString();
  return Promise.resolve({ items: [{ at, reason: '本地样例 · 解锁专业军师', delta: -20, balance }] });
}

// 命理 mock 只负责提供一份确定性 UI 样例，不冒充真实排盘；字段与 Taro mock / 服务端契约同构。
function sampleChart() {
  const year = new Date().getFullYear();
  const phases = ['进攻', '平稳', '防守', '进攻', '平稳', '进攻', '防守', '平稳', '进攻', '平稳', '防守', '平稳'];
  const turning = new Set([3, 7, 11]);
  return {
    engineVersion: 'paipan-v3',
    hourKnown: true,
    pillars: { year: { ganZhi: '庚午' }, month: { ganZhi: '壬午' }, day: { ganZhi: '戊子' }, time: { ganZhi: '甲寅' } },
    dayMaster: { gan: '戊', element: '土', strength: '身强' },
    pattern: { name: '正财格', traits: '务实稳健、重信守诺，善守成不喜冒进', suits: ['稳扎稳打、深耕存量'], avoid: ['盲目扩张'] },
    ziwei: { soulMajorStars: ['紫微', '天府'], bodyMajorStars: ['武曲'] },
    monthlyOutlook: { year, months: phases.map((phase, index) => ({ month: index + 1, phase, turning: turning.has(index + 1) })) },
  };
}

const MOCK_CHART_CITIES = ['北京', '上海', '广州', '深圳', '杭州', '南京', '成都', '重庆', '西安', '哈尔滨', '乌鲁木齐', '拉萨', '长春', '长沙'];
function matchChartCity(place) {
  if (!place) return null;
  const normalized = String(place).replace(/特别行政区|(?:壮族|回族|维吾尔族)?自治区|自治州|地区/g, '').replace(/[省市区县旗]/g, '').replace(/[，,、；;\s]+/g, '').trim();
  if (normalized.length < 2) return null;
  if (MOCK_CHART_CITIES.includes(normalized)) return normalized;
  let best = null;
  MOCK_CHART_CITIES.forEach((city) => {
    const index = normalized.indexOf(city);
    if (index >= 0 && (!best || index < best.index || index === best.index && city.length > best.city.length)) best = { city, index };
  });
  return best ? best.city : null;
}

function sampleChartReport(birthPlace, trueSolarApplied) {
  const year = new Date().getFullYear();
  const pillar = (ganZhi, shiShenGan, hideGan, shiShenZhi, naYin) => ({ ganZhi, shiShenGan, hideGan, shiShenZhi, naYin });
  const star = (name, brightness, mutagen) => ({ name, brightness, mutagen });
  const palaces = [
    { name: '命宫', stem: '丁', branch: '巳', isSoul: true, isBody: false, majorStars: [star('紫微', '旺', null), star('天府', '得', null)], minorStars: ['左辅', '文昌'], adjectiveStars: ['台辅', '天巫'], decadal: { start: 6, end: 15 } },
    { name: '父母', stem: '戊', branch: '午', isSoul: false, isBody: false, majorStars: [star('太阴', '陷', '禄')], minorStars: ['文曲'], adjectiveStars: ['天厨'], decadal: { start: 16, end: 25 } },
    { name: '福德', stem: '己', branch: '未', isSoul: false, isBody: false, majorStars: [star('贪狼', '庙', '权')], minorStars: ['火星'], adjectiveStars: ['天福'], decadal: { start: 26, end: 35 } },
    { name: '田宅', stem: '庚', branch: '申', isSoul: false, isBody: false, majorStars: [star('巨门', '得', null)], minorStars: ['右弼'], adjectiveStars: ['天官'], decadal: { start: 36, end: 45 } },
    { name: '官禄', stem: '辛', branch: '酉', isSoul: false, isBody: true, majorStars: [star('天相', '旺', null)], minorStars: ['文昌', '禄存'], adjectiveStars: ['三台', '八座'], decadal: { start: 46, end: 55 } },
    { name: '仆役', stem: '壬', branch: '戌', isSoul: false, isBody: false, majorStars: [star('天梁', '庙', '科')], minorStars: ['铃星'], adjectiveStars: ['天寿'], decadal: { start: 56, end: 65 } },
    { name: '迁移', stem: '癸', branch: '亥', isSoul: false, isBody: false, majorStars: [star('七杀', '旺', null)], minorStars: ['天马'], adjectiveStars: ['孤辰'], decadal: { start: 66, end: 75 } },
    { name: '疾厄', stem: '甲', branch: '子', isSoul: false, isBody: false, majorStars: [], minorStars: ['地空'], adjectiveStars: ['天哭'], decadal: { start: 76, end: 85 } },
    { name: '财帛', stem: '乙', branch: '丑', isSoul: false, isBody: false, majorStars: [star('廉贞', '平', '忌'), star('天府', '庙', null)], minorStars: ['擎羊'], adjectiveStars: ['龙池'], decadal: { start: 86, end: 95 } },
    { name: '子女', stem: '丙', branch: '寅', isSoul: false, isBody: false, majorStars: [star('太阳', '旺', null)], minorStars: ['陀罗'], adjectiveStars: ['凤阁'], decadal: { start: 96, end: 105 } },
    { name: '夫妻', stem: '丁', branch: '卯', isSoul: false, isBody: false, majorStars: [star('武曲', '庙', null), star('天相', '得', null)], minorStars: ['地劫'], adjectiveStars: ['红鸾'], decadal: { start: 106, end: 115 } },
    { name: '兄弟', stem: '戊', branch: '辰', isSoul: false, isBody: false, majorStars: [star('天同', '平', null), star('天梁', '得', null)], minorStars: ['天钺'], adjectiveStars: ['天喜'], decadal: { start: 116, end: 125 } },
  ];
  return {
    engineVersion: 'paipan-v3',
    base: { solarDate: '1990-06-18', lunarDate: '庚午年五月廿六', gender: '男', hourKnown: true, hourLabel: '巳时', trueSolarApplied: Boolean(trueSolarApplied), birthPlace: birthPlace || null },
    bazi: {
      pillars: {
        year: pillar('庚午', '偏财', ['丁', '己'], ['正印', '劫财'], '路旁土'),
        month: pillar('壬午', '偏财', ['丁', '己'], ['正印', '劫财'], '杨柳木'),
        day: pillar('戊子', '日主', ['癸'], ['正财'], '霹雳火'),
        time: pillar('甲寅', '七杀', ['甲', '丙', '戊'], ['七杀', '偏印', '比肩'], '大溪水'),
      },
      dayMaster: { gan: '戊', element: '土', strength: '身强', strengthLevel: '偏旺', strengthScore: 6, confidence: '高', basis: '月令午火生身，年时通根，日主偏旺。' },
      favorableElements: ['金', '水', '木'],
      tiaoHou: { gods: ['甲', '丙', '癸'], elements: ['木', '火', '水'] },
      pattern: { name: '偏财格', monthShiShen: '偏财', traits: '务实进取、善用资源、交游广阔', suits: ['整合外部资源、以势取利'], avoid: ['贪多铺摊、押上全部本金'], basis: '月令透偏财且得地，以偏财立格。', confidence: '高' },
      daYun: {
        direction: '顺行', startAge: '3 岁 4 个月起', approximate: false,
        list: [
          { ganZhi: '癸未', startAge: 3, startYear: 1993 }, { ganZhi: '甲申', startAge: 13, startYear: 2003 },
          { ganZhi: '乙酉', startAge: 23, startYear: 2013 }, { ganZhi: '丙戌', startAge: 33, startYear: 2023 },
          { ganZhi: '丁亥', startAge: 43, startYear: 2033 }, { ganZhi: '戊子', startAge: 53, startYear: 2043 },
          { ganZhi: '己丑', startAge: 63, startYear: 2053 }, { ganZhi: '庚寅', startAge: 73, startYear: 2063 },
        ],
      },
      wuxingCount: { counts: { 木: 1, 火: 3, 土: 2, 金: 1, 水: 1 }, basis: '天干 4 位 + 地支本气 4 位，共 8 位计数。' },
    },
    ziwei: { fiveElementsClass: '火六局', soulStar: '贪狼', bodyStar: '天相', yinYang: '阳男', soulBranch: '巳', bodyBranch: '酉', palaces },
    yinzheng: {
      baziAxis: { text: '以「偏财格」立局，日主戊土偏旺，宜借金水木起势；调候取甲丙癸。', basis: '格局 + 旺衰 + 喜用 + 调候拼装。' },
      ziweiAxis: { text: '命宫巳，紫微、天府坐守；身宫落官禄，火六局。生年化禄落父母宫。', basis: '命宫主星 + 身宫宫名 + 五行局 + 化禄落宫。' },
      elementCheck: { favorable: ['金', '水', '木'], ju: '火六局', juElement: '火', aligned: false, note: '局五行与喜用异路，以八字体用为主。' },
      timeline: [
        { years: '2013–2022', daYun: { ganZhi: '乙酉', startAge: '23 岁', startYear: 2013 }, daXian: { palace: '福德', start: 26, end: 35 }, isCurrent: false },
        { years: '2023–2032', daYun: { ganZhi: '丙戌', startAge: '33 岁', startYear: 2023 }, daXian: { palace: '田宅', start: 36, end: 45 }, isCurrent: true },
        { years: '2033–2042', daYun: { ganZhi: '丁亥', startAge: '43 岁', startYear: 2033 }, daXian: { palace: '官禄', start: 46, end: 55 }, isCurrent: false },
      ],
      keyYears: [{ year: 2023, age: 34, reason: '换运换限重合', overlap: true }, { year: 2033, age: 44, reason: '换运', overlap: false }],
      sihua: [
        { star: '太阴', hua: '禄', palace: '父母' }, { star: '贪狼', hua: '权', palace: '福德' },
        { star: '天梁', hua: '科', palace: '仆役' }, { star: '廉贞', hua: '忌', palace: '财帛' },
      ],
    },
    disclaimer: `命理内容为文化视角的研究与参考，不构成投资、经营或人生决策依据；「人谋可以改命」。引擎 paipan-v3 · 数据由算法层确定性推算，${year} 年为准。`,
  };
}

function chart() {
  const bazi = wx.getStorageSync(storageKey('bazi')) || null;
  return Promise.resolve({ bazi, chart: bazi && bazi.believe !== false ? sampleChart() : null });
}
function saveBazi(body) {
  const bazi = Object.assign({}, body || {});
  wx.setStorageSync(storageKey('bazi'), bazi);
  const believe = bazi.believe !== false;
  const matchedCity = matchChartCity(bazi.birthPlace);
  return Promise.resolve({ believe, chart: believe ? sampleChart() : null, matchedCity });
}
function chartReport() {
  const bazi = wx.getStorageSync(storageKey('bazi')) || null;
  if (!bazi) return Promise.resolve({ needBazi: true });
  const matchedCity = matchChartCity(bazi.birthPlace);
  return Promise.resolve(sampleChartReport(bazi.birthPlace, Boolean(matchedCity)));
}
function dossier() { return Promise.resolve(wx.getStorageSync(storageKey('dossier')) || { report: null }); }
function generateDossier() { const report = { name: '主公', headline: '把复杂经营问题收成一条可验证的主线。', verse: '先定一事，再聚众力', sections: [{ key: 'main', no: '一', label: '当前判断', blocks: [{ type: 'para', text: '这是原生 mock 生成的完整履历。连接服务端后会根据真实档案、对话和案卷生成。' }] }] }; wx.setStorageSync(storageKey('dossier'), { report }); return Promise.resolve({ report, generatedAt: new Date().toISOString() }); }
function brandKit() { return Promise.resolve(wx.getStorageSync(storageKey('brandKit')) || null); }
function generateBrandKit() { const value = { version: 1, approved: false, persona: { name: '创始人主理人', tagline: '用判断帮助企业少走弯路', tone: '克制、清楚、可信', story: '从真实经营问题出发', doNots: ['空泛口号'] }, voice: { hooks: ['先看主要矛盾'], openers: ['这件事先别急着做'], ctas: ['就从今天这一件开始'], taboos: ['夸大承诺'] }, theme: { keywords: ['东方', '克制'], colorHint: '本命色', styleRefs: ['编辑部'] } }; wx.setStorageSync(storageKey('brandKit'), value); return Promise.resolve(value); }
function fateCardPreview(body) { return Promise.resolve({ title: `${body.friendName || '朋友'}的天命速写`, summary: '稳中求进，先把手里最重要的一件事做深。', lines: ['守正', '聚焦', '徐进'] }); }
function dailyBattleReport() { return Promise.resolve({ date: '', judgement: '先聚焦一个可验证结果。', actions: ['补齐关键事实', '完成今日主令'] }); }
const MOCK_BIZ_METRIC_TEMPLATE = [
  { metricKey: 'monthly_revenue', metricName: '月营收', unit: '万元' },
  { metricKey: 'customer_price', metricName: '客单价', unit: '元' },
  { metricKey: 'repurchase_rate', metricName: '复购率', unit: '%' },
  { metricKey: 'store_conversion', metricName: '到店转化率', unit: '%' },
  { metricKey: 'new_customers', metricName: '新客数', unit: '人' },
];
function ymd(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function mondayOf(offsetWeeks) {
  const date = new Date();
  const dayOffset = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - dayOffset + Number(offsetWeeks || 0) * 7);
  return ymd(date);
}
function seedBizMetricSeries() {
  return [
    { weekStart: mondayOf(-2), metrics: { monthly_revenue: 18, customer_price: 620, repurchase_rate: 34, store_conversion: 41, new_customers: 52 } },
    { weekStart: mondayOf(-1), metrics: { monthly_revenue: 21, customer_price: 660, repurchase_rate: 37, store_conversion: 44, new_customers: 58 } },
  ];
}
function ensureBizMetricSeries() {
  const stored = getList('bizMetrics');
  if (stored.length) return stored;
  const seeded = seedBizMetricSeries();
  setList('bizMetrics', seeded);
  return seeded;
}
function bizMetricTemplate() { return Promise.resolve({ items: MOCK_BIZ_METRIC_TEMPLATE.map((item) => Object.assign({}, item)) }); }
function bizMetricSeries(weeks) {
  const size = Math.max(1, Math.trunc(Number(weeks) || 8));
  const items = ensureBizMetricSeries().slice().sort((a, b) => String(a.weekStart).localeCompare(String(b.weekStart))).slice(-size);
  return Promise.resolve({ items });
}
function saveBizMetrics(weekStart, metrics) {
  const key = String(weekStart || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return Promise.reject(Object.assign(new Error('周起始日期不合法'), { code: 'BIZ_METRIC_WEEK_INVALID' }));
  const rows = ensureBizMetricSeries().slice();
  const index = rows.findIndex((item) => item.weekStart === key);
  const value = { weekStart: key, metrics: Object.assign({}, metrics || {}) };
  if (index >= 0) rows[index] = value; else rows.push(value);
  setList('bizMetrics', rows);
  return Promise.resolve({ ok: true });
}
const MOCK_POSTER_TEMPLATES = [
  { key: 'person_hero', name: '人物主视觉', desc: '真人照片打底，人物占据主视觉' },
  { key: 'editorial', name: '编辑杂志', desc: '杂志内页式排版，图文并重' },
  { key: 'business_launch', name: '商业发布', desc: '发布会 / 新品公告气质' },
];
function prescriptions() {
  return Promise.resolve({ items: [{ id: 'rx1', problem: '获客越来越贵', playbook: '做影响力短视频获客', toolKey: 'brand', toolType: 'agent', externalUrl: null, status: 'proposed', proposedAt: '2026-07-08 10:00' }] });
}
function prescriptionAction() { return Promise.resolve({ ok: true }); }
// 与 H5 mock 同契约（AGENTS.md §「两端各有一份同契约 mock 后端」）：高级档在 mock 里恒可用，
// 否则原生端确认页少一整块档位 UI，本地走查根本验不到它。
function creativeStatus() {
  return Promise.resolve({
    enabled: true,
    pricePerPoster: 10,
    premiumPricePerPoster: 25,
    premiumAvailable: true,
    templates: MOCK_POSTER_TEMPLATES,
  });
}
function posterBriefDraft() {
  return Promise.resolve({
    brief: {
      scene: 'personal_brand', goal: '让潜在客户看懂你在做什么', audience: '有相同问题、还没找到解法的人',
      headline: '一件事，做到别人做不到', subheadline: '', proofPoints: ['先看主要矛盾', '再定一条行动主线'],
      cta: '扫码来聊', visualDirection: '干净留白、克制的墨色与暖金、正面柔光、竖版三分构图',
      templateKey: 'person_hero', ratio: '3:4',
    },
    templateReason: '人物信任感是主要抓手，人物主视觉能让第一眼先记住人，再记住主张。',
  });
}
const MOCK_POSTER_PRICE = 10;
const MOCK_POSTER_PAGE_SIZE = 20;
const MOCK_POSTER_PAGE_MAX = 50;
const MOCK_POSTER_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADwAAABQCAIAAADKqIEEAAAB2klEQVR42tXOW0vTcQCH8edVBBFUkoghggzzkJlhmeKBMRhmaYllBzWGMjxgJqZ4RpNhiWklw5KRNUYmZqiMxViZ5hFLLKSuvO4N9Ap+eiV/vvC5fx6O2E7I4WhilByOJUXL4XhqjBxOpp2Ww6n0ODnEZMTLITYzQQ5xl2xyiL+cKIeEnGQ52PJS5XCm4JwcUuzn5XDWcUEO6c6LcsgozJJDZlGOHLKu5cohuyTf5N9exFqmMXJL7SaWT5vGyC9zmFg+bRrDfstpYvm0aQzH7UITy6dNYzjvFcnhSmWxHK7evy6HElepHG7U3JRDmbvcJBLyH559ugeivPauyaFO79M9EHfqK+RQ0Vglh6omlxxczdVyqG5xy8HdWiuHuvZ6OTR0NsrhQXeTHB72Nsuhpf+RHNoG2uTQ7umQQ9dglxx6hnrk0DfcJ4eBkcdy8Dz3yOHJ2KAchrxP5fBsfFgOo69H5PDS90IO3jdjchh/65XDhP+VHHyBCTlMTvnk4J+elENg5p0cpmYDcpieey+Hjwsf5PApOCOH+dCsHILhOTmEIgtyCH8NyiHy7bMcFr+H5bC8+kUOK+uLcljfXJLD5taKHH5sr8lhe2dDDr9+b8lhd/enHP783ZHzHwStB5oWBI+zAAAAAElFTkSuQmCC';
function loadCreativeJobs() {
  const rows = getList('creativeJobs');
  return Array.isArray(rows) ? rows : [];
}
function saveCreativeJobs(rows) { setList('creativeJobs', rows.slice(-30)); }
function creativePhase(row) {
  if (row.terminal === 'cancelled') return { status: 'cancelled', progress: 'upload' };
  if (row.terminal === 'failed') return { status: 'failed', progress: 'visual' };
  const elapsed = Math.max(0, Date.now() - Number(row.createdAt || 0));
  if (elapsed < 900) return { status: 'pending', progress: 'philosophy' };
  if (elapsed < 1800) return { status: 'running', progress: 'visual' };
  if (elapsed < 2600) return { status: 'running', progress: 'render' };
  if (elapsed < 3200) return { status: 'running', progress: 'upload' };
  return { status: 'succeeded', progress: 'upload' };
}
function creativeActions(status) {
  if (status === 'pending' || status === 'running') return ['cancel'];
  if (status === 'succeeded') return ['revise', 'regenerate'];
  return ['regenerate'];
}
function creativeView(row) {
  const phase = creativePhase(row);
  const asset = {
    id: `${row.id}-png`, kind: 'poster_png', mimeType: 'image/png', width: 1080, height: 1440,
    previewUrl: MOCK_POSTER_PNG, downloadUrl: MOCK_POSTER_PNG,
  };
  const succeeded = phase.status === 'succeeded';
  const done = succeeded || phase.status === 'failed' || phase.status === 'cancelled';
  return {
    id: row.id, kind: 'poster', status: phase.status, progress: phase.progress,
    creditCost: Number(row.creditCost || 0), refunded: Boolean(row.refunded),
    createdAt: new Date(Number(row.createdAt)).toISOString(),
    completedAt: done ? new Date(Number(row.terminalAt || Number(row.createdAt) + 3200)).toISOString() : undefined,
    assets: succeeded ? [asset] : [], outputs: succeeded ? [MOCK_POSTER_PNG] : [],
    parentJobId: row.parentJobId || undefined, actions: creativeActions(phase.status), brief: Object.assign({}, row.brief || {}),
    errorMessage: phase.status === 'cancelled' ? '已取消' : phase.status === 'failed' ? '出图失败，已退回钻石' : undefined,
  };
}
function creativeNotFound() { return mockNotFound('任务不存在', 'NOT_FOUND'); }
function creativeResult(row, reused) {
  return { jobId: row.id, id: row.id, status: creativePhase(row).status, creditCost: Number(row.creditCost || 0), reused: Boolean(reused) };
}
function createPosterJob(body) {
  const request = body || {};
  const key = String(request.idempotencyKey || '').trim();
  if (!key) return Promise.reject(Object.assign(new Error('idempotencyKey 非法'), { code: 'IDEMPOTENCY_KEY_INVALID', statusCode: 422 }));
  const jobs = loadCreativeJobs();
  const duplicate = jobs.find((row) => row.idempotencyKey === key);
  if (duplicate) return Promise.resolve(creativeResult(duplicate, true));
  const row = {
    id: `mock-poster-${Date.now()}-${jobs.length + 1}`, createdAt: Date.now(), idempotencyKey: key,
    brief: Object.assign({}, request.brief || {}), creditCost: MOCK_POSTER_PRICE,
  };
  jobs.push(row); saveCreativeJobs(jobs);
  return Promise.resolve(creativeResult(row, false));
}
function creativeJob(id) {
  const row = loadCreativeJobs().find((item) => item.id === id);
  return row ? Promise.resolve(creativeView(row)) : Promise.reject(creativeNotFound());
}
function createPosterChild(id, body, kind) {
  const patch = body || {};
  const jobs = loadCreativeJobs();
  const parent = jobs.find((item) => item.id === id);
  if (!parent) return Promise.reject(creativeNotFound());
  const prefix = kind === 'revise' ? 'revise' : 'regen';
  const key = String(patch.idempotencyKey || '').trim() || `${prefix}:${id}:${Date.now()}`;
  const duplicate = jobs.find((item) => item.idempotencyKey === key);
  if (duplicate) return Promise.resolve(creativeResult(duplicate, true));
  const brief = Object.assign({}, parent.brief || {});
  const fields = kind === 'revise'
    ? ['headline', 'subheadline', 'proofPoints', 'cta', 'templateKey']
    : ['visualDirection', 'negativePrompt', 'templateKey'];
  fields.forEach((field) => { if (Object.prototype.hasOwnProperty.call(patch, field)) brief[field] = patch[field]; });
  const row = {
    id: `mock-poster-${Date.now()}-${jobs.length + 1}`, createdAt: Date.now(), idempotencyKey: key,
    brief, creditCost: kind === 'revise' ? 0 : MOCK_POSTER_PRICE, parentJobId: parent.id,
  };
  jobs.push(row); saveCreativeJobs(jobs);
  return Promise.resolve(creativeResult(row, false));
}
function reviseJob(id, body) { return createPosterChild(id, body, 'revise'); }
function regenerateJob(id, body) { return createPosterChild(id, body, 'regenerate'); }
function cancelJob(id) {
  const jobs = loadCreativeJobs();
  const row = jobs.find((item) => item.id === id);
  if (!row) return Promise.reject(creativeNotFound());
  const status = creativePhase(row).status;
  if (status === 'pending' || status === 'running') {
    row.terminal = 'cancelled'; row.terminalAt = Date.now(); row.refunded = Number(row.creditCost || 0) > 0;
    saveCreativeJobs(jobs);
  }
  return Promise.resolve(creativeView(row));
}
function creativePosterItem(row) {
  const view = creativeView(row);
  if (view.status === 'failed' || view.status === 'cancelled') return null;
  const poster = view.assets.find((item) => item.kind === 'poster_png');
  if (view.status === 'succeeded' && !poster) return null;
  return {
    jobId: row.id, status: view.status, createdAt: view.createdAt,
    completedAt: view.status === 'succeeded' ? view.completedAt : undefined,
    headline: String(row.brief && row.brief.headline || '').trim(), templateKey: row.brief && row.brief.templateKey || undefined,
    progress: view.status === 'succeeded' ? undefined : view.progress, poster: poster || undefined,
    parentJobId: row.parentJobId || undefined,
  };
}
function creativePosters(cursor, limit) {
  const all = loadCreativeJobs().map(creativePosterItem).filter(Boolean).sort((a, b) => {
    const time = Date.parse(b.createdAt) - Date.parse(a.createdAt);
    return time || (a.jobId < b.jobId ? 1 : -1);
  });
  const size = Math.min(Math.max(Math.trunc(Number(limit)) || MOCK_POSTER_PAGE_SIZE, 1), MOCK_POSTER_PAGE_MAX);
  let rest = all;
  const rawCursor = String(cursor || '').trim();
  if (rawCursor) {
    const parsed = /^(\d{1,15}):(.+)$/.exec(rawCursor);
    if (!parsed) return Promise.reject(Object.assign(new Error('分页游标非法'), { code: 'CURSOR_INVALID', statusCode: 422 }));
    const at = Number(parsed[1]);
    const id = parsed[2];
    rest = all.filter((item) => {
      const time = Date.parse(item.createdAt);
      return time < at || (time === at && item.jobId < id);
    });
  }
  const items = rest.slice(0, size);
  const last = items[items.length - 1];
  const result = { items };
  if (rest.length > size && last) result.nextCursor = `${Date.parse(last.createdAt)}:${last.jobId}`;
  return Promise.resolve(result);
}
function today() { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
function casefileKey() { return `junshi.dossier.${wx.getStorageSync('junshi.userId') || 'guest'}`; }
function casefile() { const value = wx.getStorageSync(casefileKey()); if (!value) return Promise.resolve({ casefile: null }); try { return Promise.resolve({ casefile: typeof value === 'string' ? JSON.parse(value) : value }); } catch (_) { return Promise.resolve({ casefile: null }); } }
function saveCasefile(value) { value.updatedAt = new Date().toISOString(); wx.setStorageSync(casefileKey(), JSON.stringify(value)); return value; }
function ensureCasefile() { return casefile().then((r) => r.casefile || { id: `mock-casefile-${Date.now()}`, title: '我的经营案卷', sourceAgent: '我', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), judgment: '', risks: [], orders: [], backfill: {} }); }
function addOrder(text) { return ensureCasefile().then((value) => { value.orders.unshift({ id: `mock-order-${Date.now()}`, text, from: '我', tag: '军令 · 自定', date: today(), done: false }); return { casefile: saveCasefile(value) }; }); }
function toggleOrder(id, body) { return ensureCasefile().then((value) => { value.orders = value.orders.map((item) => item.id === id ? Object.assign({}, item, body && Object.prototype.hasOwnProperty.call(body, 'resultNote') ? { resultNote: body.resultNote } : { done: !item.done }) : item); return { casefile: saveCasefile(value) }; }); }
function removeOrder(id) { return ensureCasefile().then((value) => { value.orders = value.orders.filter((item) => item.id !== id); return { casefile: saveCasefile(value) }; }); }
function saveBackfill(values) { return ensureCasefile().then((value) => { value.backfill[today()] = Object.assign({}, values, { savedAt: new Date().toISOString() }); return { casefile: saveCasefile(value) }; }); }
function saveGoals(patch) { return ensureCasefile().then((value) => { value.goals = Object.assign({}, value.goals || {}, patch || {}, { updatedAt: new Date().toISOString() }); return { casefile: saveCasefile(value) }; }); }
function reviewStreakFrom(items) {
  const dates = Array.from(new Set((items || []).map((item) => String(item.date || '')).filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)))).sort().reverse();
  if (!dates.length) return 0;
  const dayMs = 24 * 60 * 60 * 1000;
  const todayAt = new Date(`${today()}T00:00:00`).getTime();
  const latestAt = new Date(`${dates[0]}T00:00:00`).getTime();
  if (latestAt !== todayAt && latestAt !== todayAt - dayMs) return 0;
  let streak = 1;
  let previous = latestAt;
  for (let index = 1; index < dates.length; index += 1) {
    const current = new Date(`${dates[index]}T00:00:00`).getTime();
    if (previous - current !== dayMs) break;
    streak += 1; previous = current;
  }
  return streak;
}
function reviews() {
  const items = getList('reviews').slice().sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.createdAt).localeCompare(String(a.createdAt)));
  const streak = reviewStreakFrom(items);
  wx.setStorageSync(storageKey('reviewStreak'), streak);
  return Promise.resolve({ items, streak });
}
function reviewCasefile(layer) {
  return ensureCasefile().then((value) => {
    const date = today();
    const orders = (value.orders || []).filter((item) => item.date === date);
    const done = orders.filter((item) => item.done).length;
    const rows = getList('reviews').slice();
    const reviewLayer = String(layer || 'daily');
    const item = {
      id: `mock-review-${date}-${reviewLayer}`, layer: reviewLayer, date,
      ordersTotal: orders.length, ordersDone: done, alignRate: orders.length ? Math.round((done / orders.length) * 100) : null,
      hasBackfill: Boolean(value.backfill && value.backfill[date]), createdAt: new Date().toISOString(),
    };
    const index = rows.findIndex((row) => row.date === date && String(row.layer || 'daily') === reviewLayer);
    if (index >= 0) rows[index] = Object.assign({}, rows[index], item); else rows.unshift(item);
    setList('reviews', rows);
    const streak = reviewStreakFrom(rows);
    wx.setStorageSync(storageKey('reviewStreak'), streak);
    return { streak, review: item };
  });
}
function seedLedger() {
  const day = today();
  const decision = (seq, text, status, fast, scene) => ({
    id: `d${seq}`, seq, scene: scene || '战略规划', decision: text, reasons: [], tianshiRef: '', expected: '',
    verifyStandard: '', verifyByDate: day, status, verifyNote: '', fast, createdAt: `${day} 10:0${seq}`,
  });
  const prophecy = (seq, text, status) => ({
    id: `p${seq}`, seq, prophecy: text, basis: '流月', verifyStandard: '', dueDate: day,
    status, verifyNote: '', createdAt: `${day} 10:0${seq}`,
  });
  return {
    decisions: [
      decision(1, '先收缩到复购最好的两家店，砍掉拖后腿的第4家', 'correct', false),
      decision(2, '把9800年卡改成体验—复购分层，先拉复购率', 'correct', false),
      decision(3, '暂缓加盟扩张，先把直营模型跑透', 'revise', true, '紧急战况'),
      decision(4, '上私域内容获客，替代高价投放', 'pending', null),
      decision(5, '把技师提成和复购挂钩', 'pending', null),
      decision(6, '开一条轻医美高毛利线试水', 'pending', null),
    ],
    prophecies: [
      prophecy(1, '3月忌神当令，现金流会有压力', 'hit'),
      prophecy(2, '4月偏财得力，有意外进账', 'hit'),
      prophecy(3, '5月官星受克，团队可能有波动', 'miss'),
      prophecy(4, '下半年适合签长约、落白纸黑字', 'pending'),
      prophecy(5, '秋后有一次扩张窗口', 'pending'),
    ],
  };
}
function loadLedger() {
  const raw = wx.getStorageSync(storageKey('ledger'));
  if (raw) {
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (parsed && Array.isArray(parsed.decisions) && Array.isArray(parsed.prophecies)) return parsed;
    } catch (_) { /* 损坏的本地样例重新初始化 */ }
  }
  const seeded = seedLedger();
  wx.setStorageSync(storageKey('ledger'), seeded);
  return seeded;
}
function saveLedger(value) { wx.setStorageSync(storageKey('ledger'), value); }
function ratio(correct, wrong) { return correct + wrong >= 5 ? Math.round(correct / (correct + wrong) * 100) : null; }
function decisionStats(items) {
  const correct = items.filter((item) => item.status === 'correct').length;
  const revise = items.filter((item) => item.status === 'revise').length;
  const fast = items.filter((item) => item.fast === true);
  const slow = items.filter((item) => item.fast === false);
  return {
    total: items.length, pending: items.length - correct - revise, correct, revise, accuracy: ratio(correct, revise),
    fastAccuracy: ratio(fast.filter((item) => item.status === 'correct').length, fast.filter((item) => item.status === 'revise').length),
    slowAccuracy: ratio(slow.filter((item) => item.status === 'correct').length, slow.filter((item) => item.status === 'revise').length),
  };
}
function prophecyStats(items) {
  const hit = items.filter((item) => item.status === 'hit').length;
  const miss = items.filter((item) => item.status === 'miss').length;
  return { total: items.length, pending: items.length - hit - miss, hit, miss, hitRate: ratio(hit, miss) };
}
function decisions() {
  const value = loadLedger();
  return Promise.resolve({ items: value.decisions.slice().sort((a, b) => Number(b.seq) - Number(a.seq)), stats: decisionStats(value.decisions) });
}
function prophecies() {
  const value = loadLedger();
  return Promise.resolve({ items: value.prophecies.slice().sort((a, b) => Number(b.seq) - Number(a.seq)), stats: prophecyStats(value.prophecies) });
}
function verifyDecision(id, outcome, note) {
  const value = loadLedger();
  const item = value.decisions.find((candidate) => candidate.id === id);
  if (!item) return Promise.reject(mockNotFound('决策记录不存在', 'NOT_FOUND'));
  if (outcome !== 'correct' && outcome !== 'revise') return Promise.reject(mockNotFound('验证结果无效', 'INVALID_OUTCOME'));
  item.status = outcome;
  if (note) item.verifyNote = String(note).trim().slice(0, 500);
  saveLedger(value);
  return Promise.resolve({ decision: Object.assign({}, item), stats: decisionStats(value.decisions) });
}
function verifyProphecy(id, outcome, note) {
  const value = loadLedger();
  const item = value.prophecies.find((candidate) => candidate.id === id);
  if (!item) return Promise.reject(mockNotFound('预言记录不存在', 'NOT_FOUND'));
  if (outcome !== 'hit' && outcome !== 'miss') return Promise.reject(mockNotFound('验证结果无效', 'INVALID_OUTCOME'));
  item.status = outcome;
  if (note) item.verifyNote = String(note).trim().slice(0, 500);
  saveLedger(value);
  return Promise.resolve({ prophecy: Object.assign({}, item), stats: prophecyStats(value.prophecies) });
}
function disputeDecision(id, dispute) {
  const value = loadLedger();
  const item = value.decisions.find((candidate) => candidate.id === id);
  if (item) item.disputeNote = String(dispute || '').trim().slice(0, 500);
  saveLedger(value);
  return Promise.resolve({ ok: Boolean(item) });
}
function disputeProphecy(id, dispute) {
  const value = loadLedger();
  const item = value.prophecies.find((candidate) => candidate.id === id);
  if (item) item.disputeNote = String(dispute || '').trim().slice(0, 500);
  saveLedger(value);
  return Promise.resolve({ ok: Boolean(item) });
}
function progress() {
  const value = loadLedger();
  const decisionState = decisionStats(value.decisions);
  const prophecyState = prophecyStats(value.prophecies);
  return Promise.resolve({
    progress: {
      rank: '尉官', usageDays: 16, streak: 15,
      decisionAccuracy: decisionState.accuracy, prophecyHitRate: prophecyState.hitRate,
      milestones: { '7': '2026-07-01', '14': '2026-07-08' },
      nextRank: { rank: '校官', requirement: '连续复盘 30 天 + 完成首次月度战报' },
    },
  });
}
function refreshForces() {
  const profile = wx.getStorageSync(storageKey('profile')) || null;
  const forces = buildBattleForces(profile);
  const updatedAt = new Date().toISOString();
  wx.setStorageSync(storageKey('battleForces'), forces);
  wx.setStorageSync(storageKey('battleForcesUpdatedAt'), updatedAt);
  return Promise.resolve({ forces });
}
function battleCommit() {
  return ensureCasefile().then((value) => {
    if (!value.judgment) value.judgment = '先聚焦一个可验证结果，再围绕它排今天的军令。';
    if (!value.orders.some((item) => item.date === today())) {
      value.orders.unshift({ id: `mock-order-${Date.now()}`, text: '补齐当前判断最关键的一条证据', from: '总军师', tag: '今日主令', date: today(), done: false });
    }
    return { casefile: saveCasefile(value), report: { id: `mock-report-${Date.now()}` } };
  });
}
function acceptDeliverable(deliverable, agentName) {
  return ensureCasefile().then((value) => {
    const d = deliverable || {};
    const sections = Array.isArray(d.sections) ? d.sections : [];
    const first = sections.find((section) => section && (section.b || (section.paras && section.paras.length)));
    const actionSections = sections.filter((section) => section && Array.isArray(section.list) && section.list.length);
    const candidates = actionSections.flatMap((section) => section.list).map((item) => String(item || '').trim()).filter(Boolean).slice(0, 3);
    const before = value.orders.length;
    value.title = d.title || value.title;
    value.sourceAgent = agentName || '军师';
    value.judgment = first ? (first.b || first.paras[0]) : (d.title || value.judgment);
    const existing = new Set(value.orders.filter((item) => item.date === today()).map((item) => item.text));
    for (const text of candidates.reverse()) if (!existing.has(text)) value.orders.unshift({ id: `mock-order-${Date.now()}-${value.orders.length}`, text, from: agentName || '军师', tag: `军令 · ${agentName || '军师'}`, date: today(), done: false });
    const newOrders = value.orders.length - before;
    return { casefile: saveCasefile(value), newOrders, skippedOrders: Math.max(0, candidates.length - newOrders) };
  });
}

function raw(path, method, data) {
  const clean = String(path || '').split('?')[0];
  if (method !== 'GET') return Promise.resolve({ ok: true });
  if (clean === '/me') return me();
  if (clean === '/me/credits') return credits();
  if (clean === '/me/dossier') return dossier();
  if (clean === '/me/memory-library') return Promise.resolve({ sections: [] });
  if (clean === '/projects') return projects();
  if (clean.startsWith('/projects/')) return project(clean.split('/').pop());
  if (clean === '/knowledge') return knowledge();
  if (clean === '/knowledge/docs') return knowledgeDocs();
  if (clean === '/knowledge/pipeline') return knowledgePipeline();
  if (clean.startsWith('/knowledge/')) return knowledgeDetail(clean.split('/').pop());
  if (clean === '/library') return library();
  if (clean === '/reports') return reports();
  if (clean === '/creative/posters') return creativePosters();
  if (clean === '/reminders') return Promise.resolve({ items: [], subscribeReady: false });
  if (clean.startsWith('/reports/')) return report(clean.split('/')[2]);
  if (clean === '/plans' || clean === '/plans/options') return clean.endsWith('options') ? planOptions() : plans();
  if (clean === '/profile/chart') return chart();
  if (clean === '/profile/chart/report') return chartReport();
  if (clean === '/brand-kit') return brandKit();
  if (clean === '/cards/daily') return dailyBattleReport();
  if (clean === '/decisions') return decisions();
  if (clean === '/prophecies') return prophecies();
  if (clean === '/progress') return progress();
  if (clean === '/data-sources') return dataSources();
  if (clean === '/modules') return modules();
  if (clean === '/skus') return skus();
  if (clean === '/reviews') return reviews();
  if (clean === '/biz-metrics/template') return bizMetricTemplate();
  if (clean === '/biz-metrics') return bizMetricSeries();
  if (clean === '/prescriptions') return prescriptions();
  if (clean === '/creative/status') return creativeStatus();
  if (clean === '/casefile') return casefile();
  if (clean.startsWith('/creative/jobs/')) return creativeJob(clean.split('/').pop());
  return Promise.resolve(data || []);
}

function generate(body) {
  const text = String(body && body.text || '').trim();
  if (!text) return Promise.reject(Object.assign(new Error('请输入内容'), { code: 'EMPTY_TEXT' }));
  const allAgents = DEFAULT_AGENTS;
  const agent = allAgents.find((item) => item.key === body.agentKey) || allAgents[0];
  const id = body.sessionId || `native-${Date.now()}`;
  const detailKey = storageKey(`session.${id}`);
  const now = new Date().toISOString();
  const detail = wx.getStorageSync(detailKey) || {
    id, agentKey: agent.key, agent,
    title: text.slice(0, 18), messages: [],
  };
  detail.messages.push({ id: `u-${Date.now()}`, role: 'user', content: { text }, refs: Array.isArray(body.refs) ? body.refs : [], at: now });
  const reply = {
    text: `我先把这件事收住：${text.slice(0, 80)}。`,
    points: ['先确认你真正要解决的结果', '再补一条最关键的事实或数据', '最后把判断拆成今天能执行的动作'],
    acts: [['target', '继续判断']],
  };
  detail.messages.push({ id: `a-${Date.now()}`, role: 'assistant', content: reply, at: now });
  wx.setStorageSync(detailKey, detail);
  const listKey = storageKey('sessions');
  const list = wx.getStorageSync(listKey) || [];
  const row = { id, agentKey: agent.key, agentName: agent.name, title: detail.title, snippet: reply.text, updatedAt: now, unreadCount: 0 };
  const next = [row, ...list.filter((item) => item.id !== id)];
  wx.setStorageSync(listKey, next);
  return Promise.resolve({ sessionId: id, created: !body.sessionId, agentKey: agent.key, kind: 'chat', reply });
}

module.exports = {
  DEFAULT_AGENTS, agents, purchaseAgent, sessions, session, search, deleteSession, login, wechatLogin, wechatPhoneLogin, sendSmsCode, me, generate,
  wenceHints, proactiveSession, track,
  updateIdentity, deleteAccount, bindPhone, setColor, uploadAvatar, getProfile, saveProfile, quickScan, journey, workbench,
  plans, planOptions, quotePlan, purchasePlan,
  skus, createSkuOrder, dataSources, requestDataSourceAuth, uploadDataSource, modules, enableModule, patchModule,
  projects, project, createProject, updateProject, deleteProject,
  createKnowledge, uploadKnowledge, knowledge, knowledgeDocs, knowledgeDetail, deleteKnowledge, knowledgePipeline, organizeBatch, confirmKnowledge,
  reports, report, reportVersion, library, saveToLibrary, summarize, credits, chart, saveBazi, chartReport, dossier, generateDossier,
  brandKit, generateBrandKit, fateCardPreview, dailyBattleReport, prescriptions, prescriptionAction,
  bizMetricTemplate, bizMetricSeries, saveBizMetrics,
  creativeStatus, posterBriefDraft, createPosterJob, creativeJob, reviseJob, regenerateJob, cancelJob, creativePosters, raw,
  casefile, addOrder, toggleOrder, removeOrder, saveBackfill, saveGoals, reviews, reviewCasefile,
  refreshForces, decisions, prophecies, progress, verifyDecision, verifyProphecy, disputeDecision, disputeProphecy,
  battleCommit, acceptDeliverable,
};
