# 闸门 A 真机跑测手册

判据和统计口径在 `docs/KUAICHUPIAN_GATE_PROTOCOL_2026-08-24.md`，这份只讲怎么操作。

判定只看 **A-low 与 I-old 两台真机 · M 网络档 · 冷缓存**，两台都过才算过。
A-mid / I-new 只做对照。模拟器的数一律不进报告。

---

## 一、一次性准备

### 1. 素材放到手机够得着的地方

生成夹具（协议 §2.2 的对齐标记片）：

```bash
node -e "const m=require('./app/weapp-native/packages/video/model.js'),c=require('./app/weapp-native/packages/video/catalog.js');let a=0;console.log(JSON.stringify(c.getBuiltInTemplate('ct_shiti').scriptSkeleton.segments.map(x=>{const d=m.summarize([x]).totalSec,r={no:x.no,role:x.role,startSec:Math.round(a*100)/100,durationSec:d};a+=d;return r})))" > /tmp/segs.json
GATE_A_SEGMENTS="$(cat /tmp/segs.json)" node scripts/gen-gate-a-media.mjs ./gate-a-media
```

产出 22 个分段 mp4 + 一条音轨 + `manifest.json`。放哪儿两个选择：

- **同一 WiFi 下用局域网**：`cd gate-a-media && python3 -m http.server 8899`，
  地址写 `http://<Mac 的局域网 IP>:8899/`。省事，但**弱网档 P 没法用**——
  局域网不过整形出口，dummynet 管不着它。W / M 档也要确认流量真的走了整形口。
- **传到 CDN**：判据跑测建议用这个。冷缓存靠唯一签名 query（§1.3），
  页面会用本次 runId 自动追加。

把地址填进 `app/weapp-native/packages/video/gatea/manifest.js` 的 `REAL`，
`audioUrl` 和 22 个 `url` 都要填满，`startSec` 用真实累计起点。

⚠️ 夹具测得出切换间隙、黑场、漂移这些机制指标，**测不出真实素材的解码压力**
（码率、分辨率、编码档次都不一样）。协议 §2.1 那套真实素材必须另跑一轮。

### 2. 装到手机上

```bash
npm --prefix app run build:weapp
/Applications/wechatwebdevtools.app/Contents/MacOS/cli preview \
  --project "$PWD/app/dist-native" --qr-format image \
  --qr-output ~/Desktop/gate-a-qr.png \
  --compile-condition '{"pathName":"packages/video/gatea/index"}'
```

两个坑：`--project` 必须指 `dist-native`（指外层 `app/` 报 800059 app.js not found）；
`--qr-output` 不能放 `/tmp`（报「二维码输出路径无效」）。

### 3. 手机上开两个开关

- 用 http 局域网素材时：微信里进小程序 → 右上角胶囊「…」→ 打开调试 → **不校验合法域名**
- **关省电模式并插电**。不关的话安卓会降频，测出来的是省电策略不是产品性能（§1.1）。

---

## 二、每个格子怎么跑

一个格子 = 一个机型 × 一个网络档 × 冷或热。协议要求每格 **10 次完整连播**。

### 1. 网络整形（M 档是判据档）

Mac 开「互联网共享」把网分给手机，在共享出去的桥接口上挂 dummynet：

```bash
sudo dnctl pipe 1 config bw 10Mbit/s delay 30ms plr 0
echo 'dummynet out proto {tcp,udp} from any to any pipe 1' | sudo pfctl -f - -e
```

跑之前复核实际带宽再记进报告 —— **配了不等于生效**（§1.2）。

### 2. 录屏

协议要 60fps。手机自带录屏不一定是 60，录完先验：

```bash
ffprobe -v error -select_streams v:0 -show_entries stream=avg_frame_rate -of csv=p=0 录屏.mp4
```

不是 60 就换工具：iPhone 用数据线接 Mac、QuickTime「影片录制」选 iPhone 作输入源；
安卓用 `scrcpy --record=out.mp4 --max-fps=60`。

**低于 60fps 的录屏不能用来判 33ms 的黑场线** —— 30fps 下 1 帧就是 33ms，
量程还不如判据线细。

### 3. 跑

扫码进页面 → 点「开始连播」→ 放完 163 秒 → 再点，重复 10 次。
页面**自动并池**：协议 §1.4 要求一格里所有跑次的样本并成一个池子算一次 P95，
不是每次算一个再平均（那样会把长尾抹掉）。界面上「已跑 N 次」就是池子里的跑次数。

