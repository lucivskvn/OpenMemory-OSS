#!/usr/bin/env bash
set -euo pipefail

echo "Starting Postgres via docker compose (profile: pg)"
docker compose --profile pg up -d postgres

echo "Waiting for Postgres to accept connections on localhost:5432..."
# Wait up to 60s
for i in {1..30}; do
  if nc -z 127.0.0.1 5432 >/dev/null 2>&1; then
    echo "Postgres is reachable"
    break
  fi
  echo "Waiting... ($i)"
  sleep 2
done

echo "Running Postgres integration tests"
OM_METADATA_BACKEND=postgres OM_ENABLE_PG=true OM_PG_HOST=127.0.0.1 OM_PG_PORT=5432 OM_PG_DB=openmemory OM_PG_USER=openmemory OM_PG_PASSWORD=openmemory bun test tests/backend/db-migration.pg.test.js --verbose

echo "Postgres tests finished"

echo "Tearing down Postgres container (keep data by default). To remove data, run: docker compose --profile pg down -v" 
