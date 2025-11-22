#!/usr/bin/env bash
set -euo pipefail

# check-system-resources.sh
# Lightweight helper to inspect available RAM and swap and return useful exit codes
# Exit codes:
#  0 -> OK (resources above thresholds)
#  1 -> WARNING (resources low) - scripts should consider reducing concurrency
#  2 -> CRITICAL (abort) - scripts should abort to avoid OOM / system thrash

# Defaults (human-friendly sizes). These can be overridden in the calling environment.
MIN_FREE_MEM_BYTES=${MIN_FREE_MEM_BYTES:-3221225472}   # 3 GiB
MIN_FREE_SWAP_BYTES=${MIN_FREE_SWAP_BYTES:-1073741824} # 1 GiB
CRITICAL_FREE_MEM_BYTES=${CRITICAL_FREE_MEM_BYTES:-1073741824} # 1 GiB

function bytes_to_human() {
  local b=$1
  if [ "$b" -ge $((1024**3)) ]; then
    printf "%.1fGB" "$(awk "BEGIN {printf %f, $b/1073741824}")"
  elif [ "$b" -ge $((1024**2)) ]; then
    printf "%.1fMB" "$(awk "BEGIN {printf %f, $b/1048576}")"
  elif [ "$b" -ge 1024 ]; then
    printf "%.1fKB" "$(awk "BEGIN {printf %f, $b/1024}")"
  else
    printf "%dB" "$b"
  fi
}

function get_mem_and_swap() {
  # Linux: use /proc/meminfo
  if [ -r /proc/meminfo ]; then
    local mem_free=$(awk '/^MemAvailable:/ {print $2 * 1024; exit}' /proc/meminfo || echo 0)
    # MemAvailable is in kB -> bytes
    local swap_free=$(awk '/^SwapFree:/ {print $2 * 1024; exit}' /proc/meminfo || echo 0)
    echo "$mem_free $swap_free"
    return 0
  fi

  # macOS / BSD: prefer vm_stat + sysctl (best effort)
  if command -v vm_stat >/dev/null 2>&1 && command -v sysctl >/dev/null 2>&1; then
    local page_size=$(sysctl -n hw.pagesize 2>/dev/null || echo 4096)
    local free_pages=$(vm_stat | awk '/free|Pages free/ {print $3}' | tr -d '.')
    local mem_free=$(( ${free_pages:-0} * page_size ))
    # no swap detection reliably across macOS versions here; set to zero
    echo "$mem_free 0"
    return 0
  fi

  # fallback: return 0 0
  echo "0 0"
  return 0
}

read available_mem available_swap < <(get_mem_and_swap)

human_mem=$(bytes_to_human "$available_mem")
human_swap=$(bytes_to_human "$available_swap")

echo "System resources: available_mem=${human_mem} (${available_mem}B), available_swap=${human_swap} (${available_swap}B)"

if [ "$available_mem" -lt "$CRITICAL_FREE_MEM_BYTES" ]; then
  echo "CRITICAL: available memory (${human_mem}) is below critical threshold: $(bytes_to_human "$CRITICAL_FREE_MEM_BYTES")" >&2
  exit 2
fi

if [ "$available_mem" -lt "$MIN_FREE_MEM_BYTES" ] || [ "$available_swap" -lt "$MIN_FREE_SWAP_BYTES" ]; then
  echo "WARNING: low resources detected; consider reducing parallelism or freeing memory/swap" >&2
  echo "Suggested actions: set PARALLEL_TESTS=0, PREPUSH_FAST=1 or run 'bun run prepush:containers' on a machine with more RAM." >&2
  exit 1
fi

echo "OK: system resources appear sufficient for heavy workloads." >&2
exit 0
