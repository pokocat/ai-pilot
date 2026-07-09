# 军师小程序 V7 · 新版效果图对齐技术迭代方案

> **设计事实来源（本次迭代唯一视觉/交互基准）**：`pokocat/ai-pilot-temp` 仓库 `design/junshi-miniapp-effect.html`（12011 行，深绿+宋体重构版，含完整交互 JS）。
> **上游工程文档**：`AGENTS.md`（工程总账，§7.2 小程序约束清单 + §13 gap 清单）→ `docs/[FABLE5]POLISH_PLAN.md`（打磨方向拍板）→ **本篇（V7 对齐执行规格）**。
> **编写日期**：2026-07-09。**编写方式**：由架构 agent 对原型（逐行）与现有前后端（app 全量 / server 57 模型 161 端点 / LLM 网关层）分别做深度盘点后交叉比对产出，所有文件路径均已对照真实代码库核实。
>
> 本文分两部分：**第一部分给人看**（业务方 / 产品 / 管理层：打算怎么做、要拍板什么、大概多大）；**第二部分给 coding agent 看**（V7-01 ~ V7-15 工单：契约、模型、接口、改动点、验收标准、依赖）。

---

# 第一部分 · 给人看的方案说明

## 1. 一句话结论

现有小程序**不是推倒重来，而是「换壳 + 补三块地基」**：五 tab 骨架、对话流式、执行闭环（军令/回填/复盘）、版本化报告等核心动线已经真实可用，与新效果图的结构基本同构；真正的差距集中在 **① 智库的三段式资料整理管道、② 数据源/模块的状态持久化（现在全是静态引导页）、③ 商业化四轨计价（¥单次/算力/积分/会员）**，外加一层视觉与信息架构的对齐（贴底白条底栏、tab 命名、统一付费确认弹层）。按本方案拆成 4 个批次 15 个工单推进，绝大多数是**加法**（新表新接口新页面），对现有已验证动线的破坏面很小。

## 2. 背景：新原型改了什么

业务方这版 `junshi-miniapp-effect.html` 相对上一代设计（`junshi-miniapp-pages.html`，金色主色、无交互）是一次**全面重构**，且当前代码里的五 tab 恰恰是对齐旧版设计实现的。新版的核心变化：

1. **视觉体系换代**：金色主色 → **深绿 #1E5A43 主色 + 金色辅助 + 宋体标题**的「案卷文书」质感；底栏从悬浮胶囊改为**贴底白条 + 线性图标**（这一条 README 里早已声明为方向，代码一直没做）。
2. **对话页强化「单线对话、多军师协同」**：7 位军师带字号别名、未读数、系统同步卡（「军师已同步内部判断」）、快捷回复 chips、跨域搜索框。
3. **战局页变成「判断 → 认可 → 生成」状态机**：三势判断有了**结构化的强弱/结论/打法/强度条**；底部 CTA 是三态按钮（认可判断 → 生成中 → 已生成查看），一次认可同时产出**军令 + 报告**。
4. **执行页军令卡字段升级**：负责人、截止时间、预计耗时、来源引用、三步骤、三组指标、下一步动作类型；军令有了独立详情屏。目标阶梯带真实指标（营收×2、转化率 1.2%→3%）。
5. **智库页彻底重做**：核心是**三段式资料整理管道**——「待整理（43）→ 已优化（8）→ 知识库（51）」，上传 → AI 粗分 → 深度整理（付费）→ 用户确认入库；数据源 6 类带状态机（已绑定/待授权/待上传）+ 完整授权流程屏；能力中心有推荐位、五色 tier 体系、能力详情（输入/产出/消耗/回写）。
6. **我的页运营化**：邀请码、社群班级（上海 3 班）、服务老师微信、群二维码、档案工作台（4 分区 + 「当前最该补」排序）、订单流水。
7. **商业化四轨并行**：微信支付单次（¥29/39/49/99/199）、算力（80 算力/次）、积分（990/1990 兑换）、会员（钻石88）+ 免费额度（30 份/200MB/月）；所有付费动作过统一的**台账式确认弹层**（本次消耗/当前余额/扣后状态），余额不足有专门异常屏和降级路径。

## 3. 现状底子（为什么不用重写）

- **前端**：Taro 3.6（React+TS）小程序+H5 双端，五 tab + 16 个分包页全部真实接通后端；对话页双路 SSE 流式（逐 token / 成果卡分段渐显）、执行闭环（认可方案→拆军令→打卡→回填→复盘→段位）已服务端化并经真机验证；mock/server 双模式、`shared/contracts.d.ts` 三端契约 SSOT。
- **后端**：Fastify+Prisma+PostgreSQL 单体，57 个模型、161 个端点；LLM Gateway 支持 mock/Claude/OpenAI 兼容/Dify 四路由 + per-agent 接入覆盖 + 提示词缓存 + 工具循环；四本账本（决策/预言/复盘/进度）全部服务端统计（「数字禁止 AI 现编」铁律）；微信登录/支付 v3/订阅消息/钻石+token 双轨计量已就绪；集成测试 370+ 用例。
- **可直接复用到新原型的**：对话列表与聊天（≈90%）、执行页结构（≈80%）、报告中心（≈85%）、我的页骨架（≈70%）、战局页骨架（≈60%）。

## 4. 差距地图（按优先级分级）

| 级别 | 含义 | 条目 |
|---|---|---|
| **A · 视觉/文案对齐**（纯前端） | 改样式与文案，不动数据 | 贴底白条底栏；tab 命名（问策/军情/军令/锦囊/主公 → 对话/战局/执行/智库/我的，待拍板 D-1）；设计 token 补齐（tier 五色、进度条族、chip 族）；首跑引导弹层 |
| **B · 前端改造**（复用现有接口） | 新组件/新页面，后端基本不动 | 统一 PaySheet 台账弹层；异常屏三件套；报告全屏阅读器版式；军令同步屏；执行页复盘结果卡 |
| **C · 需后端建模**（本次主体工作量） | 新表 + 新接口 + 前端 | **智库三段整理管道**（最大单项）；三势结构化；军令字段扩展 + LLM 拆解升级；数据源状态持久化；模块/Skill 状态持久化；目标阶梯；跨域搜索；档案工作台聚合；提醒补全（09:00/周五）；邀请码与社群运营位 |
| **D · 需产品拍板**（见 §6） | 影响架构走向，先拍板再动工 | 积分体系去留；算力/钻石名词统一；tab 命名；数据源真实 OAuth 范围；单主题 vs 本命色；任务卡点击语义等 |

已对齐、无需动的：聊天流式与成果卡、认可方案→案卷军令动线、数据回填/复盘/账本、版本化报告与 diff、登录四通道、微信支付底座、会话未读点。

## 5. 迭代策略：4 批次 15 工单

**原则**：① 先壳后骨——视觉壳先行，让业务方尽快看到「像新原型」的版本；② 地基工单（PaySheet、SKU）先于依赖它的功能工单；③ 一切新增走加法（新表、可空列、新端点），不破坏线上旧版小程序的既有契约（AGENTS §11 发布约束）；④ 每个工单独立成 PR、独立可验收。

