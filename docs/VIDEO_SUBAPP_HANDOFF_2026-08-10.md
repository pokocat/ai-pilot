# 「快出片」视频子应用 · Handoff 提示词（交接给执行 agent）

> **2026-08-11 增量**：文案首步已加入可持续追问的 AI 对话共创，端上入口现为圆形悬浮按钮 + 独立纵向消息抽屉，关闭后成稿保留在原文；项目新增独立 `shots` 镜头计划，默认先显示已分好的高层画面段，再从某一当前段内取消/保留句子、全部拆开或与下一段合并。报价、预检和 AIStar 生成/总装已统一按 shot 聚合，不再逐句强制切画面。AI 文案走军师 LLM，不消耗石榴点数。

> **2026-08-11 石榴 v0.116 增量**：采集页先读服务端 requirements，明确区分石榴官方硬限制、军师产品质量门和推荐拍法；BFF + AIStar ffprobe 双层阻断错误素材。授权文案、`authId` 语义、speaker/avatar 真实进度和错误码已对齐官方文档；声音固定 V2.0，整片 avatar/b-roll 统一由段 TTS 音频驱动。重新采集支持只重做失败项。自动化只跑桩，不创建真实任务、不耗点数；本人真机素材是最终体验验收。

> **2026-08-11 移动 UI 增量**：按 `mobile-app-ui-design` 的移动生产力原则重做核心流程：模板成为首页主任务，AI 对话成为文案页第一焦点，配画面报价进入内容流，确认页强化状态与费用层级，生成/成片页补齐 peak-end 反馈。统一轻暖灰底、暖橙/蓝色双业务色、8 点间距、软阴影与 44px 点击区；业务逻辑和预发 mock 边界不变。

> **创建**：2026-08-10。上一个 session 已完成前端框架搭建 + 技术方案 + 一轮 code review，
> 本文是**自包含交接书**：读完本文 + 引用的文档，不需要上一个 session 的对话记录即可继续开发。

> **执行状态（更新至 2026-08-11）**：本文列出的代码任务已在隔离 worktree 完成；前端、军师 BFF、AIStar clip 域和针对性测试均已落地。AIStar v0.116 已对齐石榴官方采集、授权、V2 声音、形象训练、V2 音频驱动视频、状态进度、错误码与时效结果转存，并完成多段 ffmpeg 总装、三套固定品牌尾卡、字幕/AI 标识、音轨归一和音画质量门。隔离预发仍可显式 force-mock 做零点数工程验收；切真实供应商后应只由用户本人真机提交素材。军师 BFF 已实现媒体审核适配器；测试阶段可显式旁路并留审计，production 硬拒绝。真实上线仍缺：目标阿里云账号内容安全授权、本人素材质量/耗时/成本实测、授权群像尾片或运营 preset、真实平台发布、微信类目与深度合成备案。后续以 `docs/VIDEO_SUBAPP_PLAN_2026-08-10.md` 顶部“执行结果”和两仓 TODO 为当前事实。

---

## 0. 你的任务（一句话）

在军师小程序（本仓库 `ai-pilot`）内，把已搭好框架的「快出片」数字分身口播视频子应用**开发完整**：
修掉已知问题、补全前端桩、落地军师 BFF、并在 AIStarEcosystem 仓库新建 aidrama 侧 clip 域。

**开工前先开 worktree**（本仓库主干常有并行 session，别人一条 `git stash -u` 就能带走你未提交的活）。

---

## 1. 必读材料（按顺序）

| # | 材料 | 读什么 |
|---|---|---|
| 1 | `docs/VIDEO_SUBAPP_PLAN_2026-08-10.md`（本仓库） | 分包形态技术方案：三处形态转换、mock/BFF 接法、抽离设计、坑与分期 |
| 2 | `/Users/donis/dev/AIStarEcosystem/docs/clip-avatar-video-plan.md` | 上游产品方案 549 行：生产模型、石榴AI 能力、数据模型草案（§6）、API 草案（§7）、基座复用映射（§5）、风险（§11）。**服务端开发以它为准** |
| 3 | `/Users/donis/dev/AIStarEcosystem/apps/miniprogram/agent.md` | 微信平台坑库，动小程序代码前必读 |
| 4 | 设计稿：`~/Downloads/13屏原型与设计确认-handoff.zip` | 13 屏 HTML 原型。**用 `ditto -x -k` 解压**（文件名含中文，`unzip` 会因编码炸掉）；主文件 `13/project/快出片 原型.dc.html`（693 行，读源码别截图） |
| 5 | `docs/H5_REMOVAL_TODO_2026-08-10.md` §2.4 | 只需知道一件事：军师原生端 39/50 个 scss 反向依赖 `app/src/`，**新分包不许加入这笔债**（现状已自包含，保持住） |

---

## 2. 当前已落地状态

### 2.1 前端框架（已完成，编译通过）

