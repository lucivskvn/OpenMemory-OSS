import { migrations, get_initial_schema_pg, get_initial_schema_sqlite } from "./schema";
import { DbOps } from "./schema/initial"; // DbOps is defined there
import { log } from "./log";

async function get_db_version(ops: DbOps): Promise<string | null> {
    if (ops.is_pg) {
        const sc = process.env.OM_PG_SCHEMA || "public";
        try {
            const check = await ops.get_async(
                `SELECT EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_schema = '${sc}' AND table_name = 'schema_version'
        ) as exists`
            );
             // pg returns { exists: true/false }
            if (!check || !check.exists) return null;

            const ver = await ops.get_async(
                `SELECT version FROM "${sc}"."schema_version" ORDER BY applied_at DESC LIMIT 1`
            );
            return ver?.version || null;
        } catch (e) {
            return null;
        }
    } else {
        try {
            const check = await ops.get_async(
                `SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'`
            );
            if (!check) return null;
            const ver = await ops.get_async(
                `SELECT version FROM schema_version ORDER BY applied_at DESC LIMIT 1`
            );
            return ver?.version || null;
        } catch (e) {
            return null;
        }
    }
}

async function set_db_version(ops: DbOps, version: string): Promise<void> {
    if (ops.is_pg) {
        const sc = process.env.OM_PG_SCHEMA || "public";
        await ops.run_async(
            `CREATE TABLE IF NOT EXISTS "${sc}"."schema_version" (
        version TEXT PRIMARY KEY, applied_at BIGINT
      )`
        );
        await ops.run_async(
            `INSERT INTO "${sc}"."schema_version" VALUES ($1, $2)
       ON CONFLICT (version) DO UPDATE SET applied_at = EXCLUDED.applied_at`,
            [version, Date.now()]
        );
    } else {
        await ops.run_async(
            `CREATE TABLE IF NOT EXISTS schema_version (
        version TEXT PRIMARY KEY, applied_at INTEGER
      )`
        );
        await ops.run_async(
            `INSERT OR REPLACE INTO schema_version VALUES (?, ?)`,
            [version, Date.now()]
        );
    }
}

async function check_table_exists(ops: DbOps, table_name: string): Promise<boolean> {
    if (ops.is_pg) {
        const sc = process.env.OM_PG_SCHEMA || "public";
        const tbl = table_name.replace(/"/g, "").split(".").pop() || table_name;
        const res = await ops.get_async(
            `SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = $1 AND table_name = $2
      ) as exists`,
            [sc, tbl]
        );
        return res?.exists;
    } else {
         const res = await ops.get_async(
            `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
            [table_name]
        );
        return !!res;
    }
}

export async function run_migrations_core(ops: DbOps) {
    log.info("[MIGRATE] Checking schema status...");

    let memories_table = "memories";
    if (ops.is_pg) {
        const sc = process.env.OM_PG_SCHEMA || "public";
        memories_table = `"${sc}"."${process.env.OM_PG_TABLE || "openmemory_memories"}"`;
    }

    const has_memories = await check_table_exists(ops, memories_table);

    const current_version = await get_db_version(ops);
    const latest_version = migrations.length > 0 ? migrations[migrations.length - 1].version : "0.0.0";

    if (!has_memories) {
        log.info("[MIGRATE] Fresh install detected. Initializing schema...");
        if (ops.is_pg) {
            const sc = process.env.OM_PG_SCHEMA || "public";
            const tables = {
                m: `"${sc}"."${process.env.OM_PG_TABLE || "openmemory_memories"}"`,
                v: `"${sc}"."${process.env.OM_VECTOR_TABLE || "openmemory_vectors"}"`,
                w: `"${sc}"."openmemory_waypoints"`,
                l: `"${sc}"."openmemory_embed_logs"`,
                u: `"${sc}"."openmemory_users"`,
                s: `"${sc}"."stats"`,
                tf: `"${sc}"."temporal_facts"`,
                te: `"${sc}"."temporal_edges"`,
            };
            for (const sql of get_initial_schema_pg(tables)) {
                await ops.run_async(sql);
            }
        } else {
            const vector_table = process.env.OM_VECTOR_TABLE || "vectors";
            for (const sql of get_initial_schema_sqlite(vector_table)) {
                await ops.run_async(sql);
            }
        }
        // Mark as latest version
        if (latest_version !== "0.0.0") {
             await set_db_version(ops, latest_version);
        }
        log.info(`[MIGRATE] Schema initialized to version ${latest_version}`);
        return;
    }

    // Existing installation
    log.info(`[MIGRATE] Current DB version: ${current_version || "legacy"}`);

    for (const m of migrations) {
        if (!current_version || m.version > current_version) {
            log.info(`[MIGRATE] Applying migration ${m.version}: ${m.desc}`);
            try {
                if (ops.is_pg) {
                    const sc = process.env.OM_PG_SCHEMA || "public";
                    const replacements: Record<string, string> = {
                        "{m}": `"${sc}"."${process.env.OM_PG_TABLE || "openmemory_memories"}"`,
                        "{v}": `"${sc}"."${process.env.OM_VECTOR_TABLE || "openmemory_vectors"}"`,
                        "{w}": `"${sc}"."openmemory_waypoints"`,
                        "{u}": `"${sc}"."openmemory_users"`,
                        "{s}": `"${sc}"."stats"`,
                        "{tf}": `"${sc}"."temporal_facts"`,
                        "{te}": `"${sc}"."temporal_edges"`,
                    };
                    for (let sql of m.postgres) {
                        for (const [k, v] of Object.entries(replacements)) {
                            sql = sql.replace(new RegExp(k, "g"), v);
                        }
                        await ops.run_async(sql);
                    }
                } else {
                    for (const sql of m.sqlite) {
                        try {
                             await ops.run_async(sql);
                        } catch (e: any) {
                            if (!e.message.includes("duplicate column")) {
                                throw e;
                            }
                        }
                    }
                }
                await set_db_version(ops, m.version);
            } catch (e) {
                log.error(`[MIGRATE] Migration ${m.version} failed:`, { error: e });
                throw e;
            }
        }
    }
    log.info("[MIGRATE] Schema is up to date.");
}
