# 交接：分享底图（换好看的图）+ 文案库随机化

> 2026-08-19 · 上一个终端出问题，新终端从这里接。
> **先读完再动手**，特别是 §4「未完成的半截代码」——工作树里有一处改到一半、当前编译不过。

---

## 1. 先自己核仓库状态（别信转述）

```bash
git -C /Users/donis/dev/ai-pilot log --oneline -3
git -C /Users/donis/dev/ai-pilot branch --show-current
git -C /Users/donis/dev/ai-pilot status --short
```

预期：分支 `feat/share-art-and-copy-pool`；main 为 `2e8dbc9`（转发+邀请关系链已合并）；
工作树**不干净**（`app/weapp-native/services/share.js` 改到一半）。

> ⚠️ 上一个会话有一段时间输出过**未真实执行**的工具结果（已向用户承认）。
> 本文凡状态类结论请自己跑命令复核；代码内容类结论来自实际读取，相对可靠。

---

## 2. 用户这轮要的两件事

### ① 分享底图太丑 → 换好看的图

现状：`app/weapp-native/assets/share/card-friend.png`（750×600，2.6KB）与
`card-timeline.png`（600×600，2.2KB），是**构建脚本用代码画的纯色块**，用户明确说丑。

已试过并被排除的路径：
1. ~~PIL/canvas 代码画~~ —— 用户否掉（"不要用 canvas 画了，很丑"）
2. ~~codex imagegen skill~~（`~/.codex/skills/.system/imagegen`，默认内置 `image_gen` 工具）
   —— **额度用尽**：`You've hit your usage limit ... try again at 11:46 PM`，一张未出
3. ~~imagegen CLI fallback~~（`scripts/image_gen.py`）—— 本机无 `OPENAI_API_KEY`
4. **当前方案：web 上找开源图**（用户指示："那你去web上找一些开源图"）

**许可硬要求**：小程序对外分发＝商业用途，只能用 Unsplash / Pexels License 或 CC0；
**CC BY-NC 不可用**。图片出处与 License 要写进 CHANGELOG（法务需要，别省）。

### ② 分享文案要文案库 + 随机发

用户原话："分享文案要有个文案库，随机发，而不是每次都一样"。
原实现按本地自然日轮动（同一天全站同一套，为可排查）。改随机，
**可排查性靠埋点记选中序号**，不靠确定性。

---

## 3. 找图的筛选标准

**用途决定一切**：微信聊天流里显示宽约 210pt（3 倍屏 630px）。
- 构图极简、主体极大，缩到拇指大小仍看得清
- **图上不要任何文字**（标题由 `onShareAppMessage` 的 `title` 提供并显示在图旁边；
  图上再写是重复，且中文在缩略图里糊成一团）
- 不要边框/相框，不要做成带标题栏的"海报"

**品牌口径**（给做生意老板用的 AI 商业参谋）：
- 气质：东方、克制、雅致、有分量，像高级茶室或私人书房
- **忌**：玄学感、算命感、赛博朋克、科技蓝、发光电路板、鲜艳霓虹、塑料反光
- 配色：深绿 `#143726` / 墨 `#16191D` / 烫金 `#A07D2C` `#F4D99E`（点缀 ≤8%）/ 米底 `#FBFAF6`
- 整体压低饱和度，像陈年宣纸与旧铜器

**三个主题**（每主题各要 5:4 与 1:1 两张）：
- **A 夜案**：深夜书房一角，暖光小灯照深色木案，摊开素纸与毛笔，四周沉入墨色
- **B 远山**：极简东方山水，三层远山退入薄雾，大量留白，水墨洇开的软边
- **C 棋盘**：旧木棋盘局部特写，三四枚墨黑与米白棋子，浅景深。
  是"落子前的停顿"，**不要**对峙战局感、不要输赢感

搜索词建议：`ink wash mountain mist minimal`、`japanese study desk lamp night`、
`go board stones macro shallow depth`、`calligraphy brush inkstone dark`、
`tea ceremony minimal dark green`

**处理**：裁到精确 750×600 与 600×600，单张 <100KB
（本地图占主包，ai-society 踩过 369KB 顶穿主包上限）。
裁切压缩用 PIL 可以——用户反对的是"用代码画图"，不是反对处理图。

---

## 4. ⚠️ 未完成的半截代码（接手第一件事）

`app/weapp-native/services/share.js` 已改两处、差最后一处，**当前编译不过**。

**已完成**：
1. `BUILTIN_POSTERS`（4 条文案与图绑定）→ 拆两池：
   - `BUILTIN_COPY`：**12 条**文案（通用 2 / 获客 3 / 现金流 3 / 用人 2 / 方向 2），
     每条 `title`（递给你看的语气）+ `timelineTitle`（广而告之的语气）
   - `BUILTIN_ART`：底图池，暂 1 套（新图到位后扩成 3 套）
