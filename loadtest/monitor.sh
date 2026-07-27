#!/usr/bin/env bash
set -euo pipefail

OUT_DIR="${1:-/opt/junshi-loadtest/results}"
INTERVAL="${MONITOR_INTERVAL:-2}"
COMPOSE_DIR="${COMPOSE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
API_PORT="${LT_API_PORT:-14000}"
mkdir -p "$OUT_DIR"

printf 'timestamp,load1,load5,load15,mem_available_bytes,swap_free_bytes,net_rx_bytes,net_tx_bytes\n' >"$OUT_DIR/host.csv"
printf 'timestamp,container,cpu_percent,mem_usage,mem_percent,net_io,block_io,pids\n' >"$OUT_DIR/containers.csv"
printf 'timestamp,total_connections,active_connections,idle_in_transaction,waiting_connections,pg_stat_statements_available\n' >"$OUT_DIR/postgres.csv"
printf 'timestamp,api_host_pid,api_rss_bytes,api_fd_count,api_processes\n' >"$OUT_DIR/api-process.csv"
printf 'timestamp,redis_used_memory_bytes,redis_connected_clients,redis_total_commands_processed\n' >"$OUT_DIR/redis.csv"
printf 'timestamp,event_loop_p95_seconds,process_rss_bytes,prisma_pool_busy,prisma_pool_idle,prisma_pool_open\n' >"$OUT_DIR/metrics.csv"
printf 'timestamp,llm_in_flight,llm_queued,llm_ceiling,llm_max_concurrency,llm_queue_depth_max,llm_wait_max_seconds,llm_upstream_429_total,llm_cooldowns_total,llm_timed_out_total\n' >"$OUT_DIR/llm.csv"

compose() {
  sudo docker compose -f "$COMPOSE_DIR/docker-compose.yml" "$@"
}

metric_value() {
  local name="$1"
  awk -v key="$name" '$1 == key { print $2; exit }'
}

