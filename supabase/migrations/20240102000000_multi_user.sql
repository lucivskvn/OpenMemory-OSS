-- Multi-user tenant support
ALTER TABLE openmemory_memories ADD COLUMN IF NOT EXISTS user_id TEXT;
CREATE INDEX IF NOT EXISTS openmemory_memories_user_idx ON openmemory_memories(user_id);
ALTER TABLE openmemory_vectors ADD COLUMN IF NOT EXISTS user_id TEXT;
CREATE INDEX IF NOT EXISTS openmemory_vectors_user_idx ON openmemory_vectors(user_id);
ALTER TABLE openmemory_waypoints ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE openmemory_waypoints DROP CONSTRAINT IF EXISTS waypoints_pkey;
ALTER TABLE openmemory_waypoints ADD PRIMARY KEY (src_id, user_id);
CREATE INDEX IF NOT EXISTS openmemory_waypoints_user_idx ON openmemory_waypoints(user_id);
CREATE TABLE IF NOT EXISTS openmemory_users (
    user_id TEXT PRIMARY KEY, summary TEXT,
    reflection_count INTEGER DEFAULT 0,
    created_at BIGINT, updated_at BIGINT
);
CREATE TABLE IF NOT EXISTS stats (
    id SERIAL PRIMARY KEY,
    type TEXT NOT NULL, count INTEGER DEFAULT 1, ts BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS openmemory_stats_ts_idx ON stats(ts);
CREATE INDEX IF NOT EXISTS openmemory_stats_type_idx ON stats(type);
