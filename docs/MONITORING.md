# 军师 · 后台监控大盘（MONITORING）

> 给「帮我看/搭监控」的人看：照本文件即可在生产机上起一套完整监控——系统资源 + 业务指标 + 看板 + 告警。
> 组件全部是成熟开源：**Prometheus + Grafana + Alertmanager + node_exporter + postgres_exporter + blackbox_exporter**（可选 **Loki + Promtail** 收日志）。
> 配套模板见 `deploy/monitoring/`；应用侧打点在 `server/src/services/metrics.ts`（`/api/metrics` 端点）。
> 口径铁律（压测方案 V2 §6）：**压测采集什么，线上就告警什么，指标名一致**。告警阈值全部来自
> `docs/[OPUS5]LOADTEST_OPT_PLAN_2026-07-26.md` §7，改阈值先改那边的口径。

---

## 1. 架构

```
                       ┌────────────────────── 生产服务器（与 API 同机） ──────────────────────┐
                       │                                                                        │
   浏览器 ── https://域名/grafana/ ──► Nginx ──► Grafana :3000 (127.0.0.1)                      │
                       │                            │ 读                                        │
                       │              ┌─────────────┼──────────────┐                            │
                       │              ▼             ▼              ▼                            │
                       │        Prometheus :9090   JunshiDB(PG 只读)   Loki :3100（可选）        │
                       │         │ 抓取(15s)                          ▲                         │
                       │         ├─► API /api/metrics :4000（Bearer METRICS_TOKEN）             │
                       │         ├─► node_exporter :9100（主机 CPU/内存/盘/网）                  │
                       │         ├─► postgres_exporter :9187（连接/TPS/缓存/锁）                 │
                       │         ├─► blackbox_exporter :9115（本机探活 + 公网 HTTPS 探活）       │
                       │         └─► 告警规则 ──► Alertmanager :9093 ──► API /api/alerts/webhook │
                       │                    （阈值经 junshi_alert_config 后台可调）└─► 飞书群机器人 │
                       │                                               Promtail（journald+nginx）│
                       └────────────────────────────────────────────────────────────────────────┘
```

- 所有组件跑在 docker compose 里、**host 网络 + 只监听 127.0.0.1**；对外只有 Nginx 反代的 Grafana 一个口。
- 为什么 host 网络：生产 API/PG 只监听 loopback，桥接容器摸不到；见 `deploy/monitoring/docker-compose.yml` 顶部注释。

## 2. 指标从哪来（打点清单）

### 2.1 应用自报 `/api/metrics`（`server/src/services/metrics.ts`）

| 类别 | 指标（前缀 junshi_） | 打点位置 |
|---|---|---|
| 进程 | `process_{resident_memory,heap_used}_bytes` · `process_cpu_seconds_total` · `nodejs_event_loop_delay_seconds{quantile}` | 进程内 |
| HTTP | `http_request_duration_seconds`（直方图,按 method×路由模板）· `http_route_responses_total{class}` · `http_responses_total{class}` · `http_in_flight` · `http_rate_limited_total` · `http_overload_*` | `app.ts` onResponse 钩子 |
| LLM 调用 | `llm_calls_total{kind,provider,status}` · `llm_call_duration_seconds` | `services/trace.ts` recordTrace（与 llm_trace 表同口径） |
| LLM 闸门/池 | `llm_{in_flight,queued,ceiling,cooling,upstream_429_total,...}{lane}` · `llm_pool_endpoint_*` | `llmGate.ts` / `llmPool.ts` |
| Token 成本 | `llm_tokens_total{kind,provider,model,dir}` · `llm_cost_cny_total`（元）· `usage_unreported_total`（漏账） | `services/usage.ts` recordTokenUsage（与 token_usage 表同口径） |
| 产出质量 | `gen_degraded_total{path}`（mock 兜底/工程语境替换）· `llm_output_truncated_total{provider,resolved}`（**resolved=continued 已自动续写救回 / given_up 交回用户**——告警与看板一律按 resolved 拆，混在一起会把「救回来了」画成事故） | `llm/gateway.ts` 各 fallback 分支 / `completionGuard.ts` |
| 对话交互质量 | `chat_first_token_seconds`（直方图,首字延迟,只统计原生流式）· `chat_stream_stall_total{provider,phase}`（空闲看门狗开火：first_event 发完响应头就断供 / mid_stream 中途静默）· `chat_nonstream_total{reason}`（tools\|dify\|mock\|stream_failed\|sync）· `chat_partial_kept_total{provider,cause}`（已下发正文没被换成错误气泡的次数=安全网健康度） | `providers/{claude,openai}.ts` streamChatRound / `llm/gateway.ts` 回落处 / `routes/sessions.ts` 的 /generate-sync |
| 业务事件 | `user_registrations_total{channel}` · `moderation_checks_total{ref,verdict}` · `credits_flow_total{direction,reason}` · `plan_gate_blocked_total{state}` | `routes/auth.ts` / `moderation.ts` / `credits.ts` / `app.ts` 禁写闸 |
| 支付 | `pay_orders_created_total` · `pay_orders_applied_total{type}` · `pay_amount_cny_total` · `pay_refunds_total` · `pay_sweep_*` · `pay_stuck_paid_unapplied`（抓取时查库,60s 缓存） | `services/wechatPay.ts` |
| 告警配套 | `alert_config{key}`（阈值运行值,后台「功能开关」页可调）· `alerts_forwarded_total{outcome}`（飞书转发成败） | `services/alertConfig.ts` / `routes/alerts.ts` |
| DB 池 | `prisma_pool_connections_{busy,idle,open}` | Prisma metrics 预览特性 |

