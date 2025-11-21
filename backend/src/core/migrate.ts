import { env } from "./cfg";
// NOTE: This legacy helper historically imported `sqlite3` statically which
// caused runtime errors for environments that don't have the native
// `sqlite3` module installed. We now dynamically load `sqlite3` only when
// needed and provide a clear error message if it's missing. The canonical
// migration CLI runner is `backend/src/migrate.ts` (see repo root docs).
import { initDb, run_async, all_async } from "./db";
import logger from "./logger";

const is_pg = env.metadata_backend === "postgres";

const log = (msg: string) => {
    if (env.log_migrate) logger.info({ component: "MIGRATE" }, "[MIGRATE] %s", msg);
};

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
];

async function get_db_version_sqlite(db: any): Promise<string | null> {
    return new Promise((ok, no) => {
        db.get(
            `SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'`,
            (err: any, row: any) => {
                if (err) return no(err);
                if (!row) return ok(null);
                db.get(
                    `SELECT version FROM schema_version ORDER BY applied_at DESC LIMIT 1`,
                    (e: any, v: any) => {
                        if (e) return no(e);
                        ok(v?.version || null);
                    },
                );
            },
        );
    });
}

async function set_db_version_sqlite(db: any, version: string): Promise<void> {
    return new Promise((ok, no) => {
        db.run(
            `CREATE TABLE IF NOT EXISTS schema_version (
        version TEXT PRIMARY KEY, applied_at INTEGER
      )`,
            (err: any) => {
                if (err) return no(err);
                db.run(
                    `INSERT OR REPLACE INTO schema_version VALUES (?, ?)`,
                    [version, Date.now()],
                    (e: any) => {
                        if (e) return no(e);
                        ok();
                    },
                );
            },
        );
    });
}

async function check_column_exists_sqlite(db: any, table: string, column: string): Promise<boolean> {
    return new Promise((ok, no) => {
        db.all(`PRAGMA table_info(${table})`, (err: any, rows: any[]) => {
            if (err) return no(err);
            ok(rows.some((r: any) => r.name === column));
        });
    });
}

async function run_sqlite_migration(db: any, m: Migration): Promise<void> {
    log(`Running migration: ${m.version} - ${m.desc}`);

    const has_user_id = await check_column_exists_sqlite(
        db,
        "memories",
        "user_id",
    );
    if (has_user_id) {
        log(`Migration ${m.version} already applied (user_id exists), skipping`);
        await set_db_version_sqlite(db, m.version);
        return;
    }

    for (const sql of m.sqlite) {
        await new Promise<void>((ok, no) => {
            db.run(sql, (err: any) => {
                if (err && !err.message.includes("duplicate column")) {
                    logger.error({ component: "MIGRATE", error_code: 'migrate_sql_error', err }, "[MIGRATE] SQL error: %o", err);
                    return no(err);
                }
                ok();
            });
        });
    }

    await set_db_version_sqlite(db, m.version);
    log(`Migration ${m.version} completed successfully`);
}

async function get_db_version_pg(): Promise<string | null> {
    try {
        const sc = process.env.OM_PG_SCHEMA || "public";
        const check = await all_async(
            `SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = $1 AND table_name = 'schema_version'
      )`,
            [sc],
        );
        if (!check || !check[0] || !check[0].exists) return null;

        const ver = await all_async(
            `SELECT version FROM "${sc}"."schema_version" ORDER BY applied_at DESC LIMIT 1`,
        );
        return ver[0]?.version || null;
    } catch (e) {
        return null;
    }
}

async function set_db_version_pg(version: string): Promise<void> {
    const sc = process.env.OM_PG_SCHEMA || "public";
    await run_async(
        `CREATE TABLE IF NOT EXISTS "${sc}"."schema_version" (
      version TEXT PRIMARY KEY, applied_at BIGINT
    )`,
    );
    await run_async(
        `INSERT INTO "${sc}"."schema_version" VALUES ($1, $2) 
     ON CONFLICT (version) DO UPDATE SET applied_at = EXCLUDED.applied_at`,
        [version, Date.now()],
    );
}

