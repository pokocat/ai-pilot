# 快出片交接说明（2026-08-24）

换机继续做的人从这份开始读。分支 `docs/kuaichupian-plan-v5-1`，已推 origin。

---

## 1. 现在到哪一步了

方案定稿到 v5.1，可点击原型 13 块画板做完，**尚未开工写代码**。
上一轮结论：距离开工还差三件硬的（见 §5），其中第一件是没人。

**2026-08-24 这一轮做完的（§6 第 1～4 项）**：

- 闸门 A/B 的测试协议与 P0-a 出口判据的可验证版 → `docs/KUAICHUPIAN_GATE_PROTOCOL_2026-08-24.md`；
- 原型按 `catalog.js` 运行时真值全面订正，并删掉四处仍在演示 T2V 的界面；
- 首页四套编的模板换成真的三套，两套没内容的压灰标「即将上线」；
- Intake 改成「AI 按模板写好脚本，逐段确认」，把模板 `hint` 露出来。

§6 只剩第 5 项（mixcut 画板，可选）没做，另外发现三条新的（见 §6 下半）。
**§5 的硬阻塞一条都没变——第一件仍然是没人。**

本分支的提交：

| commit | 内容 |
|---|---|
| `abc2654` | 方案 v5.1 + 原型入库 + AGENTS.md 登记 SSOT |
| `7b714e2` | 本交接说明 |
| （本轮） | 闸门协议 + 原型订正 + 方案与 AGENTS.md 回填 |

`~/dev/product-ui-completeness`（审计 skill）是**另一个仓库**，`ee2684e` 初始提交，
只有本地，**没有远端** —— 换机拿不到，见 §2。

---

## 2. 换机要先解决的两件事

**(1) 审计 skill 没有远端。** `~/dev/product-ui-completeness` 只在原机器上有 git 库。
另一台要用 `/product-ui-completeness` 得先把它推上去。原机器执行：

```bash
gh repo create product-ui-completeness --private --source ~/dev/product-ui-completeness --push
```

新机器 clone 后建软链：

```bash
ln -s ~/dev/product-ui-completeness ~/.claude/skills/product-ui-completeness
```

**(2) 原型的 2.4MB 打包产物没入库。**
`docs/prototypes/v3-canvas/kuaichupian-flow-prototype.html` 已 gitignore。
要看原型走已发布链接，不要在新机器上找这个文件：

https://claude.ai/code/artifact/1588e454-03b6-4228-8fb4-cbe49d877304

改原型改同目录的 `*.dc.html` 和 `canvas.json`，重新打包要用 `/design` skill 的
`seed-canvas.mjs`（不在本仓库里，随 skill 走）。

---

## 3. 三份事实源，别改岔了

| 东西 | 位置 | 状态 |
|---|---|---|
| 方案正文 | `docs/VIDEO_STANDALONE_MINIAPP_PLAN_2026-08-19.md` | v5.1，唯一产品事实源 |
| 飞书同稿 | `https://qcni1ridpveu.feishu.cn/docx/SBcOdOH1foExsZx6L6ccA4sqnBb` | rev 102，与本地一致 |
| 可点击原型 | `docs/prototypes/v3-canvas/` + 上面的 artifact 链接 | 13 块画板 |

`docs/prototypes/VIDEO_STANDALONE_MOBILE_FLOW_V1.svg` 和 `V2.svg` 是**未采纳**的探索稿，
只做存档，不要拿去评审或当开发依据。

**双稿同步的命令**（改完本地正文后执行，整篇覆盖，不要 str_replace）：

```bash
lark-cli docs +update --command overwrite --doc-format markdown --content - < docs/VIDEO_STANDALONE_MINIAPP_PLAN_2026-08-19.md
```

飞书渲染有两个坑，写正文时就要避开：相对路径的 SVG 链接会挂，写成纯文本；
`**加粗**：**加粗**` 这种紧邻会渲染成字面量 `\*\*`，一段里只留一个加粗跨度。

---

## 4. 已定的事，不要再翻

决策全过程在方案 §14「决策演进记录」，这里只列最容易被重新讨论的：

- **起点只有一个：选模板**（§3.1）。本阶段**不开放自由创作**，用户不从空白开始。
- **首期三套模板**：为实体发声 / 企业宣传片 / 短视频带货（明星切片混剪）。
- **预览是单轨时间线**（§3.3），仿常见剪辑器。§3.3 里有「单轨 ≠ 专业剪辑器」的边界表，
  越界的需求（多轨、关键帧、转场编辑）按那张表挡回去。
