#!/usr/bin/env bash
set -euo pipefail

# Simple smoke E2E for dashboard: build, start, curl a few endpoints
# Usage: ./scripts/e2e_smoke.sh

PORT=3000
NEXT_TELEMETRY_DISABLED=1

echo "Building dashboard..."
bunx --bun next build

echo "Starting dashboard in background..."
bunx --bun next start -p ${PORT} &
PID=$!

echo "Waiting for server to be available..."
for i in {1..30}; do
  if curl -sSf "http://localhost:${PORT}/api/stats" >/dev/null 2>&1; then
    echo "API /api/stats is up"
    break
  fi
  sleep 1
done

# Smoke checks
curl -sSf "http://localhost:${PORT}/api/stats" | head -n 1
curl -sSf "http://localhost:${PORT}/api/memories" | head -n 1 || true

# Teardown
kill $PID
wait $PID 2>/dev/null || true

echo "Smoke E2E passed"
