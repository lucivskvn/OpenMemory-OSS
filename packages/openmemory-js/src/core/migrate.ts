import { env } from "./cfg";
import { Database } from "bun:sqlite";
import { Pool } from "pg";

const is_pg = env.metadata_backend === "postgres";

const log = (msg: string) => console.log(`[MIGRATE] ${msg}`);

interface Migration {
    version: string;
    desc: string;
    sqlite: string[];
    postgres: string[];
}

const migrations: Migration[] = [
    {
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
        ],
    },
    {
        version: "1.3.0",
        desc: "Temporal Graph user_id support",
        sqlite: [
            `ALTER TABLE temporal_facts ADD COLUMN user_id TEXT`,
            `CREATE INDEX IF NOT EXISTS idx_temporal_facts_user ON temporal_facts(user_id)`,
            `ALTER TABLE temporal_edges ADD COLUMN user_id TEXT`,
            `CREATE INDEX IF NOT EXISTS idx_temporal_edges_user ON temporal_edges(user_id)`,
        ],
        postgres: [
            `ALTER TABLE {sc}.temporal_facts ADD COLUMN IF NOT EXISTS user_id TEXT`,
            `CREATE INDEX IF NOT EXISTS temporal_facts_user_idx ON {sc}.temporal_facts(user_id)`,
            `ALTER TABLE {sc}.temporal_edges ADD COLUMN IF NOT EXISTS user_id TEXT`,
            `CREATE INDEX IF NOT EXISTS temporal_edges_user_idx ON {sc}.temporal_edges(user_id)`,
        ],
    },
    {
        version: "1.4.0",
        desc: "Fixed waypoint primary key and cascading deletions support",
        sqlite: [
            `CREATE TABLE IF NOT EXISTS waypoints_v2 (
                src_id TEXT, dst_id TEXT NOT NULL, user_id TEXT,
                weight REAL NOT NULL, created_at INTEGER, updated_at INTEGER,
                PRIMARY KEY(src_id, dst_id, user_id)
            )`,
            `INSERT OR IGNORE INTO waypoints_v2 SELECT * FROM waypoints`,
            `DROP TABLE waypoints`,
            `ALTER TABLE waypoints_v2 RENAME TO waypoints`,
            `CREATE INDEX IF NOT EXISTS idx_waypoints_src ON waypoints(src_id)`,
            `CREATE INDEX IF NOT EXISTS idx_waypoints_dst ON waypoints(dst_id)`,
            `CREATE INDEX IF NOT EXISTS idx_waypoints_user ON waypoints(user_id)`,
        ],
        postgres: [
            `ALTER TABLE {w} DROP CONSTRAINT IF EXISTS waypoints_pkey`,
            `ALTER TABLE {w} ADD PRIMARY KEY (src_id, dst_id, user_id)`,
        ],
    },
];

function get_db_version_sqlite(db: Database): string | null {
    try {
        const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'`).get() as any;
        if (!row) return null;
        const ver = db.prepare(`SELECT version FROM schema_version ORDER BY applied_at DESC LIMIT 1`).get() as any;
        return ver?.version || null;
    } catch (e) {
        return null;
    }
}

function set_db_version_sqlite(db: Database, version: string): void {
    db.run(`CREATE TABLE IF NOT EXISTS schema_version (
        version TEXT PRIMARY KEY, applied_at INTEGER
      )`);
    db.prepare(`INSERT OR REPLACE INTO schema_version VALUES (?, ?)`).run(version, Date.now());
}

function check_column_exists_sqlite(
    db: Database,
    table: string,
    column: string,
): boolean {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as any[];
    return rows.some((r) => r.name === column);
}

async function run_sqlite_migration(
    db: Database,
    m: Migration,
): Promise<void> {
    log(`Running migration: ${m.version} - ${m.desc}`);

    const has_user_id = check_column_exists_sqlite(
        db,
        "memories",
        "user_id",
    );
    if (has_user_id && m.version === "1.2.0") {
        // Specifically for 1.2.0 which added user_id, skip if it exists.
        // For other migrations, we rely on schema_version check in run_migrations
        log(
            `Migration ${m.version} already applied (user_id exists), skipping`,
        );
        set_db_version_sqlite(db, m.version);
        return;
    }

    // Bun's sqlite is synchronous, but we can wrap in transaction
    const transaction = db.transaction(() => {
        for (const sql of m.sqlite) {
            try {
                db.run(sql);
            } catch (err: any) {
                if (!err.message.includes("duplicate column")) {
                    log(`ERROR: ${err.message}`);
                    throw err;
                }
            }
        }
    });

    transaction();

    set_db_version_sqlite(db, m.version);
    log(`Migration ${m.version} completed successfully`);
}

