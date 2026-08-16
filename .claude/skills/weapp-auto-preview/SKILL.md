---
name: weapp-auto-preview
description: 编译军师小程序并用微信开发者工具 CLI 的 auto-preview 把当前代码热推到手机。当用户想"编译小程序并推到手机/真机预览/实时预览/auto-preview/推手机看效果"时使用。涵盖前置编译动作 + DevTools CLI 调用 + 两个关键坑：--project 必须指向 dist-native（否则报 800059 app.js file not found）、输出路径必须可写（禁用 /tmp）。
---

# 军师小程序 · 编译 + auto-preview 热推手机

把 `app/weapp-native/` 当前代码编译成小程序产物，再用微信开发者工具（DevTools）CLI 的 `auto-preview` 直接推到手机，免上传密钥、免扫码、改完即推。

## 适用 / 不适用
- ✅ 本机已装微信开发者工具、已登录开发者账号；想快速在真机看当前改动。
- ❌ 要发体验版/正式版 → 走 `npm run upload:weapp`（另一条线）。
- ❌ 要给别人扫码的可分享预览码 → 用 `app/scripts/weapp-preview.mjs`（miniprogram-ci，需上传密钥 + 本机公网 IP 白名单）。

## 前置条件（真机这端，替代不了）
1. **手机微信在前台运行**，且登录的是**开发者本人账号**（本项目是 `duó`）——auto-preview 按账号推送。
2. DevTools 已登录（CLI 会自动拉起 IDE）。
3. 小程序 AppID：`wx810ebe6dfef8e75f`（`app/project.config.json`，`miniprogramRoot: dist-native/`）。

## 步骤

### 1) 前置编译（必做）
在 `app/` 目录编译原生小程序产物到 `dist-native/`：
```bash
cd /Users/donis/dev/ai-pilot/app
npm run typecheck            # 可选但建议；无输出即通过
npm run build:weapp:server   # → dist-native/，打生产 API
```
选后端：`build:weapp:server` = 生产 `https://wxapi.aibuzz.cn/api`；`build:weapp:preprod` = 预发 `/api_preprod`。
**编译成功的标志是最后两行 `[native-weapp] ✓ …`**，第二行会打出产物目录；同时 `dist-native/junshi-build-meta.json` 记录本次 `mode / api / version / gitSha`，推完可以拿它核对手机上跑的到底是哪个 commit、连的哪个后端。

> 注：这里已不是 Taro webpack 构建（`app/src/` 那套是 H5/PC，正在退役）。所以不会再出现
> `Compiled successfully` 或 `mini-css-extract-plugin Conflicting order` 这类 Taro 输出。

### 2) auto-preview 热推手机
```bash
/Applications/wechatwebdevtools.app/Contents/MacOS/cli auto-preview \
  --project /Users/donis/dev/ai-pilot/app/dist-native \
  --info-output "$HOME/junshi-weapp-auto-preview-info.json" \
  --lang zh
```
看到 `✔ auto-preview` 即成功，手机上会自动弹出/刷新到当前版本。`--info-output` 里是各分包体积（`size.packages`）。

## ⚠️ 关键坑一：`--project` 必须指向 `dist-native`，不是 `app`
把 `--project` 指向外层 `app/`（那里的 `project.config.json` 写着 `miniprogramRoot: "dist-native/"`），上传阶段会报：

```
✖ 上传中
[error] { code: 10, message: '... 系统错误，错误码：800059,error: app.js, file not found ...' }
```

**即使 `dist-native/app.js` 明明存在也照报，重试无用。** 原因不是产物缺文件，而是 DevTools 对外层 `miniprogramRoot` 的**旧文件索引在热重建后没刷新**。构建脚本早就为此留了后手——`app/scripts/build-native-weapp.mjs` 在产物里额外生成了一份 `dist-native/project.config.json`（`miniprogramRoot: ""`，同 AppID），注释原话是「dist-native 可作为独立项目导入，规避部分 DevTools RC 版本在外层 miniprogramRoot 热重建后保留旧文件索引的问题」。

**对策：`--project` 直接指 `app/dist-native`，把产物当独立项目。** 这条只适用于本地 DevTools 预览；正式上传（`npm run upload:weapp`，miniprogram-ci）仍走外层项目配置，不要跟着改。

## ⚠️ 关键坑二：输出路径必须可写，禁用 /tmp
DevTools 是独立 GUI 应用，**对 `/tmp` 没有写权限**（macOS 下它的 `/tmp` 与 shell 不是同一个）。若把 `--info-output`（或 `preview` 的 `-o` 二维码路径）指到 `/tmp`，会报：

```
错误 Error: 二维码输出路径无效或不存在 %s (code 17)
```

这个报错**误导性极强**——它甩锅给"二维码"，实际是**输出路径不可写**。注意 `%s` 占位符没被填值，正是路径变量为空的征兆。
**对策：所有输出路径放可写目录**（`$HOME` 或仓库内；放 `$HOME` 还能免得在仓库里落一个未跟踪文件），永远别用 `/tmp`。和主体资质、手机绑定都无关。

## 兜底：静态预览码（auto-preview 不可用时）
若 DevTools 未登录/账号对不上，退而生成可扫的预览码（同样指 `dist-native`、同样别用 /tmp）：
```bash
/Applications/wechatwebdevtools.app/Contents/MacOS/cli preview \
  -f image -o "$HOME/junshi-preview-qr.png" \
  --project /Users/donis/dev/ai-pilot/app/dist-native
# 再发给用户扫码：
cc-connect send --image "$HOME/junshi-preview-qr.png" --message "军师小程序预览码，用微信扫码预览"
```

## 备注
- **预览包连的后端由编译时决定，推之前先想清楚**。若服务端有配套改动还没部署，真机上会是「新前端 + 旧后端」，涉及该改动的交互不能作数（严重时会产生真实扣费等副作用）。要么先部署后端，要么用 `build:weapp:preprod` 连预发。
- 流式响应（聊天逐 token）在原生端由 `app/weapp-native/config/env.js` 的 `STREAM_CHAT` 控制，当前**硬编码为 `true`**（消费方 `services/streaming.js`）；旧的 `TARO_APP_STREAM=0` 环境变量只对退役中的 `app/src/` 那套生效，对本构建无效。
- 登录组件是 `app/weapp-native/components/login-sheet/`：勾选协议后才出现 `open-type="getPhoneNumber"` 的微信手机号按钮，另有手动输入手机号 + 验证码通道兜底。手机号一键获取需小程序为**企业主体 + 已开通「手机号快速验证」**，否则报 `jsapi has no permission`（短信通道仍可登录）。登录门的合规约束（游客可浏览、不得前置、必须可取消）见 `docs/[OPUS5]WEAPP_LOGIN_COMPLIANCE_2026-08-05.md`。
