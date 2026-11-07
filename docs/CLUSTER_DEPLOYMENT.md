# 军师集群部署与主备滚动发布

当前 A 主用、B 常驻备用，ALB 权重 100/0。API 与爱速拍 BFF 在两台机器都运行，定时任务仅 A 的独立 scheduler 运行。B 的独立探针和 metrics 持续工作，权重 0 的 Unused 是预期状态。域名为 wxapi.aibuzz.cn 与 copilot.aibuzz.cn，新资源实际在杭州同 VPC。

演练环境停用后，`identity-stage`（`id-rehearsal.aibuzz.cn`）与 `aistar-pg-rehearsal-20261104`（`api-rehearsal.aibuzz.cn`）的 ALB 健康检查保持关闭；需要再次演练时，先启动并验收服务，再显式恢复对应组的检查。正式军师、metrics、账号中心和为正式业务预留的后端组不受此操作影响；不能把关闭全部探活作为清理手段。

| 组件 | 当前配置 |
| --- | --- |
| ECS A / B | 101.37.189.227 / 121.199.172.157，内网 10.20.1.215 / 10.20.2.195 |
| ALB / 后端组 | alb-8lqfxfyvfyitbs3s6r / sgp-rit8llexfk1rpjnqk8 |
| RDS | pgm-bp1gp4819mbs30z3；junshi_prod，PG18、UTF8、C/C、Asia/Shanghai |
| 数据库运行角色 | junshi_app，非管理员，每进程连接池 5，角色连接上限 40 |
| Tair | r-bp182e1w8fk05cnbvr，rediss，DB10；共享缓存和限流 |
| SLS | aibuzz-prod-1603478465921848；junshi-app / alb-access，14 天保留 |
| 测试 | 独立 junshi_migration_test 与独立测试角色；/etc/junshi/release-test.env 仅 root 可读 |
| 配置 | deploy/cluster/production.json 为非敏感资源配置；两机 /etc/aibuzz-deploy/node.json 验证身份 |

## 日常命令

```bash
# 只读查看资源、主备、版本、schema 差异和发布顺序
bash scripts/deploy-prod.sh --plan

# 默认：军师 API + 两套运营后台（/admin、/quickreel）+ 单实例 scheduler
bash scripts/deploy-prod.sh

# 指定已提交版本；只部署该提交，不包含工作区未提交内容
DEPLOY_SHA=<commit> bash scripts/deploy-prod.sh

# 爱速拍 BFF 独立发布，不替换军师目录、不重启军师或 scheduler
QUICKREEL_ONLY=1 bash scripts/deploy-prod.sh

# 一次明确更新两套后端；可选同步 H5
bash scripts/deploy-prod.sh --component both
DEPLOY_H5=1 bash scripts/deploy-prod.sh

# 已有独立前端发布安排时，仅发后端及 scheduler
SKIP_ADMIN=1 bash scripts/deploy-prod.sh

# 证书：先检查，需要时续签和替换 ALB
bash scripts/renew-alb-certificate.sh --check
bash scripts/renew-alb-certificate.sh
```

本机需 Python3.9+、已登录的 Alibaba CLI、SSH 新机密钥、devq；续签另需 Certbot、OpenSSL、dig。脚本自身将整条重任务链放入 devq，不要在外层再次包 devq，不要后台并行发第二次。无 CODEX_THREAD_ID 时入口自动生成一次任务 owner。

`DEPLOY_HOST`、`REMOTE_ROOT`、`PUBLIC_BASE` 是已停用的单机参数，设置即拒绝；旧 8.136.36.175 / 47.98.162.120 均不能作为新发布目标。`DEPLOY_PC=1` 因新集群尚无该前端路由而明确拒绝，不能生成“发布成功但路由不可用”的结果。预发仍在旧机，使用其专用预发脚本，不能套用正式配置。

## 自动执行的发布顺序

