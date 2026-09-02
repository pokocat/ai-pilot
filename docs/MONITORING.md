# 军师 · 后台监控大盘（MONITORING）

> 给「帮我看/搭监控」的人看：照本文件即可在生产机上起一套完整监控——系统资源 + 业务指标 + 看板 + 告警。
> 组件全部是成熟开源：**Prometheus + Grafana + Alertmanager + node_exporter + postgres_exporter + blackbox_exporter**（可选 **Loki + Promtail** 收日志）。
> 配套模板见 `deploy/monitoring/`；应用侧打点在 `server/src/services/metrics.ts`（`/api/metrics` 端点）。
> 口径铁律（压测方案 V2 §6）：**压测采集什么，线上就告警什么，指标名一致**。容量/成本阈值来自
> `docs/[OPUS5]LOADTEST_OPT_PLAN_2026-07-26.md` §7；对话体验等运行质量线来自线上事故复盘，规则文件会标明来源。

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
                       │               （领域+等级聚合）                    └─► 飞书 Card 2.0 │
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
| LLM 调用 | `llm_calls_total{kind,provider,model,status}` · `llm_call_duration_seconds{kind,provider,model}` · `llm_errors_total{kind,provider,model,bucket}`（错误按类型分布——鉴权/限流/上下文超限/内容策略/网络/过载等，bucket 定义见 `llm/errorClassify.ts`） | `services/trace.ts` recordTrace（与 llm_trace 表同口径；bucket 只喂指标，不落库） |
| LLM 闸门/池 | `llm_{in_flight,queued,ceiling,cooling,upstream_429_total,wait_seconds,...}{lane}`（`wait_seconds` 是排队等待的真实分布，每次授予槽位记一次、含 0 等待，可用 histogram_quantile 算真实 P95）· `llm_pool_endpoint_*` | `llmGate.ts` / `llmPool.ts` |
| LLM 端点探活 | `ai_endpoint_probe_total{endpoint,label,purpose,kind,source,status}` · `ai_endpoint_probe_ok` · `ai_endpoint_probe_last_run_timestamp_seconds` · `ai_endpoint_probe_interval_seconds` | `services/aiProbe.ts`；定时任务只探在线用途路由，手动检测以 `source=manual` 隔离，不参与告警 |
| Token 成本 | `llm_tokens_total{kind,provider,model,dir}` · `llm_cost_cny_total`（元）· `usage_unreported_total`（漏账） | `services/usage.ts` recordTokenUsage（与 token_usage 表同口径） |
| 产出质量 | `gen_degraded_total{path}`（mock 兜底/工程语境替换）· `llm_output_truncated_total{provider,resolved}`（**resolved=continued 已自动续写救回 / given_up 交回用户**——告警与看板一律按 resolved 拆，混在一起会把「救回来了」画成事故） | `llm/gateway.ts` 各 fallback 分支 / `completionGuard.ts` |
| 对话交互质量 | `chat_first_token_seconds`（用户发送/Job 接单→首字）· `chat_provider_first_token_seconds`（provider 建流→首字）· `chat_stream_stall_total{provider,phase,had_text}`（是否已有可见正文）· `chat_nonstream_total{reason}` · `chat_partial_kept_total{provider,cause}` · `chat_asks_recovered_total{outcome}` | provider 流式循环 / gateway / GenerationJob worker |
| 持久生成 | `chat_generation_total{result}` · `chat_generation_duration_seconds{phase=queue\|provider\|finalize\|job}` · `chat_generation_recovered_total` · `chat_usage_estimated_total{provider}` | `services/generationJobs.ts` 终态与租约接管；区分排队慢/provider 慢/收尾慢及估算结算 |
| 业务事件 | `user_registrations_total{channel}` · `user_registrations_72h` · `user_last_registration_timestamp_seconds` · `monitor_public_launch_enabled` · `moderation_checks_total{ref,verdict}` · `credits_flow_total{direction,reason}` · `plan_gate_blocked_total{state}` | 注册 counter 供渠道趋势；72h 数量与最后注册时间为抓取时查库的事实（60s 缓存），只有运营后台开启「正式开放增长监控」后才用零注册告警；其余见 `routes/auth.ts` / `moderation.ts` / `credits.ts` / `app.ts` 禁写闸 |
| 定时任务 | `scheduler_job_runs_total{job,result}` · `scheduler_job_{interval_seconds,enabled,health_anchor_timestamp_seconds,last_success_timestamp_seconds,last_failure_timestamp_seconds,last_duration_seconds,in_flight}{job}` | `services/scheduler.ts`；健康锚点初始化为任务注册时间、成功后更新，避免新进程首轮尚未到期即误报 |
| 支付 | `pay_orders_created_total` · `pay_orders_applied_total{type}` · `pay_amount_cny_total` · `pay_refunds_total` · `pay_sweep_*` · `pay_stuck_{paid_unapplied,created_stale}`（抓取时查库,60s 缓存） | `services/wechatPay.ts`；支付对账延迟只有确有待处理订单时才作为支付告警，空订单期由通用任务健康告警覆盖 |
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
#    MONITOR_ENV_LABEL=生产环境
#    MONITOR_GRAFANA_URL=https://你的域名/grafana   # 卡片看板按钮；可选
#    MONITOR_TIME_ZONE=Asia/Shanghai               # 卡片显示时区；可选
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
| 军师 · 主机与数据库 | `junshi-system` | CPU/内存/磁盘/网络/句柄 + PG 连接/TPS/缓存命中/死锁/临时文件 + 采集 target/飞书转发自检 | Prometheus |
| 军师 · API 服务 | `junshi-api` | RPS、普通接口 P50/95/99、最慢路由 Top、路由级 5xx、429/过载 503、事件循环、Prisma 池、探活耗时 | Prometheus |
| 军师 · LLM 网关 | `junshi-llm` | 车道并发/排队/冷却、429/调用错误率/调用 P95、token 流向、成本、降级/截断/漏账、端点池权重 | Prometheus |
| 军师 · 业务大盘 | `junshi-business` | 注册/DAU/GMV/订单/退款/支付 sweep、创作失败/模板回退、算力、产出、套餐、审核、禁写闸 | Prometheus + JunshiDB（PG 只读直查） |