跑满 10 次点「复制 JSON」，粘出来存档。
**换格子（换机型 / 换网络 / 换冷热）之前一定点「清空重来」**，否则会把两个格子的样本混池。

冷缓存每次跑测自动挂新的 runId query；热缓存是同一组 URL 紧接着再放一遍、中间不退出页面。

---

## 三、分析录屏

```bash
node scripts/analyze-gate-a-recording.mjs 录屏.mp4
```

出漂移曲线、黑场、按 §2.4 逐条判。

**录屏是判定用的第一证据线，页面里的 JSON 是第二线，两者冲突以录屏为准（§1.6）。**
埋点看得见「下了播放指令、播放事件回来了」，看不见「这一帧真的上屏了」。

切换间隙和首帧起播要逐帧判读切换点，分析脚本给不了，得配合录屏手工核。

---

## 四、报告里必须写的

缺任一项这条数据作废重跑（§1.1）：

具体型号 · 系统版本 · 微信版本 · 基础库版本 · 测试时电量与是否插电 ·
省电模式状态 · dummynet 实测带宽 · 录屏实际帧率 · runId · 冷或热 · 跑次数

---

## 五、已知的两处协议缺口

跑之前最好先定了，否则数据出来对不上判据：

1. **163 秒累计漂移采不到。** §2.4 要这个读数，但标记每 15 秒一个、最后一个落在
   150 秒。要么补一个 162 秒的标记，要么把判据点改到 150 秒。
2. **标记片长度自相矛盾。** §2.2 说 180 秒，又说分段结构与 ct_shiti 完全一致（163 秒）。
   `gen-gate-a-media.mjs` 按 163 秒实现。

---

## 六、模拟器上已经跑过的

不是判据，只是把机制问题先清掉，省真机时间。对齐标记片、22 段 163 秒：

| 指标 | 模拟器实测 | 线 | |
|---|---|---|---|
| 切换间隙 P95 / max | 34 / 35ms | 150 / 400ms | 过 |
| 首帧起播 | 149ms | 1500ms | 过 |
| 45 秒累计漂移 | 9ms | 200ms | 过 |
| 163 秒累计漂移 | 74ms | 建议 400ms | 过 |
| 任意 15 秒滑窗漂移 | 454ms | 建议 125ms | **不过** |
| 崩溃 / OOM | 0 | 0 | 过 |

滑窗那条正是 §2.5 预言的情况：已定判据全过，而「口播对不对得上」的那条不过。
画面比音频快约 6%，段内累积、到切点被拽回，在 ±300ms 之间摆。
要过这条得有比 seek 更细的校正手段，是产品决定，未擅改。

---

## 七、换台电脑接着跑

```bash
git fetch origin && git switch spike/gate-a-preview
npm --prefix app ci        # 或 npm --prefix app install
```

**仓库里没有的东西，到了新机器要自己再做一遍：**

| 缺什么 | 怎么办 |
|---|---|
| 夹具素材（22 段 mp4 + 音轨） | 按 §一.1 重跑 `gen-gate-a-media.mjs`，产物已 gitignore，不入库 |
| `manifest.js` 的 `REAL` | 仓库里是空的（不把某台机器的局域网地址提进去）。按 §一.1 填 |
| 开发者工具登录 | 新机器要重新扫码登录，`cli open` 会报「需要重新登录」 |
| ffmpeg | 生成夹具和分析录屏都要。注意：**有的 ffmpeg 没编 `drawtext`**，
生成脚本已改用 `drawbox` 画二进制时间码，不依赖字体，不用管这个 |

**跑之前先自查一遍，不用开发者工具、不用手机：**

```bash
node scripts/test-gate-a-page.mjs
```

打桩跑完整条 163 秒状态机，检查切换次数、顺序、预热、边界贴合、主时钟回拉、
跨跑次并池。全绿再往真机上花时间。

**要在模拟器里先跑一遍**（不是判据，用来清机制问题）：

```bash
/Applications/wechatwebdevtools.app/Contents/MacOS/cli auto \
  --project "$PWD/app/dist-native" --auto-port 9420 &
node scripts/run-gate-a-simulator.mjs
```

已跑的结果和已知问题在 §六。
