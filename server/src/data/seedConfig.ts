// 运营可配的预设：每日献策 / 建档问卷 / 方案额度
// 事实来源对齐原型 scripts/app.js 与 运营后台.html。

import { industryOptionLabels } from './industryPacks.js';

export const SAYINGS: { text: string; enabled: boolean }[] = [
  { text: '先把自己<em>立于不败</em>，再等对手露出破绽。', enabled: true },
  { text: '现金流不是结果，是你每个<em>决策的回声</em>。', enabled: true },
  { text: '增长的尽头，是你能<em>服务好</em>的那群人。', enabled: true },
  { text: '战略是<em>选择不做什么</em>，比做什么更难。', enabled: true },
  { text: '没有<em>壁垒</em>的增长是负债；先有护城河，再谈规模。', enabled: true },
  { text: '别在<em>非共识</em>里随大流，机会藏在少数人对的地方。', enabled: true },
  { text: '组织的上限，往往是<em>创始人认知</em>的上限。', enabled: false },
  { text: '做难而正确的事，<em>时间</em>会成为你的朋友。', enabled: true },
  { text: '真正的战略，不是多做一件事，而是<em>少犯一个大错</em>。', enabled: true },
  { text: '利润不是财务表里的数字，是商业模式<em>被市场验证</em>后的结果。', enabled: true },
  { text: '先找到<em>最小可赢市场</em>，再谈全国复制。', enabled: true },
  { text: '客户愿意复购，才说明你的增长不是<em>一次性买量</em>。', enabled: true },
  { text: '不要用热闹证明增长，要用<em>留存和毛利</em>证明价值。', enabled: true },
  { text: '一家公司的护城河，常常长在<em>交付细节</em>里。', enabled: true },
  { text: '好的融资故事，必须经得起<em>单位经济模型</em>追问。', enabled: true },
  { text: '组织问题很少只在组织里，更多藏在<em>战略不清</em>里。', enabled: true },
  { text: '定价不是报一个数，是选择你要服务的<em>客户层级</em>。', enabled: true },
  { text: '现金流紧时，先砍低确定性动作，再保留<em>高信号实验</em>。', enabled: true },
  { text: '竞品最值得看的，不是他们说什么，而是他们<em>持续投入什么</em>。', enabled: true },
  { text: '把复杂问题拆到<em>可验证假设</em>，焦虑就会变成行动。', enabled: true },
  { text: '增长先问渠道，再问转化，最后必须回到<em>复购</em>。', enabled: true },
  { text: '品牌不是漂亮话，是客户在关键时刻<em>想起你的理由</em>。', enabled: true },
  { text: '老板最重要的工作，是把资源押到<em>少数关键战场</em>。', enabled: true },
  { text: '如果指标不能指导动作，它只是<em>漂亮报表</em>。', enabled: true },
  { text: '先让一个细分客群离不开你，再让更多客群<em>看见你</em>。', enabled: true },
  { text: '商业判断要先问一句：这件事会不会改善<em>现金、利润或壁垒</em>？', enabled: true },
  { text: '真正的机会窗口，通常出现在对手<em>路径依赖</em>最强的时候。', enabled: true },
  { text: '越是早期公司，越要把每次试错变成<em>可复用知识</em>。', enabled: true },
];

export const SURVEY: { key: string; title: string; options: string[] }[] = [
  // 行业选项从行业包（data/industryPacks.ts）派生 —— 单一真相源：新增行业包，选项自动跟上。
  { key: 'industry', title: '你的行业？', options: industryOptionLabels() },
  // M3 PR-13：阶段改营收区间（V6.0 §7 阶段自适应的判定输入）；旧标签在 stageOf() 里保持兼容。
  { key: 'stage', title: '年营收大概在？', options: ['100 万以下', '100-500 万', '500 万-5000 万', '5000 万以上'] },
  { key: 'pain', title: '最头疼的事？', options: ['增长乏力', '现金流', '融资', '组织 / 团队', '定位 / 竞争'] },
];

