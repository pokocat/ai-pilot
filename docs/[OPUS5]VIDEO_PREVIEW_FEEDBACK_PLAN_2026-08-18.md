# 「快出片」用户反馈处置方案（2026-08-18）

来源：主理人公社 AI 学习群真实用户反馈截图。
讨论方：Opus 5（主）+ codex-cli（对手方，两轮）。所有事实性结论均已回代码核对，行号在正文。

**本文按截图里的每一条消息单独立项，不做合并。** 编号 F01–F16 对应截图从上到下的消息顺序。
识读置信度标 ⬤ 高 / ◐ 中 / ○ 低；○ 的几条在 §4 列出，需要你确认原意。

---

## 1. 逐条处置

### F01　上传视频时军师报错，只能重新上传一遍　⬤

> 原话：「视频上传的模板，军师会提示…没反应，又重新上传」
> 你追问的「数字人训练已结束的报错」就是这一条。

**这是一个确定的 bug，已定位到精确成因。**

报错原文在 [video.ts:632](server/src/routes/video.ts:632)：
`CLIP_CLONE_REQUEST_CLOSED` →「这次训练已经结束，请重新提交」。

触发链：

1. 用户选好视频点「创建真人数字分身」。请求带一个 `clientRequestId`
   （[clone/index.js:464 ensureCloneRequestId](app/weapp-native/packages/video/clone/index.js:464)，
   键是 `filePath|expectedCredits`）。
2. 服务端先 `reserveCloneCredits` 预扣钻石，再上传给 AIStar。中间任一步失败，
   `catch` 里 `refundCloneHold(hold.id,'submit_failed')` 把这笔预扣**退款**（[video.ts:676](server/src/routes/video.ts:676)）。
3. 这时如果端上收到的是**没有 statusCode 的纯网络失败**（大视频传到 180 秒超时、断网、切后台），
   [handleCloneError](app/weapp-native/packages/video/clone/index.js:491) 会**故意保留** `cloneRequestId`
   —— 设计意图是"重试要被识别成同一次提交，避免重复扣费"。
4. 用户在原页面**再点一次**同一个按钮 → 同 filePath、同 requestId →
   服务端 `reservation.reused === true` 且 hold 已 refunded → 抛
   **「这次训练已经结束，请重新提交」**。
5. 用户把这句读成"要重新上传"，于是重新选一次视频（新的 tempFilePath → 键变了 → 新 id）→ 才成功。

也就是说：**用户实际要点三次、传两次视频，而第二次的报错是设计冲突造成的死路。**
"保留 requestId 防重复扣费"这条规则和服务端"refunded 的 hold 不可复用"这条规则互相打架。

**同一个 bug 在出片链路上更严重**：[confirm/index.js:34](app/weapp-native/packages/video/confirm/index.js:34)
的 `renderRequestId` 只在 `onLoad` 生成一次，`submit()` 失败后**从不刷新**。
所以出片提交遇网络失败后再点，会撞 [video.ts:347](server/src/routes/video.ts:347)
`CLIP_RENDER_REQUEST_CLOSED`「该出片请求已经结束，请重新提交」，
而且这一页**永远好不了**——用户必须退出确认页重新进来才能出片。

**修法**：
- `handleCloneError` 收到 `CLIP_CLONE_REQUEST_CLOSED` 时，清掉 requestId 并**自动重提一次**，
  用户无感；文案同时改成"网络中断了，正在为你重试"而不是"请重新提交"。
- 纯网络失败也应做**有界重试**（同 requestId 重试 1–2 次），而不是把判断责任丢给用户。
- `confirm/index.js` 的 `renderRequestId` 在每次 `submit` 失败后重新生成。
- 两条 `..._REQUEST_CLOSED` 文案统一改成用户能执行的动作，不要出现"重新提交"这种会被读成"重新上传"的词。

**验收**：拔网模拟一次提交超时，恢复网络后**再点一次原按钮**必须成功，且全程只上传一次视频、不重复扣费。

---

### F02　每段画面的素材"限多少秒"没有任何地方说　⬤

> 原话：「替换上面的模板，每一个对应的视频限多少秒？这个还要匹配视频画面吗？」

**这不是 bug，是产品从来没告诉过用户规则。** 规则本身是清楚的：

- **素材本身没有时长上限。** 现拍限 30 秒（[shots/index.js:301](app/weapp-native/packages/video/shots/index.js:301)
  `maxDuration: 30`、[assets/index.js:241](app/weapp-native/packages/video/assets/index.js:241)），
  但**从相册选不受这个限制**。
- **每段画面播多久，由那一段口播的时长决定，不由素材决定。**
  合成端 [ClipAssemblyService.normalizeBroll](/Users/donis/dev/AIStarEcosystem/apps/server/src/main/java/com/aistareco/aep/clip/service/ClipAssemblyService.java:247)
  用 `-stream_loop -1` + `-t <口播时长>`：**素材短了循环补满，长了直接截断**。
- 所以"要不要匹配画面"的答案是：**只要素材 ≥ 这一段口播的秒数就不会出问题**；短了会看到画面从头硬跳一次。

端上现在只有**事后**提醒（[shots/index.js:137 assetTooShort](app/weapp-native/packages/video/shots/index.js:137)
「素材 X 秒，短于本段 Y 秒，画面会重复播放」），选之前什么都不说。