| 批次 | 工单 | 主题 | 规模 |
|---|---|---|---|
| **一 · 壳与视觉**（可并行） | V7-01 | 底栏白条化 + tab/IA 命名对齐 | M |
| | V7-02 | 设计 token 与视觉基线对齐 | S |
| | V7-03 | 全局弹层三件套（首跑引导 / PaySheet 台账 / 异常屏） | M |
| **二 · 判断→军令闭环** | V7-04 | 三势结构化 + 战局「认可判断」三态状态机 | L |
| | V7-05 | 军令字段扩展 + LLM 结构化拆军令 + 军令详情页 | M |
| | V7-09 | 报告中心对齐 +「同步为军令」动线 | S |
| | V7-10 | 目标阶梯结构化 | S |
| | V7-11 | 提醒体系补全（09:00 军令 / 周五周复盘 / 提醒日历页） | M |
| **三 · 智库与数据** | V7-06 | 智库三段式资料整理管道（可拆 3 个 PR） | XL |
| | V7-07 | 数据源状态持久化 + 授权流程屏 | M |
| | V7-08 | 能力/模块中心持久化 + 能力详情 | L |
| | V7-14 | 跨域搜索接口 | S |
| **四 · 商业化与运营** | V7-12 | 商业化四轨映射（SKU 单次付费 + 名词统一） | L |
| | V7-13 | 我的页对齐（邀请码 / 社群运营位 / 档案工作台） | M |
| | V7-15 | 会话协同披露 + 未读数强化（后置可选） | M |

依赖关系：V7-03 的 PaySheet 被 V7-06/08/12 复用；V7-12 的 SKU 是 V7-06「深度整理 ¥39」、V7-08「单次 ¥ 能力」的支付底座（先做的话可用 402 占位）；V7-04 先于 V7-09。其余工单相互独立可并行。

## 6. 需要产品拍板的 9 个问题（附建议默认值）

coding agent 将按「建议默认」执行，除非业务方在动工前另行拍板。

| # | 问题 | 建议默认 | 理由 |
|---|---|---|---|
| D-1 | tab 命名：代码现为「问策/军情/军令/锦囊/主公」，原型为「对话/战局/执行/智库/我的」 | **跟原型改回直白命名** | 原型代表业务方最新意志；AGENTS/README 文档口径本来就是后者 |
| D-2 | 原型是单一深绿主题；现有 6 套本命色主题 | **保留本命色系统，默认墨绿**（≈原型绿 #1E5A43） | 本命色是既有产品卖点（首登仪式/命理联动），且默认色与原型几乎一致，视觉不冲突、改造成本为零 |
| D-3 | 原型出现独立「积分」体系（1280 积分、990/1990 兑换、积分不足转微信支付） | **v1 不建独立积分**，兑换位统一由钻石（算力）承接 | 三种虚拟货币（钻石+token 额度+积分）并行会让计量、对账、退款复杂度翻倍；原型中积分仅用于兑换，钻石可完全覆盖该场景 |
| D-4 | 「算力」vs「钻石」名词：原型通篇叫算力（264 算力/80 算力/本月算力 64%），现有前端叫 💎 钻石 | **对外统一叫「算力」**，💎 图标保留；`CreditLedger`（钻石）对外展示为算力，token 月度额度对外展示为「本月算力」百分比 | 纯文案层映射，后端两轨计量结构不动 |
| D-5 | 单次付费定价（深度矛盾分析 ¥29 / 深度整理 ¥39 / 财务体检 ¥49 / IP 选题库 ¥99 / 店铺看板 ¥199 / 空间包 ¥19 / 免费额度 30 份/200MB/月） | 按原型数值入 SKU 表（运营后台可改） | 原型即最新报价；SKU 化后调价不发版 |
| D-6 | 数据源真实 OAuth（店铺/企微 CRM/广告后台）v1 范围 | **v1 只做状态持久化 + 「上传替代资料」动线**；真实 OAuth 预约登记、后置专项 | 每类 OAuth 都是独立采买/资质项目（AGENTS §13 已登记）；原型自己也把广告/CRM 授权演示为「必然失败→引导上传替代」 |
| D-7 | 执行页任务卡点击语义（原型 JS 里「开详情」与「勾选完成」两套交互冲突） | **卡身点击 = 开军令详情；右侧勾选框 = 打卡**（独立热区） | 原型 8 节已自注该歧义；现有代码勾选打卡已是独立热区，只需给卡身加详情跳转 |
| D-8 | 军师头像资产：原型用 qimen 雪碧图（7 位军师），现有 6 张 imagegen 立绘 | **沿用现有立绘**，第 7 位（个人成长军师·明止）是否新增 agent 由业务方确认后再补资产 | 头像是资产交付问题不是工程问题；避免阻塞 |
| D-9 | 「个人成长军师·明止」为新增角色（现无对应 agent） | v1 不新建 agent，对话列表暂不展示该行 | 新 agent 涉及提示词/计费/运营配置，应走运营后台既有流程单独立项 |

## 7. 规模与风险

- **总规模**：15 个工单 ≈ 13 个有效 PR 批次（V7-06 拆 3 个），后端新增约 5 张表 + 约 20 个端点，前端新增约 6 个页面/屏 + 3 个全局组件，其余为改造。
- **主要风险**：
  1. **智库管道（V7-06）是最大单项**，涉及知识库生命周期状态机、AI 分类、免费额度计量三件事叠加——已按「先管道后付费」拆分，付费深度整理可后置。
  2. **商业化改动（V7-12）触碰支付**——严格复用已验证的 `PaymentOrder` 幂等入账底座，只加 SKU 维度，不另起支付通道；所有改动必须带集成测试。
  3. **小程序真机回归**——底栏/弹层/键盘是历史踩坑重灾区，AGENTS §7.2 约束清单是不可回退红线，V7-01 要求逐条对照。
  4. **线上兼容**——所有 schema 变更为加法可空列，`/api` 既有响应契约不改，保证旧版小程序在审期间可用。

---

# 第二部分 · 给 coding agent 的执行规格

## 0. 全局执行约束（每个工单必须遵守）

