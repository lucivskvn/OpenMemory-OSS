-- Migration to update waypoints table primary key to (src_id, dst_id, user_id)
-- to allow multiple destinations per source/user.

PRAGMA foreign_keys=OFF;

CREATE TABLE waypoints_new (
    src_id TEXT,
    dst_id TEXT NOT NULL,
    user_id TEXT,
    project_id TEXT,
    weight REAL NOT NULL,
    created_at INTEGER,
    updated_at INTEGER,
    PRIMARY KEY (src_id, dst_id, user_id)
);

INSERT INTO waypoints_new (src_id, dst_id, user_id, weight, created_at, updated_at)
SELECT src_id, dst_id, user_id, weight, created_at, updated_at FROM waypoints;

DROP TABLE waypoints;
ALTER TABLE waypoints_new RENAME TO waypoints;

PRAGMA foreign_keys=ON;