1. 锁定完整 SHA，取得远端跨聊天发布锁。检查 ECS 实例与 IP、主后端组、主备权重、生产数据库/Tair/TLS、profile、上一版与 schema。两台同时承流时拒绝，需先按主备配置操作。
2. 非承流节点在 /opt/aibuzz-deploy/builds/<run> 构建归档；Node24、内存预检、npm ci、server build、独立库全量与 profile 检查。默认也检查并构建 admin（108 项单测）和 quickreel-console；分别固定 /admin/、/quickreel/ 基础路径，切流前核对 HTML 与脚本/CSS 资源；H5 按需。默认不复用验证；`--validation-receipt` 仅供精确匹配 server Git tree、Node 版本及独立库的已完成验证复核。
3. 给两台机器分发相同校验和产物。API 与 BFF 分别进入各自 /opt/<产品>/releases/<完整 SHA>/server；EnvironmentFile 永远从 /etc/junshi 读取，归档不带正式或测试环境文件。静态资源使用新目录切换并保留旧客户端可能继续请求的 hashed chunks。
4. 待更新实例先收到 SIGUSR2，停止后台领单并保留 HTTP；脚本确认实际 PID 日志回执，等 ALB 排空间隔、HTTP 在途和持久任务完成后才重启。至少三次空闲观察；超时保留旧进程，不强杀、不清状态。Quickreel-only 不停止军师 worker。
5. 更新备用实例的 systemd drop-in，验证实际 PID 环境、版本路径、两个产品健康与显式 ALB 探针、跨机 Tair 读写，再把正式流量切过去。原主降权后，排空并更新原主。
6. 主产品发布时同时更新 scheduler：B 只准备新入口且禁用自启；A 停止周期触发、等已排队/执行任务完成，再启动唯一新进程。systemd 不因固定短超时强杀正在排空的 scheduler；它可能延长发布耗时，其他节点继续提供 API。
7. 恢复 A=100、B=0，核验两台实际版本与探针，写 .deploy-version/.deploy-history；清本次临时构建/归档，保留不可变版本和日志。状态记录在本机 .deploy-logs/cluster-*/state.json，远端测试/构建日志在 /opt/aibuzz-deploy/logs/<run>/。

首次将无排空协议的迁移旧版本升级时，才允许显式 `--bootstrap-legacy-drain`，仍必须经过零在途/零任务门。正常发布不得继续依赖它；目标版本必须有排空协议。本次已用它完成首次接入，后续默认命令不需要该参数。

## 数据库结构与独立边界

schema/pgvector 文件相对任一节点正在运行版本发生变化时，默认拦截。先按 [迁移 SOP](MIGRATION_SOP.md) 完成兼容结构演进、备份和数据核验，才可 `--schema-reviewed`；该参数会只读比较 RDS 与目标结构，并不执行 DDL。发布工具没有 seed/reset/accept-data-loss，也不把生产配置当本地或测试默认。

军师与爱速拍 BFF 共库，但安装目录和版本独立。默认发军师、两套运营前端及 scheduler；Quickreel-only 只发爱速拍 BFF；共用 ALB 切流时另一个产品保持同版本可用。若变化涉及公共代码且两边都需要，明确选择 both。运营价目、提示词、商户和身份配置不随代码发布重置。

## 失败恢复与主备接管

构建/验收失败不切流；新备用不可用时保留原主。原主更新失败时，把流量保留给已经验收通过的新节点，不强行恢复 A 的名义主用。失败节点会尝试恢复原 drop-in/静态入口并重启原版本，实际恢复失败需按 state.json 继续处理。恢复仍使用新 RDS，不能启用旧数据库服务或解除旧库只读。

A 整机故障时，先确认并隔离 A，验证 B 的 API/BFF、数据库及外部依赖后将 A=0、B=100。确认 A scheduler 停止或主机已隔离，才启动 B 的 scheduler；A 恢复前防止重复自启。权重 0 不等于自动接管，此流程需人工或另建自动化。

后续放量前确认两边同版本、Tair 共享、连接预算和后台任务幂等，再将 A/B 权重都设为 100；此时先暂停使用主备发布入口，待切回单节点主用后再滚动发布。

## 证书与备份

ALB 当前证书已在本次续签至 2027-02-02，保留原 14 个 SAN；不是阿里云托管自动续期。续签入口在距到期≤35天时使用已登录的本机 CLI 做 DNS-01，上传 CAS、替换绑定并验证两个 VIP 的两个域名，失败恢复原绑定。挑战清理只删本次记录。私钥/ACME 账号在 .deploy-certs，700 目录且 Git 忽略；不依赖旧机，也不保存长期云 AK。尚未设置后台定时任务，维护时需运行 --check/续签。

RDS 全量与日志恢复保留 7 天；Tair 只承载可丢失状态。旧 Nginx 保留 HTTPS 兼容转发并启用证书校验，旧正式 unit 受迁移标记启动拦截；旧机仍有其他应用和预发，不能直接退役。旧机、验证库和历史版本清理需单独核对范围。