1. **先读三份文档**：`AGENTS.md` §0（强制指令）+ §7.2（小程序工程约束清单，历史真机坑总账，**不可回退红线**）+ 本篇附录 A（原型阅读指引）。
2. **SSOT 先行**：任何接口字段/数据结构变化，先改 `shared/contracts.d.ts`，再改 server / app / admin 三端实现（AGENTS §0 #4）。
3. **mock 同口径**：`app/src/services/api.ts` 每个新方法必须有 `IS_MOCK` 分支，`app/src/services/mock.ts` 给确定性假数据，两模式同入参同返回类型（AGENTS §4）。
4. **schema 只做加法**：新表、可空列、新端点；不改既有列语义、不删字段、不改既有响应结构（线上旧版小程序兼容，AGENTS §11）。无 migrations 目录，schema 变更走 `prisma db push`；**生产禁止重跑 `db:seed`**，目录类数据同步用 `npm run admin:sync-content` / `npm run db:sync-plans` 的幂等 upsert 模式（新增目录同步逻辑照此模式写）。
5. **数字铁律**：一切展示给用户的统计数字（完整度/份数/强度%/余额/差值）由服务端计算下发，prompt 注入块写明禁止 AI 自算（参照 `DecisionLog`/`benchmarkBlock` 的做法）。
6. **LLM 结构化一律走 `structured()`**（`server/src/llm/gateway.ts`，Zod 校验 + 一轮修复 + 失败返 null 绝不伪造），mock/测试模式必须有确定性兜底；新增注入块接入 `services/context.ts` 的 `buildGenContext`（上下文注入总入口，AGENTS ✦ 工程摘要）。
7. **付费/额度门禁复用既有原语**：钻石走 `services/credits.ts`（reserve/charge/refund，advisory lock），token 走 `services/tokenQuota.ts`，权益走 `services/entitlements.ts`，支付走 `services/wechatPay.ts` + `PaymentOrder`（`markPaidAndApply` 幂等锚点）；不自造第二套。
8. **测试**：服务端改动补 `server/test/` 集成测试（Fastify inject 风格，参照 casefile/prescription 测试）；新增可隔离数据类型须在 TC-G 补跨用户不可见断言；改路由/鉴权/检索/上下文/数据模型后 `npm test` 全绿。
9. **构建基线**：`server` tsc 0 错；`app` `npm run build:weapp` 编译成功；`admin` tsc+vite build 通过（AGENTS §11）。改 `admin/` 需 `npm run lint:ui` 全绿。
10. **文案红线**：品牌一律「军师参谋部」（禁「米诺/Mino」）；前台商业文案克制（「可用/已启用/产出额度」，不写促销口吻）；费用展示口径见 V7-12。
11. **文档回写**：每个工单完成时更新 `AGENTS.md` 对应章节 + `docs/CHANGELOG.md` 顶部一条；里程碑级同步 Notion 变更日志。
12. **全屏弹层**记 `store.setOverlay(open, key)`；H5 token 双写 `app.h5.scss`；主题类显式覆盖业务 token（AGENTS §7.2）。

**建议 PR 顺序与依赖图**：

```
批次一（并行）: V7-01  V7-02  V7-03
批次二:        V7-04 → V7-09        V7-05   V7-10   V7-11
批次三:        V7-06(a→b→c)  V7-07  V7-14   V7-08 ←(单次¥位依赖 V7-12，可先 402 占位)
批次四:        V7-12 → V7-08收尾/V7-06c   V7-13   V7-15(后置可选)
共用地基: V7-03 的 PaySheet 组件被 V7-06/08/12 复用。
```

---

## V7-01 · 底栏白条化 + tab/IA 命名对齐

**对应差距**：A 级。原型底栏 = 贴底白条 82px + 顶部细分割线 + 轻毛玻璃 + 5 个 SVG 线性图标 + 11px 文字，选中态深绿；README「视觉方向」早已声明此方向。tab 命名按 D-1 拍板默认改回「对话/战局/执行/智库/我的」。**规模 M（纯前端）**。

### 改动点
1. `app/src/custom-tab-bar/index.tsx` + `index.scss`：悬浮胶囊 → 贴底白条（白底、上边框 `--line`、`backdrop-filter` 轻毛玻璃、底部安全区 padding）；选中态用 `--green`（派生自 `--accent`，保持本命色联动，D-2）。**不得动** `hideNativeTabBarOnly()`/overlay 同步机制（§7.2 铁律：原生 tabbar 只隐藏不恢复、弹层不进 custom-tab-bar、不用轮询）。
2. `app/src/app.tsx`/`app.h5.tsx` + `app.h5.scss`：H5 侧同一组件复用，底栏留白 token（`tabbar-space`）随高度变化同步调整，H5 双写。
3. **命名 sweep**：`app/src/app.config.ts`（tabBar list 文案）、五个 tab 页 `tab-page-head` 标题与副题、`app/src/data/council.ts`/`emptyStates.ts`/`operatingSystem.ts` 中出现的「问策/军情/军令(作为 tab 名时)/锦囊/主公」引用文案。注意：**「军令」作为任务实体名保留**（对齐 WO-01 名词表：案卷/方案/军令/资料），只有 tab 名改「执行」。页头副题按原型：对话=「军师参谋室 · 像微信一样管理会话」等（见原型 messages-head/各页 header）。
4. 顺手把设计事实源固化：将 `ai-pilot-temp/design/junshi-miniapp-effect.html` + `design/assets/` 复制到本仓库 `project/v7-effect/`（作为设计溯源，勿改），并在 `IMPLEMENTATION.md` 顶部登记。

### 验收
- 真机（或 DevTools 模拟器）五 tab 白条渲染正确、切换正常；打开任一全屏弹层（登录/色盘/@引用选择器）底栏正确隐藏与恢复；H5 同步。
- `grep -r "问策\|军情\|锦囊\|主公" app/src` 仅剩注释/历史 CHANGELOG 引用。
- `npm run build:weapp` 编译成功。

---

## V7-02 · 设计 token 与视觉基线对齐

**对应差距**：A 级。原型 token 与现有 `app.scss` 高度同源（--bg/--paper/--ink 三级/--line 完全一致，--green #1E5A43=现墨绿），差异在补充色与组件族。**规模 S（纯前端）**。

### 改动点
1. `app/src/app.scss` `page {}` 补 token（对照附录 C）：`--surface-2 #F3F1EA`、`--gold-deep #6F5420`、`--blue #245f88`（算力 tier 色）、字重 token（serif-title 700 / sans-strong 700 / sans-medium 650）。
2. 补全局组件类（对照原型通用模式）：五色 `tier-badge`（free 绿/paid 金/power 蓝/member 黑/points 金）、状态 `state-pill`（正常绿/warn 金/miss 红）、进度条族（5/7/9px 三档、999px 圆角、绿/warn/danger 变体）、左色条卡（军令金色 4px / 任务绿红）、勾选框（27px 圆角方框，done 绿底白勾）、字距 kicker 类（letter-spacing .14em）。
3. 三处同步铁律：`.theme-*` 六主题块显式覆盖新增业务 token；`app.h5.scss` `:root` 双写。
4. 本工单**不重排任何页面**，只提供 token 与公共类，供后续工单消费。

### 验收
- 六套本命色主题下新增 token 均有显式值（真机不吃链式 var）；H5 与 weapp 视觉一致；构建绿。

---

## V7-03 · 全局弹层三件套：首跑引导 / PaySheet 台账 / 异常屏

**对应差距**：A/B 级。原型的 `onboardSheet`（首跑 4 步引导）、`paySheet`（台账式付费确认：本次消耗/当前余额/扣后状态三行 + 场景化按钮文案）、异常屏（上传失败/算力不足/积分不足三类 + 统一四格说明）是贯穿全站的通用件。**规模 M（前端为主）**。

### 契约
无新接口。余额数据来自既有 `GET /me`（token 额度）与 `GET /me/credits`（钻石流水+余额）。

