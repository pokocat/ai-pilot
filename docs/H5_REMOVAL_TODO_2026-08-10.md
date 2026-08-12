# 待办：下线移动端 H5 / 移除 Taro（2026-08-10 记，未开工）

## 状态

**已勘察，未动手。** 卡在一个产品决策上（见文末「未决问题」），答案不同工作量差一个量级。

## 背景

`7baa2fe feat: migrate WeChat app to native runtime` 之后，小程序已是原生形态（`app/weapp-native/`），
Taro 只剩移动 H5 一条流水线（`build:h5` → `dist-h5/`）。PC 工作台是独立的 vite 链路（`vite.pc.config.ts`）。

## 勘察结论

### 1. 删 Taro 对 PC 零影响（已实测）

从 `app/src/pc/main.tsx` 出发做传递依赖分析：可达 54 个文件，**0 个 import `@tarojs`**。
`vite.pc.config.ts` 注释里说的「services 层已由 `services/platform.ts` 与 Taro 解耦」属实。

注：`app/src/services/` 下仍有 8 个文件 import `@tarojs`（creative / reportShareCard / tabbar /
nav / canvasCard / pay / wechatSubscribe / posterPending），但 PC 一个都没引用到。

### 2. H5 ≠ Taro —— `dist-h5` 上挂着三件线上的事

#### 2.1 小程序宋体是靠 H5 产物托管的（最隐蔽，优先解）

```
app/src/assets/fonts/*.woff2
  → app/config/index.ts:62   copy 插件塞进 dist-h5/fonts/
  → scripts/deploy-prod.sh:198  发到 /var/www/junshi/h5/
  → nginx 两个 server 块都有 location /fonts/ { root /var/www/junshi/h5; }
  → app/weapp-native/services/font.js  wx.loadFontFace 拉这个绝对地址
```

`docs/DEPLOYMENT.md:472` 明写：**发小程序前必须先发过一次 H5，否则字体 404**。
`:473` 有实测踩坑记录，症状极隐蔽——「H5 一切正常、只有小程序回退系统字体，且机型间时有时无」。

→ **删 H5 前必须先把 `/fonts/` 摘出来独立部署**，否则小程序宋体静默失效。

#### 2.2 PC 有 6 处硬依赖移动 H5 兜底

| 位置 | 用途 |
|---|---|
| `app/src/pc/Login.tsx:144,146` | 用户协议 / 隐私政策——**合规必需，删之前必须补** |
| `app/src/pc/main.tsx:39` | `routeFromMobilePath()`：`MOBILE_TO_PC` 映射表未覆盖的路径一律开新标签跳移动版 |
| `app/src/pc/regions/lord.tsx:54` | `openMobile()`，主公页未桌面化的入口 |

`MOBILE_TO_PC`（`main.tsx` 顶部）只映射了少数几条，小程序侧共 33 个页面
（`packages/work` 28 + `packages/main` 5）。**缺口有多大没盘过，需专门量一次。**

#### 2.3 站点根会空掉

`aibuzz.cn/` 现在是 H5（`deploy/nginx.conf.example:67` `root /var/www/junshi/h5`），PC 挂 `/pc/`
（`vite.pc.config.ts` 的 `PC_BASE` 默认 `/pc/`）。删了根就 404。

## 建议执行顺序（不要一步删）

1. **把 `/fonts/` 从 H5 产物里摘出来独立部署** — 改 `app/config/index.ts`、`scripts/deploy-prod.sh`、
   `deploy/nginx.conf.example`。低风险，不影响现状，且无论最终走哪条路都要做。
2. PC 补 Login 的协议页 + 盘 `MOBILE_TO_PC` 缺口。
3. `PC_BASE=/`，PC 提到站点根。
4. 删 Taro：依赖、`app/config/index.ts`、`app/src/app.config.ts`、`app/src/app.h5.tsx`、
   `app/src/app.h5.scss`、`build:h5*` / `dev:h5*` 脚本、`scripts/dev.sh:77` 的 H5 预览、
   `scripts/deploy-prod.sh` 的 `DEPLOY_H5` 分支。

   ⚠️ **但 `app/src/` 本身删不掉**——见下。

### 2.4 原生小程序的样式反向依赖 `app/src/`（2026-08-10 补，推翻上一版说法）

本文档初版写的「删 `app/src/` 下 PC 不可达的文件（大头）」是错的。实测：

```bash
grep -rl 'src/' --include='*.scss' app/weapp-native | wc -l   # → 39
find app/weapp-native -name '*.scss' | wc -l                  # → 50
```

**50 个原生 scss 里有 39 个 `@use` 了 `app/src/` 的 Taro 时代样式**，包括最要命的两个：

- `app/weapp-native/app.scss:1` → `@use "../src/app.scss"`（全局令牌、字体栈、主题类）
- `app/weapp-native/custom-tab-bar/index.scss:1` → `@use "../../src/custom-tab-bar/index.scss"`

也就是说 `app/src/` 不只是 H5 的源码，它同时是**原生小程序的样式真源**。删掉它，小程序不是掉几个样式，是整个视觉体系崩掉。

这是 `7baa2fe` 迁移原生运行时时留下的：逻辑层重写成了原生，样式层没搬，用 `@use` 借道旧文件。

→ 第 4 步的正确形态是：**只删 Taro 的构建链与 H5 专属文件，保留 `app/src/` 下被 39 个 scss 引用的样式文件**。
要真正清干净，得先做一次「样式搬家」：把这 39 处依赖的 scss 内容迁进 `app/weapp-native/`，
这是独立的一块工作量，没盘过。

> 新增的 `app/weapp-native/packages/video/`（快出片分包）**没有**这个依赖，样式自包含 —— 不再往这笔债上加。

## 未决问题（开工前先定）

**移动端 Web（手机浏览器打开、微信外分享的落地页）还要不要？** 三条路：

- **彻底不要** → 按上面四步走，工作量最小。代价：小程序链接在微信外打不开，对外分享只剩 PC 站和小程序码。
- **形态要留但去 Taro 化** → 用 PC 那套 vite + React 重做移动端（`src/services` 可复用）。
  这是「重写 H5」不是「删 H5」，工作量最大。
- **只冻结不删** → 保留现有产物和部署，不再迭代。风险最低，但 Taro 依赖删不掉（产物要重建就还得要它）。

## 相关

同期还有一条未开工的线：**在军师内做短视频生成子应用**（结论：可行，按「独立小程序」标准做内聚的
新分包 `app/weapp-native/packages/video/`，宿主耦合收进单个 `host.js`；服务端最大工作量是视频供应商
的异步 job 状态机——`server/src/services/creative/visualProvider.ts:9` 明确只支持同步，异步分支被删过）。
这条线尚未落成实施单。

---

**2026-08-12 追记（IA 重排造成的分叉）**：小程序侧完成五 tab 信息架构重排（战局合并、锦囊改作品页
`pages/pouch`、图籍接家底，见 `docs/CHANGELOG.md` 同日条目）。H5 侧的 `app/src/app.config.ts`、
`app/src/custom-tab-bar/index.tsx`、`app/src/pc/main.tsx` **未随改**——H5 的 tab 结构自此与小程序分叉。
既然本文档已定 H5 移除方向，分叉按「不修复、随移除一并消灭」处理；若 H5 移除计划取消，需回头补齐
三处同源改动并为 H5 新建 pouch 页面。
