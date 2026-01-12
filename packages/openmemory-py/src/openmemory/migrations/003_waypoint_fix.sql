-- 003_waypoint_fix.sql
CREATE TABLE IF NOT EXISTS {w}_v2 (
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
    OR IGNORE INTO {w}_v2
SELECT src_id,
    dst_id,
    dst_sector,
    user_id,
    weight,
    created_at,
    updated_at
FROM {w};
DROP TABLE {w};
ALTER TABLE {w}_v2
    RENAME TO {w};
CREATE INDEX IF NOT EXISTS idx_waypoints_src ON {w}(src_id);
CREATE INDEX IF NOT EXISTS idx_waypoints_dst ON {w}(dst_id);
CREATE INDEX IF NOT EXISTS idx_waypoints_user ON {w}(user_id);