**修法**：段行卡在**还没配画面时**就写清「这段需要约 N 秒画面 · 视频或图片都行 · 短了会重复播放」；
挑素材时按"够不够 N 秒"给标记；相册选到超长素材时说明"只会用前 N 秒"。

**验收**：用户在点"配画面"之前就能读到这一段要多少秒。

---

### F03　保存完直接就生成了，没有预览版　⬤

> 原话：「这个视频保存了，就直接生成了，有没有可以做成预览版？…也没有看到预计的效果」

**属实。** 配画面页 → 确认页 → 点提交 → 直接扣费真出片，中间没有任何"看效果"的档位。
唯一能感知的只有单句试听（[script/index.js:144 previewVoice](app/weapp-native/packages/video/script/index.js:144)）。

这条与 F09/F10/F11/F12 是同一诉求的不同表述，**统一由 §3 的"排练片 + 数字人试镜"回答**，
但每一条的验收标准不同，见各条。

**本条验收**：确认页在扣费按钮之上必须有一个不扣正片费用的"先看排练片"入口。

---

### F04　素材只能传视频吗，能不能换成图片　⬤

> 原话：「上传这个素材，只能上传视频吗？能不能把它替换成图片也可以？」

**能力早就有了，是入口没说。** 三处都支持图片：
[shots/index.js:301](app/weapp-native/packages/video/shots/index.js:301) `mediaType:['video','image']`、
[assets/index.js:234](app/weapp-native/packages/video/assets/index.js:234) 同样、
合成端 `normalizeBroll` 明确接受 `image`。素材卡也会显示"图片素材"。

问题在于选素材的 actionSheet 文案是「拍一段 / 从相册选 / 我的素材库」——
"拍一段""选"这些词让用户以为只能是视频。

**修法**：actionSheet 文案改成「拍一段视频 / 从相册选视频或图片 / 我的素材库」；
空态提示写「视频或图片都行，图片会按这段口播的时长静止展示」。

**验收**：不看文档的新用户能直接知道可以传图片。

---

### F05　合并两段时，不能选保留上面还是下面的素材　⬤

> 原话：「与下一段合并的时候，能不能有个选择，选上面还是下面的视频素材保留」

**真缺口。** [model.js:475 mergeAdjacentShots](app/weapp-native/packages/video/model.js:475)：
两段素材不同时直接 `assetId: null`（[:486](app/weapp-native/packages/video/model.js:486)、
[:492](app/weapp-native/packages/video/model.js:492)）。
端上 [shots/index.js:mergeNext](app/weapp-native/packages/video/shots/index.js:214) 已经会弹确认框告知
"合并后需要为整段重新选择一个画面"，但只给了**确定 / 取消**两个选项。

**修法**：`mergeAdjacentShots` 加参数 `keepAssetFrom: 'current' | 'following' | null`；
端上把 confirm 换成 actionSheet 三选一：「保留上面那段的画面 / 保留下面那段的画面 / 合并后重新选」。
补 `app/scripts/video-model.test.mjs` 用例。

**验收**：合并后能保留任一侧素材，不再强制重选。

---

### F06　合并之后素材好像要重新传　⬤

> 原话：「现在2段合并了，素材就好像重新传」

**F05 的直接后果，但要单独验收。** 素材被清空后，端上的"配画面"入口默认走
[pickAsset](app/weapp-native/packages/video/shots/index.js:279) 的 actionSheet，
三个选项里"我的素材库"排在第三位，前两个是"拍一段""从相册选"——
用户第一反应就是又要拍一遍/传一遍，而其实原素材还在库里。

**修法**：F05 修好后这条自然消失大半；此外把 actionSheet 的顺序改成
「我的素材库（N 个）/ 从相册选 / 拍一段」，已经传过的素材永远排第一。

**验收**：任何"要重新配画面"的场景，用户第一眼看到的都是"从已传的素材里挑"。

---

### F07　生成中看不到大概什么时候完成　⬤

> 原话：「这个能不能设计成看到大概什么时候完成？」

**真缺口，而且端上有一个从没被赋过值的死字段。**
[rendering/index.js:21](app/weapp-native/packages/video/rendering/index.js:21) 的 `etaText: ''`，
`poll()` 全程没 set 过它，wxml 里也没用；
[works/index.wxml:53](app/weapp-native/packages/video/works/index.wxml:53) 引用了 `item.etaText`，
但那个值只有 [mock.js:73](app/weapp-native/packages/video/mock.js:73) 造得出来。
服务端 `ClipJobView`（`packages/types/src/clip.ts:127`）只有 `status/stage/progress`，没有 eta。

**修法分两步，不要一步到位**：
1. **先把"不用盯着"这件事解决**：出片完成发微信订阅消息。
   [wechatSubscribe.ts:35-42](server/src/services/wechatSubscribe.ts:35) 的注释已经写明
   "以后新增异步任务（**视频出片**、批量导出…）照抄这一行即可，**不要**再加新的 env"——
   加一个 `clip` scene 复用 `WECHAT_SUBSCRIBE_AVATAR_TEMPLATE_ID` 就行，成本极低。
2. **再出 ETA**：先埋点记录每个 stage 的开始/结束和供应商轮询耗时，攒够样本后返回
   **区间**（"预计还需 4–8 分钟"）。当前 worker 没有严格队列位次、石榴轮询耗时波动大，
   **不要伪造"排队第几位"或精确倒计时**。

**验收**：第一步——用户可以退出小程序，出片好了微信会推给他。第二步——进度页显示的是区间且不会跑飞。

