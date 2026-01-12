-- Migration: Learned Sector Classifier Models
-- Added: 2024-12-31
CREATE TABLE IF NOT EXISTS {lm} (
    user_id TEXT PRIMARY KEY,
    weights TEXT,
    -- JSON string of sector weights
    biases TEXT,
    -- JSON string of sector biases
    version INTEGER DEFAULT 1,
    updated_at BIGINT
);
-- Note: In PostgreSQL, BIGINT matches JS implementation. 
-- In SQLite, it will use INTEGER.