async function check_column_exists_pg(
    table: string,
    column: string,
): Promise<boolean> {
    const sc = process.env.OM_PG_SCHEMA || "public";
    const tbl = table.replace(/"/g, "").split(".").pop() || table;
    const res = await all_async(
        `SELECT EXISTS (
      SELECT FROM information_schema.columns 
      WHERE table_schema = $1 AND table_name = $2 AND column_name = $3
    )`,
        [sc, tbl, column],
    );
    return !!(res && res[0] && res[0].exists);
}

async function run_pg_migration(m: Migration): Promise<void> {
    log(`Running migration: ${m.version} - ${m.desc}`);

    const sc = process.env.OM_PG_SCHEMA || "public";
    const mt = process.env.OM_PG_TABLE || "openmemory_memories";
    const has_user_id = await check_column_exists_pg(mt, "user_id");

    if (has_user_id) {
        log(`Migration ${m.version} already applied (user_id exists), skipping`);
        await set_db_version_pg(m.version);
        return;
    }

    const replacements: Record<string, string> = {
        "{m}": `"${sc}"."${mt}"`,
        "{v}": `"${sc}"."${process.env.OM_VECTOR_TABLE || "openmemory_vectors"}"`,
        "{w}": `"${sc}"."openmemory_waypoints"`,
        "{u}": `"${sc}"."openmemory_users"`,
    };

    for (let sql of m.postgres) {
        for (const [k, v] of Object.entries(replacements)) {
            sql = sql.replace(new RegExp(k, "g"), v);
        }

        try {
            await run_async(sql);
        } catch (e: any) {
            if (
                !e.message.includes("already exists") &&
                !e.message.includes("duplicate")
            ) {
                logger.error({ component: "MIGRATE", error_code: 'migrate_pg_error', err: e }, "[MIGRATE] PG error: %o", e);
                throw e;
            }
        }
    }

    await set_db_version_pg(m.version);
    log(`Migration ${m.version} completed successfully`);
}

export async function run_migrations() {
    log("Checking for pending migrations...");

    if (is_pg) {
        // Initialize DB helpers (this will use Bun Postgres client when
        // OM_METADATA_BACKEND=postgres). We rely on the exported async
        // helpers from ./db so migrations run under the same client.
        await initDb();

        const current = await get_db_version_pg();
        log(`Current database version: ${current || "none"}`);

        for (const m of migrations) {
            if (!current || m.version > current) {
                await run_pg_migration(m);
            }
        }
    } else {
        const db_path = process.env.OM_DB_PATH || "./data/openmemory.sqlite";
        // Dynamically load sqlite3 so the module import doesn't fail on runtimes
        // that don't ship the node-sqlite3 C extension (CI, Bun-native,
        // contributor machines without sqlite3). If sqlite3 is unavailable we
        // surface a clear error and instruct the operator to use the canonical
        // runner `backend/src/migrate.ts` instead or install sqlite3.
        let sqlite3: any;
        try {
            // dynamic import to avoid hard dependency at module-load time
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            sqlite3 = await import("sqlite3");
        } catch (e) {
            logger.error({ component: "MIGRATE", error_code: 'migrate_sqlite3_missing', err: e }, "[MIGRATE] sqlite3 module not available. This legacy migration helper requires the 'sqlite3' package. Prefer running `bun src/migrate.ts` from the backend directory which uses Bun-friendly migrations, or install sqlite3 in this environment.");
            throw new Error("sqlite3 module not available. Use backend/src/migrate.ts or install sqlite3 to run this helper.");
        }

        const db = new sqlite3.Database(db_path);

        const current = await get_db_version_sqlite(db);
        log(`Current database version: ${current || "none"}`);

        for (const m of migrations) {
            if (!current || m.version > current) {
                await run_sqlite_migration(db, m);
            }
        }

        await new Promise<void>((ok) => db.close(() => ok()));
    }

    log("All migrations completed");
}
