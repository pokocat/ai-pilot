# PC 工作台 · 交接文档

> 写于 2026-08-10。给接手这个分支继续做的人。
> 配套读物：`docs/PC_WORKBENCH_PLAN_2026-08-10.md`（决策定案 + 设计元素→API 映射表 + 遗留清单）。
> **本文只讲「怎么接着干」和「哪里有雷」，不重复方案文档里已有的映射表。**

---

## 0. 三十秒上手

```bash
cd /Users/donis/dev/ai-pilot/.claude/worktrees/pc-workbench/app
npm ci                 # 首次；worktree 有自己的 node_modules
npm run build:pc       # 产物 → app/dist-pc/（base=/pc/）
node scripts/serve-h5.mjs 5199   # 然后开 http://localhost:5199/pc/
```

mock 模式默认开着，不用起后端。浏览器里塞个登录态就能看真数据形态：

```js
localStorage.setItem('junshi.userId', JSON.stringify({data:'u-preview-1'}))
```

**注意存储格式必须是 `{"data": v}` 这层包装**，理由见第 4 节。

改完必须过的四道关：

```bash
npm run typecheck && npm test && npm run build:pc && npm run build:h5
```

`npm test` 里含 `scripts/pc-bundle.test.mjs` 的四条守卫（PC 源码不得引用 Taro、不得引用仍绑 Taro 的 services 模块、共用层保持无 Taro、产物不含 Taro 运行时）。**这四条是这个架构的地基，不要为了图快去改断言。**

---

## 1. 代码在哪，分支什么状态

| | |
|---|---|
| worktree | `/Users/donis/dev/ai-pilot/.claude/worktrees/pc-workbench` |
| 分支 | `feat/pc-workbench`（已 rebase 到 main 的 `89941f4`） |
| commits | `e070796` 问策 + 脱 Taro · `54dd3c6` 预览端口 · `0601fba` 锦囊 + 外壳修复 |
| 主干 | 干净，**不含任何 PC 代码**。PC 只活在这个分支上 |

> ⚠️ **这个仓库经常有多个 session 并行改主干。** 本分支的工作在 2026-08-10 就被别的 session
> 一条 `git stash -u` 从主干工作区带走过一次（后来完整找回）。所以：**别把 PC 代码写回主干**，
> 就在这个 worktree 里干；**阶段性成果尽早 commit**，未提交的东西在共享仓库里没有任何保护。

---

## 2. 架构：两条流水线，一份业务层

```
app/src/
├─ pc/            ← PC 专属（纯 React DOM，零 Taro）   → Vite   → dist-pc/  挂 /pc/
├─ pages/         ← 移动 H5（Taro）                    → webpack → dist-h5/  挂站点根
├─ packages/      ← 移动 H5 分包（Taro）
├─ services/      ← 【两边共用】业务层，已脱 Taro
└─ data/          ← 【两边共用】静态数据（军师目录、intents 等）
```

微信小程序是另一套独立代码（`app/weapp-native/`，含自己的 `services/`），**与本分支无关**，别去动它。

### 脱 Taro 是怎么做到的

`services/platform.ts` 是业务层与宿主之间的**唯一接缝**，抽了五件事：
`storage` / `request` / `upload` / `toast` + `confirm` / `navigate` + `relaunch`。

- 默认实现是纯 Web（fetch / localStorage / XHR），PC 直接用，零配置。
- 移动 H5 在 `app.h5.tsx` 启动时 `setPlatform({...})` 换成 Taro 实现，行为逐像素不变。

`store.ts` 里还有两处小程序专属副作用（隐藏自定义底栏、预取微信订阅模板），改成
`setHostHooks()` 由宿主注入。**不这么做的话 store 会静态依赖那两个 Taro 模块，
整个 Taro 运行时被拖进 PC 包，实测胖 70KB+。**

> 新增共用逻辑时：**不许在 `services/` 里 import Taro**，需要宿主能力就往 platform 加一个方法。
> `services/pay.ts`、`services/tabbar.ts`、`services/wechatSubscribe.ts` 仍绑 Taro，PC 不得引用（守卫会拦）。

### 区（Region）注册表

`app/src/pc/regions/index.tsx` 导出 `REGIONS`，五个区各实现 `Region` 接口（见 `regions/types.ts`）：
`head`（列表栏抬头）/ `useGroups?`（列表栏分区导航）/ `useBar`（顶栏）/ `Main`（主工作区）/ `ListBody?`（问策专用线程列表）。

