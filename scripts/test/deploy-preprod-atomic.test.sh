#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT/scripts/deploy-preprod.sh"

bash -n "$SCRIPT"

assert_has() {
  local pattern="$1" label="$2"
  grep -Fq -- "$pattern" "$SCRIPT" || { echo "not ok - $label" >&2; exit 1; }
  echo "ok - $label"
}

assert_lacks() {
  local pattern="$1" label="$2"
  if grep -Fq -- "$pattern" "$SCRIPT"; then
    echo "not ok - $label" >&2
    exit 1
  fi
  echo "ok - $label"
}

assert_has 'RELEASE="$RELEASES_ROOT/release-${RELEASE_ID}"' 'candidate builds in a disk release directory'
assert_has '[ -s "$CANDIDATE_SERVER/dist/index.js" ]' 'candidate dist is required before switching'
assert_has 'sudo mv -Tf "$NEXT_LINK" "$LIVE_SERVER"' 'live server path switches atomically'
assert_has 'rollback_release' 'failed health check has a rollback path'
assert_has 'MIN_AVAILABLE_MB="${PREPROD_MIN_AVAILABLE_MB:-3072}"' '3 GiB available-memory gate is the default'
assert_has '--property="MemoryMax=$BUILD_MEMORY_MAX"' 'build cgroup has a memory ceiling'
assert_has '--property="CPUQuota=$BUILD_CPU_QUOTA"' 'build cgroup has a CPU ceiling'
assert_has '--property="MemorySwapMax=0"' 'build cannot create hidden swap pressure'
assert_lacks 'sudo rm -rf "$PREPROD_ROOT/server"' 'online server directory is never deleted before build'
assert_lacks 'sudo rm -rf dist' 'online dist is never deleted before candidate build'

echo '10 atomic/resource deploy guards passed'
