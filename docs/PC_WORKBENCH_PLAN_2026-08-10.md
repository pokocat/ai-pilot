# PC 工作台方案（2026-08-10 定案）

> **开发位置**：本特性在独立 worktree 上做 —— `.claude/worktrees/pc-workbench`，分支 `feat/pc-workbench`。
> 主干（main）同期有「连续会话与渐进交付」在推进，两条线互不落地。
> 该 worktree 的 `h5-preview` 预览端口改为 **5199**（主干占 5173），移动 H5 在 `/`、PC 在 `/pc/`。

设计稿：claude.ai/design 项目 `db1411d1-ff9f-4bc8-8320-6fbb4b96c23f` 的 `军师 PC.dc.html`（1440 基准，三栏工作台）；本轮另有用户上传的 `/Users/donis/Downloads/军师小程序H5转PC版适配-handoff.zip`。
本文档记录五项决策定案、架构方案、设计元素 → 现有 API 映射，以及分期与阻塞项。

## 一、决策定案（用户 2026-08-10 拍板）

| # | 议题 | 结论 |
|---|------|------|
| 1 | 工程形态 | **PC 是独立的 Vite + React DOM 应用，零 Taro**（`app/src/pc/` → `dist-pc/`，挂 `/pc/`）。做法：先把共用业务层与 Taro 解耦（`services/platform.ts` 垫片），PC 与移动 H5 共用同一份 `services/` 与 `data/`，各自一条构建流水线。移动 H5 仍是 Taro（`dist-h5/`，站点根），本次不动。 |
| 2 | 一期范围 | 按三档：五大区+报告/资料详情进 Shell；settings 等长尾页居中窄栏兜底；poster/market/community/gift/onboarding 一期不给 PC 入口。**PC 定位：上传文件、整理资料、出报告为主场景；高频日常在小程序。** |
| 3 | 设计未覆盖处 | 后端不动。设计稿有而后端无数据的块，用现有 API 近似渲染或隐藏；未画设计的子页面按设计稿的桌面设计语言实现（分期做）。 |
| 4 | 命名 | 三端统一改名：军情→**沙盘**、军令→**点兵**、老板→**主公**（问策、锦囊不变）。小程序随下版发布。 |
| 5 | 登录/支付 | PC 登录用**手机号 + 短信验证码**（服务端已有，无阻塞；不做微信扫码，那需要开放平台「网站应用」资质，审核周期不可控）。**PC 必须登录才能使用**：未登录不挂载五区或公开目录，存量 token 先经 `/me` 验真；移动 H5 / 小程序游客策略不变。PC 展示真实方案关系，但不直接接微信支付：购买统一打开既有移动 H5 / 微信小程序安全链路。 |

## 二、架构

### 两条流水线，一份业务层

| | 移动 H5 | PC 工作台 |
|---|---|---|
| 框架 | Taro 3.6 + React | Vite 5 + React DOM（**零 Taro**） |
| 配置 | `config/index.ts` | `vite.pc.config.ts` |
| 入口 | `src/app.h5.tsx` | `src/pc/main.tsx` |
| 产物 | `dist-h5/` → 站点根 | `dist-pc/` → `/pc/` |
| 命令 | `npm run build:h5` | `npm run build:pc` |
| 共用 | `src/services/`、`src/data/`、`shared/contracts.d.ts` —— 同一份代码，无分叉 | |

- **解耦手法**：新增 `services/platform.ts` 垫片，定义 storage / request / upload / toast / confirm / navigate 六件事，默认实现是纯 Web。`api.ts`、`store.ts`、`mock.ts`、`token.ts`、`chatPending.ts`、`dossier.ts` 全部改走垫片，不再 import Taro。移动端在 `app.h5.tsx` 用 `setPlatform` 换回 Taro 实现（toast/confirm/导航），行为逐帧不变。
- **存储格式**：垫片的 Web 实现照抄 Taro H5 的 `{"data": v}` 包装。PC 与移动 H5 同源（aibuzz.cn），用户在手机网页登录后开 PC 必须读到同一个 token —— 写裸值会静默丢登录态。
- **宿主钩子**：store 里两处只有移动端才有意义的副作用（隐藏自定义底栏、预取微信订阅模板）改为 `setHostHooks` 注入。否则 store 静态 import `tabbar.ts`/`wechatSubscribe.ts`，整个 Taro 运行时会被拖进 PC 包（实测胖 70KB+）。
- **仍绑定 Taro 的服务**（PC 不得引用）：`pay`、`tabbar`、`wechatSubscribe`、`creative`、`canvasCard`、`reportShareCard`、`posterPending`、`nav`。由 `scripts/pc-bundle.test.mjs` 四条断言守卫，回归即测试失败。
- **流式对话**：`services/streaming.ts` 早已有浏览器 fetch + ReadableStream 分支且零 Taro，PC 开箱可用，经 `liveGen` 单例托管，不另写 SSE。

