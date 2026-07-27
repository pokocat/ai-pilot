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
`LT_MOCK_429_RATE`、`LT_REPORT_PDF_DISABLED`、`LT_API_CPUS`、`LT_TRUST_PROXY` 等。

跑 S5（LLM 闸门与队列）时至少要设：

```bash
LT_MOCK_LATENCY_MS=3000        # 模拟上游耗时，mock 会占一个真实闸门槽位
LT_MOCK_LATENCY_JITTER_MS=500  # 抖动，避免整齐同步的假锯齿
LT_MOCK_429_FIRST_N=1           # 确定性注入第 1 个 429；验证冷却后恢复时优先用它
LT_MOCK_429_RATE=0.1            # 概率注入，仅用于长时间扰动，不作通过/失败判定
```

零 token 的 LLM 闸门/队列测试用 `k6-llm-queue.js` 打隔离 `/generate-sync`。它只会向
压测库写入测试会话和消息；当 `AI_MOCK_LATENCY_MS>0` 时，mock 会占用真实 `llmGate` 槽位。
依次运行 8 / 12 / 20 / 40 并发，并读取 `llm.csv` 与 `/metrics` 的 `junshi_llm_*` 指标；
要验证 429 冷却时单独设置 `LT_MOCK_429_FIRST_N=1`，先跑一条允许注入失败的请求，再立刻跑一条正常请求，
在 `llm.csv` 确认 `upstream_429_total=1`、`cooldowns_total=1` 与恢复请求的等待时间；不与正常容量档混跑。

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

从**另一台压测机**经 SSH 隧道运行时，继续使用隧道地址：

```bash
mkdir -p loadtest/results
docker run --rm --user 0:0 \
  -e BASE_URL=http://host.docker.internal:14080 \
  -e RATE=100 \
  -e DURATION=5m \
  -e RUN_ID=rate-100 \
  -v "$PWD/loadtest/k6-readonly.js:/scripts/k6-readonly.js:ro" \
  -v "$PWD/loadtest/tokens.json:/scripts/tokens.json:ro" \
  -v "$PWD/loadtest/results:/results" \
  grafana/k6 run /scripts/k6-readonly.js
```

在**隔离服务器本机**运行时，网关端口只绑定在宿主机 loopback，容器不能访问
`host.docker.internal:14080`。应加入 Compose 的 edge 网络并直接访问服务名：

```bash
mkdir -p loadtest/results
docker run --rm --user 0:0 --network junshi-loadtest_edge \
  -e BASE_URL=http://gateway:8080 \
  -e RATE=100 -e DURATION=5m -e RUN_ID=rate-100 \
  -v "$PWD/loadtest/k6-readonly.js:/scripts/k6-readonly.js:ro" \
  -v "$PWD/loadtest/tokens.json:/scripts/tokens.json:ro" \
  -v "$PWD/loadtest/results:/results" \
  grafana/k6 run /scripts/k6-readonly.js
```

`--user 0:0` 只用于读取权限为 0600 的压测专用 token 文件；它不改变被测 API 的权限或网络边界。

`tokens.json` 必须挂进去（脚本在 init 阶段 `open()` 它）。缺了会在启动时直接报错，
而不是静默退回裸 `x-user-id` —— 免得又跑出一轮「没验签」的数据。
每个 VU 还会带一个稳定的合成 `X-Forwarded-For`（`203.0.113.x`，RFC 5737 文档保留段），
因为限流按「已登录按用户、未登录按 IP」分桶，匿名请求全挤一个 IP 会把限流层测成「一撞就 429」。

### S2：限流与真实客户端 IP

S2 仅在隔离环境临时把 `LT_RATE_LIMIT_MAX=5`、`LT_TRUST_PROXY=<edge 网络 CIDR>` 写入
`loadtest/.env`，重建 API 后执行。后者必须是网关回源网段，不能用 `true`；本机 Docker
网络可通过 `docker network inspect junshi-loadtest_edge` 获取。每一子项前清空隔离 Redis 的
计数，再恢复默认限额与信任配置。

```bash
docker run --rm --user 0:0 --network junshi-loadtest_edge \
  -e BASE_URL=http://gateway:8080 -e MODE=single -e LIMIT=5 -e REQUESTS=8 \
  -e RUN_ID=s2-single-ip \
  -v "$PWD/loadtest/k6-rate-limit.js:/scripts/k6-rate-limit.js:ro" \
  -v "$PWD/loadtest/results:/results" \
  grafana/k6 run /scripts/k6-rate-limit.js

# 清空隔离 Redis 后再跑；20 个不同的 XFF 都应为 200。
docker run --rm --user 0:0 --network junshi-loadtest_edge \
  -e BASE_URL=http://gateway:8080 -e MODE=multi -e LIMIT=5 -e REQUESTS=20 \
  -e RUN_ID=s2-multi-ip \
  -v "$PWD/loadtest/k6-rate-limit.js:/scripts/k6-rate-limit.js:ro" \
  -v "$PWD/loadtest/results:/results" \
  grafana/k6 run /scripts/k6-rate-limit.js
```

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