### 改动点
1. **`components/PaySheet`**（新）：props `{ mode: 'credits'|'sku'|'member'|'quota', title, desc, costLabel, costValue, balanceValue, afterValue, confirmText, onConfirm, onCancel }`；渲染 kicker + 标题 + 描述 + 三行 ledger + 结果说明 + 双按钮（「先不启用」/确认）；底部 sheet 形态、`pay-rise` 入场、遮罩模糊；打开记 `store.setOverlay(true,'paysheet')`。**接管现有付费确认场景**：`AgentUnlock`（智能体解锁）、`Plans`（套餐）保持现组件，新场景（模块启用/深度整理/空间包，V7-06/08/12）一律用 PaySheet。
2. **`components/ExceptionSheet`**（新）：三 kind——`upload`（格式不支持/超 30MB）、`power`（算力不足 → 主按钮跳套餐/算力购买）、`points→sku`（按 D-3 改为：算力不足时提供「改用微信支付 ¥N」备选，接 V7-12）；统一四格（下一步/保留状态/服务老师/「不会直接扣费」）。
3. **`components/OnboardSheet`**（新）：首登建档完成后自动弹一次（storage 标记 `junshi.onboard.v7.<token>`）；4 步文案照原型（建案卷-对话 / 上传资料-待整理区 / 看战局判断 / 生成军令复盘）；「开始上传资料」→ `switchTab` 智库 + 定位案卷资产分区。挂载点：`pages/sessions`（启动页）。
4. 上传前端校验统一抽 `services/uploadGuard.ts`：>30MB 或可执行扩展名 → ExceptionSheet(upload)（供 chat 加号上传与 V7-06 智库上传共用）。

### 验收
- mock 模式全流程可走查（余额来自 mock）；三弹层 overlay 登记/清理正确（切 tab 底栏恢复）；构建绿。

---

## V7-04 · 三势结构化 + 战局「认可判断」三态状态机

**对应差距**：C 级（AGENTS §13.7「三势判断结构化」+ 原型 battle-cta 状态机）。现状：三势卡是方法框架+发起对话，市势/人势靠报告标题关键词反查（`pages/home` 自注脆弱）；「认可方案」只能从对话成果卡触发。**规模 L**。

### 契约（`shared/contracts.d.ts`）
```ts
export interface ForceView {
  kind: 'sky' | 'market' | 'people';        // 天势/市势/人势
  level: 'strong' | 'mid' | 'weak';
  conclusion: string;                        // 一句结论，如「行业上行」
  tactic: string;                            // 打法，如「可以借势」
  tacticTone: 'ok' | 'warn' | 'danger';
  note: string;                              // 一句说明
  strength: number;                          // 0-100，服务端产出，前端渲染进度条
}
// UnderstandingView（挂 /me.understanding）增可选字段：
//   forces?: ForceView[];  forcesUpdatedAt?: string;
export interface BattleCommitResult {
  casefile: DossierState;                    // 复用既有案卷视图类型
  reportId: string; reportSlug: string; libraryId: string;
}
```

### 服务端
1. **新 service `server/src/services/forces.ts`**：`generateForces(userId)` —— 输入=战略档案 + 企业档案 + 最新案卷判断 + 行业包 + （有命盘时）天势简报；走 `structured()`（Zod：3 条 ForceView，strength 由代码按 level 映射区间 + 基准修正，**不让 LLM 直接编百分比**——level→基线 {strong:75, mid:50, weak:32}，行业基准/回填趋势各 ±5 修正，修正逻辑纯代码）；落 `StrategicProfile.forcesJson`（schema 已有 forces 预留字段，确认字段名后复用，不加新列）；mock 确定性兜底（按行业包派生固定三条）。刷新时机：认可方案时（casefile accept hook）+ 手动刷新端点。
2. **新端点**（`routes/`）：`POST /forces/refresh`（用户态，限频每日 3 次，额度门禁 `reserveQuota`）；`GET /me` 的 understanding 装配处（`services/understanding.ts`）带出 `forces`。
3. **新端点 `POST /battle/commit`**（用户态）：战局页「认可判断→生成军令与报告」一键动线。服务端串既有能力：取当前 understanding 判断与案卷上下文 → `generateDeliverable`（agentKey=general，deliverableKey=战略方案）→ 复用 `services/casefile.ts` accept 逻辑建案卷/拆军令 → 复用 `routes/library` 存库桥接版本化报告 → 返回 `BattleCommitResult`。额度门禁与 `/generate-sync` 同口径（`assertPlanActive` + `reserveQuota`）。幂等：同用户 5 分钟内重复 commit 返回上次结果（缓存 `services/cache.ts`）。
4. 注入：forces 摘要并入【战略档案】注入块（一行「三势：天势强/市势中/人势弱」），禁自算口径照旧。

### 前端
1. `pages/home`：三势卡改真实渲染（势名+强弱 serif、结论、彩色打法 em、说明、强度条），**删除标题关键词反查逻辑**；整卡点开三势全解详情（新半屏 sheet，列三条+合参结论）；无 forces 时保留现有引导态（emptyStates）。
2. battle-cta 三态状态机：初始「认可判断 → 生成军令与报告」→ 点击调 `POST /battle/commit`（期间「正在生成军令与报告…」，按钮锁定）→ 成功「已生成 → 查看军令与报告 ✓」（点击 `switchTab` 执行页）；失败按 `handleApiError` 分型（402 → PaySheet/ExceptionSheet）。有 active 案卷且今日已 commit 过时直接渲染完成态。
3. mock：`mock.ts` 补 forces 与 battleCommit 确定性实现。

### 验收
- 集成测试：`forces.test.ts`（生成→落库→/me 带出→strength 在映射区间内；mock 确定性）+ `battleCommit.test.ts`（commit → 案卷/军令/报告/方案库四处落库 + 幂等 + 未登录 401 + 额度不足 402）。
- 前端 H5 走查：战局页三势真实渲染 → CTA 三态 → 跳执行页看到新军令。

---

## V7-05 · 军令字段扩展 + LLM 结构化拆军令 + 军令详情页

**对应差距**：C 级（README 已描述负责人/截止/耗时但模型无此字段；AGENTS §13.5.1 拆军令 LLM 升级是既有 TODO；原型军令详情屏）。**规模 M**。

### 契约
`DossierOrder`（前端）/ 相应服务端视图增可选字段：`ownerName?: string; dueAt?: string; etaMinutes?: number; sourceQuote?: string; steps?: string[]; metrics?: { label: string; value: string }[]; actionType?: 'upload'|'backfill'|'review'|'topics'|'none'`。

### 服务端
1. `prisma/schema.prisma`：`CasefileOrder` 加可空列 `ownerName dueAt etaMinutes sourceQuote stepsJson metricsJson actionType`（全部加法）。
2. `services/casefile.ts` 拆军令升级：现分节启发式提取 → **`structured()` LLM 结构化拆解**（Zod：军令数组，每条含 text/tag/owner/due/eta/actionType/steps≤3/metrics≤3/sourceQuote + aligned 逐条布尔）；LLM 不可用（mock/test）时**保留现启发式并给确定性缺省**（owner=用户称呼、actionType 按 tag 映射：补资料→upload、数据→backfill、复盘→review，其余 none）；幂等口径不变（同案卷+同日+标准化文本）。
3. `/casefile*` 响应带出新字段（`GET /casefile`、accept、orders CRUD）。

