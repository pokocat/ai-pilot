# prompts/ · 提示词种子文件

## 口径：后台是真相源，本目录只是种子

**2026-07-28 定调，取代此前含糊的表述。**

| | 谁说了算 |
|---|---|
| **运行时提示词** | 数据库 `agent.systemPrompt` → 已发布快照 `agent_version`。**运营在后台调教，这是唯一事实来源。** |
| **本目录的 `.md`** | 仅用于**新环境初始化**（`seed` / `sync-content` 的 create 分支）。已有环境不以它为准。 |

此前 README 与 `agents.ts` 的注释都同时写了「线上库是运行时事实来源」和「提示词变更走 git 版本管理」——这两句互相矛盾，也正是 `admin:sync-content` 曾经会静默覆盖线上调教的根源。现统一为前者。

**因此：**

- ❌ **不要**为了「让仓库和线上一致」而定期回灌。运营调教需要快速试错，走 git 提交太重；实测也印证了这一点——9 个专业 agent 与仓库逐字节一致、从没被改过，只有 `general` 被持续微调。
- ✅ `npm run admin:sync-content` 默认**跳过** `systemPrompt` / `greet`（见 `scripts/syncAdminContent.ts` 的 `OPERATOR_OWNED`）。这是有意的，不是遗漏。
- ✅ 确需用文件覆盖线上（新环境铺底、或明确要回退某个版本）：加 `--force-prompts`；若仓库版本比线上短超过 20% 还会再拒一次，要绕过需 `--allow-shrink`。
- ✅ 想看线上现在长什么样：`npm run admin:sync-content -- --dump-prompts <目录>`（只读，导出所有 agent 的 systemPrompt/greet + index.json）。

## 文件

| 文件 | 内容 | 挂在哪个 agent |
|---|---|---|
| `strat.v6.md` | 《军师参谋部 · 天势终极版 V6.0》全文 | **`general`**（总军师） |

> 文件名沿用 `strat.v6.md` 是历史原因——V6.0 最初挂在 `strat` 上，2026-07-03 迁到 `general`，`strat` 已回归「战略诊断官」专业模板。**改名需同步 `agents.ts:28`。**

**⚠️ 全文即提示词**：`loadPromptFile()` 把文件内容原样 `trim()` 后作为 system prompt 下发。**不要在 md 里加任何说明性文字、YAML front matter 或注释**——包括 `<!-- -->`，对模型来说那也是正文。所有说明写在本 README 或代码注释里。

## 当前长度（2026-07-28 实测）

| | 字节 | UTF-8 字符 |
|---|---|---|
| 仓库 `strat.v6.md` | 44,959 | 17,232 |
| 生产 `agent.general` | 49,094 | 19,486 |
| 差异 | +9.2% | +13.1%（24 行，相似度 98.1%） |

**⚠️ 量长度必须区分字节与字符**：生产库 `server_encoding = SQL_ASCII`，该编码下 PostgreSQL 的 `length()` 返回**字节数**（恒等于 `octet_length()`），中英混排约 2.5 字节/字符。2026-07-27 曾因拿 DB 的字节数与文件的字符数相比，把 9% 的差误报成「漂移 2.85 倍」。同理 `wc -m` 在非 UTF-8 locale 下也会退化成字节数，用 `python3 -c "print(len(open(f,encoding='utf-8').read()))"` 才可靠。

## 其他约定

- 生产**不要**重跑 seed（`deleteMany` 会冲掉用户引用，见 AGENTS.md 生产部署节）。
- 本目录参与部署打包：生产 scp 时需带上 `prompts/`（dist 相对 cwd 读取 `prompts/strat.v6.md`）。
- 存量品牌残留见 AGENTS.md §13：`src/data/prompts/strat.v6.baseline.md` 那份 2026-06-20 的原始快照仍含旧品牌（运行时不加载）。**本目录的 `strat.v6.md` 与线上 `general` 均已核对为 0 处残留。**
