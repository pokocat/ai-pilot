#!/usr/bin/env bash
# 抓一档压测的慢 SQL Top-N，落盘到 loadtest/results/<run_id>-slowsql.txt。
#
#   bash loadtest/slowsql.sh v2-s1b-10x-t1-250-r1
#
# 每档跑完立刻执行，然后 postseed.sh 里那句 pg_stat_statements_reset() 再清一次，
# 下一档才是干净的。不清就会把上一档的账算进来。
#
# 这是回答「10x 数据下那条拖垮在途槽位的长尾到底是哪条 SQL」的唯一直接证据。
set -euo pipefail

LT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$LT"
RUN="${1:?用法: bash loadtest/slowsql.sh <run_id>}"
OUT="results/${RUN}-slowsql.txt"
mkdir -p results

if docker ps >/dev/null 2>&1; then DC=(docker compose); else DC=(sudo docker compose); fi
PSQL=("${DC[@]}" exec -T db psql -U junshi_lt -d junshi_lt -v ON_ERROR_STOP=1)

{
  echo "# 慢 SQL Top-N — run=${RUN}"
  echo

  echo "## 按总耗时排序（找吃掉最多时间的语句）"
  "${PSQL[@]}" -c "
    SELECT round(total_exec_time)::text || ' ms' AS 总耗时,
           calls AS 次数,
           round(mean_exec_time::numeric, 2)::text || ' ms' AS 平均,
           round(max_exec_time::numeric, 2)::text || ' ms' AS 最慢,
           round(stddev_exec_time::numeric, 2)::text || ' ms' AS 标准差,
           left(regexp_replace(query, '\s+', ' ', 'g'), 130) AS 语句
      FROM pg_stat_statements
     WHERE query NOT LIKE '%pg_stat_statements%'
     ORDER BY total_exec_time DESC
     LIMIT 15"

  echo
  echo "## 按最慢单次排序（找那条占死在途槽位的长尾）"
  # 报告里「成功请求 P95 只有 41ms，却有 8% 被过载闸拒掉」的形状，只可能是少数极慢请求
  # 把 MAX_IN_FLIGHT 占满。平均值看不出来，要看 max 和标准差。
  "${PSQL[@]}" -c "
    SELECT round(max_exec_time::numeric, 2)::text || ' ms' AS 最慢单次,
           calls AS 次数,
           round(mean_exec_time::numeric, 2)::text || ' ms' AS 平均,
           round(rows::numeric / GREATEST(calls, 1), 1) AS 每次返回行数,
           left(regexp_replace(query, '\s+', ' ', 'g'), 130) AS 语句
      FROM pg_stat_statements
     WHERE query NOT LIKE '%pg_stat_statements%' AND calls > 0
     ORDER BY max_exec_time DESC
     LIMIT 15"

  echo
  echo "## 缓存命中率（判断是不是内存装不下）"
  # 命中率明显低于 99% → 工作集超内存，属该给 DB 加内存，不是该加 API 实例。
  "${PSQL[@]}" -c "
    SELECT round(100.0 * sum(heap_blks_hit) / NULLIF(sum(heap_blks_hit + heap_blks_read), 0), 2) AS 表缓存命中率百分比,
           pg_size_pretty(sum(heap_blks_read) * 8192) AS 累计从盘读取
      FROM pg_statio_user_tables"

  echo
  echo "## 顺序扫描 Top（统计信息缺失时最先暴露的症状）"
  "${PSQL[@]}" -c "
    SELECT relname AS 表, seq_scan AS 顺序扫描次数,
           to_char(seq_tup_read, 'FM999,999,999,999') AS 顺序读行数,
           idx_scan AS 索引扫描次数
      FROM pg_stat_user_tables
     WHERE seq_scan > 0
     ORDER BY seq_tup_read DESC
     LIMIT 10"
} | tee "$OUT"

echo
echo "已落盘 → loadtest/${OUT}"
