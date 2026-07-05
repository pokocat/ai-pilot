# 军师 · 后端集成测试（TESTING）

> 目的：**大的变更后跑一遍**，守住核心契约——尤其 **跨用户/跨租户数据隔离（防信息泄露）**。
> 全程 **mock 模型**（不调用真实 LLM）：产出走确定性模板、嵌入走本地确定性向量，结果可复现。
> 现状：**57 用例 / 23 套件（0 跳过）**；覆盖微信登录 openid 复登、运营后台鉴权、算力/套餐购买、智能体权益、军师档案访谈与用户主路径。最近一次 Docker 临时 PostgreSQL 测试库实跑为 2026-06-13，57/57 全过；CI 用临时 PostgreSQL 服务跑后端 build + 全量集成测试。

## 一、怎么跑

集成测试用 Fastify `inject`（免端口）+ Node 原生 test runner（`node --import tsx --test`），需要一个 **PostgreSQL 测试库**（与开发库分开，避免污染）。

```bash
cd server

# 1) 准备测试库（一次）
createdb junshi_test                # 或 psql 里 CREATE DATABASE junshi_test;
export DATABASE_URL="postgresql://USER:PASS@127.0.0.1:5432/junshi_test?schema=public"
npm run db:push                     # 建表（含本项目全部模型）

# 2) 跑测试（每次）
AI_PROVIDER=mock npm test
```

- 不需要真实 API Key：未配 key 时模型自动降级 mock。
- 不需要 pgvector：默认 `PGVECTOR_ENABLED=false`，检索走内存余弦。
- 测试 `before` 会清空业务表并灌入智能体注册表；每个用例用唯一手机号建独立账号，互不干扰。
- ⚠️ 未设 `DATABASE_URL` 会因连不上库而整体失败——这是预期，请先准备测试库。

### CI 跑法

仓库已内置 `.github/workflows/server-integration.yml`。GitHub Actions 会启动 `postgres:16-alpine` 服务，并使用 tmpfs 数据目录保证每次运行都是干净临时库：

```bash
cd server
npm ci
npx prisma generate
npm run build
npx prisma db push --skip-generate
AI_PROVIDER=mock PGVECTOR_ENABLED=false npm test
```

CI 只跑后端回归；小程序/后台构建仍按 `AGENTS.md §11` 的三端构建基线执行。

### 纯单元测试（免 DB，可单独跑）

部分模块有不连库、不联网的纯单元测试，stub `globalThis.fetch` 即可，无需准备测试库：

```bash
cd server
node --import tsx --test test/dify.test.ts   # Dify 提供方（28 用例）：请求构造/响应解析/inputs 占位符映射/连通性测试
```

> `npm test` 会把所有 `test/*.test.ts` 一起跑（含需要 DB 的集成测试）；只想验证某个纯单元模块时按上面单跑该文件。
> Dify / per-agent 接入的设计与配置见 [AGENT_PROVIDERS.md](AGENT_PROVIDERS.md)。

## 二、覆盖的用例（与代码 `server/test/integration.test.ts` 一一对应）