四块看板当前共 **106 个面板**（LLM 网关新增「错误分布」「耗时分解」两行,共 11 个面板：按错误类型的分布/明细、鉴权失败/上下文超限/内容策略/网络过载等专项计数、排队等待真实分位、按模型拆分的调用 P95、排队/调用/首字三段耗时对比）。JSON 由 `deploy/monitoring/grafana/dashboards/build.mjs` 生成——**改看板改脚本再 `node build.mjs`**,
UI 上的改动只是临时的（provisioning 每 30s 会对回文件）。
生产发布脚本会对比看板目录内容哈希，并校验 Grafana 容器实际挂载的 JSON 数量；内容变化或主机/容器文件数不一致时强制重建 Grafana，避免 bind mount 继续指向旧目录、界面长期显示数据库中的旧看板。

## 5. 告警（`deploy/monitoring/prometheus/alerts/`,默认阈值=压测方案 §7,运行值后台可调）

**阈值配置化（二期）**：21 项阈值（CPU/PG 连接/API P95/API 最小样本量/5xx/API 限流频次/LLM 429 率/模型调用 P95/队列等待/Token 日预算/RSS/退款/审核/未写完/续写频次/首字延迟 P95）
注册为运营后台「功能开关」页的「告警 ·」数值项,存 DB → `/api/metrics` 吐 `junshi_alert_config{key}` →
规则里 `scalar()` 取值。**后台改完 ≤75s 生效**（60s 缓存 + 一个抓取周期）,不改文件、不发版、不重启。
容量、成本和资源默认值参考压测口径；**用户接口时延使用生产 SLO**，不能把压测扩容线直接当线上故障线。改默认基线需同步 `server/src/services/alertConfig.ts` 与本文。

