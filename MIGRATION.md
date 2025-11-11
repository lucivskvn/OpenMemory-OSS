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

- ✅ Auto-detects applied migrations (won't re-run)
- ✅ Safe execution (checks for existing columns before altering)
- ✅ Version tracking (stores applied versions in `schema_version` table)
- ✅ Works with both SQLite and PostgreSQL
- ✅ Gracefully handles errors (skips duplicates)
- ✅ Runs before database is initialized

**After migration, start your server normally:**

```bash
bun run dev
# or
bun run start
```

**Location:** `backend/src/core/migrate.ts`

---

## Manual Migration (Advanced)

If you prefer manual control or need to run migrations separately, use the SQL scripts below.

### SQLite Migration

Run these commands in your SQLite database (`data/openmemory.sqlite`):

```sql
-- Add user_id to memories table
ALTER TABLE memories ADD COLUMN user_id TEXT;
CREATE INDEX idx_memories_user ON memories(user_id);

-- Add user_id to vectors table
ALTER TABLE vectors ADD COLUMN user_id TEXT;
CREATE INDEX idx_vectors_user ON vectors(user_id);

-- Recreate waypoints table with composite primary key (src_id, user_id)
-- SQLite requires table recreation to change primary key
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

-- Create users table
CREATE TABLE users (
  user_id TEXT PRIMARY KEY,
  summary TEXT,
  reflection_count INTEGER DEFAULT 0,
  created_at INTEGER,
  updated_at INTEGER
);

-- Create stats table (added in v1.2 for maintenance tracking)
CREATE TABLE stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  count INTEGER DEFAULT 1,
  ts INTEGER NOT NULL
);

CREATE INDEX idx_stats_ts ON stats(ts);
CREATE INDEX idx_stats_type ON stats(type);
```

---

## PostgreSQL Migration

Replace `schema` with `OM_PG_SCHEMA` and `table_name` with `OM_PG_TABLE` from your config:

```sql
-- Add user_id to memories table
ALTER TABLE schema.table_name ADD COLUMN user_id TEXT;
CREATE INDEX openmemory_memories_user_idx ON schema.table_name(user_id);

-- Add user_id to vectors table
ALTER TABLE schema.openmemory_vectors ADD COLUMN user_id TEXT;
CREATE INDEX openmemory_vectors_user_idx ON schema.openmemory_vectors(user_id);

-- Add user_id to waypoints and update primary key
ALTER TABLE schema.openmemory_waypoints ADD COLUMN user_id TEXT;
ALTER TABLE schema.openmemory_waypoints DROP CONSTRAINT openmemory_waypoints_pkey;
ALTER TABLE schema.openmemory_waypoints ADD PRIMARY KEY (src_id, user_id);
CREATE INDEX openmemory_waypoints_user_idx ON schema.openmemory_waypoints(user_id);

-- Create users table
CREATE TABLE schema.openmemory_users (
  user_id TEXT PRIMARY KEY,
  summary TEXT,
  reflection_count INTEGER DEFAULT 0,
  created_at BIGINT,
  updated_at BIGINT
);
```

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

1. From the backend directory, refresh dependencies and run migrations:

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

  use your previous release tag, then `npm install` and run the old server.

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

Postgres / legacy Node support
------------------------------

As of the `next` branch changes on 2025-11-11, the backend now requires Bun's native Postgres client when `OM_METADATA_BACKEND=postgres`.

- The legacy Node `pg` client fallback and the previous `ws`/Node server compatibility path were removed to simplify the runtime and reduce maintenance burden.
- If you need to run the code with the legacy `pg` client (Node), set up a pinned branch before this change or revert the commit — this repository no longer ships `pg` in `backend/package.json` on the `next` branch.
- To run Postgres-backed tests and services, ensure your CI or local environment provides a Bun runtime with Postgres support (e.g., Bun >=1.3.x with Postgres bindings) and the env vars: `OM_PG_HOST`, `OM_PG_PORT`, `OM_PG_USER`, `OM_PG_PASSWORD`, `OM_PG_DB`.

Recommended migration steps

1. Add a CI job that starts Postgres and runs `bun test` against the `backend` package. Validate migrations and table creation under Bun's Postgres client.
2. Remove any lingering Node-only server artifacts if you no longer need them (search for `server.js` or `ws`-based code paths) and update docs accordingly.

C

## CI validation (added)

A GitHub Actions job named `test-backend-postgres` has been added to the consolidated CI workflow `.github/workflows/ci.yml`. It starts a Postgres service and runs the backend test script with `OM_METADATA_BACKEND=postgres` to validate the Bun Postgres integration in CI. Use this job as the canonical way to verify Postgres-backed changes under the Bun runtime.

Additionally, the consolidated CI pipeline builds and publishes a multi-platform Docker image to GitHub Container Registry (GHCR) after tests pass. The published image tags are:

- `ghcr.io/<owner>/<repo>:latest`
- `ghcr.io/<owner>/<repo>:<commit-sha>`

Replace `<owner>/<repo>` with your repository owner/name when pulling the image. If you prefer Docker Hub or another registry, update the workflow and provide credentials via repository secrets.

## Configuration additions

- `OM_HYBRID_FUSION` (boolean, default: true): Toggle hybrid fusion behavior when the backend runs in hybrid tier. This variable is available in `docker-compose.yml` and is mapped to `env.hybrid_fusion` in `backend/src/core/cfg.ts`.

- `OM_EMBEDDINGS` (legacy alias): Some deploys historically used `OM_EMBEDDINGS`. The backend now prefers `OM_EMBEDDINGS` when present for backwards compatibility, but `OM_EMBED_KIND` is the canonical variable. To avoid ambiguity, set `OM_EMBED_KIND` in new deployments.

---

## Schema Changes Summary

### Modified Tables

- **memories**: Added `user_id TEXT` column + index
- **vectors**: Added `user_id TEXT` column + index
- **waypoints**: Added `user_id TEXT` column, changed primary key from `(src_id)` to `(src_id, user_id)`

### New Tables

- **users**: User summaries and reflection tracking
- **stats**: Maintenance operation logging (decay, reflect, consolidate)

### New Query Methods

- `all_mem_by_user(user_id, limit, offset)` - Get memories for specific user
- `ins_user(user_id, summary, reflection_count, created_at, updated_at)` - Insert/update user
- `get_user(user_id)` - Get user record
- `upd_user_summary(user_id, summary, updated_at)` - Update user summary

---

## Post-Migration Notes

- **Existing records**: Will have `user_id = NULL` (treated as system/default user)
- **API usage**: Include `user_id` in `POST /memory/add` requests
- **Querying**: Filter by user with `filters: { user_id: "user123" }`
- **User summaries**: Auto-generated when memories are added per user
- **Migration tool**: Preserves user_id when importing from Zep/Mem0/Supermemory