### PC 侧细节

- **路由**：hash 形如 `#/think?view=assets&k=general`，路径段是区、query 是子区与选中项。换区不跳页，只改 `usePcState`，地址栏用 `replaceState` 同步（可刷新、可分享）。
- **视口分流**：移动 `index.html` 在 Taro 启动前判断 `innerWidth ≥ 1024` 且落在五个 tab 主入口 → `location.replace('/pc/#/<tab>')`；PC `index.html` 反向：窄屏 → 回移动版对应 tab。长尾子页两边都不拦，桌面上以 390px 居中窄栏打开。
- **样式**：Vite 直接编译，px 就是 px（不经 Taro 的 px→rem 管线）。类名统一 `pc-` 前缀；颜色全部走 `index.scss` 顶部的 `--pc-*` 变量，`--accent*` 由 App 按本命色写在根节点行内。
- **主题**：6 套本命色对齐现有 `setColor`；列表宽度（280–460，拖拽把手）与导航文字开关落 localStorage。
- **登录**：手机号 + 验证码（`src/pc/Login.tsx`）。PC 使用不可关闭的首屏硬登录门：无 token 只渲染登录，存量 token 先请求 `/me` 验真，未通过时不挂载 Shell；`requireAuth` 仅保留为运行中掉线的第二道防线。
- **交互增强**：右键菜单、Esc 就近关闭、Enter 发送 / Shift+Enter 换行、拖拽上传（锦囊）、hover 与自定义滚动条按设计稿实现。

## 三、设计元素 → API 映射

### 问策（sessions，列表+对话双栏合并）
| 设计元素 | 数据源 |
|---|---|
| 军师线程列表（常驻军师/专业参谋分组、锁定态、别名） | `store.agents`（`api.agents`）+ `api.sessions` |
| 搜索、历史切换 | 本地过滤 + `api.search` |
| 记忆条 | `SessionDetail.agent.memText`（**实现时改的**：memText 本身就是一句面向用户的话，比记忆条数更贴设计稿；注意它存的是带 `<b>` 的富文本，渲染前要剥标签）。右侧「记着呢」是固定文案，没有 presence 字段 |
| 消息流/流式回复 | `api.session`/`generate` + `services/sse、streaming、chatReply、liveGen` |
| 诊断卡四问+快捷 chips | `data/intents.ts`（设计稿注明逐字取自此文件） |
| 派给 chips | `store.agents` 过滤 |

### 沙盘（原军情/home）
| 设计元素 | 数据源 |
|---|---|
| 今日献策 | `api.todaySaying` |
| 主要矛盾卡（判断+依据计数） | `store.me().understanding.mainContradiction/summary/evidenceCount`，战略案卷 `judgment` 只作兜底 |
| 三势卡+全解抽屉 | `store.me().understanding.battleForces` + `api.refreshForces`，抽屉按三势真值前端合参 |
| 判断依据/待补证据 | `understanding.evidenceCount` + `understanding.nextQuestions` |
| 指标格 | `understanding.maturity` + `nextQuestions.length` + `dossier.risks.length` |
| 决策日志·待验证 | `api.decisions` + `verifyDecision` |
| 经营数据（日粒度） | 战略案卷 `dossier.backfill[today()]`，与点兵今日回填同源 |
| 现在不能做 | 战略案卷 `dossier.risks`；为空就隐藏，不造风险文案 |
| CTA 升帐点兵 | `api.battleCommit` |
| 子分区：时运策/命盘分析 | `api.myChart` 的 `monthlyOutlook/dayMaster/pattern/ziwei`；先服从 `/me.features.fortune`，无权限或无命盘用明确空态 |

### 点兵（原军令/studio）
| 设计元素 | 数据源 |
|---|---|
| 今日战役/献策三步/今日主令/提醒节奏四卡 | `refreshDossier()` + `api.reminders`；主令和完成度均从今日案卷军令实时派生 |
| 军令表（勾选批量、右键、回填） | `ordersOf/toggleOrder/addOrder/removeOrder/setOrderResult`；展示契约已有 `ownerName/dueAt/etaMinutes/steps/metrics`，缺字段显示 `—`；批量完成 / 删除写真案卷，顺延因无服务端动作明确标「施工中」 |
| 周计划/复盘视图 | `recentOrders` + `api.reviews/decisions/reminders`；`startReview` 落复盘记录，决策验证走 `verifyDecision` |
| 经营数据回填 | 今日 `saveBackfill`；周指标 `bizMetricTemplate` + `api.saveBizMetrics`，历史趋势读 `api.bizMetricSeries` |
| 内容出品卡 | `store.agents` 中 `type='creative'` 的已上架军师；按权益进入问策或成果入口，不引用 Taro-only `services/creative` |

