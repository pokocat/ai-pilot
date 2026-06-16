# 微信小程序上传版本记录

> 本文件记录每次上传到微信小程序后台的版本号、描述、提交和结果。
> 执行 DevTools CLI `upload` 或 `miniprogram-ci upload` 前，先确认本文件即将新增的记录与上传命令一致；上传成功后补齐包体与状态。

## 记录规则

- `版本号` 必须与上传命令的 `--version` 或 `UPLOAD_VERSION` 一致。
- `上传描述` 必须与上传命令的 `--desc` 或 `UPLOAD_DESC` 一致。
- `提交` 使用上传产物对应的 Git short SHA。
- `状态` 区分 `上传成功`、`上传失败`、`预览`；只把真正上传到微信后台的记录写为 `上传成功`。
- 上传失败也要记录失败原因，避免重复踩同一个 CLI/权限/网络问题。
- AGENTS.md 只保留入口约束，不记录每次上传明细。

## 上传记录

| 日期 | 版本号 | 上传描述 | 提交 | AppID | API | 工具 | 包体 | 状态 |
|---|---|---|---|---|---|---|---|---|
| 2026-06-16 | `0.2.1` | `修复上传引导:从聊天选文件(文件传输助手)` | `e6689ff` | `wx05a49967e2adb557` | `https://wxapi.aibuzz.cn/api` | WeChat DevTools CLI `upload` | 491.5 KB / 503253 B | 上传成功 |
| 2026-06-16 | `0.2.0` | `知识库:我的资料库+文档上传` | `a50596b` | `wx05a49967e2adb557` | `https://wxapi.aibuzz.cn/api` | WeChat DevTools CLI `upload` | 490.5 KB / 502279 B | 上传成功 |
| 2026-06-14 | `0.1.6` | `junshi server build 7820f1c` | `7820f1c` | `wx05a49967e2adb557` | `https://wxapi.aibuzz.cn/api` | WeChat DevTools CLI `upload` | 481.8 KB / 493328 B | 上传成功 |
| 2026-06-14 | `0.1.5` | `junshi server build 606fe8d` | `606fe8d` | `wx05a49967e2adb557` | `https://wxapi.aibuzz.cn/api` | WeChat DevTools CLI `upload` | 481.9 KB / 493455 B | 上传成功 |
| 2026-06-14 | `0.1.4` | `junshi server build 59a3458` | `59a3458` | `wx05a49967e2adb557` | `https://wxapi.aibuzz.cn/api` | WeChat DevTools CLI `upload` | 481.7 KB / 493309 B | 上传成功 |
| 2026-06-14 | `0.1.3` | `junshi server build 5fe99d3` | `5fe99d3` | `wx05a49967e2adb557` | `https://wxapi.aibuzz.cn/api` | WeChat DevTools CLI `upload` | 481.7 KB / 493284 B | 上传成功 |
| 2026-06-14 | `0.1.2` | `junshi server build f424d6e` | `f424d6e` | `wx05a49967e2adb557` | `https://wxapi.aibuzz.cn/api` | WeChat DevTools CLI `upload` | 481.7 KB / 493259 B | 上传成功 |
| 2026-06-14 | `0.1.1` | `junshi server build 0de177a` | `0de177a` | `wx05a49967e2adb557` | `https://wxapi.aibuzz.cn/api` | WeChat DevTools CLI `upload` | 518.5 KB / 530936 B | 上传成功 |
| 2026-06-13 | `0.1.0` | `junshi server build 7b2e0a3` | `7b2e0a3` | `wx05a49967e2adb557` | `https://wxapi.aibuzz.cn/api` | WeChat DevTools CLI `upload` | 509.4 KB / 521641 B | 上传成功 |
