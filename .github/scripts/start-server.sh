#!/usr/bin/env bash
set -eu
# usage: start-server.sh <working-directory> <pid-file> <health-url>
WORKDIR=${1:-.}
PID_FILE=${2:-/tmp/server_pid}
HEALTH_URL=${3:-http://127.0.0.1:8080/health}

mkdir -p $(dirname "$PID_FILE")
pushd "$WORKDIR" > /dev/null
echo "Starting server in $WORKDIR"
# redirect stdout/stderr to logfile for debugging in CI
LOGFILE=/tmp/server.log
bun run start > "$LOGFILE" 2>&1 &
echo $! > "$PID_FILE"
popd > /dev/null

echo "Waiting for health check: $HEALTH_URL"
SLEEP=1
for i in {1..60}; do
  if curl -sSf "$HEALTH_URL" >/dev/null 2>&1; then
    echo "Server is healthy (after ${i} attempts)."
    exit 0
  fi
  echo "Waiting for server... (attempt $i)"
  sleep $SLEEP
  # simple backoff
  SLEEP=$((SLEEP+1))
done

echo "Server did not become healthy; dumping logs from $LOGFILE"
if [ -f "$LOGFILE" ]; then
  tail -n +1 "$LOGFILE" | sed -n '1,200p'
fi
exit 1