| 编号 | 场景 | 关键断言 |
|---|---|---|
| **TC-A** | 鉴权与账号隔离基线 | 无/非法 token → 401；手机号登录自动建号；微信 openid 登录/复登；A、B 属不同租户；admin 接口无凭证→401、普通用户→403 |
| **TC-B** | 与不同智能体对话（mock） | general → 自由对话；strat → 结构化成果（多段）；会话持久化可回溯 |
| **TC-C** | 长期记忆召回 | 对话后写入记忆且下次可召回；**语义召回**——与问题相关的记忆排在前 |
| **TC-D** | 项目 + 知识库 + 跨对话召回 | 会话归属项目；知识入库→检索命中→**下次对话上下文自动召回**；**对话汇总→版本化报告+沉淀知识库** |
| **TC-E** | 版本化报告 + diff | 同名续版本（v1→v2）；**同内容去重**不新增版本；两版 **section 级 + 词级**差异 |
| **TC-G** | **★ 跨用户隔离（防泄露）** | A 的 项目/报告/方案库/知识 B 全不可见；**B 检索搜不到 A 的机密**；直取 A 资源→404；服务层 `hybridSearch`/`resolveReferences`/`recallMemories`/`buildGenContext` 跨租户一律隔离 |
| **TC-H** | 模型配置 | 读配置含 `hasKey` 布尔、**绝不回传明文 apiKey**；切 Agnes；未配 key 实际降级 mock |
| **TC-I** | 流式产出（SSE） | `/generate` 按事件流式下发 `begin/section/footer/done` |
| **TC-J** | 内容审核拦截 | 命中违规词输入 → 422 `MODERATION_BLOCK` |
| **TC-K** | 算力账户 + 套餐购买 | 注册按套餐赠送、`/me` 见余额；**报告产出按次扣减、对话免费、`/me` 同步**；**余额不足→402 拦截且不留会话**；购买决策版后切套餐并入账算力、后台用量同步；购买企业版后余额 `-1` 且报告不扣费 |
| **TC-V** | 智能体权益 | `/agents` 返回 `billing/price/owned`；`unlock` 未解锁→403 且不留会话；算力解锁扣费且幂等；余额不足→402；`free` 不可购买；`metered` 免解锁按 price 扣费；后台可为用户开通/取消；后台可新增智能体且默认下架 |
| **TC-L** | 并发冒烟 | 同用户并发 8 次产出均成功、会话不串号 |
| **TC-M** | 首登建档→个性化 | 建档后 `onboarded=true`；产出按企业档案（行业）个性化 |
| **TC-N** | 老用户回流 | 同手机号复登 token 不变、历史项目仍在（持久化） |
| **TC-O** | 跨智能体协同+引用闭环 | 一个项目内 战略报告→融资参谋 @引用它续产；项目聚合多智能体产物 |
| **TC-P** | 成果反馈回流 | 默认配置不写反馈记忆；开 `deliverable_feedback` 后采纳信号可召回 |
| **TC-Q** | 记忆留存 TTL | 过期记忆不召回、未过期正常召回 |
| **TC-R** | 跨项目知识隔离 | 同一用户：项目 A 对话不串入项目 B 的知识 |
| **TC-S** | 每日献策 | `/sayings/today` 返回当日一条 |
| **TC-T** | 边界/健壮性 | 空输入→400；空检索→[]；删除会话后不可访问且从列表消失 |
| **TC-U** | 用户主要操作路径 | 登录→拉智能体/问卷→建档→建项目→加知识→顾问产出→存方案库/版本报告→生成纪要→项目聚合，且算力扣减与 `/me` 同步 |
| **TC-W** | 运营后台鉴权 | 无凭证→401；普通小程序用户→403；错误密钥→401；正确 `ADMIN_TOKEN`→200；`role=admin` 用户可凭 x-user-id 访问；普通用户不能越权自助开通付费智能体 |
| **TC-X** | 身份与账号注销 | 注册不生成随机名；旧占位名不展示为真实身份；花名只写用户称呼不写公司；PUT `/me` 同步称呼+公司；报告抬头使用真实公司；军师档案访谈不召回旧项目/知识/记忆；注销后 token 失效且用户数据删除 |

> 命名跳过 TC-F：对话汇总并入 TC-D（D3）。模拟的「企业主旅程」：首登建档(TC-M/U)→跟多位顾问在一个项目里出谋(TC-B/O/U)→解锁/使用付费智能体(TC-V)→成果版本化迭代(TC-E/U)→对话沉淀知识/纪要(TC-C/D/U)→越用越懂(记忆 TC-C/P/Q)→购买套餐与消耗算力(TC-K)→回流续用(TC-N)；全程**数据按用户/租户/项目隔离**(TC-A/G/R)。

### TC-G 为什么重点
这是**信息泄露**的红线。它同时从 **HTTP 层**（列表/检索/直取接口）和 **服务层**（`hybridSearch` 租户过滤、`resolveReferences` 拒解析他人资源、`recallMemories` 按 userId、`buildGenContext` 不注入他人知识）双重验证：**B 即便拿到 A 的资源 id 显式 @引用，也解析不出任何内容**。大改检索/上下文/路由后，**务必跑通此用例**。