---

### F08　发出去的片子好像没有封面　◐

> 原话（识读不完全）：「我发的这个，估计也是没有封面的…」

**成因已定位**：封面在成片里的长度是 **0.04 秒**
（[ClipAssemblyService.java:40](/Users/donis/dev/AIStarEcosystem/apps/server/src/main/java/com/aistareco/aep/clip/service/ClipAssemblyService.java:40)
`COVER_DURATION_SEC = 0.04`，30fps 下约 1.2 帧）。它是**故意**这么设计的——
封面的用途是当视频第一帧和平台缩略图，不占正片时长。
成片页确实用它当 `poster`（[work/index.wxml:28](app/weapp-native/packages/video/work/index.wxml:28)）。

但用户把片子发到抖音/视频号之后，**平台用不用第一帧当封面是平台说了算**，
我们这边没有任何地方告诉过用户这件事，也没给他一张能单独下载去手动设封面的图。

**修法**：
- 成片页把封面**单列成一张可保存的图片**，文案写清"封面只作为视频第一帧和平台缩略图，不占正片时长；
  发布时如果平台没自动取，可以用这张图手动设置"。
- **不改 `COVER_DURATION_SEC`**——改它会改变正片时长和既有产品定义。
  要肉眼可见的开头，应该新增独立的"片头卡 1.5 秒"开关并明确告知会增加时长。

**验收**：用户能从成片页单独存下封面图，并且知道它是干什么用的。

---

### F09　封面当时设置了字，出来看不到　◐

> 原话（识读不完全）：「这个封面当时没有设计字，但是出来是没有的…」

与 F08 同源但**是不同的问题**，要分开查：F08 是"平台没取到封面"，
F09 是"我在封面页填了字，成片里看不见"。

除了 0.04 秒这个共同原因，还有两个独立嫌疑，需要按顺序排查：
1. **封面开关根本没打开**。封面页是确认页的**可选支线**
   （[confirm/index.js:goCover](app/weapp-native/packages/video/confirm/index.js:117)），
   `cover.enabled` 默认 false。用户填了字但没打开开关，`ClipCoverPlan.parse` 返回 empty，
   `prependCover` 直接 `return false`，整张封面不生成。
2. **端上预览与服务端烧录不是一套渲染**。封面页自己在注释里写了
   ([cover/index.js:1-9](app/weapp-native/packages/video/cover/index.js:1))：
   端上是 CSS 用宋体近似，真正的字体/描边由服务端 Java2D 烧录（`ClipCoverRenderer`）。
   版式对得上、像素对不上是有意的，但如果用户填的字**超出槽位长度**被截断，端上和服务端的截断点未必一致。

**修法**：
- 封面开关的状态必须在确认页的封面摘要行上明确显示"已开启/未开启"，
  未开启时不允许页面看起来像"已经设好了"。
- 封面入口从确认页支线**提前到配画面完成后**，让它成为主流程的一步而不是一个容易漏掉的支线。
- 排练片里带上封面（给它 1.5 秒并标注"这是封面，成片里只占第一帧"）。
- 字数超限时端上就按服务端的规则截断并给出提示，不要两边不一致。

**验收**：用户在出片前就能确认"我的封面开了没、字是不是这样"。

---

### F10　合成前那个"预览"只能看流线，看不到效果　⬤

> 原话：「合成前那个预览是可以浏览整体流线的，但…没法预览，只能合成的时候先赌了」

**属实，而且现在这个东西叫"预览"是过度承诺。**
[shots/index.js:preview()](app/weapp-native/packages/video/shots/index.js:341) 打开的是一个
**静态故事板浮层**：每段一张静帧 + 角色标签，
[shots/index.wxml:95](app/weapp-native/packages/video/shots/index.wxml:95) 标题写的就是"出片前预览"。
它既没有声音、没有字幕、没有转场，也没有真实时长感。

**修法**：
- 立刻把这个浮层改名为**"分镜清单"**，并在里面明说"这里只核对顺序和画面，效果请看排练片"。
  不能让一个静态列表继续占着"预览"这两个字。
- "预览"这个词留给 §3 的排练片。

**验收**：用户不会再把分镜清单当成预览而产生错误预期。

---

### F11　这样不行，效果我们完全控制不了　⬤

> 原话：「那这样不行，这效果我们完全控制不了」

这是用户对整条链路的**总评**，不是一个具体功能点，但它给出了验收标准：
**用户必须在扣正片费用之前，看到一条能播的、和成片同一套时间轴的片子。**

需要注意 codex 提的一点，我认同：**排练只能暴露问题，未必能调整问题**。
如果用户看到"字幕太大压住了脸"却没有任何地方能改，那还是不受控。
所以排练片落地时**至少要配齐**：字幕字号/安全区、素材裁切焦点、语速/停顿、BGM 音量这几个可调项。

**验收**：用户看完排练片说得出"我要改哪里"，并且改得动。

---

### F12　开拍、剪映合成前都能先预览　⬤（已确认）

> 原话：「开拍、剪映都可以先预览」

竞品明确了：**开拍**（口播拍摄 / 提词一键成片）和**剪映**（时间线编辑器）。
这两个的预览都是**本地实时渲染**——拖一下立刻能看、看多少次都不要钱。

这条给出的不是一个功能点，而是**体感标准**：用户的锚点是"编辑态就能看"，
所以预览必须满足三件事——**即时、免费、可反复**。

