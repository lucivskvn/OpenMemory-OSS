import { env } from "./config";
import { client, run_async, transaction } from "./db";
import {
    assertSafeIdentifier,
    DEFAULT_VECTOR_TABLE,
    LEGACY_ORPHAN_TENANT,
} from "./identifiers";

const log = (msg: string) => console.log(`[MIGRATE] ${msg}`);

const explicit_vector_table = process.env.OM_VECTOR_TABLE;
const resolved_vector_table = assertSafeIdentifier(
    explicit_vector_table || DEFAULT_VECTOR_TABLE,
    "OM_VECTOR_TABLE",
);

interface Migration {
    version: string;
    desc: string;
    completion_columns?: Array<{ table: string; column: string }>;
    sqlite: (vectorTable: string) => string[];
}

const migrations: Migration[] = [
    {
        version: "1.2.0",
        desc: "Add version column to memories",
        completion_columns: [{ table: "memories", column: "version" }],
        sqlite: () => [
            "ALTER TABLE memories ADD COLUMN version integer default 1;",
        ],
    },
    {
        version: "1.3.0",
        desc: "Add project_id column to core tables",
        completion_columns: [
            { table: "memories", column: "project_id" },
            { table: resolved_vector_table, column: "project_id" },
            { table: "waypoints", column: "project_id" },
        ],
        sqlite: (vectorTable: string) => [
            "ALTER TABLE memories ADD COLUMN project_id text;",
            `ALTER TABLE ${vectorTable} ADD COLUMN project_id text;`,
            "ALTER TABLE waypoints ADD COLUMN project_id text;",
        ],
    },
    {
        version: "1.3.1",
        desc: "Add tags column to memories",
        completion_columns: [{ table: "memories", column: "tags" }],
        sqlite: () => ["ALTER TABLE memories ADD COLUMN tags text;"],
    },
    {
        version: "1.4.0",
        desc: "Add temporal graph tables and stats",
        completion_columns: [
            { table: "temporal_facts", column: "object" },
            { table: "temporal_edges", column: "source_id" },
            { table: "stats", column: "ts" },
        ],
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
        completion_columns: [
            { table: "temporal_facts", column: "project_id" },
            { table: "temporal_edges", column: "project_id" },
        ],
        sqlite: () => [
            "ALTER TABLE temporal_facts ADD COLUMN project_id text;",
            "ALTER TABLE temporal_edges ADD COLUMN project_id text;",
        ],
    },
    {
        version: "1.4.2",
        desc: "Add summary column to memories for decay caching",
        completion_columns: [{ table: "memories", column: "summary" }],
        sqlite: () => ["ALTER TABLE memories ADD COLUMN summary text;"],
    },
    {
        version: "1.4.3",
        desc: "Add user_id and sector indexes for vector isolation",
        sqlite: (vectorTable: string) => [
            `create index if not exists idx_vectors_user_id on ${vectorTable}(user_id);`,
            `create index if not exists idx_vectors_sector on ${vectorTable}(sector);`,
            "create index if not exists idx_mem_user_id on memories(user_id);",
            "create index if not exists idx_mem_simhash on memories(simhash);",
        ],
    },
];

const get_db_version = async (): Promise<string> => {
    try {
        await client.execute(
            "CREATE TABLE IF NOT EXISTS openmemory_schema (version TEXT)",
        );
        const res = await client.execute(
            "SELECT version FROM openmemory_schema ORDER BY ROWID DESC LIMIT 1",
        );
        return res.rows.length ? (res.rows[0].version as string) : "0.0.0";
    } catch {
        return "0.0.0";
    }
};

const update_db_version = async (ver: string) => {
    await run_async("INSERT INTO openmemory_schema (version) VALUES (?)", [
        ver,
    ]);
};

const table_exists = async (table: string): Promise<boolean> => {
    const res = await client.execute({
        sql: "select 1 from sqlite_master where type='table' and name=?",
        args: [table],
    });
    return res.rows.length > 0;
};

