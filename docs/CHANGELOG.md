# 军师 · 工程变更日志（CHANGELOG）

> 本文件承接原 `AGENTS.md` §14 的历史变更日志，按最新在上维护。
> 任何代码 / 配置 / 接口 / 数据结构变更，都必须在同次提交中更新受影响文档，并在本文顶部追加一条 `YYYY-MM-DD · 改动 · 影响面`。
> `AGENTS.md` 只保留工程执行必需信息与本文入口，以降低新 agent 初始加载上下文。

## 变更日志

> 格式：`YYYY-MM-DD · 改动 · 影响面`

- **2026-06-15** · **统一技能库新增/编辑组件语汇**：运营端技能库「新增技能」入口改用后台统一 `add-btn full`，新增/编辑表单改用 `crd new-agent`、`ai-field`、`ai-btn` 组件组合，删除动作改用 `mini-btn danger`，去掉局部 `sv/gh` 与 inline button 样式，保持与智能体、套餐、模型配置页一致。
- **2026-06-15** · **优化审计页移动端扫描与详情排查体验**：运营端审计页在窄屏下从横向宽表切换为紧凑事件流，单条日志按状态、接口/动作、时间、摘要、用户/IP 分区展示，避免手机端横向滚动和信息挤压；每条日志可点击打开详情面板，查看完整账号上下文、请求状态、IP/UA 与原始 payload；桌面端仍保留高密度表格。
- **2026-06-15** · **审计页收敛为用户 API 单行列表**：`GET /admin/audit-logs` 默认过滤 `admin.*` 后台自身行为，保留用户 API、登录尝试和业务动作，显式 `includeAdmin=true` 才返回后台日志；运营端审计页由卡片明细改为紧凑单行表格，展示时间、状态、方法、接口/动作、用户、IP 与摘要，避免 payload 默认展开占用过多空间。
- **2026-06-15** · **扩展审计为全量排查日志**：`services/audit.ts` 改为记录除健康检查外的所有 `/api/*` 请求，覆盖匿名、无效 token、登录、后台与用户行为，并写入方法、路径、状态码、耗时、IP、UA、鉴权状态和脱敏后的请求摘要；登录、短信、微信/本机号/运营商入口与后台账号登录/初始化/改密新增成功失败语义审计；`AdminAuditItem` 与运营端审计页增加摘要、状态徽标、路径、账号/租户、IP/UA 和更完整 payload 明细，便于后续定位登录失败、权限失败与异常请求。
- **2026-06-15** · **优化首页首屏层级与底栏质感**：`pages/home` 将三张同构「推荐产出」卡收敛为单组「可以先做」列表，强化对话输入作为首页主行动，并避免静态入口伪装成个性化优先级；`custom-tab-bar` 降低玻璃装饰并补清晰选中态，减少首屏认知负担与模板感。AGENTS 同步记录首页层级约束。
- **2026-06-14** · **配置短信验证码模板并补登录链路文档**：`server/.env.example` 将阿里云短信模板固定为 `SMS_508120103`；AGENTS/DEPLOYMENT/SMS_LOGIN/ROADMAP 同步短信验证码、本机号一键登录与 JWT 待生产化状态，后续线上部署需在服务端环境写入同一模板号。
- **2026-06-14** · **拆分 AGENTS 变更日志**：新增 `docs/CHANGELOG.md` 承接历史变更日志，`AGENTS.md` 只保留维护约定与入口链接，减少后续 agent 初始加载上下文；§0/§14 同步改为要求在独立 changelog 顶部追加记录。
- **2026-06-14** · **沉淀常用调试/部署/实时预览指令**：§11 新增本地三端调试、小程序 mock/server 真机预览、`screen` 实时 watch、DevTools `auto-preview/preview`、服务器升级发布与微信小程序上传路径，后续 agent 可直接按 AGENTS 执行常用操作。
- **2026-06-13** · **新增小程序上传版本记录**：新增 `docs/WEAPP_RELEASES.md` 作为微信小程序上传版本 ledger；§11 上传约束改为引用该文件，要求上传命令版本号/描述与记录一致，AGENTS 不再承载每次上传明细。
- **2026-06-13** · **军师档案改为访谈式补全**：登录弹层「AI 起名」改为 spark 图标按钮；`pages/brief` 的补档案动作改为“让军师来问我”，进入对话时明确访谈模式；后端过滤 `用户123/企业123` 占位名，访谈请求跳过旧项目/知识库召回，模型 guard 改为自然追问，避免把内部约束说给用户或先分析旧报告。
- **2026-06-13** · **军师档案入口化**：将「经营底稿」更名为用户更易懂的「军师档案」；`pages/profile` 只保留菜单入口，不再在我的页首页平铺完整内容；新增 `pages/brief` 详情页展示完整档案与待补问题。
- **2026-06-13** · **新增注册花名与军师档案**：`GET /auth/suggest-name` 返回古典武侠/军事花名，登录弹层新增可选称呼输入与「AI 起名」，花名只写用户称呼不写公司；SSOT 新增 `ClientUnderstanding`，`/me` 返回「军师档案」，我的页只保留菜单入口，详情页展示经营身份/创业路径/当前难题/沉淀资料/待补问题；`buildGenContext` 将同一档案注入模型上下文，运行时 guard 明确禁止编造客户事实，资料不足先追问。
- **2026-06-13** · **修复智能体解锁门禁被旧接口冲掉**：`store.loadAgents()` 合并线上 `/agents` 与本地 `DEFAULT_AGENTS`，当旧后端缺少 `billing/price/owned` 时保留本地权益字段，避免标 `💎xN` 的 `unlock` 智能体被误判为可直接进入对话。
- **2026-06-13** · **扩展线上智能体内容同步**：`server/scripts/syncAdminContent.ts` 现会同步智能体基础展示字段、`billing/price/gift` 权益字段、提示词与记忆配置，并继续保留线上上架/下架状态，避免旧库新增列默认 `free/0` 后把专项能力误开为免费。
- **2026-06-13** · **修复成果缓存串公司抬头**：`llm/gateway.ts` 的结构化成果缓存 key 纳入 `companyName`、行业、阶段、痛点与项目名，避免不同用户相同输入复用旧成果导致报告 meta 不带当前公司；`.gitignore` 排除微信预览二维码/信息文件，Docker 临时 Postgres + Node 容器完整测试用于回归验证。
- **2026-06-13** · **拆分产品说明并统一智能体钻石价格**：新增 `PRODUCT.md` 承接产品定位、信息架构、文案口径、企业事务操作系统和升级方向；`AGENTS.md` 收敛为工程入口与约束摘要。前台智能体费用展示新增 `services/format.ts`，智库/工坊卡片与专项能力弹层将「启用需 N 点」「每次产出 N 点」「用 N 点启用」统一改为 `💎xN` / `💎xN/次` 口径。
- **2026-06-13** · **沉淀小程序工程约束清单**：§0 新增小程序改动前置检查要求，§7.2 将项目配置、原生 tabbar、overlay key、登录弹层归属、键盘避让、401/网络错误、H5/小程序样式隔离、分包控重与真机排版修复收敛为防回归清单，后续改 `app/` 需先对照执行。
- **2026-06-13** · **彻底避免真机默认底栏回弹**：`services/tabbar.ts` 移除 `Taro.showTabBar` 分支，`store.setOverlay(false)` 关闭弹层时只恢复自定义胶囊底栏并继续强制 `hideTabBar`，避免真机偶发出现微信默认底栏与自定义悬浮底栏并存；AGENTS 更新底栏约定，明确 custom tabBar 模式下不得 show 原生 tabbar。
- **2026-06-13** · **修复对话页键盘顶起整页**：`pages/chat` 禁用页面级滚动，输入框关闭 `adjustPosition` 并改为监听键盘高度设置 `--keyboard-height`，让输入区随键盘上移但头部/问候卡不再被推到系统状态栏下方；AGENTS 同步更新对话输入兼容约定。
- **2026-06-13** · **修复小程序 High 级 review 项**：`app/project.config.json` 切为正式安全口径（开启 urlCheck/es6/enhance/postcss/minified），删除根目录误生成 DevTools 配置并保留本机 `app/project.private.config.json` 覆盖局域网预览；新增 `store.handleApiError`，会话/项目/方案库/报告/方案与专项能力弹层不再把 401/网络错误吞成空态。
- **2026-06-13** · **修复小程序 Medium 级 review 项**：`custom-tab-bar` 移除 250ms/1500ms 常驻轮询，改用 `eventCenter` 与页面 `useDidShow` 触发式同步；项目工作台/项目详情/方案库/报告页移动到 `packages/work` 分包，`pages/profile` 与 `pages/chat` 配置预加载，降低后续主包膨胀和启动风险。
- **2026-06-13** · **前台商业文案去促销化**：首页「智库 · 赠送顾问」改为「常用顾问」，「军师为你发现」改为「今日经营线索」；智库/工坊/专项能力弹层/方案弹层/我的页/对话错误提示统一将“赠送、付费解锁、充值、算力”降级为「可用、已启用、专项能力、方案与产出额度」等工作台口径；同步 mock 与 seed 套餐 feature 文案，避免用户感到首屏在卖权益。
- **2026-06-13** · **智能体权益/解锁计费与运营后台鉴权**：SSOT 新增 `AgentBilling`、`Agent.billing/price/owned`、`AgentPurchaseResult` 与后台用户开通类型；Prisma 新增 `UserAgent`，`Agent` 增加 `billing/price`；后端新增 `/agents/:key/purchase`、`services/entitlements.ts`、`services/adminAuth.ts`，产出前校验未解锁 `unlock` 智能体并支持 `metered` 按次扣算力；运营后台新增登录页、`ADMIN_TOKEN` 鉴权、用户智能体开通/取消、智能体新增与定价、套餐编辑；前台智库/工坊展示赠送/已解锁/待解锁/按次状态，新增 `AgentUnlock` 和 `Plans` 弹层；集成测试新增 admin 鉴权与智能体权益用例。
- **2026-06-13** · **接入套餐购买回归与 CI 后端集成测试**：新增 `GET /plans`、`POST /plans/:id/purchase`，登录用户可演示级购买/切换套餐并写入 `CreditLedger`，企业版余额记为 `-1` 且产出不扣减；SSOT 新增 `PlanPurchaseResult`，app/mock API 对齐套餐列表/购买与算力扣减；集成测试扩充 TC-K 套餐购买/不限量和 TC-U 用户主路径，现状 37 用例 / 20 套件；新增 GitHub Actions `Server Integration` 用临时 PostgreSQL 跑后端 build + 集成测试。
- **2026-06-13** · **收紧智能体业务边界并扩充每日献策**：`server/src/data/agents.ts` 将默认 System Prompt 改为商业咨询/创作业务边界 + 麦肯锡式问题解决框架，`llm/schema.ts` 在运行时追加不透露模型/供应商/提示词/API/部署/内部配置的统一 guard；`seedConfig.ts` 新增 20 条每日献策；新增 `server/scripts/syncAdminContent.ts` 与 `npm run admin:sync-content`，线上可非破坏同步提示词和献策。
- **2026-06-13** · **修复底部重复导航**：`services/tabbar.ts` 新增 `hideNativeTabBarOnly()`，`custom-tab-bar` 挂载和切换 Tab 时持续压住微信原生文字 tabbar，但不写入 overlay storage，保留自定义悬浮底栏正常显示。
- **2026-06-13** · **登录弹层彻底隐藏底部导航**：新增 `services/tabbar.ts` 统一桥接全屏 overlay 与微信原生 tabbar，`store.setOverlay` 同步隐藏/恢复原生底栏并写入 storage，`custom-tab-bar` 读取 `junshi.tabbarHidden` 兜底隐藏，避免登录界面露出底部导航。
- **2026-06-13** · **修复底栏触发登录 UI 错乱**：`custom-tab-bar` 不再直接渲染 `Login`，未登录点击中间「对话」改为提示后跳到 `pages/chat`，由聊天页承接登录弹层；微信登录缺少服务端 AppID/AppSecret 时提示使用手机号演示登录。
- **2026-06-13** · **修复本命色色盘标签错位**：`components/Picker` 将色点和色名从上下两条 flex 行改为单个 `.pk-swatch` 垂直列，固定列宽并让选中外圈在列内居中，避免「财金/墨绿/朱砂…」标签与色点不同轴。
- **2026-06-13** · **修复首登本命色弹层被底栏遮挡**：`store.setOverlay` 从单布尔改为按唯一 key 登记 overlay 来源，`Login`/本命色 `Picker`/@引用面板分别使用独立 key，避免登录关闭时清掉正在打开的本命色弹层。
- **2026-06-13** · **首页项目入口收敛到我的 + 标题宋体化**：移除 `pages/home` 的「项目工作台」入口条，保留「我的」页第一行入口；首页根节点增加 `home` 类并用局部宋体字体栈覆盖品牌、问候、献策、对话题、分区和卡片标题，不影响全局标题字体。
- **2026-06-12** · **前置未登录对话拦截**：首页对话入口未登录时不再跳转，直接弹登录提示；底栏中间「对话」未登录时在当前页弹登录并在登录后再开新会话；`pages/chat` 首帧检测无 token/401，先渲染兜底问候并立即弹登录，避免先白屏再显示登录。
- **2026-06-12** · **前台产品化披露 Agent Memory**：`pages/chat` 顶部记忆条改为「专属理解」表达，问候气泡新增轻量说明卡，披露顾问会参考企业档案、对话偏好和引用资料；记忆写入成功提示改为“专属理解已更新/已校准业务偏好和判断口径”，避免直接暴露后台术语。
- **2026-06-12** · **运营后台改为全屏无边框并补严记忆主开关**：`admin/src/styles/admin.css` 去掉本地后台手机壳边框、圆角、阴影和页面外边距，改为占满视口；`services/context.ts` 在 `longTerm=false` 时不再召回既有长期记忆，`services/memory.ts` 在 `longTerm=false` 时不再写入成果反馈记忆，使 Agent Memory 主开关语义与后台配置一致。
- **2026-06-12** · **扩充运营后台为真实管理台**：SSOT 新增 `AdminUserItem/AdminUsageView/AdminAuditItem`；后端新增 `/admin/users`、`/admin/usage`、`/admin/audit-logs`，概览改为读取真实用户/会话/成果/算力/审计数据；新增 `services/audit.ts` 统一秒级审计时间与小程序 API 行为审计，登录/建档/产出/存库/汇总/后台配置变更写入语义审计；运营端新增用户、消耗、审计模块，顾问页支持功能上架/下架并记录审计，底部导航改为横向滚动以容纳真实后台模块。
- **2026-06-12** · **修复运营后台本地预览边框越界**：`admin/src/styles/admin.css` 收紧手机壳宽高为视口安全值，给滚动容器/表单/卡片/flex 子项补 `min-width:0` 与长文本断行，并在窄屏下让新增/模型操作按钮自动换行，避免本地 `npm run dev` 预览时边框或内容横向溢出。
- **2026-06-12** · **接入微信小程序账号登录**：新增 `POST /auth/wechat-login` 与 `services/wechat.ts`，服务端用 `WECHAT_MINI_APPID/WECHAT_MINI_SECRET` 调 `jscode2session`，按 openid/unionid 注册或复登并保留 `session_key` 不下发；`User` 增加 `wechatOpenId/wechatUnionId/wechatLinkedAt`；小程序 server 模式登录弹层新增「微信账号登录」，H5/mock 保持手机号演示登录；补后端集成测试、`.env.example`、部署/测试文档。
- **2026-06-04** · **统一非 Tab 页顶部安全区与报告页排版**：新增 `components/SafeHeader`，对话/项目/项目列表/方案库/报告页统一按微信胶囊实测值避让状态栏和右侧胶囊，移除各页独立 `env(safe-area-inset-top)` 头部实现；报告详情页优化版本卡、模式切换与文档正文间距，成果卡/报告/对话要点列表改用块级 Markdown 渲染，避免 `**` 等标记在真机原样显示。
- **2026-06-04** · **格式化 AI 返回 Markdown 文档**：新增 `components/MarkdownText` 轻量 Markdown 渲染器，覆盖标题/段落/列表/引用/加粗/代码；`pages/chat`、`ReportCard`、`pages/report` 接入，避免模型返回的 Markdown 原文未格式化显示。
- **2026-06-04** · **新增对话 AI 思考动效**：`pages/chat` 在 `busy` 状态下渲染对话流内思考气泡，包含顾问身份、三点 pulse 动画与“正在梳理上下文”提示，并在发送后自动滚到底部，避免等待模型返回时页面像卡死。
- **2026-06-04** · **明确小程序网络/合法域名错误**：`services/api.ts` 捕获 `Taro.request` reject，根据 `errMsg` 提示 request 合法域名需配置 `https://wxapi.aibuzz.cn` 或网络失败，避免小程序端请求未到服务器时仍显示泛化“产出失败”。
- **2026-06-04** · **修复小程序对话输入无法输入**：`pages/chat` 输入框新增整条输入区 focus、显式 `type=text`、`cursorSpacing/adjustPosition/alwaysEmbed`，`onInput` 返回当前值并由 `onConfirm` 直接用事件值发送；补 `.chat-log min-height:0` 与 `.cinput min-width/width`，提升真机输入框可点、可输、可发送稳定性。
- **2026-06-04** · **修复小程序 Chat/Studio 顶部界面错位**：`pages/chat` 用微信胶囊实测值设置顶部栏 padding 与右侧避让，避免标题/生成纪要落到状态栏或胶囊下；全局 `.kicker/.h1` 改为块级标题，`pages/studio` 补齐 hero、分组标题与两列智能体卡样式，修复标题文字挤成一行和工坊列表排版缺失。
- **2026-06-03** · **修复 H5/小程序视觉差异**：新增 `app/src/app.h5.tsx` 在 H5 手动挂载同款胶囊自定义底栏，新增 `app/src/app.h5.scss` 给浏览器根节点补设计 token、隐藏 Taro H5 默认 `weui` tabbar，并保持小程序 `page` + 原生 custom-tab-bar 路径不变。
- **2026-06-03** · **清理本地生成物跟踪噪声**：`.gitignore` 增加本地评审产物、微信开发者工具私有/误生成配置、Taro CLI tarball、根目录空 `package-lock.json` 忽略规则；还原 `server/package-lock.json` 的 npm 元数据抖动，保持工作区只显示真实代码/配置变更。
- **2026-06-03** · **修复运营后台无尾斜杠访问**：`deploy/nginx.conf.example` 增加 `location = /admin { return 301 /admin/; }`；ECS Nginx 已同步 reload，避免访问 `/admin` 时落入 H5 首页 fallback。
- **2026-06-03** · **修复对话页未登录错误提示**：`pages/chat` 增加登录态兜底，未登录发送/401 token 失效时弹登录并提示“请先登录/登录态失效”，402 算力不足也显示明确文案，避免统一落成“抱歉，产出失败了”。
- **2026-06-03** · **H5 server 构建环境注入修复 + IP 测试部署**：`app/config/index.ts` 显式注入 `TARO_APP_MODE/TARO_APP_API`，`app/src/services/config.ts` 直接读取注入常量，避免浏览器运行时拿不到构建期变量而退回 mock/default；已用 `TARO_APP_API=http://8.136.36.175/api` 重新构建 H5 并部署到 ECS（`/`=H5，`/api`=后端，`/admin/`=后台）。
- **2026-06-03** · `project.config.json` AppID 设为 `wx05a49967e2adb557`；尝试用 miniprogram-ci 上传，被云端网络白名单拦截（`servicewechat.com` 未放行），改为本机上传（见 §13 TODO / §11）。
- **2026-06-03** · **部署文档与模板**：新增 `docs/DEPLOYMENT.md`（架构图 + 裸机/Docker 上线步骤 + Nginx/HTTPS + 模型配置 + 安全 checklist）+ `deploy/`（nginx/systemd/Dockerfile/compose 模板）。实测后端生产构建 `npm run build`→`node dist/index.js` 可跑、admin `--base=/admin/` 资源路径正确。
- **2026-06-03** · **一键本地开发 + 修复 seed 潜伏 bug**：新增根 `package.json` 的 `npm run dev` + `scripts/dev.sh`（确保 PG/建库/迁移/首次种子/同起 后端+H5+后台，Ctrl+C 全关）。**修复 `prisma/seed.ts` 演示项目 `project.create` 缺必填 `slug`**（该段此前从未真跑过——集成测试用 `seedBaseline` 未覆盖；由一键脚本实跑暴露）。本地实跑：三端就绪、演示账号 13800000000 读到「2026 融资冲刺」项目 + 战略诊断报告 v2 + 2 条知识。
- **2026-06-03** · **H5 浏览器联调打通（替代小程序测试）**：H5 路由设 hash（`config/index.ts`，`dist/` 任意静态服务器可开）；新增 `app/scripts/serve-h5.mjs`（零依赖静态服务器）+ 脚本 `build:h5:server`/`dev:h5:server`/`serve:h5`。**本地实跑**：浏览器(:5173)→后端(:4000) CORS 预检放行 `x-user-id`、登录/产出/算力扣减全通、`/me` 读出 Agnes 配置。weapp 与 H5 无平台分叉、功能对齐。文档 `docs/TESTING.md §五`。
- **2026-06-03** · **算力计量落地（解锁 TC-K2/K3）**：新增 `services/credits.ts`（按次扣费/余额/不足拦截），`sessions.ts` 两个产出路由接入——报告类产出前校验余额（不足→402 且不建会话）、成功后扣 1 并回填 `GenResult.creditBalance`/SSE `credit` 事件；对话免费；企业版不限量。移除 gateway 空壳 `meter`。`GenResult` 加 `creditBalance?`。集成测试 **33 全过 / 0 跳过**。
- **2026-06-03** · **集成测试扩容到企业主全旅程**：在原 7 套件基础上新增 TC-I~TC-T（SSE 流式 / 内容审核拦截 / 算力赠送+扣减占位 / 并发冒烟 / 首登建档个性化 / 老用户回流 / 跨智能体协同+引用闭环 / 成果反馈回流 / 记忆 TTL / 跨项目知识隔离 / 每日献策 / 边界健壮性）；`helpers.ts` 加 `seedBaseline`（套餐+智能体+献策+问卷）。**本地 Postgres 16 实跑 31 通过 + 1 skip / 19 套件**。
- **2026-06-03** · **后端集成测试 + 文档沉淀**：抽出 `src/app.ts`(`buildApp` 工厂)、`index.ts` 改用之；新增 `server/test/`（`helpers.ts` + `integration.test.ts`，Node 原生 test runner + Fastify inject，mock 模型）；`package.json` 加 `test` 脚本。覆盖 7 套件 16 用例（鉴权隔离/多智能体/记忆召回/项目+知识库召回/汇总/报告版本+diff/**★跨用户隔离 TC-G**/模型配置）。新增 `docs/ROADMAP.md`、`docs/TESTING.md`。**本地 Postgres 16 实跑 16/16 全过**。
- **2026-06-03** · **接入 Agnes 2.0 Flash + 可切换模型配置 + 四项升级全做**：
  - 模型配置：新增 `AiSetting` 模型 + `services/aiConfig.ts`（DB>env、预设 Agnes/DeepSeek/Qwen/Moonshot/OpenAI/Claude/mock、脱敏视图、就绪/降级判定）；Gateway 与 providers/embedding 全面改为「运行时配置驱动」；新增 `/admin/ai-config`(GET/PUT/test)；运营后台新增「模型」页（预设一键切换 + 测试连接 + 即时生效）。默认 Agnes（`apihub.agnes-ai.com/v1`，OpenAI 兼容），未配 key 安全降级 mock。
  - 升级项：① pgvector 路径（`services/vectorStore.ts` + `prisma/pgvector.sql` + `PGVECTOR_ENABLED`，flag 内 ANN 下推/向量列双写，默认关）；② 真实嵌入配置驱动；③ Learned Memory/汇总 LLM 化（`extractInsights`/`summarizePoints`，mock 兜底）；④ 词级 diff（`reports.ts wordDiff` LCS，报告页句内高亮）。
  - 校验：三端构建全绿；运行时自检通过（词级 diff `eq/add` 正确；无 DB 时配置链路安全降级 mock、不泄露 key、洞察启发式兜底）。⚠️ pgvector 与真实模型联调需在你的 DB/Key 上验证。
