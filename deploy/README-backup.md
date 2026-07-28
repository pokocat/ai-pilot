# 生产库备份

## 现状（2026-07-28 实测）

**已有每日备份**，不是「零备份」——AGENTS.md 里那条旧描述已更正。

| 项 | 状态 |
|---|---|
| 机制 | systemd `junshi-pgdump.timer` → `junshi-pgdump.service`，每日 03:30，`Persistent=true` |
| 位置 | `/var/backups/junshi/junshi-YYYY-MM-DD-HHMM.sql.gz` |
| 起始 | 2026-07-23 |
| 保留 | 14 天（`find -mtime +14 -delete`） |
| 体积 | 约 12 MB / 份（库 49 MB），盘上 121 GB 可用，成本可忽略 |
| 完整性 | 2026-07-28 抽验 6 份全部通过：`gunzip -t` OK、63 张 `CREATE TABLE`、63 个 `COPY` 段、体积单调增长 |

## 已修的缺陷：原实现会静默销毁自己的备份历史

原 unit（2026-07-23 手搓在服务器上，**未纳入版本管理**）的 `ExecStart` 是一行流：

```
pg_dump junshi | gzip > /var/backups/junshi/junshi-$(date +%F-%H%M).sql.gz \
  && find /var/backups/junshi -name "junshi-*.sql.gz" -mtime +14 -delete
```

两个缺陷叠加：

1. **管道退出码取 `gzip` 而非 `pg_dump`**。没有 `pipefail`，pg_dump 失败（库不可达 / 权限 / 磁盘满 / OOM 被杀）时 gzip 仍成功写出残缺或空的 `.gz`，整条命令返回 0，systemd 认定成功。
2. **`&&` 后的轮转照常执行**。坏备份覆盖当天，旧的好备份按 14 天龄被删。连坏两周，历史被自己清空，且全程无报错。

现改为 `deploy/junshi-pgdump.sh`：

- `set -Eeuo pipefail` —— pg_dump 失败即整体失败
- 先写 `.partial`，**三项校验**（`gunzip -t`、体积下限、含 `CREATE TABLE`）全过才原子 `mv` 落地 → 失败的运行永不产出「看起来有效」的备份
- **轮转移到校验之后** → 新备份没验通过，绝不删旧的
- 清理历史失败残留的 `.partial`

## 安装 / 更新

```bash
sudo install -m 755 deploy/junshi-pgdump.sh /usr/local/bin/junshi-pgdump.sh
sudo install -m 644 deploy/junshi-pgdump.service /etc/systemd/system/
sudo install -m 644 deploy/junshi-pgdump.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now junshi-pgdump.timer
sudo systemctl start junshi-pgdump.service   # 立刻跑一次验证
systemctl status junshi-pgdump.service --no-pager
```

## 仍然缺的三样（按严重程度）

这三条决定了当前备份**够防误删，不够防机器丢失**。

### 1. 没有异地副本 —— 最大的缺口

所有备份都在生产机同一块盘上。**实例损毁或磁盘故障会同时带走数据库和它的全部备份。**

可选做法：

- **OSS**（推荐）：建专用 bucket + 生命周期规则，备份后 `ossutil cp` 上传。**当前机器未安装 ossutil，也未配置凭据**，需要运维前置。
- **拉到另一台机器**：定时从异地主机 `rsync` 拉取，密钥单向只读。
- 迁 RDS 后由云厂商托管，这条自动解决。

### 2. 没有时间点恢复（PITR）

只有每日快照，**最坏情况丢 24 小时数据**。要 PITR 需要归档 WAL（`archive_mode=on` + 归档到异地），或者直接上 RDS。

### 3. 从未做过恢复演练

**没恢复过的备份不算备份。** 上表的完整性抽验只证明文件结构完好，没证明能真正还原出可用的库。

建议演练方式（不碰生产）：在测试机 47.98.162.120 上建空库，`zcat` 灌入最新备份，核对表数、关键表行数、以及 `agent.systemPrompt` 长度等标志性数据。

### 备份失败无告警

`OnFailure=` 未挂任何通道，失败只进 journal，靠人主动查。接了告警通道后应在 service 里补上。在此之前建议每周人工看一眼：

```bash
systemctl list-timers junshi-pgdump.timer --no-pager
sudo ls -lh /var/backups/junshi/ | tail -5
```