/**
 * ⚠️ 本地开发 / 自动化测试的**夹具**，不是生产套餐目录的真相源。
 *
 * 2026-08-01 起：**线上套餐（价格/额度/权益/上下架）一律由运营后台配置**
 * （`GET/POST/PATCH/DELETE /admin/plans`，requireSuper + 审计），代码不再往真实环境写套餐。
 * 全新部署也走后台配置，不 seed —— 这是刻意的：定价是运营资产，代码里的常量必然滞后于线上改价。
 *
 * 历史教训：`scripts/syncPlans.ts`（已删除）按 name 全字段 upsert，运营把入门版从 ¥68 改到 ¥99 后，
 * 任何一次全量同步都会把线上价**打回 ¥68**（2026-08-01 dry-run 实测会「更新 入门版」）。
 * 同理已删除 `scripts/bumpFreeQuota.ts`：它写死 `PLANS[0]`，免费档下架后 `PLANS[0]` 变成付费入门版，
 * 跑一次就把付费用户的 token 钱包 quota/balance 重置成夹具值。
 *
 * 所以：**这里的数字只用来喂 `prisma/seed.ts`（带生产护栏）和 `test/helpers.ts`。改这里不影响线上，
 * 也不要指望改这里能改线上。** 线上现价请以运营后台 / `GET /admin/plans` 为准。
 */
export const DEV_PLANS: {
  name: string;
  price: number; // 分
  period: string;
  creditsPerMonth: number;
  tokenQuotaPerMonth: number;
  agentCount: number;
  features: string[];
  highlighted: boolean;
  hidden?: boolean; // 隐藏档：列表不返回、仅 TEST_PLAN_PHONES 白名单可见/可购（缺省 false）
}[] = [
  // 下列数字是 2026-07-28 商业化改版时的档位形状（砍掉免费体验档，起步即收费），保留是因为
  // 测试断言和本地联调依赖这个形状（两档付费月付 + 年付 + 面议档 + 隐藏支付测试档）。
  // 定价依据当时生产 30 天实测（一次完整咨询 ≈ 3 万加权 token ≈ ¥1.09 LLM 成本，重度用户月耗最高 269 万）：
  //   入门版 满耗成本 ¥14.4 → 毛利 79%；决策版 满耗 ¥54 → 月付毛利 73% / 年付 67%。
  // 入门版兼任测试期默认档（TEST_DEFAULT_PLAN_NAME=入门版）：额度即成本封顶。
  // ⚠️ 线上入门版实价已由运营改为 ¥99/月，这里的 6800 是**夹具值，不是线上价**（见上方注释）。
  {
    name: '入门版',
    price: 6800, // ¥68/月
    period: 'month',
    creditsPerMonth: 20,
    tokenQuotaPerMonth: 400000, // 加权 token（输入等价口径），约 13 次完整咨询
    agentCount: 4,
    features: ['每月约 13 次深度咨询', '20 点 / 月', '基础顾问 4 位', '知识库与项目管理'],
    highlighted: false,
  },
  // 决策版·月付（D11 新增付费月付 SKU）：与年付同档月度权益（68 点/月、150 万 token/月、8 助手），
  // 仅计费周期不同 → 使「月→年升级折算」实际生效（业界 SaaS 通行的月/年同权益、年付更省）。
  // 额度 100 万→150 万：算力改为按单价加权后（输出 5×），重度用户实测月耗 269 万，
  // 100 万在新口径下 11 天即穿——150 万 ≈ 50 次咨询，覆盖到 P90 用户。
  {
    name: '决策版 · 月付',
    price: 19800, // ¥198/月（年付 ¥1980 ≈ 10 个月月付价 → 年付立省 2 个月）
    period: 'month',
    creditsPerMonth: 68,
    tokenQuotaPerMonth: 1500000,
    agentCount: 8,
    features: ['每月约 50 次深度咨询', '68 点 / 月', '顾问助手 8 位', '方案库 + 导出', '按月付费 · 随时升年付'],
    highlighted: false,
  },
  // 决策版（年付）：旗舰主推（highlighted）。保持名称「决策版」不带后缀 = 头牌方案，亦兼容既有用例/演示数据。
  {
    name: '决策版',
    price: 198000,
    period: 'year',
    creditsPerMonth: 68,
    tokenQuotaPerMonth: 1500000,
    agentCount: 8,
    features: ['年付立省 2 个月（约 ¥396）', '每月约 50 次深度咨询', '68 点 / 月', '顾问助手 8 位', '方案库 + 导出'],
    highlighted: true,
  },
  {
    name: '企业版 · 私有化',
    price: -1, // 面议
    period: 'year',
    creditsPerMonth: -1,
    tokenQuotaPerMonth: -1,
    agentCount: 14,
    features: ['私有化部署', '接入内部系统', '专属助手配置', '数据不出内网'],
    highlighted: false,
  },
  // 支付链路测试（隐藏档）：生产真实支付 ¥0.01 全链路验证专用（下单→requestPayment→回调入账→admin 原路退款）。
  // hidden=true：/plans 列表不返回、非 TEST_PLAN_PHONES 白名单不可购（404 不泄露存在性）；
  // 下单时绕过降级守卫（白名单账号通常已有未到期套餐，此档必然低价触发 409）——购买会重置
  // 现有套餐锚点，退款后套餐立即到期，需运营后台重新改档，这是白名单内部账号明确接受的代价。
  // 验证完成后：线上这一档到运营后台删除（无用户在册才删得掉，有人在册会 409 PLAN_IN_USE，
  // 先迁移再删；只想停售就把 hidden 打开）；本数组里的这条是夹具，删它只影响本地/测试。
  {
    name: '支付链路测试',
    price: 1, // ¥0.01
    period: 'month',
    creditsPerMonth: 1,
    tokenQuotaPerMonth: 10000,
    agentCount: 1,
    features: ['支付链路验证专用（内部）'],
    highlighted: false,
    hidden: true,
  },
];

