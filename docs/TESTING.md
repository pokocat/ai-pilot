# 军师 · 后端集成测试（TESTING）

> 目的：**大的变更后跑一遍**，守住核心契约——尤其 **跨用户/跨租户数据隔离（防信息泄露）**。
> 全程 **mock 模型**（不调用真实 LLM）：产出走确定性模板、嵌入走本地确定性向量，结果可复现。
> 现状：**16 用例 / 7 套件全部通过**（2026-06-03，本地 Postgres 16 实跑）。

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

## 二、覆盖的用例（与代码 `server/test/integration.test.ts` 一一对应）

| 编号 | 场景 | 关键断言 |
|---|---|---|
| **TC-A** | 鉴权与账号隔离基线 | 无/非法 token → 401；手机号登录自动建号；A、B 属不同租户 |
| **TC-B** | 与不同智能体对话（mock） | general → 自由对话；strat → 结构化成果（多段）；会话持久化可回溯 |
| **TC-C** | 长期记忆召回 | 对话后写入记忆且下次可召回；**语义召回**——与问题相关的记忆排在前 |
| **TC-D** | 项目 + 知识库 + 跨对话召回 | 会话归属项目；知识入库→检索命中→**下次对话上下文自动召回**；**对话汇总→版本化报告+沉淀知识库** |
| **TC-E** | 版本化报告 + diff | 同名续版本（v1→v2）；**同内容去重**不新增版本；两版 **section 级 + 词级**差异 |
| **TC-G** | **★ 跨用户隔离（防泄露）** | A 的 项目/报告/方案库/知识 B 全不可见；**B 检索搜不到 A 的机密**；直取 A 资源→404；服务层 `hybridSearch`/`resolveReferences`/`recallMemories`/`buildGenContext` 跨租户一律隔离 |
| **TC-H** | 模型配置 | 读配置含 `hasKey` 布尔、**绝不回传明文 apiKey**；切 Agnes；未配 key 实际降级 mock |

> 命名跳过 TC-F：对话汇总并入 TC-D（D3）。

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
- 待补（见 ROADMAP P3）：SSE 流式 `/generate`、内容审核拦截、算力计量、并发/性能。