外壳 `App.tsx` 只按 `st.tab` 取用，换区不跳页。状态在 `pc/state.ts`（`usePcState`），
与地址栏 hash 双向同步（`#/think?view=assets`）。

---

## 3. 已完成 / 待办

### 已完成

- **外壳**：导航轨、列表栏（可拖拽调宽、宽度持久化）、顶栏、主工作区、右侧抽屉、右键菜单、Toast、Esc 关闭、六套本命色（接 `api.setColor`）
- **问策**：会话列表（搜索 / 全部军师 ⇄ 最近会话 / 未读 / 锁定 / 右键菜单）+ 对话（记忆条、消息流、诊断卡、派给 chips、Enter 发送 / Shift+Enter 换行、流式、停止、切走再切回续流）
- **锦囊**：案卷资产（配额 / 上传含拖放 / 三段流 / 资料表 / 目录格）、账号与数据、能力、方案
- **登录**：手机号 + 短信验证码，游客可浏览、动作级登录门（`pc/authBridge.ts`）
- **支付**：一期关闭，统一引导去微信小程序

### 待办（下一个人的活）

1. **沙盘区**（`regions/` 下新建，原「军情」）——主要矛盾卡、三势判断、判断依据/待补证据、决策日志、经营数据、现在不能做、CTA
2. **点兵区**（原「军令」）——今日战役卡组、**军令表（含批量勾选 / 批量完成 / 顺延 / 删除）**、经营数据回填、复盘前检查、内容出品卡片
3. **主公区**（原「老板」）——会员头卡、年度谶语、统计格、档案/资产/系统三组菜单
4. 问策未做项：反问选项（`ChatReply.asks`）、事实确认卡、引用角标、历史向上翻页、附件上传
5. 接真后端回归（见第 5 节）

设计稿三个区的原始 HTML 片段在设计项目里，取法见第 6 节。

---

## 4. 雷区（这些都是踩过的，不是假想）

**① 区的 `useBar` / `useGroups` 是 hook，App 不能直接调。**
各区 hook 数量不一致（问策区 `useChatBar` 有三个，其余是零 hook 纯函数）。直接在 App 函数体里
调用会让同一个组件实例的 hook 数量跨区变化，React 抛
`Rendered more hooks than during the previous render` 并卸载整棵树 —— **表现为切区白屏**。
已修：拆成以 `st.tab` 为 key 的 `RegionBar` / `RegionList` 子组件（`App.tsx`）。
**新增区时照这个模式来，别把 hook 调用挪回 App 函数体。**

**② storage 必须保持 `{"data": v}` 包装。**
Taro H5 就是这么存的。PC 与移动 H5 同源（`aibuzz.cn`），用户在手机网页登录后开 PC
必须读到同一个 token。写裸值 = 静默丢登录态，且极难归因。`platform.ts` 的 Web 实现已照抄这层包装。

**③ PC 的字体依赖 H5 的产物。**
PC 的 `@font-face` 指向站点根 `/fonts/`，那份思源宋体子集是**由 H5 构建落地的**。
首次上线 PC 前必须先发过一次 H5，否则宋体回退系统字体。（`deploy-prod.sh` 有 `DEPLOY_PC=1`，
nginx 模板有 `location /pc/`。）

**④ mock 的形状不等于真后端。**
- mock 没有流式分支，问策的流式是靠本地 SSE 桩验的。
- mock 的 `uploadKnowledgeStaged` 根本不碰 XHR，所以**上传进度条和取消从没真跑过**。
- mock 的 `knowledgeDocs()` 与流水线无关，导致知识库段角标数和表格行数对不上 —— 这是 mock 的
  形状问题不是 bug，真后端两者同源。

**⑤ 设计稿把颜色当数据传**（`d.stBg`、`m.badgeBg` 之类），契约里没有这些字段。
一律按状态/tier 派生 CSS 类，别去后端找。同理，设计稿有而后端没有的字段一律**显式留白**
（显示 `—` 或隐藏），**不要造假数据** —— 这条是这个项目的硬规矩。

---

## 5. 没验证过的（接真后端时必须逐条回归）

**问策**：报告流（`begin`/`section`/`footer`）、断流对账、`restoreServerTruth`、轮询兜底、
报告自动入库 `saveToLibrary`、报告类消息的降级渲染、游客登录门实际拦截、套餐到期/未开通两个前置分支。

