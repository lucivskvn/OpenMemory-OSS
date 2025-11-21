#!/usr/bin/env node
import { initDb, run_async, all_async } from "./core/db";
import { env } from "./core/cfg";
import logger from "./core/logger";

// Test seam: allow deterministic capture of migration logs in tests.
export const __TEST: {
    logHook?:
        | ((level: string, meta: any, msg: string, ...args: any[]) => void)
        | null;
    reset?: () => void;
} = {
    logHook: null,
    reset() {
        this.logHook = null;
    },
};

function migrateLog(
    level: "debug" | "info" | "warn" | "error",
    meta: any,
    msg: string,
    ...args: any[]
) {
    try {
        const hook = (__TEST as any)?.logHook;
        if (typeof hook === "function") {
            try {
                hook(level, meta, msg, ...args);
            } catch (_e) {}
        }
    } catch (_e) {}
    const fn = (logger as any)[level] || logger.info;
    fn.call(logger, meta, msg, ...args);
}

const SCHEMA_DEFINITIONS = {
    memories: `create table if not exists memories(id text primary key,user_id text,segment integer default 0,content text not null,simhash text,primary_sector text not null,tags text,meta text,created_at integer,updated_at integer,last_seen_at integer,salience real,decay_lambda real,version integer default 1,mean_dim integer,mean_vec blob,compressed_vec blob,feedback_score real default 0)`,
    vectors: `create table if not exists vectors(id text not null,sector text not null,user_id text,v blob not null,dim integer not null,primary key(id,sector,user_id))`,
    waypoints: `create table if not exists waypoints(src_id text,dst_id text not null,user_id text,weight real not null,created_at integer,updated_at integer,primary key(src_id,user_id))`,
    embed_logs: `create table if not exists embed_logs(id text primary key,model text,status text,ts integer,err text)`,
    users: `create table if not exists users(user_id text primary key,summary text,reflection_count integer default 0,created_at integer,updated_at integer)`,
    stats: `create table if not exists stats(id integer primary key autoincrement,type text not null,count integer default 1,ts integer not null)`,
    temporal_facts: `create table if not exists temporal_facts(id text primary key,subject text not null,predicate text not null,object text not null,valid_from integer not null,valid_to integer,confidence real not null check(confidence >= 0 and confidence <= 1),last_updated integer not null,metadata text,unique(subject,predicate,object,valid_from))`,
    temporal_edges: `create table if not exists temporal_edges(id text primary key,source_id text not null,target_id text not null,relation_type text not null,valid_from integer not null,valid_to integer,weight real not null,metadata text,foreign key(source_id) references temporal_facts(id),foreign key(target_id) references temporal_facts(id))`,
    stream_telemetry: `create table if not exists stream_telemetry(id text primary key,user_id text,embedding_mode text,duration_ms integer,memory_ids text,query text,ts integer)`,
};

const INDEX_DEFINITIONS = [
    "create index if not exists idx_memories_sector on memories(primary_sector)",
    "create index if not exists idx_memories_segment on memories(segment)",
    "create index if not exists idx_memories_simhash on memories(simhash)",
    "create index if not exists idx_memories_ts on memories(last_seen_at)",
    "create index if not exists idx_memories_user on memories(user_id)",
    "create index if not exists idx_vectors_user on vectors(user_id)",
    "create index if not exists idx_waypoints_src on waypoints(src_id)",
    "create index if not exists idx_waypoints_dst on waypoints(dst_id)",
    "create index if not exists idx_waypoints_user on waypoints(user_id)",
    "create index if not exists idx_stats_ts on stats(ts)",
    "create index if not exists idx_stats_type on stats(type)",
    "create index if not exists idx_temporal_subject on temporal_facts(subject)",
    "create index if not exists idx_temporal_predicate on temporal_facts(predicate)",
    "create index if not exists idx_temporal_validity on temporal_facts(valid_from,valid_to)",
    "create index if not exists idx_temporal_composite on temporal_facts(subject,predicate,valid_from,valid_to)",
    "create index if not exists idx_edges_source on temporal_edges(source_id)",
    "create index if not exists idx_edges_target on temporal_edges(target_id)",
    "create index if not exists idx_edges_validity on temporal_edges(valid_from,valid_to)",
    "create index if not exists idx_stream_telemetry_ts on stream_telemetry(ts)",
];

async function get_existing_tables(): Promise<Set<string>> {
    const tables = await all_async(
        `SELECT name FROM sqlite_master WHERE type='table'`,
    );
    return new Set(tables.map((t) => t.name));
}

async function get_existing_indexes(): Promise<Set<string>> {
    const indexes = await all_async(
        `SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'`,
    );
    return new Set(indexes.map((i) => i.name));
}

