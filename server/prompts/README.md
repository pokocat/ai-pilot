# prompts/ · 大部头提示词的版本管理目录（PR-5a）

`src/data/agents.ts` 启动/seed 时从这里加载全文提示词；文件缺失则回退代码内的占位模板。

| 文件 | 内容 | 状态 |
|---|---|---|
| `strat.v6.md` | 《军师参谋部 · 天势终极版 V6.0》全文（strat 主提示词） | ✅ 已于 2026-07-02 从生产库取回（41711 字节 / 16168 字符；与 Notion 原稿差异：品牌为「军师参谋部」+ 结尾含结构化输出约束） |

## 从生产库重新取回（只读，一条命令；线上后台改过提示词后同步用）

```bash
ssh -i /Users/donis/dev/aliyun/aiartist.pem ecs-user@wxapi.aibuzz.cn \
  'sudo -u junshi bash -lc "psql \"$(grep ^DATABASE_URL= /opt/junshi/server/.env | cut -d= -f2- | sed s/?schema=public//)\" -At -c \"SELECT \\\"systemPrompt\\\" FROM agent WHERE key='"'"'strat'"'"'\""' \
  > server/prompts/strat.v6.md
```

取回后校验：`wc -c server/prompts/strat.v6.md` 应 ≈41711（16168 字符）；`git diff` 审阅后提交。

## 口径

- **线上库 `agent.systemPrompt` 仍是运行时事实来源**（运营后台可改）；本目录保证「仓库初始化 = V6.0 全文」，且此后提示词变更走 git 版本管理（改文件 → 后台发布/UPDATE 同步线上）。
- 生产**不要**重跑 seed（deleteMany 会冲掉用户引用，见 AGENTS.md 生产部署节）；同步线上用幂等 UPDATE。
- 本目录参与部署打包：生产 scp 时需带上 `prompts/`（构建产物 dist 相对 cwd 读取 `prompts/strat.v6.md`）。
