-- 006_standardize_schema.sql
-- Align table names with JS Implementation

-- 1. Standardize Users Table (users -> openmemory_users)
CREATE TABLE IF NOT EXISTS openmemory_users (
    user_id TEXT PRIMARY KEY,
    summary TEXT,
    reflection_count INTEGER,
    created_at INTEGER,
    updated_at INTEGER
);

-- Copy data from old table if it exists
INSERT OR IGNORE INTO openmemory_users (user_id, summary, reflection_count, created_at, updated_at)
SELECT user_id, summary, reflection_count, created_at, updated_at
FROM users;

-- Drop old table
DROP TABLE IF EXISTS users;
