# 军师 · 上线核查 SOP（预发 → 生产）

> **这份文件的来历**：2026-08-17 一次「预发全绿、切到生产就露」的连环故障复盘。
> 一天里连续踩了 8 个坑，没有一个是「代码写错了」——全部是**代码之外**的：配置活在库里、
> 模型路由默认值、构建从哪里取源、验证打没打真实链路。所以这份 SOP 只收「测试跑绿也发现不了」的那类检查。
>
> 与 [RELEASE_STRATEGY.md](RELEASE_STRATEGY.md) 的分工：那份管**契约怎么演进、谁先发**（兼容方向、
> 后端先行、服务端开关）；这份管**每次上线动手时逐条核什么**。两份都过一遍才算完。

---

## 0. 这次漏了什么（先看这张表）

| 现象（用户看到的） | 真因 | 类别 |
|---|---|---|
| 海报设计师还在出「方案报告」 | 代码 08-13 就改了人格，但运行时读库里的 `agent_version`，部署从不 seed，生产停在 v2 | 真源不在代码 |
| 确认页整张表单是空的 | `structured()` 没给 `maxTokens` → 辅助档缺省 700 → 中文 JSON 被截断 → 返回 null → 每个字段回退成空 | 静默失败 |
| 同一段对话，有时抽满有时全空 | 抽取默认落 `aux` 档小模型（deepseek-v4-flash），它把提示词末尾那份空 JSON 壳当答案抄回来 | 默认值反了 |
| 端上报「军师响应超时」而服务端明明快出来了 | 端上默认 30s，服务端最坏 2 轮 × 60s = 120s | 两端预算没对齐 |
| 快拍内置片尾是占位视频 | 真片尾只在新 jar 的 classpath 里；生产那台跑着 5 天前的构建，且官方模板 seeder 默认不覆盖 | 跨仓库/跨主机 |
| 部署失败，且**下次重启会崩** | `git add <file>` 把并行 session 的未提交改动一起提交，归档缺文件；`tsc` 报错照样 emit，污染了 `dist` | 构建卫生 |
| 本地 `tsc` 绿、远端构建红 | 本地有未跟踪文件，`git archive HEAD` 里没有 | 构建卫生 |
| 「修好了」但第 3 次采样又空了 | LLM 链路单次成功不算数（线上 temperature 被强制为 1，方差极大） | 验收方法 |

---

## 1. 发布前：先确认「真源在哪」

改动涉及下面任何一类，**代码改了 + 部署了 ≠ 生效**。逐条核，别推理。

### 1.1 智能体行为（提示词 / `deliverableKey` / `skillsConfig`）

运行时读 `agent.publishedVersionId` 指向的 `agent_version` 快照（`resolveEffectiveAgent`），
而 `deploy-prod.sh` 只跑 `prisma db push`，**从不 seed**。

```bash
cd server && npm run agents:check-drift
```

改了 `src/data/agents.ts` 的行为字段就必须跑一次（生产、预发各跑）。有漂移时的落库姿势：
改 `agent` 草稿行 → 调 `dist/services/agentVersions.js` 的 `publishDraft`（**别手写 `agent_version`**，
`contentHash` 是代码算的）。回滚用 `rollbackToVersion` 重指旧版本。

### 1.2 归运营后台、代码里的值不作数

**不要**同步、不要"对齐常量"、不要写进 seed：

- 计费权益：`billing / price / billingRatio / meterUnit / gift`
- AI 接入与路由：`ai_route / ai_route_member / ai_endpoint`（purpose 分 `chat / deliverable / aux / embedding / rerank`）
- 智能体展示文案：`greet / chips / memText / learnText / enabled / sort`

生产 poster 是 `free/0/5x`、代码写着 `unlock/8/1x` —— 那是**正常**的。

### 1.3 预发不等于「对的那一边」

同一批核对里，`poster` 是预发对、`general` 是**生产对**（线上提示词是运营逐版调教的长版本，
仓库文件只是初始化种子）。所以「以预发为基准」要**逐字段判**，不能整行覆盖。

### 1.4 跨仓库 / 跨主机的依赖

快拍（视频）的模板、片尾、素材都不在本仓库，来自 AIStar，而且**预发和生产在两台不同机器上**
（预发 `127.0.0.1:8081` 与军师同宿主机；生产 `api.aibuzz.cn` → 另一台）。官方模板 seeder 默认
`reseed=false`「尊重运营编辑不覆盖」，所以光部署新版不会更新已存在的模板。细节见
`~/.claude/.../memory/video-clip-two-hosts.md`（或问下一位接手的人）。

