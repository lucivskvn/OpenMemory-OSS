#!/usr/bin/env bash
set -eu
# usage: stop-server.sh <pid-file>
PID_FILE=${1:-/tmp/server_pid}
if [ ! -f "$PID_FILE" ]; then
  echo "PID file $PID_FILE does not exist; nothing to stop"
  exit 0
fi
PID=$(cat "$PID_FILE" 2>/dev/null || true)
if [ -z "$PID" ]; then
  echo "No PID found in $PID_FILE"
  exit 0
fi
if ps -p $PID >/dev/null 2>&1; then
  echo "Stopping process $PID"
  kill $PID || true
  sleep 1
  if ps -p $PID >/dev/null 2>&1; then
    echo "Process $PID still running; sending SIGKILL"
    kill -9 $PID || true
  fi
else
  echo "Process $PID not found"
fi
rm -f "$PID_FILE" || true
echo "Stopped server and removed pid file $PID_FILE"