while true; do
  now="$(date -Is)"
  read -r load1 load5 load15 _ </proc/loadavg
  mem_available="$(awk '/^MemAvailable:/{print $2 * 1024}' /proc/meminfo)"
  swap_free="$(awk '/^SwapFree:/{print $2 * 1024}' /proc/meminfo)"
  read -r net_rx net_tx < <(
    awk -F'[: ]+' 'NR>2 && $2!="lo" {rx+=$3; tx+=$11} END {print rx+0, tx+0}' /proc/net/dev
  )
  printf '%s,%s,%s,%s,%.0f,%.0f,%.0f,%.0f\n' \
    "$now" "$load1" "$load5" "$load15" "$mem_available" "$swap_free" "$net_rx" "$net_tx" \
    >>"$OUT_DIR/host.csv"

  api_id="$(compose ps -q api)"
  db_id="$(compose ps -q db)"
  redis_id="$(compose ps -q redis)"
  gateway_id="$(compose ps -q gateway)"

  sudo docker stats --no-stream \
    --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}},{{.MemPerc}},{{.NetIO}},{{.BlockIO}},{{.PIDs}}' \
    "$api_id" "$db_id" "$redis_id" "$gateway_id" 2>/dev/null \
    | while IFS= read -r row; do printf '%s,%s\n' "$now" "$row"; done \
    >>"$OUT_DIR/containers.csv"

  pg_stats=0
  if sudo docker exec "$db_id" psql -U junshi_lt -d junshi_lt -At -c "SELECT 1 FROM pg_extension WHERE extname='pg_stat_statements'" 2>/dev/null | grep -qx 1; then
    pg_stats=1
  fi
  sudo docker exec "$db_id" psql -U junshi_lt -d junshi_lt -At -F, -c "
    SELECT
      count(*),
      count(*) FILTER (WHERE state='active'),
      count(*) FILTER (WHERE state='idle in transaction'),
      count(*) FILTER (WHERE state = 'active' AND wait_event IS NOT NULL)
    FROM pg_stat_activity;
  " 2>/dev/null \
    | while IFS= read -r row; do printf '%s,%s,%s\n' "$now" "$row" "$pg_stats"; done \
    >>"$OUT_DIR/postgres.csv"

  if [ -n "$api_id" ]; then
    api_pid="$(sudo docker inspect -f '{{.State.Pid}}' "$api_id" 2>/dev/null || true)"
    api_rss="$(awk '/^VmRSS:/{print $2 * 1024}' "/proc/$api_pid/status" 2>/dev/null || echo 0)"
    api_fds="$(sudo find "/proc/$api_pid/fd" -maxdepth 1 -type l 2>/dev/null | wc -l | tr -d ' ' || true)"
    api_procs="$(sudo docker top "$api_id" -eo pid 2>/dev/null | tail -n +2 | wc -l | tr -d ' ' || true)"
    printf '%s,%s,%s,%s,%s\n' "$now" "$api_pid" "${api_rss:-0}" "${api_fds:-0}" "${api_procs:-0}" >>"$OUT_DIR/api-process.csv"
  fi

  if [ -n "$redis_id" ]; then
    redis_info="$(sudo docker exec "$redis_id" redis-cli INFO memory clients stats 2>/dev/null || true)"
    redis_mem="$(printf '%s\n' "$redis_info" | awk -F: '$1=="used_memory" {print $2}' | tr -d '\r')"
    redis_clients="$(printf '%s\n' "$redis_info" | awk -F: '$1=="connected_clients" {print $2}' | tr -d '\r')"
    redis_commands="$(printf '%s\n' "$redis_info" | awk -F: '$1=="total_commands_processed" {print $2}' | tr -d '\r')"
    printf '%s,%s,%s,%s\n' "$now" "${redis_mem:-0}" "${redis_clients:-0}" "${redis_commands:-0}" >>"$OUT_DIR/redis.csv"
  fi

  if [ -n "${LT_METRICS_TOKEN:-}" ]; then
    metric_text="$(curl -fsS -H "Authorization: Bearer $LT_METRICS_TOKEN" "http://127.0.0.1:${API_PORT}/api/metrics" 2>/dev/null || true)"
    loop_p95="$(printf '%s\n' "$metric_text" | awk '$1 ~ /^junshi_nodejs_event_loop_delay_seconds\{quantile="0.95"\}/ {print $2; exit}')"
    process_rss="$(printf '%s\n' "$metric_text" | metric_value junshi_process_resident_memory_bytes)"
    pool_busy="$(printf '%s\n' "$metric_text" | metric_value prisma_pool_connections_busy)"
    pool_idle="$(printf '%s\n' "$metric_text" | metric_value prisma_pool_connections_idle)"
    pool_open="$(printf '%s\n' "$metric_text" | metric_value prisma_pool_connections_open)"
    printf '%s,%s,%s,%s,%s,%s\n' "$now" "${loop_p95:-0}" "${process_rss:-0}" "${pool_busy:-0}" "${pool_idle:-0}" "${pool_open:-0}" >>"$OUT_DIR/metrics.csv"

    llm_value() {
      local name="$1"
      printf '%s\n' "$metric_text" | awk -v key="$name" '$1 ~ ("^" key "\\{lane=\\\"main\\\"\\}") { print $2; exit }'
    }
    llm_in_flight="$(llm_value junshi_llm_in_flight)"
    llm_queued="$(llm_value junshi_llm_queued)"
    llm_ceiling="$(llm_value junshi_llm_ceiling)"
    llm_max="$(llm_value junshi_llm_max_concurrency)"
    llm_qmax="$(llm_value junshi_llm_queue_depth_max)"
    llm_wmax="$(llm_value junshi_llm_wait_max_seconds)"
    llm_429="$(llm_value junshi_llm_upstream_429_total)"
    llm_cooldowns="$(llm_value junshi_llm_cooldowns_total)"
    llm_timeout="$(llm_value junshi_llm_timed_out_total)"
    printf '%s,%s,%s,%s,%s,%s,%s,%s,%s,%s\n' "$now" "${llm_in_flight:-0}" "${llm_queued:-0}" "${llm_ceiling:-0}" "${llm_max:-0}" "${llm_qmax:-0}" "${llm_wmax:-0}" "${llm_429:-0}" "${llm_cooldowns:-0}" "${llm_timeout:-0}" >>"$OUT_DIR/llm.csv"
  fi

  sleep "$INTERVAL"
done
