# 快出片开发进展（2026-09-02，分支 `spike/gate-a-preview`）

给换机接手的人看的。方案正文在 `docs/VIDEO_STANDALONE_MINIAPP_PLAN_2026-08-19.md`（分支 `docs/kuaichupian-plan-v5-1`），
这份只记这条分支上**落了什么代码、验到什么程度、卡在哪**。

## 一、已落地（按提交顺序）

| 提交 | 内容 | 验证 |
|---|---|---|
| `053b529` | 闸门 A 验证页 `packages/video/gatea/` + 对齐标记片生成 + 录屏分析脚本 | 打桩自测全绿；零漂移参考片上方法噪声 < 1ms |
| `d0d9399` | 段内 seek 回拉会锁死播放 → 改为切段时对齐 | 模拟器：间隙 P95 34ms、首帧 149ms、45 秒漂移 9ms |
| `31ed8d4` | 跨跑次并池（协议 §1.4）+ 真机跑测手册 `docs/KUAICHUPIAN_GATE_A_RUNBOOK.md` | 自测 21→42 并池 |
| `0723598` | **单轨时间线预览页** `packages/video/preview/`（设计稿 Main） | 打桩自测 + 模拟器三态截图 |
| `e3b11ec` | **四 tab 壳**：`components/vd-tabbar`、首页改模板信息流、新建「我的」、作品/资料库挂底栏 | 模拟器游客态 + mock 登录态各一遍 |
| `28f3495` | 改文案页露出模板 hint / 角色 + 「已选模板」事实卡 + `no` 深链 | 模拟器 21 行、14/17 段带 hint |

自测脚本都在 `scripts/`：`test-gate-a-page.mjs`、`test-preview-page.mjs`（不需要开发者工具）；
`smoke-*.mjs` 要开发者工具开着自动化端口 9420。

## 二、与设计稿的差距，现在剩什么

| 设计稿 | 状态 |
|---|---|
| Home 首页 / Main 时间线 / Profile 我的 | 已落地 |
| Intake 确认脚本 | 部分：hint / 角色 / 事实卡落了；「从一句话提取主体 / 目标 / 受众」和「怎么称呼你」问答**没有接口**，没做 |
| Start 说一句话 | 未动。它的下游是「AI 按模板写全片」，现有 `api.aiRewrite(scope='all')` 是改写不是从零写，语义要先对齐 |
| Adjust / Checkout / Rendering / Works / Library | 已有页面，未按新设计稿重排 |
| 四 tab 还是三 tab | 按设计稿做了四个；方案 §1088 写三个，**待拍板**。改回只需删 `vd-tabbar` 的 TABS 一项 |

## 三、卡在服务端 / 契约的（端上做不了）

1. **配音（TTS）预览地址**：项目数据里没有。时间线页现在退成内部计时器当时钟，界面明说「还没有配音」。接口一到只换时钟来源（`preview/index.js` 的 `startClock`）。
2. **预览契约**：`shared/contracts.d.ts` 里 `PreparedClip / PreviewRender / timelineHash` 仍是 0 处。
3. **段级状态对端暴露**：`segmentJobsJson` 里有，`/jobs/{id}` 不返回。
4. **模板变量替换**：正文没有占位符、端上没有替换逻辑。「改一个称呼全片同步」是不存在的能力。
5. **另外两套模板内容**：企业宣传片、短视频带货。首页上标「即将上线」并写明原因。

## 四、闸门 A 真机

模拟器结论：已定判据全过，§2.5 建议的「任意 15 秒滑窗漂移 ≤ 125ms」不过（454ms）。
真机四机型 × 三网络档 × 冷热未跑，步骤在 RUNBOOK。跑之前先定协议两处缺口（163 秒读数采不到、标记片 180 vs 163）。

## 五、已知不一致，没动

- 分镜页写「35 积分」，首页 / 预览页 / 改文案页走 `model.formatCredits` 出「35 钻石」。单位归运营口径，该统一到一处。