- **T2V 整块移出 P0**。石榴网关没这能力，三套模板也都不依赖，见 §7。
- **文案口径、胶囊禁区、底部安全区**是约束项，写在 §3.7，不是建议。

---

## 5. 开工前的 gap（按是否卡住开工分层）

### 硬阻塞

**(1) 没有 owner。** §13.9 十二项全「待指派」，两道闸门没人认领，§11.0 三条投入前置
（人力排期、模板生产线责任人、只有 1/3 人力时的降级形态）一条没定。
这条不解决，下面所有 gap 都没人接。**这是第一位的。**

**(2) 三套模板里两套还不存在。**
为实体发声已有（`ct_shiti`），企业宣传片要新写（骨架可抄第一套），
短视频带货走 mixcut 明星切片、是另一套子系统，端上还要把两套模板目录聚合成一张列表
（§13.9 第 11 项，未定）。带货这套还卡在**明星肖像授权链条**（§13.9 第 10 项）——
切片来源、授权范围、能否商用、撤销后历史成片怎么处理，全没定。
这不是上线前补的合规项，是这套模板**能不能存在**的前提。

**(3) 预览契约这条纵向链路完全不存在。**
`shared/contracts.d.ts` 里 `PreparedClip` / `PreviewRender` / `timelineHash` **零处**。
现有契约只到整单级：

```ts
ClipRenderRequest { clientRequestId, expectedCredits }
ClipJobView { id, status, stage?, progress?, workId?, errorMessage? }
```

要补的是 SSOT → 数据库 → BFF → 生成底座 → 端上 API → 缓存失效 → 报价结算 → 审计一整条。
方案 §10.3 把「每镜可观察、恢复、取消」列在「继承」项下，**低估了**。

### 两道闸门还没跑，而且闸门本身就是开发量

| 闸门 | 现状 | 真实成本 |
|---|---|---|
| A · 手机时间线预览可行性 | 现有播放器刻意静音、无字幕（`shots/index.js:36`），只回答画面顺序 | 要先做音频主时钟 + 字幕轨 + 切源预加载 + 测量埋点**才能开始测**。方案里写的「半天到一天」没依据，已按 6～8 人日重估 |
| B · 代理片成本与并发闸 | clip 链路无并发闸、无代理档、无转场 | 要有可运行的 spike，约 4～6 人日 |

**测试协议已经写完**（2026-08-24）：`docs/KUAICHUPIAN_GATE_PROTOCOL_2026-08-24.md`，
机型、网络档位、冷热缓存、样本量、P95 算法、证据链、「无明显黑场」的逐帧判定全部落地。
**纯文档部分不再是阻塞——现在缺的是跑它的人和那两台判据机型。**

### 开工后做，但现在得有答案

| 缺口 | 现状 | 量级 |
|---|---|---|
| 段级状态没对端暴露 | `segmentJobsJson` 里数据全有，`/jobs/{id}` 不返回 | 小，加字段 |
| 段级失败 = 整单失败 | `fail()` 一抛整单 failed，没有「只重做那一段」 | 中 |
| clip 链路无并发闸 | 只有 `FfmpegRunner` 单次超时；mixcut 侧有 `maxConcurrent=2` | 中 |
| 单轨时间线页 | 全新页面，现有是逐段卡片 | 中 |
| **段级扣费/退费** | 军师侧 hold/settle 是整单 | **大，动钱** |
| 商品采集 | `packages/video/api.js` 零个商品接口，链接提取方案未定（§13.9 第 8 项） | 中 |

**出口判据不可签字**：已在协议文档 §4 给出可验证版（固定 ct_shiti、计时起止点、含全部系统等待、
P50 + P90 双线、供应商任务号 + 内容 sha256 双证据、真实用户素材的排除项、成本表估算占比上限）。
**但那是提案，需要拍板后回填方案 §11.0。** 另外「结构明显不同」这条经全文 grep 复核，
**根本不在方案正文里**，属于混剪带货模板的范畴，在第 3 套模板存在之前不进出口判据。
第 4 条（三套模板真实出片验收）在模板产出前无法开始。

---

## 6. 接手就能做的活

原来的 1～4 项已经做完（2026-08-24），留档如下：