安全：端点必须配 `METRICS_TOKEN` 才开放（未配 404）；输出绝不含 apiKey/baseUrl/用户数据（有测试锁着,`test/metrics.test.ts`）。
标签基数有保护：路由用模板（`/api/agents/:key`）,算力 reason 取 `·` 首段且上限 100 种,超限折叠 `other`。

### 2.2 exporter 侧

- **node_exporter**：主机 CPU/内存/磁盘/网络/文件句柄/TCP。
- **postgres_exporter**：连接数按状态、TPS、缓存命中率、死锁、临时文件、库大小、最长事务。
- **blackbox_exporter**：`http://127.0.0.1:4000/api/health/ready`（本机直连,测服务本体）+ `https://wxapi.aibuzz.cn/api/health`（公网全链路,连 Nginx/TLS/证书有效期一起测;域名在 `prometheus/prometheus.yml` 里改）。

## 3. 部署（生产机,一次性 ≈15 分钟）

前置：已按 `docs/DEPLOYMENT.md` 部署 API（systemd）+ 系统 PG + Nginx；机器装好 docker + docker compose 插件。

```bash
# ① API 侧开指标端点：server/.env 追加（token 自己生成,如 openssl rand -hex 24）
#    METRICS_TOKEN=<随机串>
#    然后 systemctl restart junshi-api
#    自查：curl -s -H "Authorization: Bearer <随机串>" 127.0.0.1:4000/api/metrics | head

# ② PG 建只读监控账号（postgres_exporter 与 Grafana 业务看板共用）
sudo -u postgres psql -d junshi <<'SQL'
CREATE USER junshi_ro WITH PASSWORD '改成强密码';
GRANT pg_monitor TO junshi_ro;
GRANT CONNECT ON DATABASE junshi TO junshi_ro;
GRANT USAGE ON SCHEMA public TO junshi_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO junshi_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO junshi_ro;
SQL

# ③ 起监控栈
cd /opt/junshi/deploy/monitoring
cp .env.example .env                                       # 填 GRAFANA_ADMIN_PASSWORD / PG 密码
cp secrets/metrics.token.example secrets/metrics.token     # 内容=①里的 METRICS_TOKEN（仅一行）
docker compose up -d
docker compose ps                                          # 全部 running 即可

# ④（可选）日志：journald 持久化 + Loki/Promtail
ls /var/log/journal || { sudo mkdir -p /var/log/journal && sudo systemctl restart systemd-journald; }
docker compose --profile logs up -d

# ⑤ 外网访问看板：nginx.conf.example 的 /grafana/ 段拷进站点配置,
#    .env 里设 GRAFANA_ROOT_URL=https://你的域名/grafana/ GRAFANA_SUB_PATH=true,
#    docker compose up -d grafana && nginx -t && systemctl reload nginx
#    不想暴露公网就 ssh -L 3000:127.0.0.1:3000 <服务器> 后开 http://localhost:3000
```

验收：Grafana（admin/你设的密码）→ Dashboards → 「军师监控」目录下四块盘都有数；
Prometheus `127.0.0.1:9090/targets` 全绿。