---

## 2. 发布前：构建与提交卫生

主干上**长期有并行 session**（本次同时有 12 个 worktree、37 个未提交文件）。下面每条都是被咬过的。

### 2.1 只提交自己的 hunk

`git add <file>` 是按**整个文件**入库的。本次事故：`git add server/src/llm/gateway.ts` 把别人未提交的
`publicThought` 功能一起提交了，而它依赖的未跟踪文件没进去 → 远端 `tsc` 报 14 个错。

```bash
git diff -- <file>          # 先看清这个文件里有几个人的改动
```

只有自己的改动才能整份 add。混着别人的活时，做一个「HEAD 版 + 只打自己补丁」的 blob 再入库：

```bash
git show HEAD:<path> > /tmp/base            # 取干净基线
# 在 /tmp/base 上只应用自己的改动，然后：
BLOB=$(git hash-object -w /tmp/base)
git update-index --cacheinfo 100644,$BLOB,<path>   # 只改暂存区，工作区一字不动
```

### 2.2 本地 typecheck 绿 ≠ 归档能构建

`deploy-prod.sh` 打包的是 `git archive HEAD`，而本地 `tsc` 看得见未跟踪文件。**发布前必须验归档**：

```bash
rm -rf /tmp/archcheck && mkdir -p /tmp/archcheck
git archive HEAD | tar -x -C /tmp/archcheck
ln -s "$PWD/server/node_modules" /tmp/archcheck/server/node_modules
cd /tmp/archcheck/server && npx tsc -p tsconfig.json --noEmit
```

> 顺带纠一个坑：`server` 没有 `typecheck` / `lint` 这两个 npm script（整个仓库也没有 eslint 配置）。
> 真正的检查是 `npx tsc -p tsconfig.json --noEmit`；`npm run -s typecheck && echo OK` 这种写法会把
> `echo` 的退出码当成结果，看着绿其实什么都没跑。

### 2.3 小程序包是从**工作区**打的，不是从 HEAD

`release:weapp` 读的是 `app/weapp-native/` 当前磁盘内容。所以审核包必须在干净检出上构建：

```bash
git worktree add --detach /tmp/release-wt HEAD
ln -s "$PWD/app/node_modules" /tmp/release-wt/app/node_modules
cd /tmp/release-wt/app && npm run release:weapp -- --version x.y.z --desc "说明" --dry-run
```

打完核对 `dist-native/junshi-build-meta.json`（`mode=server` / 生产 API / 版本 / gitSha），并**确认
不该进包的东西没进包**（本次刻意排除了并行开发中的「后端环境角标」——调试标识不得进正式包）。

### 2.4 部署失败之后，先查 dist 有没有被污染

`tsc` 有类型错误**照样 emit**。本次失败的部署把半成品写进了 `/opt/junshi/server/dist`，
服务当时没重启所以还在跑旧代码，但**下一次重启就会崩在缺失的模块上**——这是最危险的中间态。

```bash
# 部署失败后必查：dist 里有没有指向缺失文件的 import
ssh <host> 'sudo -u junshi grep -c "<新模块名>" /opt/junshi/server/dist/<路径>.js'
```

结论：**部署失败不等于没事发生**。要么修好重发一次成功的，要么把 dist 恢复到上一个好版本。

---

## 3. 发布动作

1. **顺序**：后端先行（见 RELEASE_STRATEGY 铁律二）。审核期客户端发不动时，用服务端开关解耦「发布」与「生效」。
2. **生产与预发同宿主机**（军师侧）：构建曾伴随宿主机压力导致生产 502。**部署前后各探一次生产健康**，
   且不要用管道 `tail` 吞掉退出码：
   ```bash
   curl -sS -o /dev/null -w "http=%{http_code}\n" -m 15 https://wxapi.aibuzz.cn/api/health
   bash scripts/deploy-prod.sh > /tmp/deploy.log 2>&1; echo "exit=$?"
   ```
3. **动库之前先备份**，且备份要验完整性（本次：`mysqldump | gzip` 后 `gzip -t` + 数表数 + 查关键表有没有 INSERT）。
4. **一次性开关用完必须关回去**。例：AIStar 的 `AEP_CLIP_RESEED_OFFICIAL_TEMPLATES=true`
   刷完模板必须删掉并重启，否则以后每次部署都会覆盖运营的后台编辑。
5. **改生产数据只搬该搬的字段**。同步「行为字段」时不要顺手带上计费与接入字段（见 §1.2）。

