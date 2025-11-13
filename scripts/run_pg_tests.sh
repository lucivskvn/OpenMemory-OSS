#!/usr/bin/env bash
set -euo pipefail

echo "Starting Postgres via docker compose (profile: pg)"
docker compose --profile pg up -d postgres


echo "Waiting for Postgres to accept connections on ${HOST}:${PORT}..."

# wait_for_port: try nc, then python3, then node; timeout after ~60s
wait_for_port() {
  local host="$1" port="$2" attempts=30 interval=2

  if command -v nc >/dev/null 2>&1; then
    echo "Using 'nc' to check TCP port"
    for i in $(seq 1 $attempts); do
      if nc -z "$host" "$port" >/dev/null 2>&1; then
        echo "Postgres is reachable via nc"
        return 0
      fi
      echo "Waiting... ($i)"
      sleep $interval
    done
    return 2
  fi

  if command -v python3 >/dev/null 2>&1; then
    echo "'nc' not found; using python3 TCP check"
    python3 - <<PY
import socket, time, sys
host = "${host}"
port = ${port}
attempts = ${attempts}
interval = ${interval}
for i in range(attempts):
    s = socket.socket()
    s.settimeout(1.0)
    try:
        s.connect((host, port))
        print('Postgres is reachable via python3')
        sys.exit(0)
    except Exception:
        print(f'Waiting... ({i+1})')
        time.sleep(interval)
sys.exit(2)
PY
    return $?
  fi

  if command -v node >/dev/null 2>&1; then
    echo "'nc' and 'python3' not found; using node TCP check"
    node - <<'NODE'
const net = require('net');
const host = process.env.HOST || '127.0.0.1';
const port = parseInt(process.env.PORT || '5432');
let attempts = 0;
const max = 30;
const interval = 2000;
function tryConnect(){
  const s = new net.Socket();
  s.setTimeout(1000);
  s.once('connect', ()=>{ console.log('Postgres is reachable via node'); process.exit(0); });
  s.once('error', ()=>{ attempts++; if(attempts>=max){ console.error('timeout'); process.exit(2);} setTimeout(tryConnect, interval); });
  s.connect(port, host);
}
tryConnect();
NODE
    return $?
  fi

  echo "No method available to check TCP port (need nc, python3, or node)."
  return 3
}

wait_for_port "${HOST}" ${PORT}

echo "Running Postgres integration tests"
OM_METADATA_BACKEND=postgres OM_ENABLE_PG=true OM_PG_HOST=${HOST} OM_PG_PORT=${PORT} OM_PG_DB=openmemory OM_PG_USER=openmemory OM_PG_PASSWORD=openmemory bun test tests/backend/db-migration.pg.test.js --verbose

echo "Postgres tests finished"

echo "Tearing down Postgres container (keep data by default). To remove data, run: docker compose --profile pg down -v" 