**锦囊**：上传进度与取消、文件夹拖放的递归展开（合成 DataTransfer 造不出 `FileSystemEntry`，
实测跑的是 `dataTransfer.files` 回退分支）、深度整理的 `SKU_REQUIRED` 分支、
`acceptDeliverable`（转成军令）的真实端、`statusLabel` / report `type` / `Deliverable.meta` 的实际取值。

**全局**：只在 1440×900 量过，更窄/更宽视口没试；全程 mock，没连过真后端。

---

## 6. 设计稿怎么取（**三个待做区全靠这个，别凭空发挥**）

设计稿是用户在 Claude Design 里画好的，**不是我们编的**。原始出处：

- 分享链接：`https://claude.ai/design/p/db1411d1-ff9f-4bc8-8320-6fbb4b96c23f?file=%E5%86%9B%E5%B8%88+PC.dc.html`
- MCP：`https://api.anthropic.com/v1/design/mcp`，鉴权走 `/design-login`（工具名 `DesignSync`）
- projectId：`db1411d1-ff9f-4bc8-8320-6fbb4b96c23f`

```
DesignSync { method: "list_files",  projectId: "db1411d1-ff9f-4bc8-8320-6fbb4b96c23f" }
DesignSync { method: "get_file",    projectId: "db1411d1-...", path: "军师 PC.dc.html" }
```

主文件 `军师 PC.dc.html`（约 113KB / 1444 行）会超出单次读取上限，`get_file` 的结果会落到
一个 JSON 文件里，取正文这样剥：

```python
import json; print(json.load(open('<那个结果文件>'))['content'])
```

项目里还有 `support.js`（设计工具的运行时，**不用读，与实现无关**）、`assets/avatars/*.jpg`、
`assets/fonts/*.woff2`。**素材都别下载**：仓库自己有一套立绘
（`app/src/assets/avatars/generated/*-imagegen.jpg`，见 `pc/portraits.ts`），字体走站点根 `/fonts/`。

### 文件里的行段地图（已核对）

| 位置 | 行 | 状态 |
|---|---|---|
| 外壳（导航轨 / 列表栏 / 顶栏 / 主区骨架） | 29–181 | ✅ 已实现 |
| 问策 · 对话 | 183–267 | ✅ 已实现 |
| **沙盘** | **270–389** | ⬜ 待做 |
| **点兵** | **392–538** | ⬜ 待做 |
| 锦囊 | 541–725 | ✅ 已实现 |
| **主公** | **728–785** | ⬜ 待做 |
| 右侧抽屉 | 789–823 | ✅ 已实现（`Chrome.tsx` 的 `Stage`） |
| 右键菜单 / Toast | 828–845 | ✅ 已实现 |
| **数据段** `<script type="text/x-dc">` | **849–1444** | 见下 |

**数据段是宝藏，别忽略。** 849 行往后是设计稿的示例数据与交互逻辑：`FORCES`（三势）、
`ORDERS`（军令表行）、`DOCS`、`MODULES`、`REPORTS`、各区的 `navGroups` 与顶栏 `actions` 文案、
右键菜单项与快捷键标注。做沙盘/点兵时**先读这一段**，能直接看出每个字段的预期形态和文案口径，
比对着模板标签猜快得多。849 行那条 `data-props` 里还有六套本命色的完整色值和
`listWidth` / `showRailLabels` 的默认值。

`sc-if` / `sc-for` 是设计工具的模板标签，`{{ }}` 是占位数据 —— 照结构和尺寸实现即可，
标签本身不用还原。

### 实现约束

- 三栏 `76px / var(--list-w, 348px) / 1fr`，抽屉 `432px`，对话区内容列 `760px` 居中
- 颜色**全部**走 `pc/index.scss` 的 CSS 变量，**不许写死十六进制**（本命色要能整套换）
- 设计稿里 `{{ f.toneColor }}` `{{ o.stateBg }}` 这类「把颜色当数据传」的写法，一律改成按状态派生 CSS 类（见第 4 节 ⑤）

---

## 7. 命名（三端已统一，别写回旧名）

军情 → **沙盘**　军令 → **点兵**　老板 → **主公**　（问策、锦囊不变）

路由 key 仍是历史值：`sand` / `exec` / `lord`（对应 `home` / `studio` / `profile`），只有展示文案改了。