这一条直接改变了方案取舍：原本我把"端上即时排练"定为排练片失败时的兜底，
**这个定位是错的**。对着剪映的锚点，一条要等几十秒的云端 MP4 再快也不是同一个东西。
正确的形态是**两档并存、用户自选**（详见 §3 改后的方案表）：

| 档 | 形态 | 等待 | 用途 | 诚实标注 |
|---|---|---|---|---|
| **快速档** | 端上即时排练（真 TTS 音频 + 真素材 + 静帧，端上拼播） | 秒开 | 看节奏、看顺序、看素材接得顺不顺 | "字幕位置和转场以成片为准" |
| **精确档** | 服务端排练片 MP4（与正片同一套时间轴） | 热缓存 15s / 冷 45s | 看字幕、看封面、看真实成片观感 | "出镜段是静帧，口型请看试镜" |

我原先反对纯端上方案的两条理由（三条时间轴在真机上会漂、`<video>` 是原生层级字幕只能用排版能力很差的
`cover-view`）**依然成立**——所以它只能当快速档，不能取代精确档，也不能拿它去验收字幕。
但把它降级成"兜底"同样是错的：它是唯一能对上剪映体感的那一档。

**验收**：用户在配画面页点一下就能立刻看到节奏；想看准确效果时再花几十秒要一条精确档。

---

### F13　模板能浏览，但不知道套上自己文案是什么效果　⬤

> 原话：「上传的模板、数字人是可以浏览，但没有一个预览，不然就不知道套上每个模板文案怎么样了」

模板详情页现在**只有尾卡能预览**
（[template/index.js:108](app/weapp-native/packages/video/template/index.js:108)，
没有尾卡视频时还会 toast"这个固定片段暂时没有预览视频"）。

**修法分两层，不要混为一谈**：
- **模板层**：给每个模板配一条平台预生成的 10–15 秒标准样片（用官方形象+官方文案）。
  这解决"这个模板大概长什么样"。
- **个性化层**：套上**我的**文案和**我的**分身，那就是排练片，要等用户先有文案和镜头。
  **不要**把模板页的"开始制作"直接改成"生成排练片"——用户在那一步还没有内容。

**验收**：模板页每个模板都有可播的样片；用户在有了文案之后能生成属于自己的排练片。

---

### F14　数字人（分身）也没有预览　⬤

> 原话：「上传的数字人是可以浏览，但是我们没有一个浏览」

**这是排练片盖不住的那块**，也是本轮性价比最高的一项。
分身页现在只有一张静帧（`imagePreviewUrl`，由 `ClipAvatarPreviewExtractor` 抽的），
静帧证明不了口型、动作和构图。

**做法（回答你的第三个问题）**：**真实提交给石榴，不是模拟。石榴有现成接口，不需要新增供应商能力。**

`ShiliuGateway`（`/Users/donis/dev/AIStarEcosystem/apps/server/src/main/java/com/aistareco/aep/clip/service/shiliu/ShiliuGateway.java`）
已经有两条生成路径：
- `createVideoByText(ownerId, avatarRef, speakerRef, text)` —— **直接给文本，出数字人视频**。试镜用这条最省事。
- `createVideoByAudioFile(ownerId, avatarRef, audioRef)` —— 音频驱动，正片走的是这条（段 TTS 音频驱动）。
- `query(taskId)` —— 轮询任务（石榴纯轮询无回调）。

所以试镜 = 拿一段 3–5 秒的固定中性文案，调一次 `createVideoByText`，轮询到成片存下来。
成本 ≈ 3–5 个 avatar 秒 + 一点 TTS，**按 `avatar + voice + engineVersion` 缓存，一次生成永久复用**，
换声音或引擎版本才重生成。

**验收**：分身管理页和配画面页都能播同一条真实口型视频；重复查看不再调供应商；换声音后自动重生成。

---

### F15　想把已上传的视频直接拼出来看　⬤（已确认）

> 你的确认：「打算把已上传视频做预览」

**这条含金量比我原先估的高**——它是用户自己想出来的实现思路，而且和我们的排练片方案撞在一起了。
它同时说明两件事：

1. **用户能接受"数字人段先用静帧"**。他关心的是"我传的这些画面拼起来是什么样"，
   而不是"必须先看到数字人说话"。这大幅降低了排练片用静帧顶替的产品风险
   （口型那块由 F14 的试镜单独兜住）。
2. **有一个零成本的小功能可以本周就上**：素材连播。

**素材连播**（新增，第一档）：在分镜清单里加一个"按顺序播一遍我配的画面"——
纯端上 `<video>` 顺序播放已配好的 b-roll，**不带 TTS、不带字幕**。
因为没有音频，就不存在音画同步问题，我反对端上方案的理由在这里完全不适用。
它回答的是用户最朴素的那个问题："我传的画面顺序对不对、接得顺不顺"。

**验收**：配完画面立刻能连着看一遍自己的素材，零等待、零费用、不调任何后端。

---

### F16　还是在说没法先预览成片效果　⬤（已确认）

> 你的确认：「还是表达没法先预览成片效果」

归入主诉。它与 F03 / F10 / F11 / F12 同源，但**验收口径取最严的那条**：
用户说的是"成片效果"，所以最终验收必须由**精确档排练片**（与正片同一套时间轴）来满足，
快速档和素材连播都不能替它签字。

---

---

## 1b. 本次对话新增

### V01　训练出来的声音，没地方先听一下　⬤