2. 选择逻辑：删掉 `dayIndex()` 与旧 `posterIndex()`，新增
   `copyPool()` / `artPool()`（服务端 `me.shareCopy` / `me.shareArt` 优先，兜底内置）、
   `pickIndex()`（`Math.random()`）、`currentPoster()`（两池独立随机，返回值带
   `copyIndex` / `artIndex`）

**还差这一处**：
```bash
grep -nE "posterIndex|dayIndex" app/weapp-native/services/share.js
# ~188 行：api.track('share_expose', { channel, poster: posterIndex() })
# ~289-290 行：module.exports 仍导出 posterIndex, dayIndex
```

要改成**报本次实际选中的序号**，而不是在埋点函数里自己再摇一次
（再摇一次报的就不是用户看到的那张，埋点等于说谎——这是最容易写错的一处）。

难点是 `wrapShareCallback` 的时序：它现在**先报埋点再执行回调**（注释写了理由：
回调返回什么甚至抛错，曝光都已发生，漏斗第一段不该少一条）。但"先报"时还不知道序号。
**建议**：改成"执行回调 → 从返回值取 `copyIndex`/`artIndex` → 上报"，
并在 `catch` 里也报一次（不带序号），既拿到序号又保留"回调炸了不丢曝光"。
注意别吞掉页面回调的异常。改完同步更新那段时序注释。
导出里 `posterIndex` / `dayIndex` 删掉，并检查测试是否引用。

---

## 5. 测试要跟着改（别漏）

`app/scripts/weapp-share.test.mjs`（当前 33 例）有一条**「同日幂等」**断言
（同一天两次调用拿同一套素材）。改随机后必然红，且方向已反。改成验证随机特性：
- 跑 50 次，收集到的 title 集合 size > 1
- 每次返回的 title 在文案库内、image 在图池内（不返回 undefined）
- **埋点上报的序号与本次返回素材一致**（新守卫，防"埋点自己摇一次"回归）
- 无码时 path 无参、有码时带 `ic=`（原有断言别动）

跑法：`cd app && node --test scripts/weapp-share.test.mjs`

按本仓惯例，新增断言要**实测「改坏会红」**（改坏实现一次确认报错再还原）。
这个项目吃过亏——多次出现"写了修复也写了测试，但测试测不到修复"的假绿。

---

## 6. 验证与提交

```bash
cd /Users/donis/dev/ai-pilot/app
npx tsc --noEmit --pretty false
node --test scripts/weapp-share.test.mjs
node --test scripts/native-weapp.test.mjs     # 不能弄坏既有守卫
npm run build:weapp:server                     # 产物指向生产 API，核对 gitSha
ls -la dist-native/assets/share/               # 确认图体积
```

server 测试若需跑：必须隔离库（`junshi_test` 全机共享，并发会互相清库）：
```bash
createdb junshi_test_x && DATABASE_URL="postgresql://donis@localhost:5432/junshi_test_x?schema=public" npm test; dropdb junshi_test_x
```

文档同步（AGENTS.md §0 强制）：更新 `AGENTS.md` 受影响小节 + `docs/CHANGELOG.md` 顶部加
`2026-08-19 · 改动 · 影响面`。要记：文案库 12 条、随机选、埋点带序号、**底图出处与 License**。

提交留在 `feat/share-art-and-copy-pool` 分支，跑完三端再问用户要不要 ff 进 main。
**不要在 main 上直接 `git add -A`**（上一轮在此犯过一次，被用户及时打断）。

---

## 7. 容易踩的硬规矩

1. **线上小程序是原生的**：源码 `app/weapp-native/`，构建脚本 `app/scripts/build-native-weapp.mjs`
   → `app/dist-native/`。`app/src/` 是 Taro 只出 H5/PC。`app/src/**/index.config.ts` 里的
   `enableShareAppMessage` 对原生产物**无效**。
2. **改完必须重编**：开发者工具打开的是 `dist-native/`。上一轮"开发版不能转发"就是
   合并后没重编、产物还是旧 gitSha。真机预览 `--project` 必须指 `dist-native`，
   指外层 `app/` 报 800059。
3. **登录 401 铁律**（AGENTS.md §0.7）：有 token 且失效才全局打断，无 token 401 只在原页承接。
   分享埋点刻意用裸 `wx.request` 不走 `request()`，就是为避开这条。别改。
4. **品牌红线**：文案/注释/标识符都不得出现「米诺 / Mino」。
5. **文案口径**：切真实经营痛点（获客贵/现金流紧/招人难/方向不定），不用「宜攻宜守」
   这类盘面黑话。军师语感只留在称谓与语气。
6. **对外数据归运营不归代码**：文案与图都要留服务端下发读取点（已留
   `me.shareCopy` / `me.shareArt`），内置只作兜底。

---

## 8. 相关文档

- 方案全文：`docs/[OPUS5]WEAPP_SHARE_REFERRAL_PLAN_2026-08-18.md`（v2，含四条已定决策）
- 发布流程：`docs/RELEASE_SOP.md`