```
app/weapp-native/packages/video/     ← 全部新增
├── host.js       宿主适配层：分包与军师的唯一耦合点（页面禁止直接 require services/*）
├── config.js     BACKEND_MODE 开关（mock/bff）+ 计价常量（占位值）
├── api.js        clip 域 API 客户端，mock/BFF 分流，页面代码模式无关
├── mock.js       分包自带假数据（张姐/巷口修鞋铺/为实体发声，与设计稿样例一致）
├── model.js      纯计算层：时长估算、报价、角色切换、preflight、进度映射（可单测，无 wx.*）
├── styles/tokens.scss  自包含设计令牌（暖橙 #E4622B 人文纪实调，不吃军师 app.scss）
└── 11 页 × 4 件套：home template clone script shots confirm rendering work works assets avatar
```

改动的既有文件：
- `app/weapp-native/app.json`：注册 `packages/video` 分包 + `pages/studio/index` 的 preloadRule
- `app/weapp-native/pages/studio/index.wxml` / `index.js`：「点兵」tab 内容出品区块加入口行卡（`openVideo`，图标用已有的 `video`）

**mock 态可完整走通**：首页→模板→改文案→配画面→出片确认→进度→成片。纯函数层已实测（切换 delta、尾段拒切、preflight 错误码、stageRows 映射均正确）。

### 2.2 与设计稿的三处刻意偏离（不要"修正"回去）

1. **登录页（屏01）删除**：复用军师登录浮层 `login-sheet`；游客可浏览（首页/模板/作品列表），只有出片/克隆/上传才 `host.requireLogin()`。这是军师的微信整改结论，不可回退。
2. **tabBar 作废**：分包不允许自有 tabBar，设计稿三 tab + 中央凸起按钮改为首页 + 入口行卡。
3. **积分不重复实现**（屏12 的钱包/充值部分）：跳军师 `packages/work/credits`。**对外定价数据归运营后台，代码里不许 seed 常量**。

### 2.3 服务端

军师 `/api/video/**` BFF 与 AIStar 独立 clip 域均已落地；身份桥固定为 service token + `externalOwnerId`，军师 JWT 不出域，积分只在军师侧 hold/settle/refund。AIStar 的 `packages/types/src/clip-studio.ts` 仍是另一个 MCN 真人切片台；本线使用新建的 `packages/types/src/clip.ts`。

---

## 3. Review 已知问题清单（开发时顺手修，不是紧急补丁）

上一 session 的 code review 结论，**只存在于此处**，务必带着这份清单开发：

### 逻辑 bug
1. **试听时长被丢弃**：[script/index.js:90] `commitEdit` 写 `actualDurationSec: 0`，把 `previewVoice` 刚回填的真实 TTS 时长清掉了。修法：记 `previewedText`，commit 时文本未变则保留时长。
2. **动态事件名绑定**：[shots/index.wxml:56]、[home/index.wxml:30] 用了 `bindtap="{{expr ? 'fn' : ''}}"`——全仓零先例、基础库兼容性存疑。改成固定 handler + JS 内分支（查 dataset / this.data）。

### 上生产前的防呆闸（现在是有意的桩）
3. **授权核验桩可直通**：[clone/index.js:61] toast 后照样进 step 2。加 `if (!config.isMock()) return;`，防止真闸没接就上线。这是全产品法律风险最高的闸（上游方案 §9.3）。
4. **克隆提交发的是本地临时路径**：[api.js:81 startClone 真实分支] POST `{filePath:'wxfile://...'}` 无意义，真实实现必须 `host.httpUpload` 上传文件。当前建议该分支直接 reject('待接入')，别留假接口。
5. **训练页进度只拉一次**：[clone/index.js:147] `pollTraining` 无 interval，UI 却显示百分比。照 rendering 页加轮询（onHide/onUnload 清理）。

### 设计缺口
6. **「再出一条」循环撞 10 层页面栈**：worst path 第二轮循环时 rendering→works 的 navigateTo 必失败。修法：[rendering/index.js:76 leave] 与 [work/index.js:90 again] 改 `wx.redirectTo`，让出片循环不涨栈。
7. **本地草稿只写不读**：host.js 的 `readDraft` 零调用点。要么在 script/shots 的 load 里做服务端失败→本地草稿回退，要么删掉写入侧（别留假承诺）。
8. **「恢复模板原文」只在 mock 下正确**：[script/index.js:166] 靠重拉 project 实现，真实模式拉回来的是用户已保存的编辑。需要专门 reset 端点（上游方案 §7 端点清单里没有，要补）。

### 次要
- confirm 页远端 estimate 覆盖后 `summary` 仍是本地算的（当前同源无害，留意分叉）。
- [shots/index.js:99] `result.segments === project.segments` 守卫恒 false（model 返回副本），死代码。
- script 页 `wx.createInnerAudioContext` 未 destroy。
- works 空态「去挑模板」navigateTo 又推一层 home，应 navigateBack。
- 录音权限被拒只 toast，没有 openSetting 引导（saveToAlbum 有，不一致）。
- `direct` 模式已删除且不得恢复：军师 JWT 只发给军师 BFF；AIStar 仅接受 service token + 显式外部属主，避免凭证跨域泄漏。