## 4. 看板（Grafana「军师监控」目录,自动预置）

| 看板 | uid | 内容 | 数据源 |
|---|---|---|---|
| 军师 · 主机与数据库 | `junshi-system` | CPU/内存/磁盘/网络/句柄 + PG 连接/TPS/缓存命中/死锁/临时文件 | Prometheus |
| 军师 · API 服务 | `junshi-api` | RPS、普通接口 P50/95/99、最慢路由 Top、路由级 5xx、429/过载 503、事件循环、Prisma 池、探活耗时 | Prometheus |
| 军师 · LLM 网关 | `junshi-llm` | 车道并发/排队/冷却、429 率、调用时延、token 流向、成本速率、降级/截断/漏账、端点池权重 | Prometheus |
| 军师 · 业务大盘 | `junshi-business` | 注册/DAU/GMV/订单/退款/算力流水/产出量/套餐分布/审核拦截/禁写闸转化信号 | Prometheus + JunshiDB（PG 只读直查） |

看板 JSON 由 `deploy/monitoring/grafana/dashboards/build.mjs` 生成——**改看板改脚本再 `node build.mjs`**,
UI 上的改动只是临时的（provisioning 每 30s 会对回文件）。

## 5. 告警（`deploy/monitoring/prometheus/alerts/`,默认阈值=压测方案 §7,运行值后台可调）

**阈值配置化（二期）**：18 项阈值（CPU/PG 连接/P95/5xx/429 率/队列等待/Token 日预算/RSS/退款/审核/未写完/续写频次/首字延迟 P95）
注册为运营后台「功能开关」页的「告警 ·」数值项,存 DB → `/api/metrics` 吐 `junshi_alert_config{key}` →
规则里 `scalar()` 取值。**后台改完 ≤75s 生效**（60s 缓存 + 一个抓取周期）,不改文件、不发版、不重启。
默认值是压测口径基线,改基线才动 `server/src/services/alertConfig.ts` + 压测方案文档。

| 规则文件 | 覆盖 | 关键线 |
|---|---|---|
| `system.rules.yml` | 主机 CPU/内存/磁盘（含 24h 写满预测）、PG 连接/死锁/长事务 | CPU ≥65% 预警 / ≥80% 扩容；PG 连接 ≥60% / ≥75% |
| `api.rules.yml` | 服务/探活挂、TLS 证书 14 天到期、P95、5xx 率、过载闸、事件循环、RSS | 普通接口 P95 >200ms 预警 / >500ms 或 5xx≥1% 停止放量 |
| `llm.rules.yml` · `junshi-llm` 组 | 上游 429 率、队列等待、长冷却、Token 日预算、漏账、降级 | 429 ≥0.5% / ≥2%；等待 ≥5s / ≥15s；日成本 70%/90%（日预算默认 200 元/天,后台可调） |
| `llm.rules.yml` · `junshi-chat` 组 | **对话交互质量**：未写完交回用户、自动续写频次、流卡死、原生流回落非流式、首字延迟 P95、安全网破损 | 未写完 >5 次/h；续写 >20 次/h（info）；卡死/回落 >0 即报；首字 P95 >20s 持续 10m |
| `business.rules.yml` | 已付未发放（资损!）、sweep 失败、退款激增、审核拦截激增、72h 零注册 | 已付未发放 >10 分钟 = critical |

**推送到飞书（后台配置,无需发版）**：Alertmanager 已默认把告警投给 `POST /api/alerts/webhook`
（Bearer=同一份 `secrets/metrics.token`,compose 已挂载）,服务端按运营后台配置转发：
后台「功能开关 → 告警通知」填入飞书群自定义机器人的 webhook（可选签名密钥）→ 点「发测试消息」验证。
webhook 加密落库、掩码回显；URL 白名单只收 `open.feishu.cn` 机器人域名。未配置时告警只在
Grafana/Alertmanager 界面可见（API 侧记 `junshi_alerts_forwarded_total{outcome="not_configured"}`）。

**规则与指标必须对账（`server/test/alertRules.test.ts`）**：告警规则里写错指标名、引用未注册的
`alert_config` key、或 `and`/`unless` 两侧标签集不匹配，Prometheus 都**不报错**——那条规则只是永远不触发,
监控看着「配好了」实际那一路是聋的。`promtool check rules` 对这三种也一律 SUCCESS。所以加了对账测试:
规则引用的每个 `junshi_*` 指标名要在应用侧真的渲染、每个阈值 key 要在 `ALERT_CONFIG_DEFS` 里、
`and`/`unless` 两侧要么都聚合成无标签要么显式写 `on(...)`。改规则后跑 `cd server && npm test` 即校验。