### 锦囊（thinktank，PC 主场景）
| 设计元素 | 数据源 |
|---|---|
| 配额三格 | `myCredits` / `modules` 统计 |
| 上传卡（拖拽/多选） | `api.uploadKnowledge`（+`uploadGuard`）；PC 加 drag&drop |
| 待整理/已优化/知识库三段表 | `knowledgeDocs` + `knowledgePipeline` + `organizeBatch` + `confirmKnowledge` |
| 知识库目录格 | `api.knowledge` 分类聚合 |
| 账号与数据 | `api.dataSources` + `requestDataSourceAuth` + `uploadDataSource` |
| 能力 | `api.modules` + `enableModule` / `patchModule` |
| 方案与历史版本 | `api.reports` + `report` + `reportVersion` + `reportDiff`；抽屉内「转成军令」= 现有 report→prescription 动作 |

### 主公（原老板/profile）
| 设计元素 | 数据源 |
|---|---|
| 会员卡+权益三格 | `store.me` + `myCredits`；方案入口另读 `planOptions/plans` |
| 年度谶语+点谶记录 | `strategicProfile` + `prophecies` + `verifyProphecy` |
| 统计与段位 | `api.library/projects/reports` 计数 + `api.progress`（rank/streak/decisionAccuracy）+ `api.workbench` |
| 档案/资产/系统菜单组 | 复用现有 profile 长尾路由；PC 内可承接的方案、算力、锦囊、问策直接在工作台切区，其余进入既有页面 |
| 方案与算力子视图 | 登录后读 `api.planOptions/myCredits`；PC 不提供游客公开方案视图。不可购买 / 降档关系严格禁用，支付交给移动链路 |

### 通用件
详情抽屉（432px）、右键菜单、Toast、顶栏动作 —— 纯前端；抽屉内容按上表数据源。

## 四、分期

1. **Phase 0（已完成）**：宿主页 + 分流 + 样式管线 + 三栏骨架 + 主题。
2. **Phase 1（已完成）**：问策双栏 → 锦囊 → 沙盘 / 点兵 / 主公五大主工作区。
3. **Phase 2（已完成 PC 范围）**：PC 命名、手机号登录、方案关系与移动支付交接；移动端跟随自身发布节奏。
4. **Phase 3（持续演进）**：问策高级消息形态、真后端专项回归、长尾子页桌面化与键盘快捷键打磨。

## 五、部署

PC 与移动 H5 同源不同路径（`/var/www/junshi/pc/` ← `app/dist-pc/`）。已就位：

- `deploy/nginx.conf.example`：加了 `location /pc/`（+ `/pc` → `/pc/` 跳转）。线上 Nginx 需照此补一段。
- `scripts/deploy-prod.sh`：加了 `DEPLOY_PC=1` 开关，与 `DEPLOY_H5=1` 同构，含 `/pc/` 本地 smoke。

```bash
DEPLOY_H5=1 DEPLOY_PC=1 bash scripts/deploy-prod.sh
```

**首次上线 PC 前必须先发过一次 H5**：PC 的 `@font-face` 指向站点根 `/fonts/junshi-serif-*.woff2`，
那份文件由 H5 构建落地（物理上只有一份，不重复打包）。少这一步的表现是 PC 静默回退系统字体。

本地预览：`node scripts/serve-h5.mjs` 同时服务 `/`（dist-h5）与 `/pc/`（dist-pc），路径与线上一致。

## 六、遗留 / 待办

- **支付**：PC 不直接创建支付单。方案页读取真实 relation/action/canPurchase，只有可执行关系才开放按钮，再打开既有移动 H5 / 微信小程序购买页。PC **不得 import `services/pay.ts`**（会把 Taro 带回来）。
- **微信扫码登录**：后置。需微信开放平台「网站应用」资质（企业认证 + 审核），想做时再启动。
- **移动 H5 的 Taro**：本次未动。等 PC 稳定后若决定下线移动 web（移动端流量走小程序），删掉 `app/src` 的 Taro 页面即可让 Taro 彻底退出仓库——垫片已经把业务层准备好了。
- **点兵顺延**：当前案卷接口没有“延期原因 / 新日期”动作，按钮明确显示「施工中」；在契约补齐前不得本地改日期假装成功。
- **问策一期未做**（有契约、设计稿未画或留到后面）：`ChatReply.asks` 反问选项、`factConfirmation` 事实确认卡、`SessionMessage.chips`、`refs` 引用角标、`messagePage` 向上翻页（现在只显示服务端返回的最近一页）、附件上传（随锦囊一起做）。`role='report'` 消息降级成「标题 + 分段」并入军师气泡，未复刻报告卡——表格/甘特/评分盘类 typed section 会退化成文字。
- **问策未在真后端验过的路径**：报告流（`begin`/`section`/`footer`）、断流对账、轮询兜底、报告自动入库。这些按 liveGen 契约实现，但 mock 无流式分支，只用本地 SSE 桩覆盖了 `generation/meta/token/chat/done` 五种事件。接真后端时要专门回归这几条。
