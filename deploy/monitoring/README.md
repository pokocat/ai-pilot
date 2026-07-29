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