> 提出：2026-08-18 对话追问 ——「训练出来的数字人声音效果不确定，能不能给一段文字让它念出来，
> 先听效果，免得做成片才发现不好、白花钻石」

**能力有，我们也已经接了，但入口开在了一个用户到不了的地方。**

**石榴官方支持。** 接口是 `POST /speaker/tts`，入参 `speakerId` + `text`，
**同步**返回 base64 音频 + `length`（时长），见
[HttpShiliuGateway.previewVoice](/Users/donis/dev/AIStarEcosystem/apps/server/src/main/java/com/aistareco/aep/clip/service/shiliu/HttpShiliuGateway.java:53)。
文本上限 10000 字符、音频上限 20MB，念一段几十字的样例毫无压力。

**这条链路已经通了，而且不扣用户钻石。**
BFF 的 [/video/projects/:id/preview-voice](server/src/routes/video.ts:307) 是**纯透传**，
没有任何 `reserveCredits` / hold / settle（对比 render 和 clone 两条路由都有）。
它只消耗石榴侧的 `validPoint`，那是我们承担的供应商成本。
**所以"先听一遍再决定要不要出片"对用户是免费的，产品上可以放开，只需要加限流。**

**问题在入口。** 服务端实现
[ClipScriptService.preview](/Users/donis/dev/AIStarEcosystem/apps/server/src/main/java/com/aistareco/aep/clip/service/ClipScriptService.java:44)
的签名是 `preview(owner, projectId, no, text)` —— **必须先有一个 project**，
再从 project 的 payload 里取 `avatarId`/`voiceId` 去解析 speakerRef。
端上也只有文案页有试听按钮（[script/index.wxml:97](app/weapp-native/packages/video/script/index.wxml:97)「试听这段」），
`voices/`（我的声音）、`avatar/`（分身管理）、`clone/` 训练完成页
**一个试听入口都没有**（grep 三个页面的 wxml，零命中）。

于是用户想听一下刚训好的声音，实际要走：
**挑模板 → 建项目 → 进文案页 → 点开某一句 → 试听这段**，
而且听到的是那个项目绑定的声音，不是他想听的那一条。

**修法（本周可上，成本很低）**：
1. AIStar 加一个不依赖 project 的方法：按 voiceId 直接解析。
   `requiredVoiceEngineRef(owner, avatarId, voiceId)`
   （[ClipAvatarService.java:412](/Users/donis/dev/AIStarEcosystem/apps/server/src/main/java/com/aistareco/aep/clip/service/ClipAvatarService.java:412)）
   本来就支持只给 voiceId，改动极小。
2. BFF 加 `POST /video/voices/:id/preview`，同样纯透传不扣费，但**加限流**（建议每人每分钟 5 次）。
3. 端上三处加"试听"：
   - **训练完成页**：训好的第一时间就给一句"听听你的声音"，这是心理峰值时刻。
   - **声音列表 `voices/`**：每条声音一个试听按钮。
   - **分身管理 `avatar/`**：每个分身能听它关联的那条声音。
4. 试听文案：给一段默认样例（用官方模板里的句子），同时**允许用户自己输入一句**——
   用户往往想听的正是自己文案里那句最难念的。

**这条和 F14 数字人试镜是一对，不要只做一个**：
**试听回答"声音像不像我"，试镜回答"口型和画面对不对"**。
两个都在出片扣费之前，合起来才是用户说的"免得做出来效果不好，浪费钻石"。

**验收**：训练完成后不必新建任何项目，当场就能让自己的声音念一句自定义的话；
声音列表和分身管理里每一条都能听；全程不扣钻石。

---

## 2. 讨论中暴露的、用户没说但必须先修的地基

这几条是 codex 提出、我回代码核实成立的。**它们先于任何预览能力**。

### 2.1 快照缺口（比第一轮判断的窄，但仍成立）

**更正**：我第一轮说"出片中还能改文案"是错的。`ClipProjectService.java:51` 有守卫
`if (!"draft".equals(p.getStatus())) throw CLIP_PROJECT_NOT_EDITABLE`，
而 `ClipRenderService.render` 会把项目置为 `generating`，所以**正片出片期间文案确实改不动**。

但快照工作仍然必须做，理由变了：

1. **守卫只盖住 project payload，盖不住引用的东西**。出片期间用户照样能删素材、改分身、换声音；
   worker 每阶段都重新 `ClipShotPlan.materialize(p.getPayloadJson())`（`ClipRenderWorkerState.java:54`）
   并按 assetId / avatarId 去取件。
2. **排练期间项目必然是可编辑的**。预演的设计前提就是不把项目置为 `generating`（否则用户没法边看边改），
   于是"排练看 A、出片出 B"这个洞在加了排练之后必然出现。
3. 报价 hash 与提交 hash 不一致时应直接 `CLIP_QUOTE_CHANGED`，不建任务、不扣费。

**处置不变**：`ClipRenderJob` 落 `renderSpecHash` + 规范化快照，worker 只读快照。
但优先级从"阻断级"下调为"排练片的前置"。

### 2.1b 出片失败/取消后项目被永久锁死（新发现，独立 bug）

`ClipProjectService.save` 只放行 `draft`，而全仓**没有任何一处把状态改回 `draft`**
（`grep -rn 'setStatus("draft")' apps/server/.../clip/` 无结果）。
`ClipRenderWorkerState.failProject(j,"failed")` 和 cancel 都把项目置为 `failed`。

