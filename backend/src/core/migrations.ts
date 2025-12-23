export interface Migration {
    version: string;
    desc: string;
    sqlite: string[];
    postgres: string[];
}

export const migrations: Migration[] = [
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
             `CREATE TABLE IF NOT EXISTS {s} (
        id SERIAL PRIMARY KEY,
        type TEXT NOT NULL, count INTEGER DEFAULT 1, ts BIGINT NOT NULL
      )`,
            `CREATE INDEX IF NOT EXISTS openmemory_stats_ts_idx ON {s}(ts)`,
            `CREATE INDEX IF NOT EXISTS openmemory_stats_type_idx ON {s}(type)`,
        ],
    },
    {
        version: "1.3.0",
        desc: "Temporal memory support",
        sqlite: [
            `CREATE TABLE IF NOT EXISTS temporal_facts(id TEXT PRIMARY KEY, subject TEXT NOT NULL, predicate TEXT NOT NULL, object TEXT NOT NULL, valid_from INTEGER NOT NULL, valid_to INTEGER, confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1), last_updated INTEGER NOT NULL, metadata TEXT, UNIQUE(subject, predicate, object, valid_from))`,
            `CREATE TABLE IF NOT EXISTS temporal_edges(id TEXT PRIMARY KEY, source_id TEXT NOT NULL, target_id TEXT NOT NULL, relation_type TEXT NOT NULL, valid_from INTEGER NOT NULL, valid_to INTEGER, weight REAL NOT NULL, metadata TEXT, FOREIGN KEY(source_id) REFERENCES temporal_facts(id), FOREIGN KEY(target_id) REFERENCES temporal_facts(id))`,
            `CREATE INDEX IF NOT EXISTS idx_temporal_subject ON temporal_facts(subject)`,
            `CREATE INDEX IF NOT EXISTS idx_temporal_predicate ON temporal_facts(predicate)`,
            `CREATE INDEX IF NOT EXISTS idx_temporal_validity ON temporal_facts(valid_from, valid_to)`,
            `CREATE INDEX IF NOT EXISTS idx_temporal_composite ON temporal_facts(subject, predicate, valid_from, valid_to)`,
            `CREATE INDEX IF NOT EXISTS idx_edges_source ON temporal_edges(source_id)`,
            `CREATE INDEX IF NOT EXISTS idx_edges_target ON temporal_edges(target_id)`,
            `CREATE INDEX IF NOT EXISTS idx_edges_validity ON temporal_edges(valid_from, valid_to)`,
        ],
        postgres: [
            `CREATE TABLE IF NOT EXISTS {tf} (id TEXT PRIMARY KEY, subject TEXT NOT NULL, predicate TEXT NOT NULL, object TEXT NOT NULL, valid_from BIGINT NOT NULL, valid_to BIGINT, confidence DOUBLE PRECISION NOT NULL CHECK(confidence >= 0 AND confidence <= 1), last_updated BIGINT NOT NULL, metadata TEXT, UNIQUE(subject, predicate, object, valid_from))`,
            `CREATE TABLE IF NOT EXISTS {te} (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, target_id TEXT NOT NULL, relation_type TEXT NOT NULL, valid_from BIGINT NOT NULL, valid_to BIGINT, weight DOUBLE PRECISION NOT NULL, metadata TEXT, FOREIGN KEY(source_id) REFERENCES {tf}(id), FOREIGN KEY(target_id) REFERENCES {tf}(id))`,
            `CREATE INDEX IF NOT EXISTS openmemory_temporal_subject_idx ON {tf}(subject)`,
            `CREATE INDEX IF NOT EXISTS openmemory_temporal_predicate_idx ON {tf}(predicate)`,
            `CREATE INDEX IF NOT EXISTS openmemory_temporal_validity_idx ON {tf}(valid_from, valid_to)`,
            `CREATE INDEX IF NOT EXISTS openmemory_edges_source_idx ON {te}(source_id)`,
            `CREATE INDEX IF NOT EXISTS openmemory_edges_target_idx ON {te}(target_id)`,
        ],
    },
    {
        version: "1.4.0",
        desc: "Performance optimization indices",
        sqlite: [
            `CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at)`,
            // Note: vectors primary key is (id, sector), covering sector searches if sector is leading?
            // No, PK is usually indexed as declared. If PK(id, sector), it indexes ID first.
            // We need sector index for retrieval efficiency.
            // Wait, get_initial_schema_sqlite creates table vectors... but no index on sector?
            // Actually check existing vector table definition in 1.2.0 or initial.
            // 1.2.0 adds user_id index.
            // Initial schema has: create table ... primary key(id,sector).
            // So we add sector index.
            `CREATE INDEX IF NOT EXISTS idx_vectors_sector ON vectors(sector)`,
        ],
        postgres: [
            `CREATE INDEX IF NOT EXISTS openmemory_memories_created_at_idx ON {m}(created_at)`,
            `CREATE INDEX IF NOT EXISTS openmemory_vectors_sector_idx ON {v}(sector)`,
        ],
    },
];