async function get_db_version_pg(pool: Pool): Promise<string | null> {
    try {
        const sc = process.env.OM_PG_SCHEMA || "public";
        const check = await pool.query(
            `SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = $1 AND table_name = 'schema_version'
      )`,
            [sc],
        );
        if (!check.rows[0].exists) return null;

        const ver = await pool.query(
            `SELECT version FROM "${sc}"."schema_version" ORDER BY applied_at DESC LIMIT 1`,
        );
        return ver.rows[0]?.version || null;
    } catch (e) {
        return null;
    }
}

async function set_db_version_pg(pool: Pool, version: string): Promise<void> {
    const sc = process.env.OM_PG_SCHEMA || "public";
    await pool.query(
        `CREATE TABLE IF NOT EXISTS "${sc}"."schema_version" (
      version TEXT PRIMARY KEY, applied_at BIGINT
    )`,
    );
    await pool.query(
        `INSERT INTO "${sc}"."schema_version" VALUES ($1, $2) 
     ON CONFLICT (version) DO UPDATE SET applied_at = EXCLUDED.applied_at`,
        [version, Date.now()],
    );
}

async function check_column_exists_pg(
    pool: Pool,
    table: string,
    column: string,
): Promise<boolean> {
    const sc = process.env.OM_PG_SCHEMA || "public";
    const tbl = table.replace(/"/g, "").split(".").pop() || table;
    const res = await pool.query(
        `SELECT EXISTS (
       SELECT FROM information_schema.columns 
       WHERE table_schema = $1 AND table_name = $2 AND column_name = $3
     )`,
        [sc, tbl, column],
    );
    return res.rows[0].exists;
}

async function run_pg_migration(pool: Pool, m: Migration): Promise<void> {
    log(`Running migration: ${m.version} - ${m.desc}`);

    const sc = process.env.OM_PG_SCHEMA || "public";
    const mt = process.env.OM_PG_TABLE || "openmemory_memories";
    const has_user_id = await check_column_exists_pg(pool, mt, "user_id");

    if (has_user_id && m.version === "1.2.0") {
        log(
            `Migration ${m.version} already applied (user_id exists), skipping`,
        );
        await set_db_version_pg(pool, m.version);
        return;
    }

    const replacements: Record<string, string> = {
        "{m}": `"${sc}"."${mt}"`,
        "{v}": `"${sc}"."${process.env.OM_VECTOR_TABLE || "openmemory_vectors"}"`,
        "{w}": `"${sc}"."openmemory_waypoints"`,
        "{u}": `"${sc}"."openmemory_users"`,
        "{sc}": `"${sc}"`,
    };

    for (let sql of m.postgres) {
        for (const [k, v] of Object.entries(replacements)) {
            sql = sql.replace(new RegExp(k, "g"), v);
        }

        try {
            await pool.query(sql);
        } catch (e: any) {
            if (
                !e.message.includes("already exists") &&
                !e.message.includes("duplicate")
            ) {
                log(`ERROR: ${e.message}`);
                throw e;
            }
        }
    }

    await set_db_version_pg(pool, m.version);
    log(`Migration ${m.version} completed successfully`);
}

/**
 * Runs pending database migrations for SQLite or PostgreSQL.
 * Automatically detects the backend based on environment variables.
 * Checks schema version table and applies new migrations transactionally.
 */
export async function run_migrations() {
    log("Checking for pending migrations...");

    if (is_pg) {
        const ssl =
            process.env.OM_PG_SSL === "require"
                ? { rejectUnauthorized: false }
                : process.env.OM_PG_SSL === "disable"
                    ? false
                    : undefined;

        const pool = new Pool({
            host: process.env.OM_PG_HOST,
            port: process.env.OM_PG_PORT ? +process.env.OM_PG_PORT : undefined,
            database: process.env.OM_PG_DB || "openmemory",
            user: process.env.OM_PG_USER,
            password: process.env.OM_PG_PASSWORD,
            ssl,
        });

        const current = await get_db_version_pg(pool);
        log(`Current database version: ${current || "none"}`);

        for (const m of migrations) {
            if (!current || m.version > current) {
                await run_pg_migration(pool, m);
            }
        }

        await pool.end();
    } else {
        const db_path = process.env.OM_DB_PATH || "./data/openmemory.sqlite";
        const db = new Database(db_path);

        const current = get_db_version_sqlite(db);
        log(`Current database version: ${current || "none"}`);

        for (const m of migrations) {
            if (!current || m.version > current) {
                await run_sqlite_migration(db, m);
            }
        }

        db.close();
    }

    log("All migrations completed");
}
