# strat 「战略参谋[专业版]」V6.0 prompt — 仓库基线

线上 `agent.key=strat`(显示名「战略参谋[专业版]」)的 system prompt **只存在于生产 DB**(`pubVer=NULL`,无版本快照、无仓库副本)。这里是把它拉回仓库做基线/备份的结果。

| 文件 | 是什么 | 能不能改 |
|---|---|---|
| `strat.v6.baseline.md` | **逐字快照**:2026-06-20 从 prod DB 拉取的 `systemPrompt`(41713 字)。还原源。 | ❌ 不要改 |
| `strat.v6.md` | **去品牌后的可部署版**:在 baseline 上做了品牌替换(见下)。 | ✅ 这是下次要部署的版本 |
| `dossier.seed.md` | §9.2「战略档案」种子模板(填了示例八字),丢进 `Profile.extraJson.dossier` 即可让 V6.0 当持久档案读到。 | ✅ 测试用 |

## 与 Notion「天势终极版 V6.0」(`38605c5098e680a5bbe5dd8adee93006`)的差异

内容(19 部分)逐部分一致。线上版相对 Notion 原稿:
1. 删光了 B 级卡片的 HTML/CSS 骨架(只留卡片清单表)——原始卡片骨架仍在 Notion,是找回模板的来源。
2. 末尾追加了 `【产出格式】只输出结构化分段…网页样式由系统统一渲染`(适配 `reportHtml.ts`)。
3. 全文 0 个 `{占位符}`——没接系统注入;靠 `buildSystemParts` 无条件追加的【客户档案】块拿到「个人档案/understanding」。

## 品牌替换(strat.v6.md 相对 baseline)

`对外不要透出米诺`:`米诺战略参谋部 → 军师参谋部`、`米诺 → 军师参谋`、`Mino Strategic Staff → Junshi Strategic Staff`、`Mino → Junshi`。中文版势头/孙子/麦肯锡内容不动。

## 如何部署到 prod

prompt 不由代码托管(它在 DB)。把 `strat.v6.md` 内容更新进生产 DB 的 `agent.systemPrompt`(`key=strat`):走 admin「智能体」编辑保存,或直接 DB `UPDATE`。**部署前先确认 prod 当前 = baseline**(避免冲掉线上独有改动)。详见 memory `prod-deploy-method` / `strat-v6-embedding`。
