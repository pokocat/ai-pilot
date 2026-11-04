#!/usr/bin/env bash
# 使用本地已登录 Alibaba CLI 做 DNS-01；证书与 ACME 账号保存在 git 忽略的目录。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON="${PYTHON_BIN:-python3}"
for arg in "$@"; do
  case "$arg" in --check|--help|-h) exec "$PYTHON" "$ROOT/scripts/ops/renew_alb_certificate.py" "$@" ;; esac
done
if [ -z "${CODEX_THREAD_ID:-}${DEVQ_OWNER:-}" ]; then
  export DEVQ_OWNER="$("$PYTHON" -c 'import uuid; print(uuid.uuid4())')"
fi
exec "${DEVQ_BIN:-/Users/donis/.local/bin/devq}" run --name junshi-alb-certificate-renewal --cwd "$ROOT" -- \
  "$PYTHON" "$ROOT/scripts/ops/renew_alb_certificate.py" "$@"
