import { Migration } from "./migration_types";

export const v1_2_0: Migration = {
    version: "1.2.0",
    desc: "Multi-user tenant support",
    sqlite: [
        `ALTER TABLE memories ADD COLUMN user_id TEXT`,
        `CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id)`,
        `ALTER TABLE vectors ADD COLUMN user_id TEXT`,
        `CREATE INDEX IF NOT EXISTS idx_vectors_user ON vectors(user_id)`,
        `CREATE TABLE IF NOT EXISTS waypoints_new (
    src_id TEXT, dst_id TEXT NOT NULL, user_id TEXT,
    weight REAL NOT NULL, created_at INTEGER, updated_at INTEGER,
    PRIMARY KEY(src_id, user_id)
  )`,
        `INSERT INTO waypoints_new SELECT src_id, dst_id, NULL, weight, created_at, updated_at FROM waypoints`,
        `DROP TABLE waypoints`,
        `ALTER TABLE waypoints_new RENAME TO waypoints`,
        `CREATE INDEX IF NOT EXISTS idx_waypoints_src ON waypoints(src_id)`,
        `CREATE INDEX IF NOT EXISTS idx_waypoints_dst ON waypoints(dst_id)`,
        `CREATE INDEX IF NOT EXISTS idx_waypoints_user ON waypoints(user_id)`,
        `CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY, summary TEXT,
    reflection_count INTEGER DEFAULT 0,
    created_at INTEGER, updated_at INTEGER
  )`,
        `CREATE TABLE IF NOT EXISTS stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL, count INTEGER DEFAULT 1, ts INTEGER NOT NULL
  )`,
        `CREATE INDEX IF NOT EXISTS idx_stats_ts ON stats(ts)`,
        `CREATE INDEX IF NOT EXISTS idx_stats_type ON stats(type)`,
    ],
    postgres: [
        `ALTER TABLE {m} ADD COLUMN IF NOT EXISTS user_id TEXT`,
        `CREATE INDEX IF NOT EXISTS openmemory_memories_user_idx ON {m}(user_id)`,
        `ALTER TABLE {v} ADD COLUMN IF NOT EXISTS user_id TEXT`,
        `CREATE INDEX IF NOT EXISTS openmemory_vectors_user_idx ON {v}(user_id)`,
        `ALTER TABLE {w} ADD COLUMN IF NOT EXISTS user_id TEXT`,
        `ALTER TABLE {w} DROP CONSTRAINT IF EXISTS waypoints_pkey`,
        `ALTER TABLE {w} ADD PRIMARY KEY (src_id, user_id)`,
        `CREATE INDEX IF NOT EXISTS openmemory_waypoints_user_idx ON {w}(user_id)`,
        `CREATE TABLE IF NOT EXISTS {u} (
    user_id TEXT PRIMARY KEY, summary TEXT,
    reflection_count INTEGER DEFAULT 0,
    created_at BIGINT, updated_at BIGINT
  )`,
        `CREATE TABLE IF NOT EXISTS {s} (
    id SERIAL PRIMARY KEY,
    type TEXT NOT NULL, count INTEGER DEFAULT 1, ts BIGINT NOT NULL
  )`,
        `CREATE INDEX IF NOT EXISTS openmemory_stats_ts_idx ON {s}(ts)`,
        `CREATE INDEX IF NOT EXISTS openmemory_stats_type_idx ON {s}(type)`,
    ],
};