后果：**出片失败或取消之后，用户再也改不了这个项目**——想改一句话重出都不行，只能从头新建。
出片进度页的 `retry()`（`rendering/index.js:82`）把用户送回确认页，那一页能重新提交，
但只要用户想"改一点再出"，就会撞 `CLIP_PROJECT_NOT_EDITABLE`。

**处置**：失败/取消时把项目状态回落到 `draft`（或引入 `editable` 语义与 `status` 解耦）。
这条与预览无关，是独立的、可以本周就修的闭环缺口。

### 2.2 TTS 没有缓存（决定预演经济性）

出片 tts 阶段调的就是单句试听同一个供应商接口
（`ClipRenderWorkerState.java:70` vs `ClipScriptService.java:46 gateway.previewVoice`），目前**零缓存**。

不做缓存，预演和正片会各付一次 TTS，且用户预演听到的声音未必等于成片。
**处置**：按 `voice + text + 语速/发音配置` 哈希缓存音频产物，预演产出的音频正式出片直接复用。

### 2.3 b-roll 计费口径分叉

- 服务端权威报价 `ClipEstimateService.java:34` total = `tts + avatar + assemble`，`brollCount` 只进 summary；
  `ClipProperties` 里**根本没有 broll 的价键**（只有 avatarSecond / ttsPerKchar / assemble）。
- 端上 `packages/video/config.js:33 creditPerBrollSegment: 1` 却在算。

确认页首屏用端上估价、随后被服务端报价覆盖，所以不会 422，但数字会当着用户面跳一下。

**处置**：往**端上删掉 broll 计费**这边统一（服务端补价键等于新增一个对外价格，而对外定价数据归运营后台，
代码里不许 seed 常量）。若运营确实要对 b-roll 收费，走后台配置新增，不在这一轮做。

### 2.3b 出片对外定价现在不在运营后台（待你拍板）

`ClipEstimateService` 的三个价都来自 AIStar 的环境变量
（`application.yml:67-69` → `AEP_CLIP_PRICE_AVATAR_SECOND` / `_TTS_PER_KCHAR` / `_ASSEMBLE`），
默认空、`ClipProperties.requirePrice` 未配就抛 503 `CLIP_PRICING_NOT_CONFIGURED`。

合规的一半：**没有 seed 兜底价**。
不合规的一半：**改价要动 AIStar 的 env 并重启**，不是运营后台一次录入。

codex 提议把报价权收回军师：AIStar 只返回技术用量（chars / avatarSec / brollCount），
军师 BFF 按运营后台配置算积分并扣费。这与"对外定价归运营后台"的规则一致，
但属于跨仓契约级改动。**要不要这一轮做，等你定。**

### 2.4 BFF 大文件全量进内存

`server/src/routes/video.ts:443 await data.toBuffer()` —— 最高 100MB 先整个读进内存，
再判型、再过审核、再转发 AIStar。两跳串行 + 大内存，弱网下很容易顶到 `wx.uploadFile` 的
180 秒默认超时（`app/weapp-native/services/request.js:112`，注意：**timeout 本来就是 180s，
"补 timeout"不是修法**）。

---

## 3. 预览方案的三个选项与取舍

用户要的是"片"，不是"播放器模拟"（原话：「保守拍到影都可以先预览」「不出片的预览版」）。
但完整真数字人预览等于没省钱（avatar 秒数是成本大头，`ClipEstimateService.java:31`）。

| 方案 | 做法 | 成本 | 覆盖到的风险 | 判断 |
|---|---|---|---|---|
| **A 排练片（低清 MP4）** | 真 TTS + 真素材 + 真字幕 + 真封面 + 真尾卡，**只有 avatar 段用数字人静帧**顶替并打角标。走 ffmpeg，输出 540×960。 | tts + assemble，**不含 avatar** | 节奏、素材衔接、字幕、封面、尾卡、总时长 | **主方案** |
| **B 端上即时排练** | 服务端只回时间轴清单（每段 TTS URL + 时长 + 素材 + 字幕 cue），端上 `<video>` + `innerAudioContext` + 定时器拼着播 | 仅 tts，无 ffmpeg | 节奏、顺序、素材衔接；**字幕不是烧录的那一套，不能拿它验收字幕** | **快速档，与 A 并存**（见 F12） |
| **B0 素材连播** | 纯端上按顺序播已配好的 b-roll，无音频无字幕 | 零 | 画面顺序、素材接得顺不顺 | **本周就能上**（见 F15） |
| **C 一次性数字人试镜** | 每个 avatar+voice 组合生成一条 3–5 秒真实出镜片，长期缓存，分身页和配画面页都能看 | 一次性极小 | **口型、动作、构图、真实观感** —— A/B 都覆盖不了的 | **必做，补 A 的洞** |

**B 为什么不能取代 A**（我对 codex 的反对，依然成立）：微信里要同时跑 `<video>` 播 b-roll（静音循环）
+ `innerAudioContext` 播 TTS + `setInterval` 推字幕，三条时间轴在真机上必漂；且 `<video>` 是原生组件层级最高，
字幕得用 `cover-view` 才压得住，而 `cover-view` 排版能力极差 —— 做出来的字幕和成片烧录的字幕不是同一个东西，
而"字幕对不对"恰恰是用户抱怨过的点。

**但把 B 降级成"兜底"同样是错的**（F12 确认后修正）：用户的锚点是开拍/剪映的**本地实时**预览，
一条要等几十秒的云端 MP4 再快也不是同一个体感。B 是唯一能对上那个锚点的档。

