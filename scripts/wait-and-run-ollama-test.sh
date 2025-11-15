#!/usr/bin/env bash
set -euo pipefail

BASE=${OM_BASE_URL:-http://localhost:8080}
TEST_FILE=${1:-./tests/backend/ollama-mgmt.test.ts}
if [[ "$TEST_FILE" != /* && "$TEST_FILE" != ./* ]]; then
  TEST_FILE="./$TEST_FILE"
fi
MAX_ATTEMPTS=${WAIT_MAX_ATTEMPTS:-20}
SLEEP_MS=${WAIT_SLEEP_MS:-250}

echo "Deprecated: use 'scripts/wait-for-ollama.sh' + 'bun test' instead. This script will wait for health and print instructions."

attempt=0
while [ "$attempt" -lt "$MAX_ATTEMPTS" ]; do
  attempt=$((attempt+1))
  echo "Attempt $attempt: checking $BASE/health"
  if curl -fsS "$BASE/health" -o /tmp/_om_health.json 2>/tmp/_om_health.err; then
    echo "Health OK (attempt $attempt). Response:" 
    cat /tmp/_om_health.json
    # Resolve repository root based on script location and run test from backend/
    REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
    echo "Running Bun test from $REPO_ROOT/backend: $TEST_FILE"
    echo "Please run: (cd $REPO_ROOT/backend && bun test ../$TEST_FILE)"
    exit $?
  else
    echo "Health check failed (attempt $attempt). Last stderr:"
    tail -n +1 /tmp/_om_health.err || true
  fi
  sleep $(awk "BEGIN{printf %.3f, $SLEEP_MS/1000}")
done

echo "Health did not become ready after $MAX_ATTEMPTS attempts. Dumping last health output files:" >&2
[ -f /tmp/_om_health.json ] && echo "-- /tmp/_om_health.json --" && cat /tmp/_om_health.json || true
[ -f /tmp/_om_health.err ] && echo "-- /tmp/_om_health.err --" && cat /tmp/_om_health.err || true
exit 2