// 注：行业基准已迁入 data/industryPacks.ts（按行业取，不再是单一写死串）。SaaS 基准 = saas 包的 benchmark。

// V7-12：单次付费商品目录（SKU）。定价对齐效果图/方案 D-5；代码即真相源，admin:sync-content 幂等 upsert。
// kind=module → 支付后 upsert UserModule(grantsModuleKey) 启用能力；service → 一次性服务凭据；storage → 空间加档(metaBytes)。
// grantsModuleKey 必须与 data/modules.ts 的 moduleKey 对齐。
export const SKUS: {
  key: string; name: string; desc: string; priceFen: number;
  kind: 'module' | 'service' | 'storage'; grantsModuleKey?: string; metaBytes?: number;
}[] = [
  { key: 'deep-organize', name: '深度整理', desc: '军师对上传资料做深度去重、提炼与补标，整理成可直接调用的知识。', priceFen: 3900, kind: 'service' },
  { key: 'storage-2g', name: '资料空间包', desc: '为资料库扩容约 2GB，容纳更多经营材料。', priceFen: 1900, kind: 'storage', metaBytes: 2 * 1024 * 1024 * 1024 },
  { key: 'deep-contradiction', name: '深度矛盾分析', desc: '围绕主要矛盾做一次深度拆解，给出结构化打法与验证标准。', priceFen: 2900, kind: 'module', grantsModuleKey: 'deep-contradiction' },
  { key: 'fin-checkup', name: '财务经营体检', desc: '对经营与财务数据做一次系统体检，定位现金与利润风险。', priceFen: 4900, kind: 'module', grantsModuleKey: 'fin-checkup' },
  { key: 'ip-topics-pro', name: 'IP 选题库 · 高级版', desc: '按你的定位批量产出可执行的内容选题库。', priceFen: 9900, kind: 'module', grantsModuleKey: 'ip-topics-pro' },
  { key: 'shop-dashboard', name: '店铺数据看板', desc: '搭建店铺经营数据看板，按周复盘核心经营指标。', priceFen: 19900, kind: 'module', grantsModuleKey: 'shop-dashboard' },
];
