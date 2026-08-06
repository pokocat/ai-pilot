# 军师 · 监控栈（Prometheus + Grafana + Alertmanager + exporters）

完整文档见 **`docs/MONITORING.md`**（架构、打点清单、部署步骤、看板、告警线、运维）。

快速启动（生产机,前置条件与只读账号建法见文档 §3）：

```bash
cp .env.example .env                                     # 填密码
cp secrets/metrics.token.example secrets/metrics.token   # 填 API 的 METRICS_TOKEN
docker compose up -d                                     # 核心栈
docker compose --profile logs up -d                      # 可选:Loki + Promtail
```

看板 JSON 由 `grafana/dashboards/build.mjs` 生成,改看板改脚本后 `node build.mjs` 重新生成。

告警按 `category + severity` 聚合后由 API 转成飞书 Card 2.0；卡片包含当前值、阈值、影响、动作、
持续/恢复耗时与看板按钮。API 的 `server/.env` 可配 `MONITOR_ENV_LABEL`、`MONITOR_GRAFANA_URL`、
`MONITOR_TIME_ZONE`；完整口径与 52 条规则清单见 `docs/MONITORING.md` §5。