export const get_initial_schema_sqlite = (vector_table: string) => [
    `create table if not exists memories(id text primary key,user_id text,segment integer default 0,content text not null,simhash text,primary_sector text not null,tags text,meta text,created_at integer,updated_at integer,last_seen_at integer,salience real,decay_lambda real,version integer default 1,mean_dim integer,mean_vec blob,compressed_vec blob,feedback_score real default 0)`,
    `create table if not exists ${vector_table}(id text not null,sector text not null,user_id text,v blob not null,dim integer not null,primary key(id,sector))`,
    `create table if not exists waypoints(src_id text,dst_id text not null,user_id text,weight real not null,created_at integer,updated_at integer,primary key(src_id,user_id))`,
    `create table if not exists embed_logs(id text primary key,model text,status text,ts integer,err text)`,
    `create table if not exists users(user_id text primary key,summary text,reflection_count integer default 0,created_at integer,updated_at integer)`,
    `create table if not exists stats(id integer primary key autoincrement,type text not null,count integer default 1,ts integer not null)`,
    `create table if not exists temporal_facts(id text primary key,subject text not null,predicate text not null,object text not null,valid_from integer not null,valid_to integer,confidence real not null check(confidence >= 0 and confidence <= 1),last_updated integer not null,metadata text,unique(subject,predicate,object,valid_from))`,
    `create table if not exists temporal_edges(id text primary key,source_id text not null,target_id text not null,relation_type text not null,valid_from integer not null,valid_to integer,weight real not null,metadata text,foreign key(source_id) references temporal_facts(id),foreign key(target_id) references temporal_facts(id))`,
    "create index if not exists idx_memories_sector on memories(primary_sector)",
    "create index if not exists idx_memories_segment on memories(segment)",
    "create index if not exists idx_memories_simhash on memories(simhash)",
    "create index if not exists idx_memories_ts on memories(last_seen_at)",
    "create index if not exists idx_memories_created_at on memories(created_at)",
    "create index if not exists idx_memories_user on memories(user_id)",
    `create index if not exists idx_vectors_user on ${vector_table}(user_id)`,
    `create index if not exists idx_vectors_sector on ${vector_table}(sector)`,
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
];