**结论：B0 → B → A → C 四层并存，各有各的验收边界。**
B0 看顺序、B 看节奏、A 看成片效果、C 看口型。**不许用低档去替高档签字**——
F16 明确要的是"成片效果"，只能由 A 满足。

### 预演计价口径（讨论共识）

不采用"第一次免费、之后按 TTS 成本收"——那是在惩罚迭代，而迭代正是预演存在的理由。

- 同一 `renderSpecHash`：永久免费重播，直接命中缓存。
- 每个项目含 2 次"新版本云端排练"，用户侧不显示扣费。
- 叠加用户级日上限（防新建项目绕限额），超出后仍给不限次的端上即时排练（方案 B）。
- 正式出片按完整报价扣费，但**必须复用排练已生成的 TTS**。对用户的口径是
  "排练已包含在制作服务里"，不是"预览免费、正式再收一次配音费"。

---

## 4. 执行顺序

### 第一档 · 本周（每项都独立可上，不依赖任何新能力）

| 对应反馈 | 项 | 仓库/层 | 动到 |
|---|---|---|---|
| **F01** | 提交失败后请求标识自愈 + 有界重试 | ai-pilot 端 | `clone/index.js:handleCloneError` 收到 `CLIP_CLONE_REQUEST_CLOSED` 清 id 并自动重提；纯网络失败做有界重试；`confirm/index.js` 的 `renderRequestId` 每次 submit 失败后重生成；两条 `_REQUEST_CLOSED` 文案改成可执行动作 |
| **F02** | 段时长正向预算 | ai-pilot 端 | `shots/index.js:decorate` 在未配画面时就给出"这段需要约 N 秒"；超长素材说明只用前 N 秒 |
| **F04** | 图片素材可发现性 | ai-pilot 端 | `shots/index.js:pickAsset` 与 `assets` 页 actionSheet / 空态文案 |
| **F05** | 合并时选保留哪段素材 | ai-pilot 端 | `model.js:mergeAdjacentShots` 加 `keepAssetFrom`；`shots/index.js:mergeNext` 换三选一；补 `app/scripts/video-model.test.mjs` |
| **F06** | 素材库入口前置 | ai-pilot 端 | `pickAsset` actionSheet 顺序改为「我的素材库（N）/ 相册 / 拍摄」 |
| **F07①** | 出片完成微信通知 | ai-pilot server + 端 | `services/wechatSubscribe.ts` 加 `clip` scene 复用 `WECHAT_SUBSCRIBE_AVATAR_TEMPLATE_ID`；进度页加订阅入口 |
| **F08/F09** | 封面语义与开关可见性 | ai-pilot 端 | 成片页封面单列可保存 + 说明；确认页封面摘要显示开/关；封面入口提前到配画面之后 |
| **F10** | "预览"改名为"分镜清单" | ai-pilot 端 | `shots/index.wxml:95` 标题与文案；把"预览"这个词让给排练片 |
| **F15** | 素材连播（纯端上按顺序播已配画面，无音频无字幕） | ai-pilot 端 | `shots/index.js` 分镜清单加“连着看一遍”，顺序播 b-roll；零后端 |
| **V01** | 声音试听脱离 project | AIStar + BFF + 端 | AIStar 加按 voiceId 解析的试听方法；BFF 加 `POST /video/voices/:id/preview`（纯透传不扣费 + 限流）；端上在训练完成页 / `voices/` / `avatar/` 三处加试听，含默认样例文案与自定义输入 |
| **F14** | 数字人一次性试镜 | AIStar + BFF + 端 | `ClipAvatarService` 调 `ShiliuGateway.createVideoByText` 出 3–5 秒真出镜；按 `avatar+voice+engineVersion` 缓存；`avatar/index.*` 与 `shots/index.*` 两个入口 |
| §2.1b | 出片失败后项目解锁 | AIStar clip 域 | 失败/取消时把 `ClipProject.status` 回落 `draft`；补"失败→改一句→重出"测试 |
| §2.3 | b-roll 计费口径统一 | ai-pilot 端 | 删 `config.js:creditPerBrollSegment` 与 `model.js:estimateCredits` 的 broll 行；确认页首屏改为"正在核价"而非先显端上估价 |
| F01 取证 | 上传失败取证 + 端上体积预检 | 两仓 | 见 §5；端上先补 100MB 预检；`shots/index.js:uploadAsset` 补上 `assets` 页已有的 `CLIP_ASSET_QUOTA_EXCEEDED` 处理（现在两处不一致） |

**封面时长不动**：`COVER_DURATION_SEC` 保持 0.04。要肉眼可见的开头，应新增独立的"片头卡 1.5 秒"开关并明确增加时长，
不能偷偷改变现有封面的产品定义。

### 第二档 · 两周（地基 + 排练片）→ 对应 F03 / F11 / F12 / F13个性化层 / F16

顺序不可颠倒：

1. **渲染快照 `renderSpecHash`**（AIStar clip 域）—— §2.1。前置于一切。
2. **TTS 缓存**（AIStar clip 域）—— §2.2。前置于排练片的经济性。
3. **预演任务与正式任务状态机隔离**：`jobKind = rehearsal | final`；预演不改项目为 `generating/done`、
   不进作品列表、不触发正式 hold/settle/退款、低优先级队列、产物 24–72h TTL 且不计用户永久容量、同 hash 幂等。
