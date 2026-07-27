# 军师隔离压测

该目录用于在非生产服务器部署一套独立的军师 API + PostgreSQL + Redis，再通过 SSH
隧道从外部运行 k6。运行态不接短信、真实 LLM、微信、支付、OSS 或生产数据库。

## V2 相对上一轮改了什么（为什么必须改）

上一轮的执行、隔离、清理都很干净，但**测试口径**让部分结论不可用。详见
`docs/[OPUS5]LOADTEST_PLAN_V2_2026-07-26.md` §0，本栈已按其修正：

| 上一轮 | 现在 | 不改的后果 |
|---|---|---|
| `NODE_ENV=test` | `production` | `isAiTestMode()` 为真 → **限流插件根本不注册**，「生产入口层只有约 5 RPS」这类缺陷结构上不可能被发现 |
| `cpus: 2.25` 写死 | 默认不设，配额移到 `docker-compose.limits.yml` | 观测到的 CPU 229% 是 **cgroup 配额跑满**，被误读成「Node 单进程到顶」 |
| `APP_JWT_REQUIRED=false` + 裸 `x-user-id` | 真实 HS256 JWT | HS256 验签一次都没执行，而生产每个请求都验 |
| `REDIS_URL=""` | 接隔离 Redis | 限流退化为单实例内存计数，多实例语义没被测到 |
| mock 立即返回且**不过并发闸** | `AI_MOCK_LATENCY_MS` 让它占真实槽位 | LLM 队列深度/排队等待恒为 0，闸门与端点池等于没测 |
| 无指标端点 | `GET /api/metrics`（Prometheus） | 只能靠 `docker stats`，拿不到在途请求、队列深度、连接池 |
| — | `SCHEDULER_ENABLED=false` | 切到 production 后定时任务会真跑，周期性全量扫库给容量测量掺背景负载 |

## 部署

```bash
bash loadtest/prepare.sh 1000
```

生成 `loadtest/.env`（压测专用随机 JWT 密钥 + 指标 token）与 `loadtest/tokens.json`
（1000 个真实 JWT）。两者 0600、已 gitignore、**禁止提交或贴进报告**。

```bash
cd loadtest
docker compose build
docker compose up -d db redis
docker compose run --rm api npx prisma db push --skip-generate --accept-data-loss
docker compose run --rm api npm run db:seed
docker compose run --rm -e LT_USERS=1000 api ./node_modules/.bin/tsx prisma/loadtestSeed.ts
docker compose up -d api gateway
```

**启动后第一件事**是确认配置真的生效了——这是一条免费的自检：

```bash
docker compose logs api | grep -i '安全告警'
```

只允许出现 `SMS_REQUIRE_CODE` 那一条（压测有意不走验证码流程）。若出现
`APP_JWT_SECRET` / `APP_JWT_REQUIRED` 相关告警，说明鉴权没硬化，**该轮数据作废**。

### 两档拓扑

```bash
# T1 生产同构单进程：不设 CPU 配额，回答「单进程真实上限是多少」
docker compose up -d

# T0 对照组：复刻上一轮的 2.25 核配额，校验 V2 环境与旧结果可比
docker compose -f docker-compose.yml -f docker-compose.limits.yml up -d
```

### 可调参数

全部在 `loadtest/.env` 里覆盖（`LT_` 前缀）：`LT_DB_POOL`、`LT_MAX_IN_FLIGHT`、
`LT_RATE_LIMIT_MAX`、`LT_LLM_MAX_CONCURRENCY`、`LT_MOCK_LATENCY_MS`、
`LT_MOCK_429_RATE`、`LT_REPORT_PDF_DISABLED`、`LT_API_CPUS` 等。

跑 S5（LLM 闸门与队列）时至少要设：

```bash
LT_MOCK_LATENCY_MS=3000        # 模拟上游耗时，mock 会占一个真实闸门槽位
LT_MOCK_LATENCY_JITTER_MS=500  # 抖动，避免整齐同步的假锯齿
LT_MOCK_429_RATE=0.1           # 想验整窗冷却与恢复爬坡时才开
```

### 指标

```bash
curl -s -H "Authorization: Bearer $LT_METRICS_TOKEN" \
  http://127.0.0.1:14000/api/metrics | grep junshi_llm_queued
```

API 的 4000 端口只绑 `127.0.0.1:14000`，供 `monitor.sh` 直连抓取——**不要走 nginx**，
否则观测流量会被算进被测容量。

网关仅绑定服务器 `127.0.0.1:14080`。从压测机建立隧道：

```bash
ssh -N -L 14080:127.0.0.1:14080 <server>
```

隔离网关显式配置 `worker_connections=8192` 与 512 条 upstream keepalive，避免
把 Nginx Alpine 镜像默认的 1024 连接上限误判成 API 容量。

## 运行

```bash
mkdir -p loadtest/results
docker run --rm \
  -e BASE_URL=http://host.docker.internal:14080 \
  -e RATE=100 \
  -e DURATION=5m \
  -e RUN_ID=rate-100 \
  -v "$PWD/loadtest/k6-readonly.js:/scripts/k6-readonly.js:ro" \
  -v "$PWD/loadtest/tokens.json:/scripts/tokens.json:ro" \
  -v "$PWD/loadtest/results:/results" \
  grafana/k6 run /scripts/k6-readonly.js
```

`tokens.json` 必须挂进去（脚本在 init 阶段 `open()` 它）。缺了会在启动时直接报错，
而不是静默退回裸 `x-user-id` —— 免得又跑出一轮「没验签」的数据。
每个 VU 还会带一个稳定的合成 `X-Forwarded-For`（`203.0.113.x`，RFC 5737 文档保留段），
因为限流按「已登录按用户、未登录按 IP」分桶，匿名请求全挤一个 IP 会把限流层测成「一撞就 429」。

## 安全约束

- 只读场景使用固定白名单，不包含登录、短信、生成、上传和支付接口。
- API 容器只连接 `backend` 内部网络，无法访问公网。
- 压测数据库使用独立 volume `junshi_lt_pgdata`。
- 清理只针对 Compose 项目 `junshi-loadtest` 及上述精确命名 volume。

## 真实 LLM 最小消耗探针

`k6-llm.js` 只直测已配置的模型网关，不经过业务生成接口。每次请求固定一个字符输入，
并以 `max_tokens=1` 硬限制输出；默认每个并发仅 4 次请求，单响应总 Token 超过 200
立即中止。实际执行必须逐档运行、每档读取 `llm_total_tokens` 后累计，达到当次任务预算
即停止。密钥只放临时 `0600` env 文件，结束后立即删除，禁止写入仓库或报告。
