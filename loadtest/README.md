# 军师隔离压测

该目录用于在非生产服务器部署一套独立的军师 API + PostgreSQL，再通过 SSH
隧道从外部运行 k6。运行态不接短信、真实 LLM、微信、支付、OSS 或生产数据库。

## 部署

```bash
docker compose -f loadtest/docker-compose.yml build
docker compose -f loadtest/docker-compose.yml up -d db
docker compose -f loadtest/docker-compose.yml run --rm api npx prisma db push --skip-generate --accept-data-loss
docker compose -f loadtest/docker-compose.yml run --rm api npm run db:seed
docker compose -f loadtest/docker-compose.yml run --rm \
  -e LT_USERS=1000 api ./node_modules/.bin/tsx prisma/loadtestSeed.ts
docker compose -f loadtest/docker-compose.yml up -d api gateway
```

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
  -v "$PWD/loadtest/results:/results" \
  grafana/k6 run /scripts/k6-readonly.js
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
