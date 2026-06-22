
import { env } from "./config";
import { createClient } from "@libsql/client";
import {
    assertSafeIdentifier,
    DEFAULT_VECTOR_TABLE,
    LEGACY_ORPHAN_TENANT,
} from "./identifiers";

const log = (msg: string) => console.log(`[MIGRATE] ${msg}`);

const explicit_vector_table = process.env.OM_VECTOR_TABLE;
const resolved_vector_table = assertSafeIdentifier(
    explicit_vector_table || DEFAULT_VECTOR_TABLE,
    "OM_VECTOR_TABLE"
);

// Connect to libSQL
const url = env.OM_TURSO_URL || `file:${env.db_path || "./data/openmemory.sqlite"}`;
const token = env.OM_TURSO_TOKEN;
const client = createClient({ url, authToken: token });

interface Migration {
    version: string;
    desc: string;
    sqlite: (vectorTable: string) => string[];
    }

const migrations: Migration[] = [
    {
        version: "1.2.0",
        desc: "Add version column to memories",
        sqlite: () => ["ALTER TABLE memories ADD COLUMN version integer default 1;"],

    },
    {
        version: "1.3.0",
        desc: "Add project_id column to core tables",
        sqlite: (vectorTable: string) => [
            "ALTER TABLE memories ADD COLUMN project_id text;",
            `ALTER TABLE ${vectorTable} ADD COLUMN project_id text;`,
            "ALTER TABLE waypoints ADD COLUMN project_id text;",
        ],

    },
    {
        version: "1.3.1",
        desc: "Add tags column to memories",
        sqlite: () => ["ALTER TABLE memories ADD COLUMN tags text;"],

    },
    {
        version: "1.4.0",
        desc: "Add temporal graph tables and stats",
        sqlite: () => [
            `create table if not exists temporal_facts(id text primary key,user_id text,project_id text,subject text not null,predicate text not null,object text not null,valid_from integer not null,valid_to integer,confidence real not null check(confidence >= 0 and confidence <= 1),last_updated integer not null,metadata text,unique(subject,predicate,object,valid_from));`,
            "create index if not exists idx_temporal_user on temporal_facts(user_id);",
            "create index if not exists idx_temporal_subject on temporal_facts(subject);",
            "create index if not exists idx_temporal_predicate on temporal_facts(predicate);",
            "create index if not exists idx_temporal_validity on temporal_facts(valid_from,valid_to);",
            "create index if not exists idx_temporal_composite on temporal_facts(subject,predicate,valid_from,valid_to);",
            `create table if not exists temporal_edges(id text primary key,source_id text not null,target_id text not null,relation_type text not null,valid_from integer not null,valid_to integer,weight real not null,metadata text,foreign key(source_id) references temporal_facts(id),foreign key(target_id) references temporal_facts(id));`,
            "create index if not exists idx_edges_source on temporal_edges(source_id);",
            "create index if not exists idx_edges_target on temporal_edges(target_id);",
            "create index if not exists idx_edges_validity on temporal_edges(valid_from,valid_to);",
            "create table if not exists stats(id integer primary key autoincrement,type text not null,count integer default 1,ts integer not null);",
            "create index if not exists idx_stats_ts on stats(ts);",
            "create index if not exists idx_stats_type on stats(type);",
        ],

    },
    {
        version: "1.4.1",
        desc: "Add missing project_id to temporal graph tables",
        sqlite: () => [
            "ALTER TABLE temporal_facts ADD COLUMN project_id text;",
            "ALTER TABLE temporal_edges ADD COLUMN project_id text;",
        ],

    },
    {
        version: "1.4.2",
        desc: "Add summary column to memories for decay caching",
        sqlite: () => ["ALTER TABLE memories ADD COLUMN summary text;"],
    },
];