---

## 4. 验收：必须打真实链路

### 4.1 别信不存在的健康端点

AIStar 的 `/actuator/health` 返回 404。探活探了个 404 还当成"没起来/起来了"都是错的。
**有效验收是打业务入口**：从军师 BFF 发一次 `/api/me/clip/templates`，200 + 内容对，才算服务活着。

### 4.2 直接在生产上跑真实函数（只读）

比读代码可靠得多。姿势（**不要往 `/opt/junshi/server/dist` 里写文件**，root 才有写权限，而且会污染发布目录）：

```bash
# 把 dist 整份 cp 到 /tmp、软链真 node_modules，改副本、cd 到真目录跑（为了 dotenv 读到 .env）
sudo -u junshi cp -r /opt/junshi/server/dist /tmp/abt/dist
sudo -u junshi ln -s /opt/junshi/server/node_modules /tmp/abt/node_modules
sudo -u junshi bash -lc "cd /opt/junshi/server && node /tmp/abt/run.mjs"
```

### 4.3 LLM 链路：一次成功不算数，至少采 3 次

线上 `chat` 档开着 adaptive thinking、**temperature 被强制为 1**，方差极大。本次实测同一段对话：
两次抽满、一次只填两个字段、一次回吐空壳、一次 60s 超时。**只跑一次就宣布修好，会把概率问题当成已解决**。

### 4.4 端上超时 vs 服务端最坏预算

改任何"等模型"的接口，两边一起算：服务端最坏耗时（含 `structured()` 的纠错轮 = 2 × `OPENAI_TIMEOUT_MS`）
必须小于端上 `timeout`。端上 `request()` 默认 30s，LLM 类接口要显式给（现约定 180s）。

---

## 5. LLM 链路专项（本次最大的一片坑）

1. **`structured()` 默认落辅助档小模型**。`rawText` 里 `allowAux` 缺省为真，`structured()` 只在调用方
   显式传了 `model` 时才关掉。aux 的设计初衷是「用户看不见的后台抽取」（还切独立并发车道）。
   **用户正盯着等的抽取必须显式 `allowAux: false`**，不要靠传假 model 名反向关（那会覆盖运营配的模型）。
2. **长 JSON 必须显式 `maxTokens`**。缺省是辅助档的 700，中文 JSON 一截就废。已知两次同因事故：
   海报宣言（2026-07-30）、需求单草稿（2026-08-17）。
3. **`structured()` 解析失败只返回 `null`，不抛、不打日志**。每个调用点都要有 null 分支的
   `console.warn`，否则线上空数据在 journalctl 里连一行都查不到。
4. **提示词末尾不要给"值全为空"的 JSON 壳**——小模型会把它当答案模板照抄。给键名清单 +
   一条明规则「这是清单不是模板，不许把空字符串交回来」。
5. **同一份素材上的两处上限方向要一致**。曾经 `loadConversationText` 按「结论在末尾」取尾部 6000 字，
   而 `structured()` 内部 `slice(0, maxChars)` 取头部 1200 字——外层把内层刚保下来的结尾又切掉了。

---

## 6. 一页速查

发布前：

- [ ] 改动涉及智能体行为字段？→ `npm run agents:check-drift`（生产 + 预发都跑）
- [ ] 改动涉及计费 / AI 路由 / 展示文案？→ 那是运营后台的，代码不作数，别同步
- [ ] 依赖 AIStar（快拍）？→ 确认生产那台的构建版本，官方模板要 reseed 才更新
- [ ] `git diff -- <file>` 确认要提交的文件里没有别人的活
- [ ] `git archive HEAD` 解包后单独 `tsc --noEmit` 过一遍
- [ ] 小程序包在 `git worktree` 干净检出上构建，核 `junshi-build-meta.json`
- [ ] 要动库 → 先备份并验证备份可用

发布中：

- [ ] 后端先行；客户端发不动就用服务端开关
- [ ] 部署前后各探一次生产健康，别吞退出码
- [ ] 一次性开关（reseed 之类）用完立刻关回去并重启

发布后：

- [ ] 打真实业务入口验收，不用可能不存在的健康端点
- [ ] LLM 链路采样 ≥ 3 次
- [ ] 端上超时 ≥ 服务端最坏预算
- [ ] 部署失败过？→ 确认 `dist` 没被半成品污染（重启即崩的地雷）
- [ ] 补 [WEAPP_RELEASES.md](WEAPP_RELEASES.md) / `.deploy-history` 记录