### 前端
1. `pages/studio` 任务卡：补 meta chip 行（负责人/截止/预计耗时，缺省不渲染）；**点击语义按 D-7**：卡身 → 军令详情，勾选框独立打卡热区（现有乐观更新不动）。
2. **新分包页 `packages/work/command`**（军令详情）：编号+badge+serif 标题+描述 → source 来源引用块（3px 绿左边框）→ 3 步骤（准备/处理/回写）→ 3 组指标对 → 「下一步动作」卡按 `actionType` 路由：upload→智库上传、backfill→回填面板（跳 studio 复盘 seg）、topics→智库能力分区、review→发起复盘。`app.config.ts` 注册 + studio 预加载。
3. mock 同口径。

### 验收
- 集成测试：accept 后军令带结构化字段（mock 缺省口径断言）、aligned 逐条落库；旧军令（无新字段）接口兼容。
- H5 走查：任务卡 chips 渲染、详情页四段齐全、actionType 四路由可达。

---

## V7-06 · 智库三段式资料整理管道（XL，拆 3 个 PR）

**对应差距**：C 级最大项（AGENTS §13.5.4 PR-20 未开工 + §13.5.5 AI 自动分类未实现；原型智库 assets 面板全部）。现状：`KnowledgeItem` 上传即入库（parsing→embedding→ready），无 staging 概念；AI 分类 8 类文件夹为框架展示。

**产品语义**：上传 → **待整理区**（staging，不进检索）→ AI 粗分（batch organize：识别来源/去重/按案卷目标分类）→ （可选付费）深度整理 → **已优化**（optimized，等确认）→ 用户确认 → **知识库**（confirmed，嵌入并可被军师引用）。

### 契约
```ts
export type KnowledgeStage = 'staging' | 'optimized' | 'confirmed';
export interface KnowledgePipelineView {
  counts: { staging: number; optimized: number; confirmed: number };
  quota: { usedDocs: number; freeDocs: number; usedBytes: number; freeBytes: number };
  folders: { key: string; label: string; count: number; stage: KnowledgeStage }[]; // AI 分类文件夹（真实计数）
  batches: { id: string; count: number; status: 'uploaded'|'organizing'|'organized'; typeStats: {label:string;count:number}[] }[];
}
// KnowledgeItemT 增：stage?: KnowledgeStage; bizCategory?: string; batchId?: string; dupOfId?: string;
```

### PR-a（模型与管道骨架）
1. schema：`KnowledgeItem` 加可空列 `stage`（默认 `'confirmed'`，**存量数据零迁移**）、`bizCategory`、`batchId`、`dupOfId`、`sizeBytes`。
2. `POST /knowledge/upload` 加可选参数 `staged=true`（智库上传走 staging；chat 内上传维持现状直入库，避免破坏既有动线）；staging 条目**不做切片嵌入**（省成本），只 docParse 存文本。
3. 新端点：`GET /knowledge/pipeline`（KnowledgePipelineView，全部服务端计数）；`POST /knowledge/confirm`（body `{ids?|batchId?}`，optimized/staging → confirmed，**此时才走 `ingestKnowledge` 切片嵌入**，批量、幂等）；`DELETE` 复用既有。
4. 业务分类目录：`server/src/data/bizCategories.ts`（8 类：企业档案/老板档案/财务经营/内容IP/增长资料/客户问答/案例证明/待识别；key+label+提示词描述），作为分类唯一真相源。

### PR-b（AI 粗分与整理动线）
1. 新端点 `POST /knowledge/organize`（body `{batchId}`，用户态，限频）：对批次内 staging 条目跑——① 规则去重（同名+同大小 → 标 `dupOfId`）；② `structured()` 逐条/分批归类到 bizCategories（Zod 枚举约束；mock 按扩展名/文件名关键词确定性归类）；③ 产出摘要标签写 `summary`；完成后条目置 `optimized`。同步返回归类统计（原型 organized-row 四行）。长批次（>20 份）转异步：立即返回 `organizing`，前端轮询 pipeline。
2. 「深度整理」入口：`POST /knowledge/deep-organize` —— v1 仅做门禁占位：校验 SKU 支付（V7-12 完成前一律 402 `SKU_REQUIRED`），前端接 PaySheet。真实深度整理（LLM 去重合并/提炼问题/补标签）后置专项。

### PR-c（前端 + 额度）
1. `pages/thinktank` assets 面板重做（对照原型）：额度三小卡（`quota` 数据：X/30 免费额度、剩余空间、深度整理入口）→ 三步 seg（1 待整理 / 2 已优化 N / 3 知识库 N）→ 待整理=上传区（复用 uploadGuard）+ 上传后文件堆（≤6 平铺 / >6 折叠 / >30 类型文件夹总览，阈值照原型）+ `资料整理` 按钮 → 4 步处理动画（轮询 organize 状态）→ 归类结果行；已优化=asset-list + 大按钮「确认优化后的资料 → 写入知识库」（调 confirm）；知识库=文件夹网格（**真实计数**，替换现框架展示）+「同步知识库 → 刷新战局判断」（调 V7-04 `POST /forces/refresh`）。
2. 免费额度计量：`services/quota`（server）按月统计 confirmed+staging 文档数与字节数，上限从 Plan.featuresJson 读（缺省 30 份/200MB，D-5）；超限上传返 402 `KNOWLEDGE_QUOTA` → 前端 PaySheet（空间包 SKU，V7-12）。
3. mock：pipeline/organize/confirm 全套确定性实现（本地 storage）。

### 验收
- 集成测试：staging 不出现在 `hybridSearch` 与 `/knowledge/search` 结果（**关键隔离断言**）；organize 归类落 bizCategory + 去重标记；confirm 后才有 chunk 嵌入且可被检索命中；额度超限 402；跨用户不可见（TC-G 补）。
- H5 + 真机走查：上传 7 个文件（触发折叠档）→ 整理 → 确认入库 → 战局刷新全链路。

---

## V7-07 · 数据源状态持久化 + 授权流程屏

**对应差距**：C 级（AGENTS §13.5「数据源授权绑定」；原型 data 面板 6 类状态机 + 授权四态流程屏）。范围按 D-6：**只做状态持久化与上传替代动线，真实 OAuth 预约登记**。**规模 M**。

### 契约
```ts
export type DataSourceStatus = 'unbound' | 'auth_requested' | 'uploaded' | 'bound';
export interface DataSourceView {
  key: string; label: string; desc: string; icon: string;
  scope: string[];                    // 读取范围 chips
  tier: 'basic' | 'advanced';        // 企微CRM/广告=advanced
  status: DataSourceStatus; statusLabel: string; updatedAt?: string;
}
```

### 服务端
1. 目录真相源：`server/src/data/dataSources.ts`（6 基础类：内容账号/客户私域/店铺经营/成交漏斗/财务经营/服务交付 + 2 高级：企微 CRM/广告后台；字段照原型 scope 清单）。
2. schema：新表 `UserDataSource`（`userId, tenantId, sourceKey, status, method('upload'|'oauth'), metaJson, createdAt, updatedAt`，`@@unique([userId, sourceKey])`）。
3. 新端点：`GET /data-sources`（目录+用户状态合并为 DataSourceView[]）；`POST /data-sources/:key/upload`（multipart 或引用已上传 knowledgeId：转 V7-06 staging 上传 + 状态置 `uploaded`）；`POST /data-sources/:key/request-auth`（登记 `auth_requested` + 审计 `datasource.auth.requested`，供运营跟进）。
4. 注入：已接入数据源清单一行并入【客户档案】注入块（军师知道有什么证据可要）。

