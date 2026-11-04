# 军师集群部署

正式请求入口为 wxapi.aibuzz.cn / copilot.aibuzz.cn，经 ALB 转至两台 ECS 的 Nginx :80；API :4000 与爱速拍 BFF :4010 仅内网使用。新机器位于杭州，与既购 RDS / Tair / ALB 同 VPC。

| 用途 | 配置 |
| --- | --- |
| ECS A | 101.37.189.227 / 10.20.1.215 |
| ECS B | 121.199.172.157 / 10.20.2.195 |
| ALB | alb-8lqfxfyvfyitbs3s6r，主后端组 sgp-rit8llexfk1rpjnqk8 |
| 正式数据库 | RDS pgm-bp1gp4819mbs30z3，junshi_prod，UTF8 / C / C / Asia/Shanghai |
| 运行账号 | junshi_app，连接池每进程 5；非管理员，连接上限 40 |
| Tair | r-bp182e1w8fk05cnbvr，TLS，DB10，仅新 ECS 白名单 |
| SLS | aibuzz-prod-1603478465921848；junshi-app / alb-access，保留 14 天 |

运行配置在 /etc/junshi/junshi-prod.env、junshi-quickreel-prod.env；证书同目录。不要提交或打印配置内容。RDS 必须 sslaccept=strict 并使用核验过签发链的 CA；Tair 必须 rediss，不得跳过证书校验。

API 进程 SCHEDULER_ENABLED=false；仅 A 的 junshi-scheduler 启用定时任务。REDIS_URL 启用共享限流和 LLM 缓存，同时禁用套餐权限的进程内缓存，权限以 PostgreSQL 为准。不要把长任务或定时器重复启动到每台机器。

## 后续发布

1. 锁定并提交单一 SHA，只归档该提交；代码、配置、schema 变更同步文档。先在独立测试库完成 server build、全量 npm test 和 test:profile；本地重任务经 devq。不得运行生产 seed/reset，不得把测试配置复制成生产配置。
2. 保留每节点两份独立发布目录：/opt/junshi/releases/<SHA>/server 与 /opt/junshi-quickreel/releases/<SHA>/server。固定 Node24 位于 /opt/junshi/runtime。构建在未启用的新目录进行，不能覆盖正运行的 dist/node_modules。
3. ALB 将 B 权重置 0 并确认停止新流量，等待连接排空（配置 180 秒；确认无进行中的生成/视频任务）。如仍有长任务，继续保留旧进程直到完成。每次仅更新一个节点，单个后端进程用 systemctl restart；配置仍从 /etc/junshi 的 EnvironmentFile 注入。
4. 更新该节点 unit 的 WorkingDirectory/ExecStart 到已验证的新 SHA；daemon-reload 后逐个重启 junshi-api、junshi-quickreel。验证两个本地 /api/health、实际进程 DB/Redis/服务 profile、ALB backend=b 受保护 metrics 及日志。绝不改运行期 DB URL 去旧库。
5. B 健康后将 A 权重降 0、B 升 100；等待 A 排空，按同样流程更新 A。完成后 A/B 各权重 100、ALB 均 healthy。定时任务若有代码变更，停旧单实例后再启动唯一新实例，防止重复调度。
6. 各独立安装根写 .deploy-version（完整 SHA），.deploy-history 追加 UTC、SHA、验收结果；验证两个 ALB VIP、域名、API/BFF、管理员页面、Prometheus 两个节点 UP 和 SLS 实际入库。发布不得凭 systemd active 判为成功。

旧 scripts/deploy-prod.sh 是历史单机流程；检测到 /opt/junshi/.migrated-to 必须拒绝执行。预发仍留在旧机器，不随正式服务迁移；不得擅自停止旧机器 PostgreSQL 或其他应用。

## 恢复

迁移前源库冻结备份与 100 表双指纹一致证据单独保存。切流后正式写入只在新 RDS：代码回退仍连接新 RDS，可把 ALB 全量转向另一健康节点。不能把 DNS 指回旧数据库服务、解除旧库只读或启用旧 systemd 进程，否则会丢失新写入。

旧 Nginx 保留 HTTPS 兼容转发，SNI 与证书校验开启、verify_depth=5。旧 IP、预发及其他应用仍可能需要旧机器，不得在 DNS TTL 到期后直接删除整机。旧入口迁移标记、源库只读和备份需保留，待单独确认退役范围。旧 junshi-api / junshi-quickreel 的 systemd drop-in 同时用 ExecStartPre 检查迁移标记，防止旧版发布脚本误重启它们。

ALB 证书有效期到 2026-12-05，需在到期前续签并替换绑定。RDS 自动备份与日志恢复保留 7 天；Tair 是可丢失的缓存和限流层，不作为业务账本。数据库备份、日志、连接及容量需要持续观察；50GB 为全部数据库共享容量，不能只按军师单库判断长期容量。
