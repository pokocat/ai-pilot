#!/usr/bin/env bash
set -euo pipefail

OUT_DIR="${1:-/opt/junshi-loadtest/results}"
INTERVAL="${MONITOR_INTERVAL:-2}"
mkdir -p "$OUT_DIR"

printf 'timestamp,load1,load5,load15,mem_available_bytes,swap_free_bytes,net_rx_bytes,net_tx_bytes\n' >"$OUT_DIR/host.csv"
printf 'timestamp,container,cpu_percent,mem_usage,mem_percent,net_io,block_io,pids\n' >"$OUT_DIR/containers.csv"
printf 'timestamp,total_connections,active_connections,idle_in_transaction,waiting_connections\n' >"$OUT_DIR/postgres.csv"

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

  sudo docker stats --no-stream \
    --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}},{{.MemPerc}},{{.NetIO}},{{.BlockIO}},{{.PIDs}}' \
    junshi-lt-api junshi-lt-db junshi-lt-gateway 2>/dev/null \
    | while IFS= read -r row; do printf '%s,%s\n' "$now" "$row"; done \
    >>"$OUT_DIR/containers.csv"

  sudo docker exec junshi-lt-db psql -U junshi_lt -d junshi_lt -At -F, -c "
    SELECT
      count(*),
      count(*) FILTER (WHERE state='active'),
      count(*) FILTER (WHERE state='idle in transaction'),
      count(*) FILTER (WHERE wait_event IS NOT NULL)
    FROM pg_stat_activity;
  " 2>/dev/null \
    | while IFS= read -r row; do printf '%s,%s\n' "$now" "$row"; done \
    >>"$OUT_DIR/postgres.csv"

  sleep "$INTERVAL"
done