### 前端
1. `pages/thinktank` data 面板重做：hero 三指标（已绑定/待补关键项/来源类数，服务端算）+ 三 subtabs（经营来源 6 卡带状态 pill / 待补优先（按 status+nextQuestions 派生）/ 高级授权）；数据源卡 → 详情屏（授权范围/同步频率/回写位置/隐私控制四宫格）→ 「去绑定」：upload 路径走真实上传（成功态照原型 SUCCESS 屏），oauth 路径 → request-auth 登记 + 「已预约开通，服务老师会联系你」提示（**不做假授权动画**）。
2. `packages/work/bindings` 旧引导页改为跳转新面板（或直接下线入口，保留路由重定向）。
3. mock 同口径。

### 验收
- 集成测试：状态机流转（unbound→uploaded/auth_requested）、`@@unique` 幂等、跨用户隔离、上传联动 knowledge staging。
- 走查：6 卡状态渲染、上传替代动线全通、高级授权登记后状态变化。

---

## V7-08 · 能力/模块中心持久化 + 能力详情

**对应差距**：C 级（AGENTS §13.5「模块/Skill 状态持久化 UserModule」；原型 modules 面板：推荐位 + 免费/深度/模块三组 + 五色 tier + 能力详情屏）。**规模 L**。

### 契约
```ts
export type ModuleTier = 'free' | 'sku' | 'credits' | 'member';
export interface ModuleView {
  key: string; label: string; desc: string; iconChar: string;
  group: 'free' | 'deep' | 'member';
  tier: ModuleTier;
  price?: { skuKey?: string; priceFen?: number; credits?: number; planRequired?: boolean };
  stateLabel: string;                    // 「默认启用 / 可直接调用 / ¥29 启用 / 消耗80算力 / 会员可用 / 已启用」
  enabled: boolean; hidden: boolean; sortOrder: number;
  detail: { scene: string; input: string; output: string; cost: string; writeback: string };
  agentKey?: string;                     // 调用承接的军师
}
```

### 服务端
1. 目录真相源下沉服务端：`server/src/data/modules.ts`（把 `app/src/data/operatingSystem.ts` 的 SKILL/MODULE 目录迁为服务端唯一真相，含 tier/定价/detail/承接 agentKey；条目对照原型清单：三势初判、矛盾初筛、深度矛盾分析 ¥29、增长漏斗诊断 80 算力、IP 内容引擎(会员)、财务经营体检 ¥49、每日军令(free)、IP 选题库高级版 ¥99、店铺数据看板 ¥199、周复盘增强(会员)）。定价可被 admin 覆盖（后置，v1 代码目录即真相 + `admin:sync-content` 模式预留）。
2. schema：新表 `UserModule`（`userId, tenantId, moduleKey, enabled, hidden, sortOrder, source('free'|'purchase'|'admin'), createdAt`，`@@unique([userId, moduleKey])`）。
3. 新端点：`GET /modules`（目录+用户状态合并；`recommended` 字段由服务端按案卷/journey 规则选 1 条——纯规则：有案卷缺回填→增长漏斗诊断，其余按 journey 阶段映射，不走 LLM）；`POST /modules/:key/enable`——tier 分流：free 直启；credits 走 `services/credits.ts` 扣减（PaySheet 确认在前端）；sku 校验 V7-12 SKU 已购（未购 402 `SKU_REQUIRED` 带 skuKey）；member 校验 `assertPlanActive` + plan features；`PATCH /modules/:key`（hidden/sortOrder，我的页模块管理用）。
4. 战局页关联模块（V7-04 页面内）与执行页「关联 IP 内容引擎」等文案位改读真实 ModuleView 状态。

### 前端
1. `pages/thinktank` modules 面板重做：hero+三统计 → 四 subtabs（推荐/免费/深度/模块）→ skill 卡（icon 字 + tier-badge + module-state pill）→ **能力详情屏**（半屏 sheet：使用场景 + 输入/产出/消耗三格 + 回写位置/启用确认/后续影响 outline）→ 免费「立即调用」跳承接军师对话（带 send 参数）；付费「查看启用方式」→ PaySheet（credits）或 SKU 支付（V7-12）。
2. `packages/work/market` 改造为消费 `GET /modules`（保留处方落地 `from=prescription` 逻辑不动）；`pages/profile` 模块管理接 PATCH（隐藏/排序）。
3. `app/src/data/operatingSystem.ts` 中被迁移的目录段标记 deprecated 并改为从 api 取（mock 分支内嵌同一份目录数据保持零后端可用）。

### 验收
- 集成测试：enable 三 tier 分流（free 幂等/credits 扣减与退款路径/sku 未购 402/member 过期 403）、hidden/sort 持久化、跨用户隔离。
- 走查：推荐位、四分组、详情屏、启用后状态即时更新、我的页模块管理联动。

---

## V7-09 · 报告中心对齐 +「同步为军令」动线

**对应差距**：B 级（原型 reports 面板状态化 + 全屏阅读器版式 + 军令同步屏）。后端能力已齐（版本化报告 + accept 拆军令）。**规模 S（纯前端为主）**。

### 改动点
1. `pages/thinktank` reports 面板：报告行带状态（待生成/生成中/查看——「战局军令与报告」行状态与 V7-04 commit 状态联动，读 journey/casefile 派生）。
2. `packages/work/report` 阅读器版式对齐原型：深绿封面卡（类别+serif 标题+摘要）→ 引用块 → 编号章节（一/二/三/四）；数据即现有 ReportVersionContent，纯样式改造。
3. 底部主按钮「同步为军令」：调既有 `services/dossier.acceptDeliverable`（报告→deliverable 桥接已有 `reportId`），成功后展示**军令同步屏**（新半屏 sheet：✓ hero + 报告→军令→复盘三步流 + 新增军令列表（点击进 V7-05 军令详情）+ 影响 chips）→「去执行」switchTab。已同步过的报告按钮显示「已同步 → 查看军令」。
4. mock 同口径。

### 验收
- 走查：报告列表状态流转、阅读器版式、同步为军令 → 执行页可见新军令；重复同步幂等（依赖 casefile 既有幂等口径）。

---

## V7-10 · 目标阶梯结构化

**对应差距**：C 级（AGENTS §13.5「目标阶梯无结构化存储」；原型 4 格带真实指标）。**规模 S**。

### 契约
```ts
export interface GoalLadder { longTerm?: string; annual?: string; quarterly?: string; weekly?: string; updatedAt?: string; }
// DossierState 增：goals?: GoalLadder
```

### 改动点
1. schema：`Casefile` 加可空列 `goalsJson`。
2. 服务端：`PUT /casefile/goals`（局部更新，手动编辑）；`services/casefile.ts` accept 时从成果分节尝试结构化抽取（`structured()`，抽不出留空，**不编造**）；`GET /casefile` 带出；goals 并入【战略档案】注入块（一行）。
3. 前端：`pages/studio` 目标阶梯 4 格——有值真实渲染（3-5年/年度/季度/本周），空格显示「＋ 补目标」进编辑（inline 弹层，PUT）；整体点击保留现有拆解对话入口（对话产出后 accept 回写）。
4. mock 同口径。