**改完规则怎么生效**：规则文件由 `scripts/deploy-prod.sh` 随代码同步到
`/opt/junshi/deploy/monitoring/prometheus/alerts`（容器只读挂载该目录）,脚本末尾自动
`promtool check rules` + `/-/reload`,并对账「加载到的规则条目数必须 >0」。不重启容器。

**`deploy/` 必须原地 rsync,绝不能 rm -rf 后整目录替换**（2026-08-05 修）。bind mount 在**容器启动时**
就绑定了 inode,换 inode 等于把容器的视图钉死在已删除的旧对象上:

| 挂载 | 类型 | 被 rm -rf 后的表现 |
|---|---|---|
| `prometheus/alerts` | 目录 | 容器里变成**空目录** → `groups: []`,**全部告警规则静默失效**（不只新加的）,`/-/reload` 也救不回来 |
| `secrets/metrics.token` | 文件 | 旧 inode 仍被挂载引用 → 运行中照样 up,**直到容器/主机重启才炸**,且 compose 会在缺失路径造出同名目录,报错完全不指向真因 |
| `.env`（gitignore） | — | 被删后**任何 `docker compose` 命令都因变量缺失直接失败**,监控栈从此无法运维（这也是上一条长期修不动的原因） |

三者叠加的实际后果:**告警规则自监控栈上线后的每次部署都是关着的**,而 target 一直显示 up、
看板照常出数,所以没人察觉。现在脚本用
`rsync -a --delete --exclude 'monitoring/.env' --exclude 'monitoring/secrets/'` 原地更新,
目录 inode 不变、容器视图立刻跟上。**往 `deploy/monitoring/.gitignore` 加条目时,必须同步加到那两个
`--exclude`**,否则又会把主机侧的运行时凭证同步掉。

**若曾被删过怎么恢复**：`.env` 与 `metrics.token` 的值可从运行中容器的 `docker inspect ... .Config.Env`
里搬（compose 创建容器时已把插值结果固化进去）,不必重设 Grafana 密码；恢复后
`docker compose up -d --force-recreate prometheus` 让挂载重新解析,再确认
`/api/v1/rules` 的组数 >0。

## 6. 日常运维

```bash
# 改了告警规则/抓取配置 → 热加载（不用重启）
curl -X POST 127.0.0.1:9090/-/reload

# 看当前在响的告警
curl -s 127.0.0.1:9093/api/v2/alerts | python3 -m json.tool | head -40

# 升级组件：docker-compose.yml 里换 tag → docker compose pull && docker compose up -d
# 数据保留：Prometheus 30 天、Loki 30 天（compose/loki.yml 里调）
```

**加新指标的路径**：`server/src/services/metrics.ts` 定义 + 业务点调用 → `test/metrics.test.ts` 补断言 →
（要上看板）`build.mjs` 加面板重新生成 →（要告警）`prometheus/alerts/*.yml` 加规则 + 热加载。

## 7. 已知限制

- 事件循环延迟分位数自进程启动**累计**,不随抓取重置（重启才清零）;看趋势用,别当瞬时值。
- `junshi_llm_wait_max_seconds` 是等待**峰值**而非 P95,告警用它近似 §7 的等待线（只会更早触发,不会漏）。
- 业务计数器是**观测口径**（尝试落账即计数,事务极端回滚时有微小偏差）;对账一律以业务表为准
  （credit_ledger / payment_order / token_usage）。
- 动态阈值依赖 API 在线：`junshi_alert_config` 缺席（API 挂/刚重启）时引用它的规则静默不评估,
  由不依赖动态阈值的 `JunshiApiDown` 兜底。飞书通知同理经 API 转发——**API 挂掉时收不到「它挂了」的
  飞书消息**,这是结构性限制。
- 单机单 Prometheus,监控栈本身无高可用;机器整个挂掉时公网探活也一起哑——结合上一条,要「挂了也有人知道」
  必须加外部拨测：Uptime Kuma / 云监控拨测盯 `https://域名/api/health`（一条即可,不重复建体系）。
