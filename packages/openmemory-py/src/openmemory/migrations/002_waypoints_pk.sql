-- Migration to update waypoints table primary key to (src_id, dst_id, user_id)
-- to allow multiple destinations per source/user.

PRAGMA foreign_keys=OFF;

CREATE TABLE waypoints_new (
    src_id TEXT NOT NULL,
    dst_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    project_id TEXT,
    weight REAL NOT NULL,
    created_at INTEGER,
    updated_at INTEGER,
    PRIMARY KEY (src_id, dst_id, user_id)
);

-- Backfill with coalesced values for NULL src_id and user_id to enforce NOT NULL constraint
INSERT INTO waypoints_new (src_id, dst_id, user_id, weight, created_at, updated_at)
SELECT
    COALESCE(src_id, 'unknown') as src_id,
    dst_id,
    COALESCE(user_id, 'anonymous') as user_id,
    weight,
    created_at,
    updated_at
FROM waypoints
WHERE dst_id IS NOT NULL;

DROP TABLE waypoints;
ALTER TABLE waypoints_new RENAME TO waypoints;

PRAGMA foreign_keys=ON;