### 验收
- 集成测试：goals CRUD + accept 抽取（mock 下确定性）+ 注入块包含 goals 行。

---

## V7-11 · 提醒体系补全

**对应差距**：C 级（AGENTS §13.5「09:00 军令提醒、周五周复盘、日历视图待建」；原型提醒节奏卡 18:00/20:30/周五 + 我的页「提醒与日历」现为 toast 占位）。**规模 M**。

### 改动点
1. **服务端 scheduler**（`services/scheduler.ts` 注册制，照 `daily-review-reminder` 模式）加两个 job：
   - `morning-order-reminder`：服务端本地时间 `ORDER_REMINDER_HOUR`(默认 9) 后，有 active 案卷且今日有未完成军令、当日未发过、有订阅额度 → 发订阅消息（新模板 env `WECHAT_SUBSCRIBE_ORDER_TEMPLATE_ID`，字段对齐 review 模板三段式）；按用户按天幂等。
   - `weekly-review-reminder`：周五 `WEEK_REVIEW_REMINDER_HOUR`(默认 17) 后，本周有军令记录且未做 week 层复盘 → 发复盘提醒（复用 review 模板）。
2. `GET /reminders`（新，用户态）：聚合派生「提醒日历」视图——今日军令截止（军令 dueAt）、20:30 复盘、周五周复盘、订阅状态；纯读派生不建表。
3. **前端**：`pages/profile`「提醒与日历」替换 toast 占位 → 新分包页 `packages/work/reminders`（提醒列表 + 逐条订阅授权按钮，复用 `services/wechatSubscribe.ts`）；`pages/studio` 提醒节奏卡与 exec-nav「提醒」按钮读同一接口。
4. `.env.example` 补新模板 env；未配模板静默跳过（照既有口径）。

### 验收
- 集成测试：两个 job 幂等触发条件（用 `x-test-now` 时间旅行）+ `/reminders` 派生正确。
- 走查：提醒页真实数据、订阅授权动线。

---

## V7-12 · 商业化四轨映射（SKU 单次付费 + 名词统一）

**对应差距**：C/D 级（原型四轨计价 vs 现有钻石+token+套餐）。按 D-3/D-4/D-5 拍板默认执行：**不建积分**；对外名词统一「算力」；单次 ¥ 走 SKU。**规模 L，触碰支付，测试必须全绿**。

### 契约
```ts
export interface SkuView { key: string; name: string; desc: string; priceFen: number; kind: 'module' | 'service' | 'storage'; grantsModuleKey?: string; }
export interface SkuOrderResult { orderId: string; payParams?: WechatPayParams; demo?: boolean; }
```

### 服务端
1. schema：新表 `Sku`（`key @unique, name, desc, priceFen, kind, grantsModuleKey?, enabled, sort`）+ `PaymentOrder` 加可空列 `skuKey`（现有 planId 流程不动）。
2. Seed/同步：`data/seedConfig.ts` 补 SKU 目录（D-5 定价：deep-organize ¥39 / storage-2g ¥19 / deep-contradiction ¥29 / fin-checkup ¥49 / ip-topics-pro ¥99 / shop-dashboard ¥199），`admin:sync-content` 幂等 upsert。
3. 新端点：`GET /skus`（公开）；`POST /skus/:key/order`（用户态，微信 JSAPI 下单，复用 `services/wechatPay.createJsapiOrder`，订单挂 skuKey）；回调 `markPaidAndApply` 扩展：`skuKey` 存在时发放对应权益——`grantsModuleKey` → upsert `UserModule(source='purchase')`；`kind='storage'` → 用户配额加档（`Profile.extraJson.storageBonus` 或独立列，选 extraJson 免加列）；`kind='service'`（深度整理）→ 写一次性服务凭据（`Prescription` 不合适，用 `CreditLedger` 备注型记账 + `UserModule` 一次性态，实现取简：`UserModule(moduleKey='sku:'+key, source='purchase')` 记已购）。**幂等复用 `appliedAt` 锚点，同一事务发放**。沙箱回调（`/pay/sandbox/notify`）同步支持 sku 订单，`pay-e2e` 扩一段 sku 冒烟。
4. `POST /knowledge/deep-organize`（V7-06b 的 402 占位）接通：校验 sku 已购 → 执行（v1 = organize 加强版：额外跑 LLM 摘要+标签）→ 核销一次性凭据。
5. **名词统一（文案层）**：前端所有「钻石」对外文案 → 「算力」（`services/format.ts` 的 💎 口径函数集中改），`GET /me/credits` 响应结构不动；「本月额度」→「本月算力」。契约/后端技术术语（credits/CreditLedger）不改。

### 前端
1. PaySheet 接 SKU：mode='sku' 时确认 → `POST /skus/:key/order` → `Taro.requestPayment`（复用 `Plans` 组件的支付调用模式）→ 成功回调后刷新对应状态（模块启用/配额/深度整理可用）。
2. `packages/work/credits` 订单流水页合并展示 SKU 订单（`GET /me/credits` + 新 `GET /orders`？——**从简**：SKU 购买在 CreditLedger 写 0 额变动的备注行，流水页零改造即可见；不加新端点）。
3. ExceptionSheet「算力不足」备选路径接 SKU（「改用微信支付 ¥N」）。
4. mock：sku 目录 + 假支付成功流。

### 验收
- 集成测试：sku 下单→沙箱回调→权益发放（module/storage/service 三 kind）→ 重复回调幂等（发放仅一次）→ 未配支付 501/演示门控；`pay-e2e` sku 段 PASS。
- `grep` 前台无「钻石」残留文案（技术标识除外）。

---

## V7-13 · 我的页对齐（邀请码 / 社群运营位 / 档案工作台）

**对应差距**：C 级（原型账户卡+档案工作台；AGENTS §13.5「社群/分班需运营后台+后端支持」）。**规模 M**。

### 服务端
1. schema：`User` 加可空列 `inviteCode @unique`（首次读取时惰性生成：`JS` + 4 位 base32）；新表 `ServiceAssignment`（`userId @unique, teacherName, teacherWechat, className, groupQrUrl, taskDone, taskTotal, note, updatedAt`）。
2. 端点：`GET /me` 带出 `inviteCode` 与 `service`（ServiceAssignment 视图，可空）；admin 简版 CRUD `GET/PUT /admin/users/:id/service`（运营手工分班/配老师，admin 前端加在用户详情面板一段表单）。
3. 群二维码图走既有 OSS 上传（admin 代传）。

### 前端
1. `pages/profile` 账户卡对齐原型：姓名 + meta 三行（手机脱敏/班级·服务中/邀请码金字）+ member-pill（套餐名）→ 权益 strip 三格（本月算力 % / 深度报告次数（读 plan features，无则隐藏）/ 案卷完整度）→ 双按钮「服务老师微信」（详情：微信号 + 复制按钮）/「群二维码」（详情：二维码图 + 班级 + 入群任务 x/y + 有效期文案）。无 ServiceAssignment 时双按钮显示「待分配」空态（emptyStates 引导）。
2. **档案工作台**：`pages/brief` 强化或新增分包页（推荐改造 brief）：完整度进度条（understanding.maturity）+ 4 档案分区卡（老板档案/企业档案/产品服务/财务经营——**份数=V7-06 bizCategory 真实计数**，待补状态=无条目）+「当前最该补」排序列表（数据= understanding.nextQuestions 前 3，各带「去补」→ 智库上传或访谈对话）。
3. `packages/work/community` 接 ServiceAssignment 真实数据（有则展示、无则保留引导态）。
4. mock 同口径。

