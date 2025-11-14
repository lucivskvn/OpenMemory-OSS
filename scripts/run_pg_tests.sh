#!/usr/bin/env bash
set -euo pipefail

# Defaults (can be overridden by environment)
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-5432}"
TEARDOWN=false
SKIP_UP=false
TEARDOWN_AFTER_FAILURE=false

usage(){
  echo "Usage: $0 [--teardown|-t]" >&2
  echo "  --teardown, -t    Tear down the Postgres containers and remove volumes after tests" >&2
  echo "  --skip-up, -s     Skip 'docker compose up' (assume containers already running)" >&2
  echo "  --teardown-after-failure, -f  Tear down containers and volumes if tests fail" >&2
  echo "  --help            Show this help" >&2
  exit 1
}

# Simple arg parsing
while [[ ${#} -gt 0 ]]; do
  case "$1" in
    -t|--teardown)
      TEARDOWN=true
      shift
      ;;
    -s|--skip-up|--no-build)
      SKIP_UP=true
      shift
      ;;
    -f|--teardown-after-failure)
      TEARDOWN_AFTER_FAILURE=true
      shift
      ;;
    -h|--help)
      usage
      ;;
    --)
      shift
      break
      ;;
    -*|--*)
      echo "Unknown option: $1" >&2
      usage
      ;;
    *)
      # positional (none expected)
      shift
      ;;
  esac
done

echo "Starting Postgres via docker compose (profile: pg)"
if [ "${SKIP_UP}" = "true" ]; then
  echo "Skipping 'docker compose up' (assuming containers already running)"
else
  docker compose --profile pg up -d postgres
fi


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
# Run tests but capture exit code so we can teardown on failure if requested
set +e
OM_METADATA_BACKEND=postgres OM_ENABLE_PG=true OM_PG_HOST=${HOST} OM_PG_PORT=${PORT} OM_PG_DB=openmemory OM_PG_USER=openmemory OM_PG_PASSWORD=openmemory bun test tests/backend/db-migration.pg.test.js --verbose
TEST_EXIT=$?
set -e

echo "Postgres tests finished (exit code: ${TEST_EXIT})"

# Decide whether to teardown:
# - If --teardown was passed, always teardown
# - If --teardown-after-failure was passed and tests failed, teardown
if [ "${TEARDOWN}" = "true" ] || { [ "${TEARDOWN_AFTER_FAILURE}" = "true" ] && [ ${TEST_EXIT} -ne 0 ]; }; then
  echo "Tearing down Postgres container and removing volumes"
  docker compose --profile pg down --volumes
else
  echo "Leaving Postgres container running (keep data by default)."
  echo "To remove containers and data now, run: docker compose --profile pg down --volumes"
fi

exit ${TEST_EXIT}
