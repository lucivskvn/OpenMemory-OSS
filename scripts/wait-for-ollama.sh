#!/usr/bin/env bash
# Waits for Ollama to be healthy at a given URL (default http://localhost:11434/api/health)
# exits 0 on success or non-zero if timeouts.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." >/dev/null && pwd)"
OLLAMA_URL=${OLLAMA_URL:-http://localhost:11434/api/health}
TIMEOUT=${1:-30}
INTERVAL=1

echo "Waiting for Ollama at $OLLAMA_URL (timeout ${TIMEOUT}s)..."

start=$(date +%s)
while true; do
  if curl -fsS "$OLLAMA_URL" >/dev/null 2>&1; then
    echo "Ollama is healthy"
    exit 0
  fi

  now=$(date +%s)
  elapsed=$((now - start))
  if [ "$elapsed" -ge "$TIMEOUT" ]; then
    echo "Timed out waiting for Ollama after ${TIMEOUT}s"
    exit 2
  fi
  sleep $INTERVAL
done