export const get_initial_schema_pg = (tables: { m: string; v: string; w: string; l: string; u: string; s: string; tf: string; te: string }) => [
    `create table if not exists ${tables.m}(id uuid primary key,user_id text,segment integer default 0,content text not null,simhash text,primary_sector text not null,tags text,meta text,created_at bigint,updated_at bigint,last_seen_at bigint,salience double precision,decay_lambda double precision,version integer default 1,mean_dim integer,mean_vec bytea,compressed_vec bytea,feedback_score double precision default 0)`,
    `create table if not exists ${tables.v}(id uuid,sector text,user_id text,v bytea,dim integer not null,primary key(id,sector))`,
    `create table if not exists ${tables.w}(src_id text,dst_id text not null,user_id text,weight double precision not null,created_at bigint,updated_at bigint,primary key(src_id,user_id))`,
    `create table if not exists ${tables.l}(id text primary key,model text,status text,ts bigint,err text)`,
    `create table if not exists ${tables.u}(user_id text primary key,summary text,reflection_count integer default 0,created_at bigint,updated_at bigint)`,
    `create table if not exists ${tables.s}(id serial primary key,type text not null,count integer default 1,ts bigint not null)`,
    // Temporal tables
    `create table if not exists ${tables.tf}(id text primary key,subject text not null,predicate text not null,object text not null,valid_from bigint not null,valid_to bigint,confidence double precision not null check(confidence >= 0 and confidence <= 1),last_updated bigint not null,metadata text,unique(subject,predicate,object,valid_from))`,
    `create table if not exists ${tables.te}(id text primary key,source_id text not null,target_id text not null,relation_type text not null,valid_from bigint not null,valid_to bigint,weight double precision not null,metadata text,foreign key(source_id) references ${tables.tf}(id),foreign key(target_id) references ${tables.tf}(id))`,

    `create index if not exists openmemory_memories_sector_idx on ${tables.m}(primary_sector)`,
    `create index if not exists openmemory_memories_segment_idx on ${tables.m}(segment)`,
    `create index if not exists openmemory_memories_simhash_idx on ${tables.m}(simhash)`,
    `create index if not exists openmemory_memories_created_at_idx on ${tables.m}(created_at)`,
    `create index if not exists openmemory_memories_user_idx on ${tables.m}(user_id)`,
    `create index if not exists openmemory_vectors_user_idx on ${tables.v}(user_id)`,
    `create index if not exists openmemory_vectors_sector_idx on ${tables.v}(sector)`,
    `create index if not exists openmemory_waypoints_user_idx on ${tables.w}(user_id)`,
    `create index if not exists openmemory_stats_ts_idx on ${tables.s}(ts)`,
    `create index if not exists openmemory_stats_type_idx on ${tables.s}(type)`,
    `create index if not exists openmemory_temporal_subject_idx on ${tables.tf}(subject)`,
    `create index if not exists openmemory_temporal_predicate_idx on ${tables.tf}(predicate)`,
    `create index if not exists openmemory_temporal_validity_idx on ${tables.tf}(valid_from,valid_to)`,
    `create index if not exists openmemory_edges_source_idx on ${tables.te}(source_id)`,
    `create index if not exists openmemory_edges_target_idx on ${tables.te}(target_id)`,
];

export interface DbOps {
    run_async: (sql: string, params?: any[]) => Promise<void>;
    get_async: (sql: string, params?: any[]) => Promise<any>;
    all_async: (sql: string, params?: any[]) => Promise<any[]>;
    // SQLite specific helpers for checking schema
    is_pg: boolean;
}

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
    console.log("[MIGRATE] Checking schema status...");

    let memories_table = "memories";
    if (ops.is_pg) {
        const sc = process.env.OM_PG_SCHEMA || "public";
        memories_table = `"${sc}"."${process.env.OM_PG_TABLE || "openmemory_memories"}"`;
    }

    const has_memories = await check_table_exists(ops, memories_table);

    const current_version = await get_db_version(ops);
    const latest_version = migrations.length > 0 ? migrations[migrations.length - 1].version : "0.0.0";

    if (!has_memories) {
        console.log("[MIGRATE] Fresh install detected. Initializing schema...");
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
        console.log(`[MIGRATE] Schema initialized to version ${latest_version}`);
        return;
    }

    // Existing installation
    console.log(`[MIGRATE] Current DB version: ${current_version || "legacy"}`);

    for (const m of migrations) {
        if (!current_version || m.version > current_version) {
            console.log(`[MIGRATE] Applying migration ${m.version}: ${m.desc}`);
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
                console.error(`[MIGRATE] Migration ${m.version} failed:`, e);
                throw e;
            }
        }
    }
    console.log("[MIGRATE] Schema is up to date.");
}