const get_db_version = async (): Promise<string> => {
    try {
        await client.execute("CREATE TABLE IF NOT EXISTS openmemory_schema (version TEXT)");
        const res = await client.execute("SELECT version FROM openmemory_schema ORDER BY ROWID DESC LIMIT 1");
        return res.rows.length ? (res.rows[0].version as string) : "0.0.0";
    } catch {
        return "0.0.0";
    }
};

const update_db_version = async (ver: string) => {
    await client.execute({ sql: "INSERT INTO openmemory_schema (version) VALUES (?)", args: [ver] });
};

const check_column_exists = async (table: string, column: string): Promise<boolean> => {
    try {
        const safeTable = assertSafeIdentifier(table, "check_column_exists");
        const res = await client.execute(`PRAGMA table_info(${safeTable})`);
        return res.rows.some((r: any) => r.name === column);
    } catch {
        return false;
    }
};

const quarantine_orphan_temporal_facts = async (): Promise<number> => {
    // Find orphans
    const orphanQuery = await client.execute({
        sql: `
        SELECT tf.id
        FROM temporal_facts tf
        LEFT JOIN users u ON tf.user_id = u.user_id
        WHERE u.user_id IS NULL AND tf.user_id IS NOT NULL AND tf.user_id != ?
    `, args: [LEGACY_ORPHAN_TENANT]});

    const ids = orphanQuery.rows.map((row: any) => row.id);
    if (ids.length === 0) return 0;

    await client.batch(ids.map((id: any) => ({
        sql: "UPDATE temporal_facts SET metadata = json_insert(coalesce(metadata, '{}'), '$._quarantined_legacy_user', user_id), user_id = ? WHERE id = ?",
        args: [LEGACY_ORPHAN_TENANT, id]
    })));
    return ids.length;
};

const compare_versions = (v1: string, v2: string) => {
    const a = v1.split(".");
    const b = v2.split(".");
    for (let i = 0; i < 3; i++) {
        const numA = Number(a[i]) || 0;
        const numB = Number(b[i]) || 0;
        if (numA > numB) return 1;
        if (numA < numB) return -1;
    }
    return 0;
};

export const run_migrations = async () => {
    log("Checking schema version via LibSQL...");
    const current_version = await get_db_version();
    log(`Current schema version: ${current_version}`);

    for (const m of migrations) {
        if (compare_versions(m.version, current_version) > 0) {
            log(`Applying ${m.version}: ${m.desc}`);
            try {
                const sql_stmts = m.sqlite(resolved_vector_table);
                if (sql_stmts.length > 0) {
                    await client.batch(sql_stmts.map(sql => ({ sql, args: [] })), "write");
                }
                await update_db_version(m.version);
            } catch (e: any) {
                // Ignore "duplicate column name" errors
                if (
                    e.message &&
                    (e.message.includes("duplicate column name") ||
                     e.message.includes("already exists"))
                ) {
                    log(`[WARN] ${m.desc} already applied partially, updating schema version.`);
                    await update_db_version(m.version);
                } else {
                    log(`[FATAL] Migration ${m.version} failed: ${e.message}`);
                    process.exit(1);
                }
            }
        }
    }

    log("Checking for orphaned temporal facts...");
    const q_count = await quarantine_orphan_temporal_facts();
    if (q_count > 0) {
        log(`Quarantined ${q_count} orphaned temporal facts to tenant: ${LEGACY_ORPHAN_TENANT}`);
    } else {
        log("No orphaned temporal facts found.");
    }

    const hasLastSeenAt = await check_column_exists("memories", "last_seen_at");
    if (!hasLastSeenAt) {
        try {
            await client.execute("ALTER TABLE memories ADD COLUMN last_seen_at integer");
            log("Added missing column last_seen_at");
        } catch (e: any) {
            if (!e.message.includes("duplicate column name")) {
                console.error("Failed to add last_seen_at", e);
            }
        }
    }

    client.close();
    log("All migrations complete.");
};

if (require.main === module) {
run_migrations().catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
});
}