export async function run_migrations() {
    if (env.log_migrate)
        logger.info(
            { component: "MIGRATE" },
            "[MIGRATE] Starting automatic migration...",
        );

    // If the metadata backend is Postgres, avoid running SQLite-specific
    // migrations here. Postgres DDL differs from the SQLite schema above
    // (types, serial/autoincrement, bytea, etc.). Operators using Postgres
    // should run Postgres-compatible migrations outside this script or
    // provide a Postgres migration implementation. Skipping avoids
    // accidental attempts to query sqlite_master on Postgres.
    if (env.metadata_backend === "postgres") {
        if (env.log_migrate)
            logger.info(
                { component: "MIGRATE" },
                "[MIGRATE] OM_METADATA_BACKEND=postgres detected, skipping SQLite-style migrations. Ensure Postgres migrations are applied separately.",
            );
        return;
    }

    // Ensure DB helpers are initialized. `initDb()` sets up run_async/all_async
    // when invoked; callers may import this module before DB init, so guard
    // and initialize here if necessary.
    try {
        if (
            typeof run_async !== "function" ||
            typeof all_async !== "function"
        ) {
            await initDb();
        }
    } catch (e) {
        logger.error(
            { component: "MIGRATE", error_code: "migrate_init_failed", err: e },
            "[MIGRATE] Failed to initialize DB helpers: %o",
            e,
        );
        throw e;
    }

    const existing_tables = await get_existing_tables();
    const existing_indexes = await get_existing_indexes();

    let created_tables = 0;
    let created_indexes = 0;

    for (const [table_name, schema] of Object.entries(SCHEMA_DEFINITIONS)) {
        if (!existing_tables.has(table_name)) {
            if (env.log_migrate)
                logger.info(
                    { component: "MIGRATE", table: table_name },
                    `[MIGRATE] Creating table: ${table_name}`,
                );
            const statements = schema.split(";").filter((s) => s.trim());
            for (const stmt of statements) {
                if (stmt.trim()) {
                    await run_async(stmt.trim());
                }
            }
            created_tables++;
        }
    }

    for (const index_sql of INDEX_DEFINITIONS) {
        const match = index_sql.match(/create index if not exists (\w+)/);
        const index_name = match ? match[1] : null;
        if (index_name && !existing_indexes.has(index_name)) {
            if (env.log_migrate)
                logger.info(
                    { component: "MIGRATE", index: index_name },
                    `[MIGRATE] Creating index: ${index_name}`,
                );
            await run_async(index_sql);
            created_indexes++;
        }
    }

    if (env.log_migrate)
        logger.info(
            { component: "MIGRATE", created_tables, created_indexes },
            `[MIGRATE] Migration complete: ${created_tables} tables, ${created_indexes} indexes created`,
        );

    const final_tables = await get_existing_tables();
    if (env.log_migrate)
        logger.info(
            { component: "MIGRATE", total_tables: final_tables.size },
            `[MIGRATE] Total tables: ${final_tables.size}`,
        );
    if (env.log_migrate)
        logger.info(
            { component: "MIGRATE", tables: Array.from(final_tables) },
            `[MIGRATE] Tables: ${Array.from(final_tables).join(", ")}`,
        );

    // Post-migration verification: ensure multi-tenant columns and indexes exist
    try {
        const requiredTablesWithUserCol = ["memories", "vectors", "waypoints"];
        for (const t of requiredTablesWithUserCol) {
            const cols = await all_async(`PRAGMA table_info(${t})`);
            const hasUser =
                Array.isArray(cols) &&
                cols.some((c: any) => c && c.name === "user_id");
            if (!hasUser) {
                throw new Error(
                    `[MIGRATE] verification failed: table ${t} missing user_id column`,
                );
            }
        }

        const existingIndexes = await get_existing_indexes();
        const requiredIndexes = [
            "idx_memories_user",
            "idx_vectors_user",
            "idx_waypoints_user",
        ];
        for (const idx of requiredIndexes) {
            if (!existingIndexes.has(idx)) {
                throw new Error(
                    `[MIGRATE] verification failed: missing index ${idx}`,
                );
            }
        }

        if (env.log_migrate)
            logger.info({ component: "MIGRATE" }, "[MIGRATE] verification ok");
    } catch (e) {
        logger.error(
            {
                component: "MIGRATE",
                error_code: "migrate_verification_failed",
                err: e,
            },
            "[MIGRATE] verification failed: %o",
            e,
        );
        throw e;
    }
}

// If this module is executed directly (CLI), run migrations and exit with
// appropriate status. When imported, callers can explicitly call and await
// `run_migrations()` to ensure migrations complete before proceeding.
// If this file is executed directly (e.g. `node migrate.js` or `bun run`),
// run migrations and exit with an appropriate status code. We avoid
// top-level await and import.meta checks to remain compatible with the
// project's TS compilation settings; instead inspect process.argv.
try {
    const maybeScript =
        typeof process !== "undefined" &&
        process.argv &&
        process.argv[1] &&
        /migrate(\.ts|\.js)$/.test(process.argv[1]);
    if (maybeScript) {
        run_migrations()
            .then(() => process.exit(0))
            .catch((err) => {
                logger.error(
                    { component: "MIGRATE", err },
                    "[MIGRATE] Error: %o",
                    err,
                );
                process.exit(1);
            });
    }
} catch (e) {
    // defensive: if anything goes wrong inspecting argv, do not crash on import
}