1. ~~写闸门 A / B 的测试协议和出口判据的可验证版本~~ → `docs/KUAICHUPIAN_GATE_PROTOCOL_2026-08-24.md`。
   落到了机型清单（选取规则 + 推荐型号）、dummynet 网络三档、靠唯一签名 URL 而不是清缓存来定义冷热、
   样本量与灰区补跑规则、P95 用线性插值且先合并再算、端上埋点 + 60fps 录屏双证据、
   以及「无明显黑场」的逐帧可判定定义（YAVG < 16 且覆盖 ≥ 90%，P95 ≤ 33ms / max ≤ 100ms）。
2. ~~订正原型里的过期数字~~ → 六块画板全部改走 `ct_shiti` 运行时真值。
3. ~~首页四个模板换成真的三套~~ → 两套没内容的压灰标「即将上线」，并写清各自卡在哪。
4. ~~Intake 改成逐段确认~~ → 22 段全展开，每段给 `text`（讲什么）+ `hint`（放什么）。
5. **仍未做（可选）**：给 mixcut 明星切片流程补一块画板。
   但这套模板卡在 §13.9 第 10 项肖像授权，画了也可能白画，建议等授权有结论再动。

### 这一轮新发现的三条

6. **`ct_shiti` 的 `variables` 是死数据。** 模板声明了 shopName / street / years / ownerName，
   但**段落正文里没有占位符，端上也没有替换逻辑**（`template/index.js` 只读 `scriptSkeleton.segments`，
   全仓 grep `{{shopName}}` 计数 0）。§3.1 原写的「AI 据此填模板变量」是一个不存在的能力，
   已改成「逐段改写」（`api.aiRewrite` 是真的）。**变量是补齐替换机制还是删掉，待拍板。**

7. **闸门 A 的漂移判据覆盖不到真实片长。** 「45 秒 ≤ 200ms」是按 45 秒带货片写的，
   而 P0-a 唯一存在的模板是 163 秒。线性外推约 725ms，闸门能过而口型对不上。
   协议 §2.5 提了修订建议（补 163 秒 ≤ 400ms 与 15 秒滑窗 ≤ 125ms），**待拍板**。

8. **原型第一行三块画板还没跟上。** 资料库 / 作品 / 语音输入仍在讲「五金收纳箱 · 45 秒带货」，
   而带货模板并不存在——作品页那条 45 秒成片等于假装这套模板已经上线了。
   主链五屏已经改走 `ct_shiti`，这三块没跟。canvas.json 里有 `todo-row1` 批注标着。

---

## 7. 已经查证过的技术事实，别重复查

这些是上一轮实际读代码 / 跑代码得出的，直接用：

- **`ShiliuGateway` 没有 T2V / I2V。** 接口只有：previewVoice、createVideoByText、
  createVideoByAudioFile、cloneAvatar、cloneVoice、recreateVoice、cloneAvatarByImage、
  createAuthorizationVideo、query。
- **段级状态是存在的**，在 `ClipRenderWorkerState.segmentJobsJson` 里
  （no / role / status / taskId / audioCdnKey / videoCdnKey / actualDurationSec），
  worker 可恢复、会跳过已完成段 —— 只是没对端暴露。
- **但 `fail()` 把整个 job 标失败**，没有段级失败/重试。
- **`shared/contracts.d.ts` 无 PreparedClip / PreviewRender / timelineHash**（grep 计数 0）。
- **`packages/video/api.js` 无商品、链接提取、goods 相关接口**。
- **`catalog.js` 的 `listBuiltInTemplates()` 会用段落文本重算
  `estDurationSec` / `avatarSecHint` / `creditHint`，覆盖硬编码常量。**
  以运行时为准，别信文件里那几个字面量。`ct_shiti` 真值：

  ```
  163 秒 | 数字人 32 秒（第 1、7、13、21 段） | 35 钻石 | 22 段 | 数字人占 20%
  ```

  端上白名单 `OFFERED_TEMPLATE_IDS` 目前只放出 `ct_shiti`；
  `ct_kaimen` / `ct_shouyi` 服务端仍 seed，端上过滤掉了。
- **AIStar 相关结论来自 `~/dev/AIStarEcosystem`**，是另一个仓库，不在本工作区。

---

## 8. 分支怎么收

现在在 `docs/kuaichupian-plan-v5-1` 上继续做就行。要合回 main：

```bash
git switch main && git merge --ff-only docs/kuaichupian-plan-v5-1 && git push
```

或者开 PR：https://github.com/pokocat/ai-pilot/pull/new/docs/kuaichupian-plan-v5-1