- **2026-06-02** · **企业事务操作系统落地**：引入「项目」主线 + 知识库（语义记忆/混合检索）+ 版本化报告（slug 归一·内容哈希去重·section 级 diff）+ @引用（上下文工程）+ 对话汇总。
  - SSOT：`shared/contracts.d.ts` 新增 Project/Report/Knowledge/MessageRef/Summarize 等类型及 Gen/Session/Lib 字段扩展。
  - 后端：新增 `services/{embedding,retrieval,knowledge,reports,summarize}.ts`、`routes/{projects,reports,knowledge}.ts`；升级 `memory.ts`(向量+语义召回)/`context.ts`(项目背景+引用+召回注入)/`schema.ts`(GenContext+injectVariables)/`library.ts`(桥接报告版本)/`sessions.ts`(projectId/refs+summarize)；Prisma 新增 5 模型 + 字段；`seed.ts` 灌演示项目/报告 v1→v2/知识。
  - 前端：新增 `pages/{projects,project,report}`；对话页加 @引用选择器/生成纪要/项目作用域；方案库 vN 跳转；首页+「我的」入口。
  - 校验：三端构建全绿（server tsc=0 / app build:weapp ok / admin tsc+vite ok）；核心逻辑运行时自检通过（向量自相似 1.0/相关 0.86/无关 0.0、slug 归一、diff=新增1·修改1·删0）。