### 验收
- 集成测试：inviteCode 惰性生成唯一性、ServiceAssignment CRUD + 跨用户隔离、/me 视图。
- 走查：账户卡三态（无套餐/有套餐/有分班）、档案工作台计数真实。

---

## V7-14 · 跨域搜索接口

**对应差距**：C 级（AGENTS §13.5.10；原型搜索占位「搜索军师、案卷、报告或资料」）。**规模 S**。

### 契约
```ts
export interface SearchHit { kind: 'agent'|'session'|'report'|'knowledge'; id: string; title: string; snippet: string; route: string; }
export interface SearchResult { q: string; hits: SearchHit[]; }
```

### 改动点
1. 新端点 `GET /search?q=`（用户态）：聚合——agents（内存过滤注册表 name/role）、sessions（title/摘要 `contains` 查询，limit 5）、reports（ReportDoc title contains，limit 5）、knowledge（复用 `hybridSearch` topK 5，只搜 confirmed）；每类带 route（前端跳转路径由前端映射，服务端只给 kind+id）；租户隔离照旧。
2. 前端 `pages/sessions` 搜索 pill：server 模式 300ms 防抖调 `/search`，分组渲染结果（军师/会话/方案/资料），点击各自路由；mock 模式保留本地过滤。
3. 集成测试：四域命中 + 跨用户不可见 + staging 资料不出现在结果。

---

## V7-15 · 会话协同披露 + 未读数强化（后置可选）

**对应差距**：原型 sys-card「军师已同步内部判断」与未读数字 badge；完整的总军师自动派单引擎（AGENTS §13.5.6 consult_specialist）是独立大项目，**本工单只做展示层与最小落库，派单引擎另行立项**。**规模 M，批次四末位，可裁剪**。

### 改动点
1. 未读数字：`GET /sessions` 的 `hasUnread` 升级为 `unreadCount`（自 lastReadAt 起 assistant 消息计数，服务端算；契约加可选字段，`hasUnread` 保留兼容）；前端列表行红点 → 数字 badge。
2. sys-card：`Message` 已有 role 枚举扩展空间——新增 `role='system'` 消息类型（契约 `SessionMessage.role` 加 'system'）；服务端在 `battle/commit`（V7-04）与跨军师「派单」动作（chat 现有协同导轨）时向目标会话写一条 system 消息（「军师已同步内部判断：…」摘要一句）；前端 chat 渲染 sys-card 样式（居中窄卡）。
3. 集成测试：unreadCount 计数与置读、system 消息落库与渲染契约。

---

## 附录 A · 原型阅读指引（coding agent 必读）

1. **唯一基准**是 `design/junshi-miniapp-effect.html`（复制入本仓库 `project/v7-effect/` 后以仓内副本为准）。同目录 `junshi-miniapp-pages.html` 与 `pages/*.html` 是**上一代旧版**（金色主色、无交互），数值/文案与新版冲突处（算力 2680 vs 264、王总 vs 陈总）一律以 effect.html 为准。
2. **忽略被 CSS 隐藏的废弃方案**：智库 overview 概览三格、待整理布局切换菜单（pending-layout-switch）、旧我的页组件（profile-hero/credit-grid/tool-grid）、CSS 手绘头像——HTML 里存在但 `display:none`，是被否掉的迭代残留，不进需求。
3. **交互事实以原型 `<script>` 的 state 对象与事件委托为准**（第 4 节 JS 逻辑清单已在架构分析中整理）：报告生成三态、上传文件堆 6/30 阈值三档、授权流程「广告/CRM 必失败→上传替代」的演示语义（→ D-6 决策依据）、paySheet 台账从 cost 文本推导的四种计价。
4. **原型的 detailSheet 是单组件 + 30 余个 type 分支的「万能详情」**，落地时按本方案拆为：真实分包页（军令详情/提醒页）、半屏 sheet（三势全解/能力详情/军令同步屏/数据源详情）、全局组件（PaySheet/ExceptionSheet/OnboardSheet）。保留其返回栈语义（军令详情可从同步屏或执行页进入，返回目标不同）。
5. 原型军师名录 7 人含「个人成长军师·明止」——按 D-9 本期不落地。

## 附录 B · 名词映射与文案 sweep 表

| 原型/新口径 | 现有代码口径 | 处理 |
|---|---|---|
| 对话/战局/执行/智库/我的（tab） | 问策/军情/军令/锦囊/主公 | V7-01 sweep（D-1） |
| 算力 | 钻石（💎）/ 本月额度 | V7-12 文案层统一「算力」，契约不动（D-4） |
| 积分 | （无） | 不建（D-3），兑换位由算力承接 |
| 军令（任务实体） | 军令（CasefileOrder/DossierOrder） | 保持（WO-01 名词表不变：案卷/方案/军令/资料） |
| 报告（智库 tab 内） | 方案（WO-01 统一后口径） | 智库四分区名从原型「报告」→ 沿用现网「方案」，分区内条目叫「方案」；阅读器内部章节样式照原型 |
| 待整理 / 已优化 / 知识库 | （无生命周期） | V7-06 stage 枚举 staging/optimized/confirmed |
| 服务老师 / 班级 / 邀请码 | community 引导态 | V7-13 建模 |

## 附录 C · 原型设计 token → 代码 token 对照

| 原型 `:root` | 值 | 现有 `app.scss page{}` | 动作 |
|---|---|---|---|
| --bg / --paper / --surface | #F4F2EC / #FBFAF6 / #FFF | 同值已有 | 无 |
| --ink / --ink-2 / --ink-3 / --line | #16191D / #565C63 / #969BA1 / #E7E4DB | 同值已有 | 无 |
| --green / --green-deep / --green-soft | #1E5A43 / #163F30 / #E7EEE9 | --green 派生自 --accent（默认墨绿同值） | 保持派生（D-2），不写死 |
| --gold / --gold-soft | #9B7C3F / #F2EAD6 | 已有（派生） | 无 |
| --gold-deep | #6F5420 | 缺 | V7-02 补 |
| --surface-2 | #F3F1EA | 缺 | V7-02 补 |
| --red = --danger | #9C4A38 | --danger 同值已有 | 无 |
| --blue（算力 tier） | #245f88 | 缺 | V7-02 补 |
| --serif / --sans | Noto Serif SC 系 / Noto Sans SC 系 | 已有同栈 | 无 |
| 字重 token | serif-title 700 / sans-strong 700 / sans-medium 650 | 缺显式 token | V7-02 补 |
| 阴影 --shadow | 0 28px 82px rgba(40,46,30,.20) | 近似值已有 | 对齐一次 |

> 注意：所有新增 token 必须三处同步——`app.scss page{}`、六个 `.theme-*` 显式覆盖块、`app.h5.scss :root`（AGENTS §7.2 H5 双写铁律）。
