#!/usr/bin/env bash
# 灌完数据、开压之前必须跑这一步。
#
#   bash loadtest/postseed.sh
#
# 为什么需要它 —— V2 第一轮报告 §3.3 的教训：
# 10 倍数据集下 350 RPS 就有 1.9% 错误、450 RPS 有 8%，据此给出了「生产 ≤250 RPS/实例」。
# 但 10x 只是把用户数放大，**每个用户的数据量没变**（都是 10 会话 / 30 条消息每会话），
# 索引也都在，单次查询要碰的行数完全一样。而错误的形状是「成功请求 P95 只有 41ms、
# 却有 8% 被过载闸拒掉」——说明是一条很慢的长尾把在途槽位占死了，不是整体变慢。
#
# 那条长尾没被查清，因为三个最可能的原因当时一个都没排除：
#   ① 批量灌完 300 万行后从没 ANALYZE，planner 拿默认统计信息选计划，容易退化成顺序扫描；
#   ② autovacuum 大概率正在压测窗口内跑，和压测抢 I/O；
#   ③ 工作集超出内存，缓存命中率掉下来。
#
# 本脚本消除 ① 和 ②（并把 ③ 需要的数字打出来），让下一轮的数字是「系统真实容量」，
# 而不是「刚灌完数据、统计信息还是空的那一瞬间的容量」。
set -euo pipefail

LT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$LT"

DC=(docker compose)
PSQL=("${DC[@]}" exec -T db psql -U junshi_lt -d junshi_lt -v ON_ERROR_STOP=1)

echo "== 1/5 启用 pg_stat_statements =="
# 扩展本身要 shared_preload_libraries 预加载（已写在 docker-compose.yml 的 db.command 里）；
# 这里只是在库内建对象。若报 "could not access file"，说明 db 起来时没带那个参数，先重建容器。
"${PSQL[@]}" -c "CREATE EXTENSION IF NOT EXISTS pg_stat_statements" >/dev/null
echo "   ok"

echo "== 2/5 VACUUM ANALYZE（这一步可能要几分钟，别打断）=="
# 用 VACUUM (ANALYZE) 而不是光 ANALYZE：批量插入留下的死元组和未设置的可见性位图
# 会让后续查询走不了 index-only scan，跟统计信息一样会污染压测结果。
"${PSQL[@]}" -c "VACUUM (ANALYZE)" >/dev/null
echo "   ok"

echo "== 3/5 等 autovacuum 静默 =="
# 刚灌完几百万行，autovacuum 通常会自己再跑一轮。它要是和压测重叠，
# 抢掉的 I/O 会被错记成「应用容量不足」。等它跑完再开压。
for i in $(seq 1 60); do
  n="$("${PSQL[@]}" -Atc "SELECT count(*) FROM pg_stat_activity WHERE query LIKE 'autovacuum:%'")"
  if [ "$n" = "0" ]; then echo "   已静默（第 ${i} 次检查）"; break; fi
  echo "   仍有 $n 个 autovacuum 在跑，10s 后重查（${i}/60）"
  sleep 10
done

echo "== 4/5 数据规模与工作集（判断是不是内存装不下）=="
"${PSQL[@]}" -c "
  SELECT relname AS 表,
         to_char(n_live_tup, 'FM999,999,999') AS 活行数,
         pg_size_pretty(pg_total_relation_size(relid)) AS 含索引大小,
         last_analyze IS NOT NULL OR last_autoanalyze IS NOT NULL AS 有统计信息
    FROM pg_stat_user_tables
   WHERE n_live_tup > 1000
   ORDER BY pg_total_relation_size(relid) DESC
   LIMIT 12"
"${PSQL[@]}" -c "
  SELECT pg_size_pretty(pg_database_size('junshi_lt')) AS 库总大小,
         current_setting('shared_buffers') AS shared_buffers"
echo "   ↑ 库总大小若明显超过本机可用内存，10x 掉容量就是缓存装不下，属 DB 内存问题而非 API 容量问题。"

echo "== 5/5 清空 pg_stat_statements 计数 =="
# 让压测期间的统计从零开始，否则 seed 自己那几百万条 INSERT 会淹掉 Top-N。
"${PSQL[@]}" -c "SELECT pg_stat_statements_reset()" >/dev/null
echo "   ok"

echo
echo "就绪，可以开压。跑完每一档立刻抓慢 SQL Top-N（否则会被下一档冲掉）："
echo "  bash loadtest/slowsql.sh <run_id>"