- **2026-06-02** · 新增 §0「给 Coding Agent 的强制指令」：任何代码变更必须记入文档、暂不做的写入 §13 TODO、完成即移出。
- **2026-06-02** · 文档落为 `AGENTS.md`（Claude Code 新会话自动加载），确立「每次变更必更文档」约定。
- **2026-06-02** · 配置化 mock/server 模式 + 全栈数据模型统一到 SSOT(`shared/contracts.d.ts`)；新增 `services/config.ts`/`mock.ts`/`token.ts`；后端/运营端类型改为引自 SSOT。三端构建全绿。
- **2026-06-02** · 内置离线兜底智能体（`data/agents.ts` 14 个，自后端 seed 生成）+ 成果模板（`data/deliverables.ts`），修复无后端时对话页空白。
- **2026-06-02** · 各 Tab 页顶部让位微信胶囊（`Screen topInset`，移除伪状态栏）；两列卡片改 `space-between+48.5%` 修复竖排。
- **2026-06-02** · 登录支持离线兜底（后端不可达→`local-<phone>`）。
- **2026-06-02** · 手机号 fake 登录 + 账号数据隔离（`resolveUser` 严格鉴权、`/auth/login`、登录门、退出登录）；端到端 19/19 通过。
- **2026-06-02** · 后端新增 OpenAI 通用协议 provider（兼容 DeepSeek/Moonshot/Qwen），`isRealKey` 占位 key 自动降级 mock。
- **2026-06-02** · UI 修复：本命色弹层用 `overlay` 标志隐藏原生底栏；对话入口卡本命色渐变+柔光；首页紧凑化、今日献策分隔线、建档问卷本地兜底。
- **（更早）** · 「军师」全栈实现落地（Taro 小程序+H5 / 运营后台 / Fastify+Prisma 后端 / LLM Gateway / Agent Memory）。