## 三、约定
- **大变更必跑**：改了 路由 / 鉴权 / 检索 / 上下文注入 / 数据模型 后，跑 `npm test` 必须全绿再提交。
- **新功能配用例**：新增可隔离的数据类型（如「文档上传」），必须在 TC-G 补一条跨用户不可见断言。
- **保持 mock 可复现**：测试不依赖真实 LLM；若被测逻辑依赖模型，用确定性兜底或在服务层断言。

## 四、扩展指引
- 新增 HTTP 流程：用 `api(method, url, { token, body })`（见 `test/helpers.ts`），无 body 的 POST 不要带 body。
- 新增账号：`login(uniquePhone())` 返回 token（=userId，作 `x-user-id`）。
- 断言服务层细节（召回/diff/隔离）可直接 import `server/src/services/*`，与路由共用同一 `prisma`。
- 待补（见 ROADMAP P3）：性能基准（非冒烟）。

## 五、附：H5 浏览器手测（替代小程序，推荐）

一套 Taro 码同出 weapp + H5、功能完全对齐（无任何平台分叉代码）。**用 H5 在浏览器里即可手测全部后端变更**（项目 / 知识 / 版本化报告 / @引用 / 汇总 / 算力扣减），免微信开发者工具。

### 最简：一键起全栈（推荐）
```bash
npm run dev   # 根目录：确保 PG → 建库/迁移/首次种子 → 同起 后端 + H5 + 运营后台
```
→ 打开 **http://localhost:5173**（H5 手测）、http://localhost:5174（运营后台改模型）；演示账号手机号 `13800000000`。详见 `AGENTS.md §11`。

### 两种模式（手动）
- **mock（零后端，走查 UI）**：`cd app && npm run dev:h5`（纯前端数据源）。
- **server（连后端，测真实变更）**：
  1. 起后端：`cd server && export DATABASE_URL=... && npm run db:push && npm run db:seed && AI_PROVIDER=mock npm run dev`（:4000）
  2. 构建并预览 H5：`cd app && npm run build:h5:server && npm run serve:h5` → 打开 **http://localhost:5173**
  3. 改模型：`cd admin && npm run dev`（运营后台「模型」页，默认 Agnes；填 key 即切真实模型）

`build:h5:server` = `TARO_APP_MODE=server`；后端地址默认 `http://localhost:4000/api`（可用 `TARO_APP_API` 覆盖）。

### 微信小程序账号联调
1. 服务端 `.env` 填 `WECHAT_MINI_APPID`（与 `app/project.config.json` 一致）和 `WECHAT_MINI_SECRET`，执行 `cd server && npm run db:push && npm run dev`。
2. 小程序构建走真实后端：`cd app && TARO_APP_MODE=server TARO_APP_API=https://你的域名/api npm run build:weapp`。
3. 微信开发者工具导入 `app/`；本地调试可临时勾选“不校验合法域名”，真机/预览必须在微信后台把 `TARO_APP_API` 的 HTTPS 域名加入 request 合法域名。
4. 登录弹层会在 weapp + server 模式显示“微信账号登录”；后端用 `wx.login` code 换 openid/unionid 后生成自有 token，`session_key` 不下发前端。

### 已验证（本地实跑，浏览器 :5173 → 后端 :4000）
CORS 预检放行自定义头 `x-user-id`；登录→`/me`→产出全通；**算力实时扣减**（产出前 10 → 报告后 9、`/me` 同步）；`/me` 正确读出 `ai=Agnes 2.0 Flash`。

### 说明
- H5 用 **hash 路由**，`dist/` 可被任意静态服务器打开；`serve:h5` 是零依赖内置静态服务器（`app/scripts/serve-h5.mjs`）。
- 普通聊天默认走 `/generate` SSE 真流式：H5 用 `fetch` ReadableStream，小程序用 `enableChunked/onChunkReceived`；总军师 on-demand 普通问答走 token 流，明确成果请求才回同步成果路径；流式失败自动回退 `generate-sync`(POST)。TC-I 覆盖 `/generate` 事件流。
