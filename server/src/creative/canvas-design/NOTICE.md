# NOTICE · Canvas Design Skill 上游来源与许可证

本目录收录了第三方 Skill 的原文与许可证，用于「海报成品图」（`canvas_design`）能力的视觉哲学提示词底稿。

## 上游来源

| 项 | 值 |
|---|---|
| 项目 | Anthropic Skills · `canvas-design` |
| 仓库路径 | https://github.com/anthropics/skills/tree/main/skills/canvas-design |
| Skill 原文 | https://github.com/anthropics/skills/blob/main/skills/canvas-design/SKILL.md |
| 固定 commit | `b9e19e6f44773509fbdd7001d77ff41a49a486c1`（2026-04-20） |
| 引入日期 | 2026-07-29 |
| 许可证 | Apache License 2.0（全文见同目录 `LICENSE.txt`） |
| 版权声明 | Copyright 2026 Anthropic, PBC. |

## 本目录文件

| 文件 | 说明 |
|---|---|
| `SKILL.upstream.md` | **上游原文，逐字保存，不得修改**。升级时整体替换并更新上表 commit / 引入日期。 |
| `LICENSE.txt` | 上游 Apache License 2.0 全文，逐字保存。 |
| `NOTICE.md` | 本文件：来源、commit、引入日期、许可证与改编声明。 |
| `design-philosophy.md` | **Modified for Junshi Strategic Staff**：改编版中文底稿，供服务端提示词引用。 |
| `templates/` | 军师自研海报模板（`person_hero` / `editorial` / `business_launch`），与上游无关，非衍生作品。 |

## 改编声明（Apache 2.0 §4(b) 变更说明）

**Modified for Junshi Strategic Staff**：本项目未修改上游原文——原版完整保存在 `SKILL.upstream.md`。
在此基础上另行编写了 `design-philosophy.md`，把上游「先建立视觉哲学、再视觉化表达」的方法论
改编为**服务端海报生成的视觉哲学提示词底稿**（中文、面向单张商业海报、约束到固定画布与模板体系）。
两者分文件存放，改编内容不回写上游文件。

上游行为差异（改编取舍）：

- 上游面向交互式 Agent（可读写本机文件、下载字体、多轮自我refine）；本项目为**服务端确定性流水线**，
  不给模型文件系统与网络权限，字体只用镜像内置的开源 OFL 字型栈。
- 上游产出 `.md` + `.pdf`/`.png`；本项目 MVP **只产出 PNG**，哲学文本作为任务中间产物落库不对外交付。
- 上游允许自由发挥页数与画幅；本项目固定 3:4 画布 + 白名单模板，超出白名单一律回退默认模板。

## 商标与关系声明

Anthropic、Claude 及相关标识为 Anthropic, PBC. 的商标。本项目仅在 Apache License 2.0 许可下使用其
开源 Skill 文本，**不使用上述任何商标或名称暗示官方合作、背书、认证或授权关系**。产品对外文案不得
出现「Anthropic 官方」「Claude 官方技能」等表述。

## 升级须知

按方案 `docs/CANVAS_DESIGN_SKILL_INTEGRATION_PLAN.md` §20：上游升级必须重新检查许可证是否变更、
Prompt 行为是否改变、以及是否引入新的运行权限要求（文件/网络/子进程），三项均复核后才可替换本目录文件。

## 工程注意

`design-philosophy.md` 与 `SKILL.upstream.md` 是**人类可读底稿**。生产镜像（`deploy/Dockerfile.server`）
只拷贝 `dist/`、`prisma/`、`package.json`，**不含 `src/`**，因此运行时不要用 `fs` 读取本目录的 `.md`：
提示词落代码时请把需要的段落内联为 TS 常量（或显式改 Dockerfile 一并拷贝本目录），否则生产会读不到文件。
