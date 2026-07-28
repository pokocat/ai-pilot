#!/usr/bin/env bash
# 第三轮（v3）：基于加权计价 + 动态额度预留代码的全量压测。无人值守，压测机本机后台跑：
#
#   cd ~/junshi-loadtest && nohup bash loadtest/run-v3.sh > /tmp/v3.log 2>&1 &
#
# 与 v2r2 的差异：
#   1. 数据卷已清空 → 本轮从零重建（db push + seed + loadtestSeed 10000 用户 ≈ 300 万行）
#   2. 只读阶梯砍掉 300 档（v2r2 四档全 0 错误，回归验证 250/350/450 三档足够）
#   3. 新增 LLM 写路径两档（mock + 真实闸门占用）：这轮改的就是生成前额度预留，
#      只读阶梯覆盖不到 reserveQuota/settle/billableOf 这条链
#   4. 写路径跑完后查钱包不变量：预留不应把余额打成巨额负数（新逻辑上限=占到 0）
#
# 诚实边界：mock provider 下 generationQuotaReserveTokens 走 2k 小额短路，
# 动态 20 万级上界分支只有单元测试覆盖，本轮压的是同一条 reserveQuota 并发链路。
set -uo pipefail   # 故意不加 -e：单档被 k6 护栏中止是预期结果，要继续跑下一档

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
LT="$ROOT/loadtest"
RES="$LT/results"
mkdir -p "$RES"

if docker ps >/dev/null 2>&1; then DCBIN=(docker compose); else DCBIN=(sudo docker compose); fi
DC=("${DCBIN[@]}" -f "$LT/docker-compose.yml")
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

step "0. 重建 api 镜像（本轮要压的就是最新代码）"
"${DC[@]}" build api || { echo "!! 镜像构建失败，中止"; exit 1; }

step "1. 起 db/redis + schema + 种子（卷已清空，全量重建）"
"${DC[@]}" up -d db redis
sleep 15
"${DC[@]}" run --rm api npx prisma db push --skip-generate --accept-data-loss || { echo "!! db push 失败"; exit 1; }
"${DC[@]}" run --rm api npm run db:seed || { echo "!! db:seed 失败"; exit 1; }
step "1b. loadtestSeed 10000 用户（约 300 万行，耐心等）"
"${DC[@]}" run --rm -e LT_USERS=10000 api ./node_modules/.bin/tsx prisma/loadtestSeed.ts || { echo "!! loadtestSeed 失败"; exit 1; }

step "2. 起 api/gateway + 冒烟 + 安全告警自检"
"${DC[@]}" up -d
sleep 25
"${DC[@]}" logs api 2>&1 | grep -i '安全告警' || echo "(无告警行)"
if ! smoke; then
  echo "!! 网关不可达，中止。诊断信息："
  "${DC[@]}" ps; "${DC[@]}" logs --tail 40 api; "${DC[@]}" logs --tail 20 gateway
  exit 1
fi
"${DK[@]}" exec junshi-loadtest-db-1 df -h /dev/shm | tail -1

step "3. postseed：VACUUM ANALYZE + 等 autovacuum + 清统计"
bash "$LT/postseed.sh" 2>&1 | tee "$RES/v3-postseed.txt"

run_one() {
  local rate="$1" dur="$2" run="$3"
  step "只读档位 ${rate} RPS / ${dur} → ${run}"
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
  step "抓慢 SQL → ${run}"
  bash "$LT/slowsql.sh" "$run" >/dev/null 2>&1 || echo "(slowsql 失败)"
  psql_c "SELECT pg_stat_statements_reset()" >/dev/null
  sleep 15
}

# ── 只读阶梯回归：v2r2 四档全 0 错误，本轮验证最新代码没退化 ──
run_one 250 5m v3-10x-250-r1
run_one 350 5m v3-10x-350-r1
run_one 450 5m v3-10x-450-r1

# ── LLM 写路径：mock 占真实闸门槽位，验证并发下额度预留/结算链 ──
llm_rung() {
  local vus="$1" iters="$2" run="$3"
  step "LLM 写路径 ${vus} VU / ${iters} 次 → ${run}"
  "${DK[@]}" run --rm --user 0:0 --network junshi-loadtest_edge \
    -e BASE_URL=http://gateway:8080 \
    -e VUS="$vus" -e ITERATIONS="$iters" -e RUN_ID="$run" \
    -e MAX_DURATION=10m \
    -v "$LT/k6-llm-queue.js:/scripts/k6-llm-queue.js:ro" \
    -v "$LT/tokens.json:/scripts/tokens.json:ro" \
    -v "$RES:/results" \
    grafana/k6 run /scripts/k6-llm-queue.js 2>&1 | tee "$RES/${run}-k6.log"
}

step "4. 重启 api：注入 mock 延迟 6s±3s，闸门/排队才真实占位"
LT_MOCK_LATENCY_MS=6000 LT_MOCK_LATENCY_JITTER_MS=3000 "${DC[@]}" up -d api
sleep 20
smoke || { echo "!! 注入延迟后网关不可达"; exit 1; }

llm_rung 32 128 v3-llm-32vu
sleep 20
llm_rung 200 400 v3-llm-200vu   # 超出 LLM_MAX_CONCURRENCY×队列的过载档，看 503 是否体面

step "5. 钱包不变量：动态预留不应制造巨额负余额"
psql_c "SELECT count(*) FILTER (WHERE balance < 0)                AS neg,
               count(*) FILTER (WHERE balance < -10000)           AS deep_neg,
               min(balance)                                        AS min_balance,
               count(*)                                            AS wallets
        FROM token_wallet WHERE \"userId\" LIKE 'lt-user-%'" | tee "$RES/v3-wallet-invariant.txt"
psql_c "SELECT count(*), coalesce(sum(\"totalTokens\"),0) FROM token_usage" | tee -a "$RES/v3-wallet-invariant.txt"

step "6. 恢复 api 默认参数（去掉注入延迟）"
"${DC[@]}" up -d api

step "全部跑完。结果清单："
ls -1 "$RES" | grep -E '^v3-' | sort
date '+%F %T'
