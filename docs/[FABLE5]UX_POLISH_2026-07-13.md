# [FABLE5] 前端交互精细化打磨方案 · 2026-07-13

> 架构：Fable5（本方案 + review）；执行：Opus 子代理。
> 输入：四路并行审查（tab 主页 / chat·brief·settings / work 分包 19 页 / 设计系统与共享组件）。
> 原则：不重提 [FABLE5]DECISIONS_2026-07-11 已拍板项；本轮以「可用性硬伤 + 专业感一致性」为主，重构类大动作记债不做。

## 0. 裁决与口径

| 争议点 | 裁决 |
|---|---|
| 复盘时间 20:30 vs 21:30 混用 | 统一 **21:30**（REMINDERS 常量与多数页面为准），抽共享常量 `REVIEW_TIME` |
| 名词 | 「模块」→「能力」；「智库上传/智库能力」→「资料库」；去英文口吻（SKILL CENTER 等） |
| 危险色 | 统一 `var(--danger)`，消灭 #c0392b/#c41e3a/#cc4a4a/#9c4a38 |
| `--ink-3` 对比度 2.6:1 | 微调至 ~3.5:1（弱化层级保留，可读性提升）；≤10.5px 的说明字提到 ≥11px |
| 弹层 | 不抽 Sheet 基座；统一五要素：z-index=900、遮罩 rgba(22,25,29,.55)、入场动画（复用 pk-rise）、圆角 var(--r-lg)、catchMove |
| 流式滚动 | 单一策略「贴底才跟随」：用户上滑即停跟随并显示「回到最新」，聊天与报告两条链路共用 |

## 1. 波次与工单

### Wave A（基建，单代理，先行）— scope: app.scss / components/* / services 或 utils 新文件 / shared 常量
- A1 token 补层：`--fs-*`(11/12/13/14/15/17/20)、`--space-*`(4/8/12/16/20/24)、`--shadow-sm`、`--z-nav(100)/--z-sheet(900)/--z-full(950)`；`--ink-3` 对比度微调；`--r-*` 在弹层落地。
- A2 按钮基类 `.btn/.btn-primary/.btn-ghost/.btn-danger`：统一 48px 高/圆角 14px/active 按压/disabled(opacity+pointer-events:none)；五个 Sheet 的主/次按钮迁入（Plans 40px→48px）。
- A3 弹层五要素统一（见 §0）：Picker 补 catchMove、z-index/遮罩对齐；其余 Sheet 补入场动画。
- A4 `navTo()` 防重入工具（navigateTo/switchTab 800ms 锁），供各波使用；custom-tab-bar switchTab fail 回滚。
- A5 NextStepCard/PrescriptionStrip 接 token 去 theme-blind（#16321f 等 → accent 族）；AgentUnlock/Plans/dossier/report 危险色统一；NextStepCard/PrescriptionStrip 加 :active 与占位高度（防后弹入位移）。
- A6 轻量三态组件 `<AsyncState loading|error|empty onRetry>`（骨架条 + 错误重试 + 空态引导），供 B/C/D 波使用。
- A7 MarkdownText：React.memo + parse 按 text 缓存；`userSelect` 非法属性修正；表格块从 code 样式改为简单行列呈现。

### Wave B（chat·brief·settings，单代理）— scope: packages/main/* + components/ReportCard
- B1 滚动跟随统一「贴底才跟随」：onToken 节流滚底（仅贴底时）；报告流 scrollToEnd 尊重上滑；「回到最新」两链路均生效。
- B2 停止生成：busy 时发送键切「停止」，接 generateStream abort。
- B3 草稿持久化：onBlur/useDidHide 存 Storage，initChat 回填。
- B4 报告卡失败挂重试（复用聊天气泡 retry 模式）；历史 restore 下发 saved 真值防重复入库。
- B5 SSE 错误 `HTTP ${status}` 兜底改中文友好话术（raw 只留日志）；上传 showLoading 改进度+可取消（若 API 成本高可降级为非模态提示，但需可取消）。
- B6 输入框：maxlength 临近上限显示计数；模型胶囊单档时去 chevron/点击态；jump-latest 偏移与 composer 高度联动。
- B7 brief：删除记忆加 showModal 确认 + 删除热区扩大；lib 加载骨架。
- B8 settings：头像上传复用 checkUpload 前置校验；VERSION 从 package.json 注入。
- B9 ReportCard：Icon 内联 hex → token；animate 与 streaming 并存时跳过逐段延时。

### Wave C（5 tab 页 + custom-tab-bar，单代理）— scope: pages/* / custom-tab-bar
- C1 登录门统一：studio/thinktank/profile 挂 Login gate（对齐 sessions/home）。
- C2 三态落地：sessions 列表失败→可重试错误态（不再伪装空态）；home 三势/hero 骨架；thinktank 四 tab 失败可重试。
- C3 跳转全部换 navTo() 防重入。
- C4 触控热区：task-check(27px)/mh-btn(32px)/cs-clear/fr-del/bm-edit 扩到 ≥44px 命中（视觉不变，透明外扩）。
- C5 文案：REVIEW_TIME 常量替换 20:30/21:30；SKILL CENTER/深度 Skill 去英文、统一「能力」；home 刷新 toast 移到 Promise 完成后。
- C6 studio：顶栏「提醒」与提醒节奏卡指向混淆——顶栏改名「复盘」；目标编辑 sheet 键盘遮挡（监听键盘高度上顶）。
- C7 thinktank 底部「上传资料」CTA 仅资料 tab 显示；profile 未登录先引导、未分配服务卡置灰、菜单按「档案/资产/账户/系统」分组；tab-label 改 sans。

### Wave D（work 分包 19 页，单代理）— scope: packages/work/*
- D1 【最高优先】report「同步为军令」加 in-flight 防抖禁用（重复记账风险）。
- D2 三态落地：ledger（吞错→错误态+重试）、project（永久加载中→failed+重试）、library/credits/projects/knowledge/reminders 首屏 loading 防闪空态。
- D3 布局：ledger/dossier calc(100vh-魔法数) 改 flex/动态头高；report 底栏补 constant() 回退；quickscan/market/command 底部 safe-area。
- D4 主题：quickscan 套 themeClass 去硬编码；market 处方卡内联 hex → token。
- D5 防丢失：projects/project 创建、加资料成功后再清空输入 + busy 防重；dossier ready 前禁用生成 + 刷新履历轻确认。
- D6 细节：knowledge ki-del 热区、ledger 验证按钮热区、quickscan/knowledge RATE_LIMITED 专属文案（含每日次数）、market 假「启用」改「了解」、命理日期按月校验、webview 空 url 友好占位、reminders 「已配置」改「暂不可订阅」、project 资料条目跳详情。

### Wave E（验证收尾，单代理）
- build:weapp + build:h5 编译通过；grep 复查口径（21:30/能力/danger）；CHANGELOG 回写；提交并推送。

## 2. 记债（本轮不做）
- 604 处存量字号/间距全量 token 迁移（标尺已立，新代码强制走 token，存量分批）。
- chat 消息列表虚拟化（本轮以 memo 止血）。
- Sheet 抽象为基座组件、公共 Segmented 组件。
- Icon 默认色 hex 源头改造（需 TS 读 token 方案）。
- 全库 a11y 语义补齐（SafeHeader 范式推广）。