| 规则文件 | 覆盖 | 关键线 |
|---|---|---|
| `system.rules.yml`（13 条） | 主机 CPU/内存/磁盘/文件句柄、PG 连接/死锁/长事务、通用定时任务停滞、监控 target 离线 | CPU ≥65% 预警 / ≥80% 扩容；PG 连接 ≥60% / ≥75%；死锁 >0 即 critical；任务超过 `max(3 个周期, 15 分钟)` 未成功才 warning |
| `api.rules.yml`（10 条） | 服务/探活挂、TLS 证书 14 天到期、用户接口 P95/5xx、429 激增、过载闸、主线程、内存 | 用户接口 15m P95 >800ms 持续 10m 预警 / >2s 持续 5m 严重；5xx≥1% 持续 5m；两类均要求 15m 样本≥20，后台可调 |
| `llm.rules.yml` · `junshi-llm` 组 | 上游 429/调用错误率/调用 P95、**按错误类型分布**（鉴权/上下文超限/内容策略/网络过载等，见 `llm/errorClassify.ts`）、队列拒绝与等待、长冷却、按端点探活、Token 日预算 70%/90%/**100%**、漏账、降级 | 定时探活只覆盖在线 route：文本走 chat 协议，embedding/rerank 走各自协议；失败精确到 endpoint×purpose×kind，持续 25m 才触发并保留恢复态 15m；其余阈值同规则文件 |
| `llm.rules.yml` · `junshi-chat` 组 | **对话交互质量 + 持久任务**：未写完、续写、输出中断、首字、残文保全、对话生成失败率/异常接管 | 失败率 >10% 且 15m 样本≥5；异常接管 >0 即 warning；估算结算仅进看板，不作为告警 |
| `business.rules.yml`（8 条） | 已付未发放（资损）、对账失败/待处理订单延迟、退款激增、审核拦截、正式开放后的 72h 零注册、创作失败率与模板回退 | 已付未发放 >10 分钟 = critical；只有确有待收敛订单且对账健康锚点超过 15m 才 warning；零注册直接读数据库事实且受「正式开放增长监控」闸门控制；创作失败率 >20% 且样本≥5 |

四个文件当前合计 **58 条可处置规则**。告警只收需要人工判断或处置的异常；`chat_usage_estimated_total` 等正常兜底统计继续保留在 Grafana，但不再因为“发生过估算结算”单独通知。支付告警必须由待收敛订单事实支撑；产品尚未正式开放时，「正式开放增长监控」保持默认关闭，零注册只进看板不通知，上线或开始投放后由 owner 在运营后台显式开启。成对阈值使用统一 `signal` 标签：critical 触发时会压住同信号 warning；
没有 `signal` 的不同告警不会互相误抑制。

API 指标口径（2026-08-06 生产重定基线）：

- “用户交互接口”剔除 `generate / stream / upload / webhook / callback / metrics / health`。这些路径分别受模型、文件、第三方回调或监控链路影响，不能与页面读写接口混算。
- `/api/alerts/webhook` 明确排除：它同步等待飞书回执，生产 24h 路由 P95 约 0.49s，曾把聚合 P95 推到预警线并形成“通知接口慢 → 再通知”的自激风险。
- P95 和 5xx 比率都必须满足 15 分钟最小样本量；低流量时一个慢请求或一个 500 只进看板/日志，不升级成群告警。
- Grafana 的 API 总览与 Prometheus 告警共用同一筛选、15 分钟窗口和 0.8s/2s 色阶，避免“看板正常、告警在响”或相反。

### 5.1 飞书告警卡片（Card 2.0）

Alertmanager 不再按 `alertname` 一条条刷短文本，而是按 **`category + severity`** 在 30 秒窗口内聚合相关信号。
例如一次 CPU 飙升同时引发 API P95 与事件循环告警，会按领域形成少量态势卡，而不是连续十几条难以关联的消息。

每张卡固定包含：

- 标题直接写具体故障，副标题固定为 `P1/P2/P3 + 业务领域 + 当前值/关联信号`，不再用“军师告警”“监控链路”等泛标题。
- 红/橙/蓝/绿标题色带：严重、预警、提示、恢复一眼区分；环境与业务时区放在结论区。
- 三格态势：当前状态、信号数量、已持续/恢复耗时；恢复卡使用真实 `startsAt → endsAt`。
- 每个信号独立指标区：**当前指标 / 告警条件 / 超限状态** 三栏；超限值按 P 级别高亮，恢复时改为绿色“已回落至告警线内”，规则提供 `excess/change` 时直接显示超限幅度或环比变化。
- 每个信号的完整证据：中文现象、业务影响、处置建议、影响对象与持续时间；用户可见摘要禁止直接暴露 `provider / usage / fallback / sweep` 等实现术语。
- 告警风暴保护：一张卡最多展开 8 个信号，超出数量明确提示去看板，不会静默丢失数量。
- 配置 `MONITOR_GRAFANA_URL` 后显示对应四大看板的跳转按钮；未配时卡片仍完整，只隐藏按钮。
- 所有 Alertmanager 字段先转义再进 Markdown，避免 route/label 中的特殊字符破坏排版。

`server/src/services/alertCard.ts` 是卡片展示真源：`ALERT_KNOWLEDGE` 为每个 alertname 提供标题、阈值解释、
影响与动作；规则本身负责 `category/current/summary`。`server/test/alertRules.test.ts` 会强制检查每条规则四者齐全，
新增一条“只有 PromQL、没有人话卡片”的规则会直接让测试失败。

**推送到飞书（后台配置,无需发版）**：Alertmanager 已默认把告警投给 `POST /api/alerts/webhook`
（Bearer=同一份 `secrets/metrics.token`,compose 已挂载）,服务端按运营后台配置转发：
后台「功能开关 → 告警通知」填入飞书群自定义机器人的 webhook（可选签名密钥）→ 点「发测试消息」验证；
测试消息本身也是完整 Card 2.0，可同时验收签名、卡片渲染、环境名和看板按钮。
webhook 加密落库、掩码回显；URL 白名单只收 `open.feishu.cn` 机器人域名。未配置时告警只在
Grafana/Alertmanager 界面可见（API 侧记 `junshi_alerts_forwarded_total{outcome="not_configured"}`）。

**规则与指标必须对账（`server/test/alertRules.test.ts`）**：告警规则里写错指标名、引用未注册的
`alert_config` key、或 `and`/`unless` 两侧标签集不匹配，Prometheus 都**不报错**——那条规则只是永远不触发,
监控看着「配好了」实际那一路是聋的。`promtool check rules` 对这三种也一律 SUCCESS。所以加了对账测试:
规则引用的每个 `junshi_*` 指标名要在应用侧真的渲染、每个阈值 key 要在 `ALERT_CONFIG_DEFS` 里、
`and`/`unless` 两侧要么都聚合成无标签要么显式写 `on(...)`。改规则后跑 `cd server && npm test` 即校验。

**改完规则怎么生效**：规则与抓取配置由 `scripts/deploy-prod.sh` 随代码同步。脚本会先检查
`.env`/`metrics.token` 存在且 token 不是目录，再跑 `docker compose config --quiet`、`promtool check config/rules`与
`amtool check-config`。若 Prometheus/Alertmanager 单文件配置的 SHA256 变化，会 `--force-recreate`
相应容器让 bind mount 重新解析；未换文件时也会普通 `compose up -d` 以吸收 compose 变更。检测使用
`docker ps -a`，已存在但处于 exited 的监控容器也必须被拉起并通过验收，不能被当作“未安装”跳过。
随后必须等待 readiness，对账容器内/主机配置 SHA，Prometheus reload 必须成功，并从
`/api/v1/rules` 精确求和 `groups[].rules` 且条数 >0。任一步失败都让部署失败，不再只 warning。

**`deploy/` 必须原地 rsync,绝不能 rm -rf 后整目录替换**（2026-08-05 修）。bind mount 在**容器启动时**
就绑定了 inode,换 inode 等于把容器的视图钉死在已删除的旧对象上:

| 挂载 | 类型 | 被 rm -rf 后的表现 |
|---|---|---|
| `prometheus/alerts` | 目录 | 容器里变成**空目录** → `groups: []`,**全部告警规则静默失效**（不只新加的）,`/-/reload` 也救不回来 |
| `secrets/metrics.token` | 文件 | 旧 inode 仍被挂载引用 → 运行中照样 up,**直到容器/主机重启才炸**,且 compose 会在缺失路径造出同名目录,报错完全不指向真因 |
| `.env`（gitignore） | — | 被删后**任何 `docker compose` 命令都因变量缺失直接失败**,监控栈从此无法运维（这也是上一条长期修不动的原因） |

三者叠加的实际后果:**告警规则自监控栈上线后的每次部署都是关着的**,而 target 一直显示 up、
看板照常出数,所以没人察觉。现在脚本用
`rsync -a --delete --exclude 'monitoring/.env' --exclude 'monitoring/secrets/'` 保留运行时凭证，并用配置哈希决定是否重建容器：
目录挂载可直接 reload，单文件挂载只要内容变了就重建，不再假设 rsync 一定保留文件 inode。
Alertmanager 显式以 root 运行，仅为读取同一份 `root:root 0600` 的 `metrics.token`；该文件仍是只读挂载。
**往 `deploy/monitoring/.gitignore` 加条目时,必须同步加到那两个
`--exclude`**,否则又会把主机侧的运行时凭证同步掉。

**若曾被删过怎么恢复**：`.env` 的插值值可从运行中容器的 `docker inspect ... .Config.Env`
核对并恢复（compose 创建容器时会把环境变量固化进去）。`metrics.token` 是文件挂载，**不在容器环境变量里，
不能从 inspect 找回**；必须从 `server/.env` 的 `METRICS_TOKEN` 或受控密码库恢复，并保持单行、
`root:root 0600`。恢复后走 `scripts/deploy-prod.sh`，由脚本按哈希重建相关单文件挂载容器，再确认
readiness、容器内 SHA 与 `/api/v1/rules` 实际规则数。

## 6. 日常运维

```bash
# 只改目录挂载的 rules 可手动热加载；
# prometheus.yml / alertmanager.yml 是单文件挂载，请走 deploy-prod.sh 的哈希检测+重建+验收。
curl -fsS -X POST 127.0.0.1:9090/-/reload

# 看当前在响的告警
curl -s 127.0.0.1:9093/api/v2/alerts | python3 -m json.tool | head -40

# 升级组件：docker-compose.yml 里换 tag → docker compose pull && docker compose up -d
# 数据保留：Prometheus 30 天、Loki 30 天（compose/loki.yml 里调）
```

**加新指标的路径**：`server/src/services/metrics.ts` 定义 + 业务点调用 → `test/metrics.test.ts` 补断言 →
（要上看板）`build.mjs` 加面板重新生成 →（要告警）`prometheus/alerts/*.yml` 加规则 + 热加载。

## 7. 已知限制

- 事件循环延迟分位数自进程启动**累计**,不随抓取重置（重启才清零）;看趋势用,别当瞬时值。
- `junshi_llm_wait_max_seconds` 是等待**峰值**，告警仍用它近似 §7 的等待线（只会更早触发,不会漏,沿用是不想改动已验证的告警）；`junshi_llm_wait_seconds` 直方图（2026-08-07 补）已能算真实 P95/P99,看板用它画真实曲线,两条口径都在,以后要把告警也换成真实分位得两条一起改。
- 业务计数器是**观测口径**（尝试落账即计数,事务极端回滚时有微小偏差）;对账一律以业务表为准
  （credit_ledger / payment_order / token_usage）。
- 动态阈值依赖 API 在线：`junshi_alert_config` 缺席（API 挂/刚重启）时引用它的规则静默不评估,
  由不依赖动态阈值的 `JunshiApiDown` 兜底。飞书通知同理经 API 转发——**API 挂掉时收不到「它挂了」的
  飞书消息**,这是结构性限制。
- 单机单 Prometheus,监控栈本身无高可用;机器整个挂掉时公网探活也一起哑——结合上一条,要「挂了也有人知道」
  必须加外部拨测：Uptime Kuma / 云监控拨测盯 `https://域名/api/health`（一条即可,不重复建体系）。
