# 军师 · 桌面双栏布局（设计稿源文件）

写于 2026-09-05。给「微信 PC / Mac 桌面双栏」这轮改造出的**布局蓝图**，等产品负责人拍板后再落代码。

线上画布（9 张 artboard，可缩放平移）：
<https://claude.ai/code/artifact/ad3be626-fdb0-4d57-a65d-84f3c64442ec>

## 这里有什么

| 文件 | 是什么 |
|---|---|
| `Main.dc.html` | 布局系统总览：三档断点、栅格、四种窗口下的实际栏宽 |
| `DecisionNav.dc.html` | 决策 A：底部胶囊底栏 vs 左侧 72px 导航条 |
| `Wence / Zhanju / Jinri / Tuji / Zhugong.dc.html` | 五个主 Tab 的桌面线框（1280 窗口） |
| `Degrade.dc.html` | 对话分包页 + 窗口收窄时的降级阶梯 |
| `Rollout.dc.html` | 分三步实施、要动的文件、三个风险、三个待拍板项 |
| `canvas.json` | 画布布局（位置、便签、打开视图） |
| `build-measure.mjs` | 溢出体检：把 9 张稿各塞进一个 shadow root 同页量真实几何 |

## 改了之后怎么更新线上画布

```bash
node "<design skill base>/seed-canvas.mjs" \
  --template "<design skill base>/payload.template.html" \
  --out junshi-desktop-two-column.html --title "军师 · 桌面双栏布局" \
  --artboard Main.dc.html --artboard DecisionNav.dc.html --artboard Wence.dc.html \
  --artboard Zhanju.dc.html --artboard Jinri.dc.html --artboard Tuji.dc.html \
  --artboard Zhugong.dc.html --artboard Degrade.dc.html --artboard Rollout.dc.html \
  --canvas canvas.json
```

拼出来的那个 2.5MB 单页产物**不入库**（`.gitignore` 已排除），每次现拼即可。

## 两条必须守住的约束（都是复核时踩出来的）

1. **画布尺寸是硬边界，超了直接裁掉。** 每张 artboard 的根节点是定宽定高的
   （总览 1360×900、页面稿 1360×940），内容超出不会缩放也不会滚动。
   改完必跑一次体检：

   ```bash
   node build-measure.mjs /tmp/measure.html   # 然后用浏览器打开看 ALL CLEAR
   ```

   体检脚本本身有两个坑（已修，别改回去）：根节点自己不能算进 `mb`，
   否则 `contentH` 永远等于 `boxH`、溢出永远看不出来；画布挂在 `left:-20000px`，
   横向初值必须是 `-Infinity` 而不是 `0`。

2. **栏宽算式只有一套，改一个数就要全稿同步。**
   `主栏 = 窗口 − 456`（72 导航 + 40 页边距 + 24 栏间距 + 320 副栏），
   容器封顶 1240 → 主栏定格 896、正文轴 840。
   **问策是唯一的例外**：三栏齐边，不走页边距与栏间距，`主栏 = 窗口 − 392`。
   这两套预算同时出现在 `Main` 与 `DecisionNav` 两张稿上，首版就是因为没标清楚而对不上。