const check_column_exists = async (
    table: string,
    column: string,
): Promise<boolean> => {
    try {
        const safeTable = assertSafeIdentifier(table, "check_column_exists");
        const res = await client.execute(`PRAGMA table_info(${safeTable})`);
        return res.rows.some((r: any) => r.name === column);
    } catch {
        return false;
    }
};

export const column_satisfied = async (
    table: string,
    column: string,
): Promise<boolean> =>
    !(await table_exists(table)) || (await check_column_exists(table, column));

const quarantine_orphan_temporal_facts = async (): Promise<number> => {
    const orphanQuery = await client.execute({
        sql: `
        SELECT tf.id
        FROM temporal_facts tf
        LEFT JOIN users u ON tf.user_id = u.user_id
        WHERE u.user_id IS NULL AND tf.user_id IS NOT NULL AND tf.user_id != ?
    `,
        args: [LEGACY_ORPHAN_TENANT],
    });

    const ids = orphanQuery.rows.map((row: any) => row.id);
    if (ids.length === 0) return 0;

    await client.batch(
        ids.map((id: any) => ({
            sql: "UPDATE temporal_facts SET metadata = json_insert(coalesce(metadata, '{}'), '$._quarantined_legacy_user', user_id), user_id = ? WHERE id = ?",
            args: [LEGACY_ORPHAN_TENANT, id],
        })),
    );
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

export const migration_is_pending = (
    migration_version: string,
    current_version: string,
    is_complete: boolean,
) =>
    compare_versions(migration_version, current_version) > 0 || !is_complete;

const apply_migration = async (m: Migration, current_version: string) => {
    log(`Applying ${m.version}: ${m.desc}`);
    const sql_stmts = m.sqlite(resolved_vector_table);
    const pending_stmts = [];
    for (const sql of sql_stmts) {
        const added_column = sql.match(
            /^alter\s+table\s+([\w]+)\s+add\s+column\s+([\w]+)/i,
        );
        if (added_column) {
            const [, table, column] = added_column;
            if (
                !(await table_exists(table)) ||
                (await check_column_exists(table, column))
            ) {
                continue;
            }
        }
        pending_stmts.push({ sql, args: [] });
    }
    await transaction.begin();
    try {
        for (const { sql, args } of pending_stmts) {
            await run_async(sql, args);
        }
        const stored_version =
            compare_versions(m.version, current_version) > 0
                ? m.version
                : current_version;
        await update_db_version(stored_version);
        await transaction.commit();
    } catch (error) {
        await transaction.rollback();
        throw error;
    }
};

const ensure_last_seen_at = async () => {
    const hasLastSeenAt = await check_column_exists("memories", "last_seen_at");
    if (!hasLastSeenAt) {
        try {
            await client.execute(
                "ALTER TABLE memories ADD COLUMN last_seen_at integer",
            );
            log("Added missing column last_seen_at");
        } catch (e: any) {
            if (!e.message.includes("duplicate column name")) {
                console.error("Failed to add last_seen_at", e);
                throw e;
            }
        }
    }
};

export const run_migrations = async () => {
    log("Checking schema version via LibSQL...");
    const current_version = await get_db_version();
    log(`Current schema version: ${current_version}`);

    for (const m of migrations) {
        const is_complete = m.completion_columns
            ? (
                  await Promise.all(
                      m.completion_columns.map(({ table, column }) =>
                          column_satisfied(table, column),
                      ),
                  )
              ).every(Boolean)
            : true;
        if (migration_is_pending(m.version, current_version, is_complete)) {
            await apply_migration(m, current_version);
        }
    }

    log("Checking for orphaned temporal facts...");
    const q_count = await quarantine_orphan_temporal_facts();
    if (q_count > 0) {
        log(
            `Quarantined ${q_count} orphaned temporal facts to tenant: ${LEGACY_ORPHAN_TENANT}`,
        );
    } else {
        log("No orphaned temporal facts found.");
    }

    await ensure_last_seen_at();

    log("All migrations complete.");
};

if (require.main === module) {
    run_migrations()
        .then(() => client.close())
        .catch((err) => {
            console.error("Migration failed:", err);
            process.exit(1);
        });
}
