<!-- markdownlint-disable MD040 MD003 -->
# Multi-User Tenant Migration (v1.2)

⚠️ **Required for users upgrading from v1.1 or earlier**

OpenMemory v1.2 introduces per-user memory isolation with `user_id` fields. The schema changes add user columns to memories, vectors, and waypoints tables, plus a new users table for summaries.

## Automatic Migration (Recommended)

**OpenMemory includes an automatic migration script for safe database upgrades.**

Run the migration before starting your server:

```bash
cd backend
bun run migrate
```

**Console output:**

```
OpenMemory Database Migration Tool

[MIGRATE] Checking for pending migrations...
[MIGRATE] Current database version: none
[MIGRATE] Running migration: 1.2.0 - Multi-user tenant support
[MIGRATE] Migration 1.2.0 completed successfully
[MIGRATE] All migrations completed

[SUCCESS] Migration completed
```

**Features:**

**After migration, start your server normally:**

```bash
bun run dev
# or
bun run start
```

**Canonical migration runner:** `backend/src/migrate.ts`

Note: A legacy migration helper exists at `backend/src/core/migrate.ts` but it is not the canonical CLI runner. Use `bun run migrate` from the `backend` directory which executes `backend/src/migrate.ts`.

## Manual Migration (Advanced)

If you prefer manual control or need to run migrations separately, use the SQL scripts below.

### SQLite Migration

Run these commands in your SQLite database (`data/openmemory.sqlite`):

```sql
ALTER TABLE memories ADD COLUMN user_id TEXT;
CREATE INDEX idx_memories_user ON memories(user_id);

ALTER TABLE vectors ADD COLUMN user_id TEXT;
CREATE INDEX idx_vectors_user ON vectors(user_id);

CREATE TABLE waypoints_new (
  src_id TEXT,
  dst_id TEXT NOT NULL,
  user_id TEXT,
  weight REAL NOT NULL,
  created_at INTEGER,
  updated_at INTEGER,
  PRIMARY KEY(src_id, user_id)
);

INSERT INTO waypoints_new
  SELECT src_id, dst_id, NULL, weight, created_at, updated_at
  FROM waypoints;

DROP TABLE waypoints;
ALTER TABLE waypoints_new RENAME TO waypoints;

CREATE INDEX idx_waypoints_src ON waypoints(src_id);
CREATE INDEX idx_waypoints_dst ON waypoints(dst_id);
CREATE INDEX idx_waypoints_user ON waypoints(user_id);

CREATE TABLE users (
  user_id TEXT PRIMARY KEY,
  summary TEXT,
  reflection_count INTEGER DEFAULT 0,
  created_at INTEGER,
  updated_at INTEGER
);

CREATE TABLE stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  count INTEGER DEFAULT 1,
  ts INTEGER NOT NULL
);

CREATE INDEX idx_stats_ts ON stats(ts);
CREATE INDEX idx_stats_type ON stats(type);
```

## PostgreSQL Migration

Replace `schema` with `OM_PG_SCHEMA` and `table_name` with `OM_PG_TABLE` from your config:

```sql
ALTER TABLE schema.table_name ADD COLUMN user_id TEXT;
CREATE INDEX openmemory_memories_user_idx ON schema.table_name(user_id);

ALTER TABLE schema.openmemory_vectors ADD COLUMN user_id TEXT;
CREATE INDEX openmemory_vectors_user_idx ON schema.openmemory_vectors(user_id);

ALTER TABLE schema.openmemory_waypoints ADD COLUMN user_id TEXT;
ALTER TABLE schema.openmemory_waypoints DROP CONSTRAINT openmemory_waypoints_pkey;
ALTER TABLE schema.openmemory_waypoints ADD PRIMARY KEY (src_id, user_id);
CREATE INDEX openmemory_waypoints_user_idx ON schema.openmemory_waypoints(user_id);

CREATE TABLE schema.openmemory_users (
  user_id TEXT PRIMARY KEY,
  summary TEXT,
  reflection_count INTEGER DEFAULT 0,
  created_at BIGINT,
  updated_at BIGINT
);
```

Note: the repository's in-process migration runner (`bun run migrate`) will skip the SQLite-style automatic migrations when `OM_METADATA_BACKEND=postgres` is set. Postgres DDL differs from the SQLite schema, so operators should run the Postgres-specific migration commands shown above (or a suitable SQL migration tool) when using a Postgres metadata backend.

## Bun Runtime Migration (v1.2 → v1.3)

OpenMemory now supports running on the Bun runtime (recommended: Bun v1.3.2+).

Overview:

  hybrid backend. This section describes steps to migrate from Node to Bun.

Steps:

1. Install Bun on your machine (follow Bun installation instructions):

```bash
curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$PATH"
```

1. From the backend directory, refresh dependencies and run migrations using Bun:

```bash
cd backend
bun install
bun run build
bun run migrate
bun run start
```

1. Verify the health endpoint:

```bash
curl http://localhost:8080/health
```

Rollback:

  use your previous release tag, then `bun install` and run the old server.

Testing:

```bash
cd backend
bun test ../tests/backend/
```

Notes:

  retains the `pg` implementation as a compatibility fallback. See
  `backend/src/core/db.ts` for migration guidance.

Note about WebSocket dependency:

  The legacy Node-based HTTP/WebSocket server (`backend/src/server/server.js`)
  has been removed in favor of the Bun-native server (`backend/src/server/server.ts`).
  The repository no longer ships the Node `ws` runtime dependency for the
  `next` branch. If your deployment still expects a Node `ws` server, update
  your runtime to Bun or pin an earlier branch that retained Node artifacts.

Postgres / runtime compatibility

The backend prefers Bun's native Postgres client when `OM_METADATA_BACKEND=postgres` is selected. However, to improve compatibility across CI runners and contributor machines, the codebase supports a dynamic runtime fallback to the Node `pg` driver when a Bun Postgres client is not available. The fallback is loaded dynamically at startup and preserves the same query and transaction semantics used by the Bun path.

Recommended migration steps

1. Add a CI job that starts Postgres and runs `bun test` against the `backend` package. Validate migrations and table creation under the runtime you plan to use (Bun with Postgres support or Node `pg` fallback).
2. If you want to require Bun's native Postgres client in CI, ensure the runner includes a Bun build with Postgres enabled or remove the dynamic fallback and update deployment docs accordingly.

## CI validation (added)

A GitHub Actions job named `test-backend-postgres` has been added to the consolidated CI workflow `.github/workflows/ci.yml`. It starts a Postgres service and runs the backend test script with `OM_METADATA_BACKEND=postgres` to validate the Bun Postgres integration in CI. Use this job as the canonical way to verify Postgres-backed changes under the Bun runtime.

Additionally, the consolidated CI pipeline builds and publishes a multi-platform Docker image to GitHub Container Registry (GHCR) after tests pass. The published image tags are:

Replace `<owner>/<repo>` with your repository owner/name when pulling the image. If you prefer Docker Hub or another registry, update the workflow and provide credentials via repository secrets.

## Configuration additions

## Schema Changes Summary

### Modified Tables

### New Tables

### New Query Methods

## Post-Migration Notes
