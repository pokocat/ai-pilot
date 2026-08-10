# PC 工作台方案（2026-08-10 定案）

设计稿：claude.ai/design 项目 `db1411d1-ff9f-4bc8-8320-6fbb4b96c23f` 的 `军师 PC.dc.html`（1440 基准，三栏工作台）。
本文档记录五项决策定案、架构方案、设计元素 → 现有 API 映射，以及分期与阻塞项。

## 一、决策定案（用户 2026-08-10 拍板）

| # | 议题 | 结论 |
|---|------|------|
| 1 | 工程形态 | **PC 是独立的 Vite + React DOM 应用，零 Taro**（`app/src/pc/` → `dist-pc/`，挂 `/pc/`）。做法：先把共用业务层与 Taro 解耦（`services/platform.ts` 垫片），PC 与移动 H5 共用同一份 `services/` 与 `data/`，各自一条构建流水线。移动 H5 仍是 Taro（`dist-h5/`，站点根），本次不动。 |
| 2 | 一期范围 | 按三档：五大区+报告/资料详情进 Shell；settings 等长尾页居中窄栏兜底；poster/market/community/gift/onboarding 一期不给 PC 入口。**PC 定位：上传文件、整理资料、出报告为主场景；高频日常在小程序。** |
| 3 | 设计未覆盖处 | 后端不动。设计稿有而后端无数据的块，用现有 API 近似渲染或隐藏；未画设计的子页面按设计稿的桌面设计语言实现（分期做）。 |
| 4 | 命名 | 三端统一改名：军情→**沙盘**、军令→**点兵**、老板→**主公**（问策、锦囊不变）。小程序随下版发布。 |
| 5 | 登录/支付 | PC 登录用**手机号 + 短信验证码**（服务端已有，无阻塞；不做微信扫码，那需要开放平台「网站应用」资质，审核周期不可控）。**支付一期关闭**：PC 只展示权益，购买引导去微信小程序完成。 |

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
- **登录**：手机号 + 验证码（`src/pc/Login.tsx`）。游客可浏览，**动作级**登录门 —— 各区调 `requireAuth('chat')`（`src/pc/authBridge.ts`），未登录才弹。
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
| 主要矛盾卡（判断+依据计数） | `api.dailyBattleReport` / `api.journey` |
| 三势卡+全解抽屉 | `journey.forces` + `api.refreshForces` |
| 判断依据/待补证据 | `journey`/`dossier` 内证据字段（以实际字段为准，缺则隐藏待补区） |
| 指标格 | `api.progress` / `myCredits` |
| 决策日志·待验证 | `api.decisions` + `verifyDecision` |
| 经营数据（设计为日粒度） | `api.bizMetricSeries`（**周粒度近似**，文案改「本周」） |
| 现在不能做 | `prescriptions` 中禁做类，缺则隐藏 |
| CTA 升帐点兵 | `api.battleCommit` |
| 子分区：时运策/命盘分析 | `api.myChart` / `myChartReport`（monthlyOutlook） |

### 点兵（原军令/studio）
| 设计元素 | 数据源 |
|---|---|
| 今日战役/献策三步/今日主令/提醒节奏四卡 | `dailyBattleReport` + `prescriptions` + `api.reminders` |
| 军令表（勾选批量、右键、回填） | `prescriptions` + `prescriptionAction`；**负责人/预计工时列无字段 → 一期省列**；「自己补一条」走现有创建入口，无则隐藏输入框 |
| 周计划/复盘视图 | `api.reviews` 有则接，无按钮态近似；复盘前检查用 `reviews` 待办近似 |
| 经营数据回填 | `bizMetricTemplate` + `saveBizMetrics`（周粒度） |
| 内容出品卡 | `services/creative` + `api.library`（gallery 数据） |

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
| 会员卡+权益三格 | `store.me` + `myCredits` + `plans` |
| 年度谶语+点谶记录 | `strategicProfile` + `prophecies` + `verifyProphecy` |
| 统计三格 | `progress`（rank/streak/decisionAccuracy） |
| 档案/资产/系统菜单组 | 现有 profile 页菜单数据；目标阶梯无 API → 一期隐藏 |

### 通用件
详情抽屉（432px）、右键菜单、Toast、顶栏动作 —— 纯前端；抽屉内容按上表数据源。

## 四、分期

1. **Phase 0**：宿主页+分流+样式管线+三栏骨架+主题（任务 #2）
2. **Phase 1**：问策双栏（#3）→ 锦囊（#4，主场景）→ 沙盘/点兵/主公（#5）
3. **Phase 2**：命名三端统一（#6）；登录/支付服务端（#7）
4. **Phase 3**：长尾子页按设计语言逐步桌面化；键盘快捷键打磨

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

- **支付**：一期关闭。`services/pay.ts` 的 `payEnvSupported()` 在非小程序环境本就返回 false 并提示「请在微信小程序内完成支付」，PC 侧只做静态引导文案 + 小程序入口说明，**不得 import pay.ts**（会把 Taro 带回来）。
- **微信扫码登录**：后置。需微信开放平台「网站应用」资质（企业认证 + 审核），想做时再启动。
- **移动 H5 的 Taro**：本次未动。等 PC 稳定后若决定下线移动 web（移动端流量走小程序），删掉 `app/src` 的 Taro 页面即可让 Taro 彻底退出仓库——垫片已经把业务层准备好了。
- 沙盘「判断依据/待补证据」「复盘检查」等字段以后端实际返回为准，开发中逐块核对，无则隐藏。
- **问策一期未做**（有契约、设计稿未画或留到后面）：`ChatReply.asks` 反问选项、`factConfirmation` 事实确认卡、`SessionMessage.chips`、`refs` 引用角标、`messagePage` 向上翻页（现在只显示服务端返回的最近一页）、附件上传（随锦囊一起做）。`role='report'` 消息降级成「标题 + 分段」并入军师气泡，未复刻报告卡——表格/甘特/评分盘类 typed section 会退化成文字。
- **问策未在真后端验过的路径**：报告流（`begin`/`section`/`footer`）、断流对账、轮询兜底、报告自动入库。这些按 liveGen 契约实现，但 mock 无流式分支，只用本地 SSE 桩覆盖了 `generation/meta/token/chat/done` 五种事件。接真后端时要专门回归这几条。
