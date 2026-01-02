-- 003_waypoint_fix.sql
CREATE TABLE IF NOT EXISTS waypoints_v2 (
    src_id TEXT,
    dst_id TEXT,
    dst_sector TEXT,
    user_id TEXT,
    weight REAL,
    created_at INTEGER,
    updated_at INTEGER,
    PRIMARY KEY (src_id, dst_id, user_id)
);
INSERT
    OR IGNORE INTO waypoints_v2
SELECT src_id,
    dst_id,
    dst_sector,
    user_id,
    weight,
    created_at,
    updated_at
FROM waypoints;
DROP TABLE waypoints;
ALTER TABLE waypoints_v2
    RENAME TO waypoints;
CREATE INDEX IF NOT EXISTS idx_waypoints_src ON waypoints(src_id);
CREATE INDEX IF NOT EXISTS idx_waypoints_dst ON waypoints(dst_id);
CREATE INDEX IF NOT EXISTS idx_waypoints_user ON waypoints(user_id);