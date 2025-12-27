import { Migration } from "./migration_types";

export const v1_7_0: Migration = {
    version: "1.7.0",
    desc: "Fix waypoint primary key and add missing indexes for multi-tenant isolation",
    sqlite: [
        // SQLite doesn't support altering primary keys, so we need to recreate the table
        `CREATE TABLE IF NOT EXISTS waypoints_new(
            src_id text,
            dst_id text not null,
            user_id text,
            weight real not null,
            created_at integer,
            updated_at integer,
            primary key(src_id,dst_id,user_id)
        )`,
        `INSERT OR IGNORE INTO waypoints_new SELECT * FROM waypoints`,
        `DROP TABLE waypoints`,
        `ALTER TABLE waypoints_new RENAME TO waypoints`,
        `CREATE INDEX IF NOT EXISTS idx_waypoints_src ON waypoints(src_id)`,
        `CREATE INDEX IF NOT EXISTS idx_waypoints_dst ON waypoints(dst_id)`,
        `CREATE INDEX IF NOT EXISTS idx_waypoints_user ON waypoints(user_id)`,
        `CREATE INDEX IF NOT EXISTS idx_waypoints_src_user ON waypoints(src_id,user_id)`,
    ],
    postgres: [
        // Postgres: Drop old constraint and add new one
        `ALTER TABLE {w} DROP CONSTRAINT IF EXISTS waypoints_pkey`,
        `ALTER TABLE {w} DROP CONSTRAINT IF EXISTS openmemory_waypoints_pkey`,
        `ALTER TABLE {w} ADD PRIMARY KEY (src_id, dst_id, user_id)`,
        `CREATE INDEX IF NOT EXISTS openmemory_waypoints_src_idx ON {w}(src_id)`,
        `CREATE INDEX IF NOT EXISTS openmemory_waypoints_dst_idx ON {w}(dst_id)`,
        `CREATE INDEX IF NOT EXISTS openmemory_waypoints_user_idx ON {w}(user_id)`,
        `CREATE INDEX IF NOT EXISTS openmemory_waypoints_src_user_idx ON {w}(src_id,user_id)`,
    ],
};
