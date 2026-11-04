#!/usr/bin/env bash
# 正式发布唯一默认入口：新 ECS 集群主备滚动发布。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON="${PYTHON_BIN:-python3}"
for arg in "$@"; do
  case "$arg" in
    --plan|--help|-h) exec "$PYTHON" "$ROOT/scripts/ops/deploy_cluster.py" "$@" ;;
  esac
done
DEVQ="${DEVQ_BIN:-/Users/donis/.local/bin/devq}"
if [ -z "${CODEX_THREAD_ID:-}${DEVQ_OWNER:-}" ]; then
  export DEVQ_OWNER="$("$PYTHON" -c 'import uuid; print(uuid.uuid4())')"
fi
exec "$DEVQ" run --name junshi-active-standby-release --cwd "$ROOT" -- \
  "$PYTHON" "$ROOT/scripts/ops/deploy_cluster.py" "$@"
