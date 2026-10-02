#!/usr/bin/env bash
# Boot the real image under the real docker-compose.yml limits (mem_limit,
# read-only rootfs, heap cap) with a warm cache volume, and fail unless it
# comes up healthy and stays up.
#
# Unit tests run in a roomy CI process with an empty cache, which is how a
# cache that OOM-killed the production container on every boot for 24 days
# passed CI. This is the check that would have caught it.
#
#   scripts/smoke-container.sh            # all scenarios
#   SMOKE_KEEP=1 scripts/smoke-container.sh   # leave the last stack up to poke at
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT=patchboard-smoke
PORT=${SMOKE_PORT:-3902}
HOLD_SECONDS=${SMOKE_HOLD_SECONDS:-20}
# Default GH_CACHE_MAX_MB is 24, so the load limit is 32 MB.
LOAD_LIMIT_MB=32
# Booted and idle, the app must leave at least half of mem_limit free: a scan
# runs straight after boot whenever the cache is stale, and needs the room.
MAX_IDLE_MIB=256

# No token needed: the collector loads the cache at construction regardless,
# and without one it never reaches out to GitHub.
export PORT HOST_BIND=127.0.0.1 GITHUB_TOKEN= GH_AUTO_REFRESH=false
compose() { docker compose -p "$PROJECT" "$@"; }
container() { compose ps -aq audit-dashboard; }

down() { compose down -v --remove-orphans >/dev/null 2>&1 || true; }
trap '[ -n "${SMOKE_KEEP:-}" ] || down' EXIT

compose build --quiet

# scenario <name> <fixture MB or 0> <expect-set-aside: yes|no>
scenario() {
  local name=$1 mb=$2 set_aside=$3
  echo "── $name"
  down
  compose create --quiet-pull >/dev/null 2>&1 || compose create
  local volume="${PROJECT}_gh-cache"
  if [ "$mb" != 0 ]; then
    docker run --rm --user root -v "$volume:/cache" -v "$PWD/scripts:/scripts:ro" \
      --entrypoint sh "audit-dashboard:$(node -p "require('./package.json').version")" \
      -c "node /scripts/gen-cache-fixture.js $mb /cache/github.json && chown -R node:node /cache"
  fi
  compose start >/dev/null

  local id; id=$(container)
  local ok=
  for _ in $(seq 1 30); do
    if curl -fsS -m 2 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then ok=1; break; fi
    sleep 1
  done
  [ -n "$ok" ] || { echo "FAIL: /healthz never answered"; docker logs --tail 30 "$id"; exit 1; }

  # Crash loops look healthy between restarts; hold and re-check.
  sleep "$HOLD_SECONDS"
  local state; state=$(docker inspect -f '{{.State.Running}} {{.State.OOMKilled}} {{.RestartCount}}' "$id")
  read -r running oom restarts <<<"$state"
  local mem; mem=$(docker stats --no-stream --format '{{.MemUsage}}' "$id" | cut -d/ -f1)
  local mib; mib=$(awk -v m="$mem" 'BEGIN { v = m + 0; if (m ~ /GiB/) v *= 1024; else if (m ~ /KiB/) v /= 1024; printf "%d", v }')
  echo "   running=$running oomKilled=$oom restarts=$restarts mem=${mib}MiB"
  if [ "$running" != true ] || [ "$oom" != false ] || [ "$restarts" != 0 ]; then
    echo "FAIL: container did not stay up"; docker logs --tail 30 "$id"; exit 1
  fi
  if [ "$mib" -gt "$MAX_IDLE_MIB" ]; then
    echo "FAIL: ${mib}MiB idle leaves no room for a scan under mem_limit (max ${MAX_IDLE_MIB}MiB)"; exit 1
  fi
  curl -fsS -m 2 "http://127.0.0.1:$PORT/healthz" >/dev/null || { echo "FAIL: /healthz stopped answering"; exit 1; }

  local aside; aside=$(docker run --rm -v "$volume:/cache:ro" --entrypoint sh \
    "audit-dashboard:$(node -p "require('./package.json').version")" -c 'test -f /cache/github.json.oversized && echo yes || echo no')
  if [ "$aside" != "$set_aside" ]; then
    echo "FAIL: expected oversized cache set aside=$set_aside, got $aside"; exit 1
  fi

  # Node is PID 1: without a SIGTERM handler `docker stop` times out and
  # SIGKILLs, so a clean redeploy is indistinguishable from a crash (137).
  docker stop -t 10 "$id" >/dev/null
  local code; code=$(docker inspect -f '{{.State.ExitCode}}' "$id")
  if [ "$code" != 0 ]; then echo "FAIL: stop exited $code, expected a clean 0"; exit 1; fi
  echo "   ok"
}

scenario "cold start, no cache"                      0                        no
scenario "largest cache the app will load"           $((LOAD_LIMIT_MB - 1))   no
scenario "oversized cache (the 2026-09 outage, 98 MB)" 98                     yes
echo "container smoke test passed"
