#!/usr/bin/env bash
# 10x 数据集容量阶梯的无人值守驱动。在压测机本机后台跑：
#
#   cd ~/junshi-loadtest && nohup bash loadtest/run-10x-ladder.sh > /tmp/ladder.log 2>&1 &
#
# 为什么要一个驱动脚本：每档 5 分钟 × 4 档 + T0，全程约 30 分钟。交互式一档档敲
# 容易在等待处断掉（前两次委派就是断在这里），也容易漏掉「跑完立刻抓慢 SQL、
# 再 reset」这个顺序——漏了 Top-N 就会串档，这一轮最关键的证据就废了。
set -uo pipefail   # 故意不加 -e：某一档被 k6 的 1% 护栏中止是预期结果，要继续跑下一档

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
LT="$ROOT/loadtest"
RES="$LT/results"
mkdir -p "$RES"

if docker ps >/dev/null 2>&1; then DCBIN=(docker compose); else DCBIN=(sudo docker compose); fi
# compose 文件在 loadtest/ 下，而本脚本在仓库根目录工作 —— 必须显式 -f，
# 否则 compose 在 CWD 找不到配置，静默地什么都不起（上一次就栽在这）。
DC=("${DCBIN[@]}" -f "$LT/docker-compose.yml")
DC_T0=("${DCBIN[@]}" -f "$LT/docker-compose.yml" -f "$LT/docker-compose.limits.yml")
DK=(sudo docker)
psql_c() { "${DC[@]}" exec -T db psql -U junshi_lt -d junshi_lt -Atc "$1"; }

step() { echo; echo "############ $* ############"; date '+%F %T'; }

smoke() {
  local code
  code="$("${DK[@]}" run --rm --network junshi-loadtest_edge curlimages/curl:latest \
    -s -o /dev/null -w '%{http_code}' --max-time 10 http://gateway:8080/api/health 2>/dev/null)"
  echo "gateway /api/health → HTTP ${code}"
  [ "$code" = "200" ]
}

step "0. 起全栈（T1：不设 CPU 配额）"
# db 加了 shm_size，必须 recreate 才生效；命名卷 junshi_lt_pgdata 不受影响，300 万行数据保留。
"${DC[@]}" up -d
sleep 25

step "0b. 安全告警自检（只允许 SMS_REQUIRE_CODE 一条）"
"${DC[@]}" logs api 2>&1 | grep -i '安全告警' || echo "(无告警行)"

step "0c. 冒烟：网关通不通 —— 不通就直接退出，别再产出一轮打空气的废数据"
if ! smoke; then
  echo "!! 网关不可达，中止。诊断信息："
  "${DC[@]}" ps
  "${DC[@]}" logs --tail 40 api
  "${DC[@]}" logs --tail 20 gateway
  exit 1
fi

step "0d. 确认 shm 已放大（VACUUM 需要）"
"${DK[@]}" exec junshi-loadtest-db-1 df -h /dev/shm | tail -1

step "1. postseed：VACUUM ANALYZE + 等 autovacuum + 打印工作集 + 清统计"
bash "$LT/postseed.sh" 2>&1 | tee "$RES/postseed.txt"

run_one() {
  local rate="$1" dur="$2" run="$3" extra="${4:-}"
  step "档位 ${rate} RPS / ${dur} → ${run}"

  # 资源采样跟着这一档的生命周期走
  bash "$LT/monitor.sh" "$RES/${run}-monitor" >/dev/null 2>&1 &
  local mon=$!

  "${DK[@]}" run --rm --user 0:0 --network junshi-loadtest_edge \
    -e BASE_URL=http://gateway:8080 \
    -e RATE="$rate" -e DURATION="$dur" -e RUN_ID="$run" \
    -e LT_USERS=10000 \
    -v "$LT/k6-readonly.js:/scripts/k6-readonly.js:ro" \
    -v "$LT/tokens.json:/scripts/tokens.json:ro" \
    -v "$RES:/results" \
    grafana/k6 run /scripts/k6-readonly.js 2>&1 | tee "$RES/${run}-k6.log"

  kill "$mon" 2>/dev/null; wait "$mon" 2>/dev/null

  # 顺序很重要：先抓 Top-N 落盘，再 reset，下一档才干净
  step "抓慢 SQL → ${run}"
  bash "$LT/slowsql.sh" "$run" >/dev/null 2>&1 || echo "(slowsql 失败)"
  psql_c "SELECT pg_stat_statements_reset()" >/dev/null
  sleep 15   # 让在途请求收尾、连接池回落，避免污染下一档
}

# ── T1 阶梯：10x 数据 ──
# 上一轮 350 就 1.9% 错误、450 有 8%。若本轮补了 ANALYZE 之后这两档变成 0 错误，
# 就证明上一轮测的是「统计信息缺失」的假象，而不是系统容量。
run_one 250 5m v2r2-10x-250-r1
run_one 300 5m v2r2-10x-300-r1
run_one 350 5m v2r2-10x-350-r1
run_one 450 5m v2r2-10x-450-r1

step "T0 对照：2.25 核配额 / 450 RPS / 2m —— 目的是拿 429 vs 503 的拆分"
"${DC_T0[@]}" up -d
sleep 25
if smoke; then
  run_one 450 2m v2r2-t0-450-r1
else
  echo "!! T0 网关不可达，跳过该档"
fi

step "全部跑完。结果清单："
ls -1 "$RES" | grep -E '^v2r2-' | sort
echo
echo "注意：清理与其他业务恢复没有自动做，由人工确认后执行。"
date '+%F %T'
