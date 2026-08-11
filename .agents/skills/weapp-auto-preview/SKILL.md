---
name: weapp-auto-preview
description: 编译军师当前原生微信小程序并用微信开发者工具 CLI auto-preview 推到真机。用于“编译推手机”“真机预览”“实时预览”“auto-preview”“看当前 worktree 效果”。支持 mock/server 显式选择、dist-native 构建身份校验、局域网 API 与可写输出路径。
---

# 军师原生小程序 · 构建并推真机

当前微信端是 `app/weapp-native/`，输出 `app/dist-native/`。日常 DevTools 预览直接使用生成的 `app/dist-native/` 独立项目（其 `miniprogramRoot=""`）；上传/发布工具仍使用外层 `app/`，其 `project.config.json` 必须保持 `miniprogramRoot=dist-native/`。

禁止使用旧 Taro 微信构建、`app/dist/`、`TARO_APP_MODE` 或 `TARO_APP_API`。

## 模式选择

- 常规真机验收用 `server`，API 必须是手机可访问的 Mac 局域网地址或明确指定的 HTTPS 环境，不能用 `localhost`。
- 真实外部依赖尚未接通、只看 UI/交互时才用 `mock`，并向用户明确说明。
- 体验版/正式版不走本 skill；只有用户明确要求发布时才运行 `upload:weapp` / `release:weapp`。

## 首选命令

使用全局 helper，它能处理当前 git worktree、依赖软链、build meta 校验和 DevTools 输出，并直接预览生成的 `app/dist-native/`，避免 DevTools RC 复用外层旧索引后误报找不到 `app.json`。CLI 即使编译失败也可能退出 0，helper 只认输出中的 `✔ auto-preview`。

```bash
PREVIEW=/Users/donis/.codex/skills/ai-pilot-weapp-preview/scripts/weapp_preview.sh

# 当前 worktree 的 mock 界面验收
AI_PILOT_REPO=/path/to/worktree WEAPP_PREVIEW_MODE=mock "$PREVIEW" push

# 当前 worktree 的局域网 server 验收
AI_PILOT_REPO=/path/to/worktree WEAPP_PREVIEW_MODE=server LAN_IP=192.168.x.x "$PREVIEW" check-api
AI_PILOT_REPO=/path/to/worktree WEAPP_PREVIEW_MODE=server LAN_IP=192.168.x.x "$PREVIEW" push

# 明确的 HTTPS 环境
AI_PILOT_REPO=/path/to/worktree WEAPP_PREVIEW_MODE=server \
  WEAPP_APP_API=https://example.com/api "$PREVIEW" push
```

可用动作：`print-env`、`check-api`、`build`、`watch`、`auto-preview`、`preview`、`push`。其中 `push = build + auto-preview`；`watch` 是长运行命令。

## 手工兜底

```bash
cd /path/to/worktree/app

# mock
node scripts/build-native-weapp.mjs --mode mock

# server
node scripts/build-native-weapp.mjs --mode server --api http://192.168.x.x:4000/api

/Applications/wechatwebdevtools.app/Contents/MacOS/cli auto-preview \
  --project /path/to/worktree/app/dist-native \
  --info-output /path/to/worktree/weapp-auto-preview-info.json \
  --lang zh
```

报告成功前确认：

1. 构建输出是 `app/dist-native/`。
2. `dist-native/junshi-build-meta.json` 的 `runtime=native-weapp`，mode/API 与本次请求一致。
3. CLI 显示 AppID `wx810ebe6dfef8e75f` 和 `✔ auto-preview`。
4. 明确告诉用户推的是 mock 还是 server。

`--info-output` 与二维码路径必须放仓库或其他可写目录，禁止 `/tmp`；DevTools 对 `/tmp` 可能报误导性的 code 17。预览 JSON/二维码是本机产物，不纳入提交。
