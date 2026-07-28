#!/usr/bin/env bash
# 生产 PostgreSQL 每日逻辑备份。由 junshi-pgdump.timer 每天 03:30 触发。
#
# ── 为什么不再用原来那行 ExecStart ──
# 原实现（2026-07-23 手搓在服务器上，未纳入版本管理）：
#
#   pg_dump junshi | gzip > .../junshi-$(date +%F-%H%M).sql.gz \
#     && find ... -name "junshi-*.sql.gz" -mtime +14 -delete
#
# 两个缺陷叠在一起会**静默销毁备份历史**：
#   ① 管道退出码取的是 gzip 的，不是 pg_dump 的。没有 pipefail，pg_dump 失败
#      （库不可达 / 权限错 / 磁盘满 / OOM 被杀）时 gzip 照样成功写出一个残缺
#      甚至空的 .gz，整条命令返回 0，systemd 认为备份成功。
#   ② `&&` 后面的轮转照常执行。于是坏备份覆盖当天、旧的好备份被按 14 天龄清掉，
#      连着坏两周，历史就被它自己清空了——而且全程没有任何报错。
#
# 本脚本的三个结构性改动：
#   · set -o pipefail：pg_dump 失败即整体失败
#   · 先写 .partial，三项校验全过才原子改名 → 失败的运行永远不产出「看起来有效」的备份
#   · 轮转移到校验之后 → 新备份没验通过，绝不删旧的
set -Eeuo pipefail

DB="${BACKUP_DB:-junshi}"
DIR="${BACKUP_DIR:-/var/backups/junshi}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
# 体积下限：防 pg_dump 早退产出空壳。当前实际约 12MB，1MB 是宽松下限。
MIN_BYTES="${BACKUP_MIN_BYTES:-1000000}"

ts="$(date +%F-%H%M)"
out="$DIR/${DB}-${ts}.sql.gz"
tmp="$DIR/.${DB}-${ts}.sql.gz.partial"

cleanup() { [ -f "$tmp" ] && rm -f "$tmp"; }
trap cleanup EXIT

mkdir -p "$DIR"

# ── 1. 转储 ──
pg_dump "$DB" | gzip > "$tmp"

# ── 2. 校验（任一不过即失败，不改名、不轮转）──
gunzip -t "$tmp"

sz="$(stat -c %s "$tmp")"
if [ "$sz" -lt "$MIN_BYTES" ]; then
  echo "备份体积异常：${sz} 字节 < 下限 ${MIN_BYTES}，判为失败" >&2
  exit 1
fi

# 内容抽查：完整的 pg_dump 一定含建表语句。空库或被截断的转储过不了这一关。
#
# 注意这里**不能**用 `zcat | grep -q`：grep -q 命中即退出并关闭管道，zcat 收到 SIGPIPE
# 以 141 退出，而本脚本开了 pipefail → 整个管道判为失败 → 明明有 CREATE TABLE 却误报缺失。
# （首次部署就踩了这个，日志里是 `gzip: stdout: Broken pipe`。）
# 改用 grep -c 读完全部输入，不提前关管道；grep 无匹配时返回 1，故补 `|| true`。
MIN_TABLES="${BACKUP_MIN_TABLES:-10}"
tables="$(zcat "$tmp" | grep -c '^CREATE TABLE' || true)"
if [ "${tables:-0}" -lt "$MIN_TABLES" ]; then
  echo "备份只含 ${tables:-0} 张表（下限 ${MIN_TABLES}），疑似截断，判为失败" >&2
  exit 1
fi

# ── 3. 原子落地 ──
mv "$tmp" "$out"
trap - EXIT

# ── 4. 只有新备份验通过了才轮转旧的 ──
find "$DIR" -maxdepth 1 -name "${DB}-*.sql.gz" -mtime +"$KEEP_DAYS" -delete
# 清掉历史失败留下的临时文件（超过 1 天的）
find "$DIR" -maxdepth 1 -name ".${DB}-*.partial" -mtime +1 -delete 2>/dev/null || true

kept="$(find "$DIR" -maxdepth 1 -name "${DB}-*.sql.gz" | wc -l)"
echo "备份完成 ${out}（${sz} 字节，${tables} 张表）；保留 ${KEEP_DAYS} 天，当前 ${kept} 份"
