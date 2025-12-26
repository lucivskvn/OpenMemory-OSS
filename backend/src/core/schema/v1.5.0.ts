import { Migration } from "./migration_types";

export const v1_5_0: Migration = {
    version: "1.5.0",
    desc: "Update waypoints primary key to allow multiple outgoing edges",
    sqlite: [
        // SQLite doesn't support dropping constraints easily, so we have to recreate the table
        `CREATE TABLE IF NOT EXISTS waypoints_new (src_id TEXT, dst_id TEXT NOT NULL, user_id TEXT, weight REAL NOT NULL, created_at INTEGER, updated_at INTEGER, PRIMARY KEY(src_id, dst_id))`,
        `INSERT OR IGNORE INTO waypoints_new SELECT src_id, dst_id, user_id, weight, created_at, updated_at FROM waypoints`,
        `DROP TABLE waypoints`,
        `ALTER TABLE waypoints_new RENAME TO waypoints`,
        `CREATE INDEX IF NOT EXISTS idx_waypoints_src ON waypoints(src_id)`,
        `CREATE INDEX IF NOT EXISTS idx_waypoints_dst ON waypoints(dst_id)`,
        `CREATE INDEX IF NOT EXISTS idx_waypoints_user ON waypoints(user_id)`,
    ],
    postgres: [
        // Using "IF EXISTS" to be safe against re-runs (though migrations logic handles versioning)
        // PostgreSQL constraint names are usually formatted as tablename_pkey
        // We need to drop the old primary key constraint first
        `ALTER TABLE {w} DROP CONSTRAINT IF EXISTS openmemory_waypoints_pkey`,
        // Deduplicate before adding new PK to prevent migration failure
        `DELETE FROM {w} a USING {w} b WHERE a.ctid < b.ctid AND a.src_id = b.src_id AND a.dst_id = b.dst_id`,
        `ALTER TABLE {w} ADD PRIMARY KEY (src_id, dst_id)`,
    ],
};