### 方案文档要顺手改的两处事实错误（`docs/VIDEO_SUBAPP_PLAN_2026-08-10.md`）
9. §5「这些 API 军师一次都没用过」不成立：`wx.chooseMedia` 已在 chat-core/behavior.js:1025、settings、poster 用过（**图片模式**）。真正新增面 = chooseMedia 的 video 模式、`wx.getRecorderManager`、`wx.saveVideoToPhotosAlbum`。另外 poster 有 chooseMedia 缺失回退 chooseImage 的写法，分包应照抄该特性检测。
10. §2.2「方案A 不用加合法域名」与「大文件走签名 URL 直传直取」矛盾：签名 URL 意味着必须加 aidrama OSS/CDN 的 uploadFile/downloadFile 域名（work 页的 `wx.downloadFile(work.videoUrl)` 已依赖此）。二选一并改文档。

### 测试欠账
- `model.js` 是纯函数但无测试。加 `app/scripts/video-model.test.mjs`（CJS require 直接可用，`npm test` 的 glob 已覆盖 `scripts/*.test.mjs`），锁住：toggleRole delta、尾段拒切、preflight 错误码、stageRows、以及 #1 修复后的「试听时长保留」。

---

## 4. 接下来的开发顺序（建议）

1. **修 §3 的 #1、#2**（几行的事，#2 影响核心屏），补 #3、#4 防呆闸，加 model 单测。
2. **补全前端桩**（都有 toast 占位标记，全局搜「待接入」）：预览、整段改写返回 segments、素材改标签、授权/使用记录、删除分身、代发。
3. **定后端接法并落地军师 BFF**：方案 A（军师 BFF 代理）已是推荐结论——积分只能有一本账（用户在军师充值）。新建 `server/src/routes/video.ts` + `server/src/services/video/`（aidramaGateway / credits / moderation），SSRF 防护照 `llm/tools/httpTool`。**军师 server 单测必须带 `.env.test`，裸跑会连 dev 库清数据。**
4. **aidrama 侧 clip 域**（在 AIStarEcosystem 仓库）：照上游方案 §6 数据模型 + §7 端点执行，同步 `specs/openapi.yaml`，每次提交过四门：
   `pnpm typecheck:all && pnpm typecheck:admin && (cd apps/server && ./mvnw compile -q -o) && pnpm check:api-contract`
   三条不可省的坑：job 自带 stale reaper（别照抄 DapJobRunner 的缺陷）、preset 素材要先补 admin 上传路由、代发只承诺抖音/快手/小红书/视频号四平台。
   **方案 A 最易漏的一条**：clip 表要存 `externalOwnerId`（军师 userId）做属主隔离，否则所有军师用户的作品混在一个 aidrama 服务账号下。
5. **M0 石榴尽调是真正的闸**（上游方案 §3.2 十项）：不达标整条线换引擎。服务端大规模开工前先拿测试 key 实测。

---

## 5. 铁律（违反会返工）

- 分包页面**只准 require `../host`（或 `./`相对文件）**，禁止直接碰军师 `services/*`；样式禁止 `@use` 军师 `src/`。这是「将来抽插件/独立小程序只换 host.js」的前提。
- 浏览免登录，落库/扣费才拦——登录门不得前置且必须可取消。
- 端上报价（model.js）只用于价格条即时反馈，**扣费一律以服务端为准**；`config.js` 的 `charsPerSecond=4` 和单价全是占位，M0 拿真实 TTS 时长后校准（设计稿「14句=2:42=68积分」自身不自洽，mock 跑出 1:24/26 分是正常的，见方案 §8#3）。
- AI 生成标识：端上角标已做（`.vd-ai-badge`），成片内水印/片尾由服务端渲染时加，端上那层不算合规。
- 深度合成备案绑军师主体和 appid——**开工大规模服务端前，先向微信侧确认军师加数字人口播是否触发新类目/重新提审**（方案 §8#2，这是「放进军师」的独有风险）。

---

## 6. 工程命令

```bash
# 军师小程序（app/ 目录下）
npm run build:weapp        # 构建到 dist-native（自动校验 app.json 声明的页面四件套齐全）
npm run dev:weapp          # watch 模式
npm test                   # typecheck + node --test scripts/*.test.mjs + src/**/*.test.ts
# 推真机预览：用 weapp-auto-preview skill（输出路径禁用 /tmp）

# 验 model.js 行为（不用起任何服务）
cd app/weapp-native/packages/video && node -e "const m=require('./model'); ..."
```

---

## 7. 待决问题（需要用户拍板的，别自作主张）

| # | 问题 | 状态 |
|---|---|---|
| 1 | 后端接法 A/B | 推荐 A，用户未最终拍板；config.js 已抽象，可先按 A 做 BFF |
| 2 | 军师加口播是否触发类目/重审 | 未问微信侧 |
| 3 | 视觉基调：分包暖橙 vs 军师墨绿，同一小程序两套色系 | 已按设计稿实现，需产品确认 |
| 4 | 石榴商务条款/产品名/模板授权/克隆定价 | 上游方案 §12 的 7 项，全部未决 |