4. **装配管线抽 visual provider**：现在 `assemble()` 与 `assembleMock()` 已经重复，**不许再复制第三份 `assembleDraft()`**。
   抽成同一条管线（时间轴/字幕/素材/封面/尾卡/BGM 共用），只切换 visual provider：
   `production → 石榴数字人视频` / `rehearsal → 分身静帧` / `mock → 测试色块`。
   静帧段必须按真实 TTS 时长生成，用与正片一致的 9:16 crop、字幕时间窗和素材循环逻辑。
5. **排练片端上接入**：确认页扣费按钮上方加"先看排练片"，生成期间先给方案 B 的端上即时排练。
（数字人试镜已上移到第一档：它不依赖快照，也不依赖预演状态机，只需要一次石榴生成 + 一张缓存表 + 两个入口，
是本轮性价比最高的一项 —— 它单独就能回答"我的数字人到底长什么样、口型对不对"。）

**排练片的验收指标**（codex 给的，采纳）：
- 输出 360×640 低码率 MP4，用户拿到的是一条能播的片，不是播放器模拟。
- 60 秒片子里字幕/音频累计漂移 ≤ 150ms。
- 改一句话最多新增一次 TTS 调用。
- 热缓存 15 秒内、冷缓存 45 秒内可播放。
- b-roll、TTS、句级字幕必须走与正片**同一套** materialize 与字幕时间轴。

### 第三档 · 更后 → 对应 F07② / F13模板层

- 出片进度 ETA：**先埋点再出数**。记录每个 stage 的开始/结束、供应商提交/轮询耗时，
  再返回 p50–p80 区间（"预计还需 4–8 分钟"）。当前 worker 没有严格队列位次、石榴轮询耗时波动大，
  **不要伪造"队列第几位"或精确倒计时**。（军师报告链路那版排队位次透出的形状不适配这里，别硬抄。）
- 模板页平台预生成样片（10–15 秒标准片）。**不要**把模板页"开始制作"改成"生成排练片"——
  用户在那一步还没有自己的文案和镜头。
- BFF 大文件改签名直传或流式转发（§2.4）。
- 上传时就做"可解码"前检（HEIC / 异常编码 / 损坏 MP4），别拖到总装才失败。

### 本轮明确不做

- 改 `COVER_DURATION_SEC`（会改变正片时长与既有产品定义，要做就做独立片头卡）。
- 完整真数字人低清预览（avatar 成本没省，等于白扣钱）。
- 服务端补 b-roll 价键（等于新增对外价格，归运营后台决策）。

---

## 5. 上传失败：先取证，再动手

根因**还没定位**。已知有 4 个可能的拒绝点，动手前先按这个顺序取证：

1. 拉线上 BFF 日志，按 code 分桶统计 `/video/assets` 的失败：
   `CLIP_ASSET_TOO_LARGE`(413) / 审核拒绝 / `CLIP_ASSET_QUOTA_EXCEEDED` / 429 rateLimit / 网关超时。
2. 看失败样本的文件体积与耗时分布 —— 若集中在 >50MB 且耗时接近 180s，就是 §2.4 的两跳串行超时，
   端上预检治标、流式转发才治本。
3. 若集中在审核拒绝，看 `services/video/moderation.ts` 的判定与阿里云返回，是否误杀。
4. 若集中在配额，说明素材库容量条没起到提示作用，要在上传前就拦。

**取证之前不要改上传链路**——端上预检那条（第一档）无论根因是什么都该做，其余等数据。

---

## 6. 还会踩、但用户还没说的坑

- 排练片过期语义：改一个字、换声音、删素材后，旧排练必须明显标为过期。
- 素材上传没有业务幂等号：第一次实际成功但响应丢失，重试会生成两份素材。
- **"看见不对但改不了"仍然是不受控**：排练只能暴露问题。至少要能调字幕字号/安全区、素材裁切焦点、
  语速/停顿、BGM 音量，否则用户看到问题也只能干瞪眼。
- 排练产物必须私有 + 短期签名 + 自动清理，否则变成新的隐私与存储债务。
- 异步生成完成后不要依赖有声 autoplay；角标最好烧进视频，避免原生 video 层级遮挡普通 view。
- 若排练产物换 CDN 域名，要同步小程序合法域名配置，并确保 Range、正确 MIME、`+faststart`、签名 URL 过期刷新。

---

## 7. 识读确认记录（2026-08-18 用户已确认）

| 编号 | 原先不确定的读法 | 用户确认 | 对方案的影响 |
|---|---|---|---|
| F12 | 「保守拍到影都可以先预览」 | **开拍、剪映可以预览** | 竞品锚点是本地实时预览 → 端上即时排练从"兜底"**升级为快速档**，与排练片 MP4 并存 |
| F15 | 「我看有怎么把上传片给他们出来」 | **打算把已上传视频做预览** | 用户自己提的思路与排练片撞上 → 印证静帧顶替可接受；**新增零成本的"素材连播"进第一档** |
| F16 | 「意思是看不到这些…中的布景」 | **还是表达没法先预览成片效果** | 归入主诉；验收取最严口径，只能由精确档排练片满足 |

另有一条「这种是啥意思」，确认是指着数字分身页那张截图问的，已由 **F01** 回答
（即「这次训练已经结束，请重新提交」那条报错）。

**截图内 16 条反馈现已全部有确定读法、确定诊断、确定修法和确定验收，无待确认项。**
