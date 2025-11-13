#!/usr/bin/env bash
set -euo pipefail

# Optional CPU profiling helper used by CI job. This script is intended to
# be invoked from the repository root (CI working dir). It uses OM_PORT
# from environment (default 8080).
OM_PORT=${OM_PORT:-8080}

echo "Starting server briefly with CPU profiling"
mkdir -p profiling || true
bun --cpu-prof dist/server/index.js &
SERVER_PID=$!
for i in {1..40}; do
  if curl -sSf "http://127.0.0.1:$OM_PORT/health" >/dev/null 2>&1; then
    echo "Server responded"
    break
  fi
  sleep 0.25
done
if ps -p $SERVER_PID >/dev/null 2>&1; then
  kill $SERVER_PID || true
fi
# Move cpu profile files (if any) into profiling/ directory
mv cpu-* profiling/ 2>/dev/null || true
