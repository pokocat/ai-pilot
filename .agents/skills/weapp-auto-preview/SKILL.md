---
name: weapp-auto-preview
description: 编译军师小程序并用微信开发者工具 CLI 的 auto-preview 把当前代码热推到手机。当用户想"编译小程序并推到手机/真机预览/实时预览/auto-preview/推手机看效果"时使用。涵盖前置编译动作 + DevTools CLI 调用 + 输出路径必须可写（禁用 /tmp）这一关键坑。
---

# 军师小程序 · 编译 + auto-preview 热推手机

把 `app/` 当前代码编译成小程序产物，再用微信开发者工具（DevTools）CLI 的 `auto-preview` 直接推到手机，免上传密钥、免扫码、改完即推。

## 适用 / 不适用
- ✅ 本机已装微信开发者工具、已登录开发者账号；想快速在真机看当前改动。
- ❌ 要发体验版/正式版 → 走 `npm run upload:weapp`（另一条线）。
- ❌ 要给别人扫码的可分享预览码 → 用 `app/scripts/weapp-preview.mjs`（miniprogram-ci，需上传密钥 + 本机公网 IP 白名单）。

## 前置条件（真机这端，替代不了）
1. **手机微信在前台运行**，且登录的是**开发者本人账号**（本项目是 `duó`）——auto-preview 按账号推送。
2. DevTools 已登录（CLI 会自动拉起 IDE）。
3. 小程序 AppID：`wx810ebe6dfef8e75f`（`app/project.config.json`，`miniprogramRoot: dist/`）。

## 步骤

### 1) 前置编译（必做）
在 `app/` 目录，server 模式编译产物到 `dist/`：
```bash
cd /Users/donis/dev/ai-pilot/app
npx tsc --noEmit          # 类型检查（可选但建议；无输出即通过）
npm run build:weapp:server # → dist/，流式响应已默认开启（除非 TARO_APP_STREAM=0）
```
编译末尾常见一条 `mini-css-extract-plugin Conflicting order` 的 CSS 引入顺序 **warning，无害**，可忽略；只要看到 `Compiled successfully` 即可。

### 2) auto-preview 热推手机
```bash
/Applications/wechatwebdevtools.app/Contents/MacOS/cli auto-preview \
  --project /Users/donis/dev/ai-pilot/app \
  --info-output /Users/donis/dev/ai-pilot/weapp-auto-preview-info.json \
  --lang zh
```
看到 `✔ auto-preview` 即成功，手机上会自动弹出/刷新到当前版本。`--info-output` 里是各分包体积。

## ⚠️ 关键坑：输出路径必须可写，禁用 /tmp
DevTools 是独立 GUI 应用，**对 `/tmp` 没有写权限**（macOS 下它的 `/tmp` 与 shell 不是同一个）。若把 `--info-output`（或 `preview` 的 `-o` 二维码路径）指到 `/tmp`，会报：

```
错误 Error: 二维码输出路径无效或不存在 %s (code 17)
```

这个报错**误导性极强**——它甩锅给"二维码"，实际是**输出路径不可写**。注意 `%s` 占位符没被填值，正是路径变量为空的征兆。
**对策：所有输出路径放可写目录**（仓库内或 `$HOME`），永远别用 `/tmp`。和主体资质、手机绑定都无关。

## 兜底：静态预览码（auto-preview 不可用时）
若 DevTools 未登录/账号对不上，退而生成可扫的预览码（同样别用 /tmp）：
```bash
/Applications/wechatwebdevtools.app/Contents/MacOS/cli preview \
  -f image -o "$HOME/junshi-preview-qr.png" \
  --project /Users/donis/dev/ai-pilot/app
# 再发给用户扫码：
cc-connect send --image "$HOME/junshi-preview-qr.png" --message "军师小程序预览码，用微信扫码预览"
```

## 备注
- 流式响应（聊天逐 token）现为**默认开**：`app/src/services/config.ts` 的 `STREAM_CHAT = process.env.TARO_APP_STREAM !== '0'`。普通 `build:weapp:server` 即启用，无需额外 flag。
- 微信「一键获取手机号」按钮受 `app/src/components/Login/index.tsx` 的 `WX_PHONE_ONETAP` 控制；真机生效需小程序为**企业主体 + 已开通「手机号快速验证」**，否则报 `jsapi has no permission`（短信兜底仍可登录）。
