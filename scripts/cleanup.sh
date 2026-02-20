#!/usr/bin/env bash
# Cleanup audit data older than 90 days
# Usage: ./scripts/cleanup.sh [data_dir] [retention_days]

set -euo pipefail

DATA_DIR="${1:-/home/clawdbot/clawd/audits}"
RETENTION_DAYS="${2:-90}"
CUTOFF=$(date -u -d "${RETENTION_DAYS} days ago" +%Y-%m-%d 2>/dev/null || date -u -v-${RETENTION_DAYS}d +%Y-%m-%d)
DELETED=0

echo "[cleanup] $(date -u +%Y-%m-%dT%H:%M:%SZ) Starting audit data cleanup"
echo "[cleanup] Data dir: ${DATA_DIR}"
echo "[cleanup] Retention: ${RETENTION_DAYS} days (cutoff: ${CUTOFF})"

for dir in "${DATA_DIR}"/????-??-??; do
  [ -d "$dir" ] || continue
  dirname=$(basename "$dir")
  if [[ "$dirname" < "$CUTOFF" ]]; then
    echo "[cleanup] Deleting: ${dir}"
    rm -rf "$dir"
    DELETED=$((DELETED + 1))
  fi
done

echo "[cleanup] Done. Deleted ${DELETED} audit directories."
