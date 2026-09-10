import { env } from "./config";
import { VectorStore } from "./vector_store";
import { PostgresVectorStore } from "./vector/postgres";
import { ValkeyVectorStore } from "./vector/valkey";
import {
    assertSafeIdentifier,
    DbInitError,
    DEFAULT_VECTOR_TABLE,
} from "./identifiers";
import { createClient, InStatement } from "@libsql/client";
import { encrypt, decrypt } from "./crypto";

const LEGACY_SQLITE_VECTOR_TABLE = "vectors";

// Re-export for downstream consumers (e.g. migrate.ts).
export { DEFAULT_VECTOR_TABLE };

type q_type = {
    ins_mem: { run: (...p: any[]) => Promise<void> };
    upd_mean_vec: { run: (mean_dim: number, mean_vec: Buffer, id: string, user_id: string) => Promise<number> };
    upd_compressed_vec: { run: (compressed_vec: Buffer, id: string, user_id: string) => Promise<number> };
    upd_feedback: { run: (feedback_score: number, updated_at: number, id: string, user_id: string) => Promise<number> };
    upd_seen: { run: (last_seen_at: number, salience: number, updated_at: number, id: string, user_id: string) => Promise<number> };
    upd_mem: { run: (content: string, tags: string, meta: string, updated_at: number, id: string, user_id: string) => Promise<number> };
    upd_mem_with_sector: { run: (content: string, primary_sector: string, tags: string, meta: string, updated_at: number, id: string, user_id: string) => Promise<number> };
    del_mem: { run: (...p: any[]) => Promise<void> };
    get_mem: { get: (id: string) => Promise<any> };
    get_mem_by_simhash: { get: (simhash: string, user_id: string) => Promise<any> };
    all_mem: { all: (limit: number, offset: number) => Promise<any[]> };
    all_mem_by_sector: {
        all: (sector: string, limit: number, offset: number) => Promise<any[]>;
    };
    all_mem_by_user: {
        all: (user_id: string, limit: number, offset: number) => Promise<any[]>;
    };
    all_mem_by_user_sector: {
        all: (
            user_id: string,
            sector: string,
            limit: number,
            offset: number,
        ) => Promise<any[]>;
    };
    get_segment_count: {
        get: (
            segment: number,
            user_id?: string,
            project_id?: string,
        ) => Promise<any>;
    };
    get_max_segment: {
        get: (
            user_id?: string,
            project_id?: string,
            is_system?: boolean,
        ) => Promise<any>;
    };
    get_segments: {
        all: (
            user_id?: string,
            project_id?: string,
            is_system?: boolean,
        ) => Promise<any[]>;
    };
    get_mem_by_segment: {
        all: (
            segment: number,
            user_id?: string,
            project_id?: string,
            is_system?: boolean,
        ) => Promise<any[]>;
    };

    ins_waypoint: { run: (...p: any[]) => Promise<void> };
    get_neighbors: { all: (src: string, user_id: string) => Promise<any[]> };
    get_waypoints_by_src: { all: (src: string, user_id: string) => Promise<any[]> };
    get_waypoint: { get: (src: string, dst: string, user_id: string) => Promise<any> };
    upd_waypoint: { run: (weight: number, updated_at: number, src_id: string, dst_id: string, user_id: string) => Promise<number> };
    del_waypoints: { run: (...p: any[]) => Promise<void> };
    prune_waypoints: { run: (t: number) => Promise<void> };

    ins_log: { run: (...p: any[]) => Promise<void> };
    upd_log: { run: (...p: any[]) => Promise<void> };
    get_pending_logs: { all: () => Promise<any[]> };
    get_failed_logs: { all: () => Promise<any[]> };

    ins_user: { run: (...p: any[]) => Promise<void> };
    get_user: { get: (user_id: string) => Promise<any> };
    upd_user_summary: { run: (...p: any[]) => Promise<void> };

    enqueue_outbox: { run: (job_id: string, id: string, user_id: string, action: "create" | "delete" | "reindex", sectors: string | null) => Promise<number> };
    claim_outbox_job: { run: (job_id: string, owner_token: string, lease_duration_ms?: number) => Promise<number> };
    mark_outbox_completed: { run: (job_id: string, owner_token: string) => Promise<number> };
    mark_outbox_failed: { run: (job_id: string, owner_token: string, err_msg: string) => Promise<number> };
    retry_dead_letter_job: { run: (job_id: string, user_id: string) => Promise<number> };

    clear_all: { run: () => Promise<void> };
};

const explicit_vector_table = process.env.OM_VECTOR_TABLE;
const sqlite_vector_table = assertSafeIdentifier(
    explicit_vector_table || DEFAULT_VECTOR_TABLE,
    "OM_VECTOR_TABLE",
);

const url =
    env.OM_TURSO_URL || `file:${env.db_path || "./data/openmemory.sqlite"}`;
const token = env.OM_TURSO_TOKEN;

/**
 * Singleton database client using libSQL.
 */
export const client = (() => {
    try {
        return createClient({ url, authToken: token });
    } catch (e: any) {
        throw new DbInitError(
            `Failed to initialize libSQL client: ${e.message}. URL: ${url}`,
        );
    }
})();

const mapRow = (row: any) => {
    if (!row) return row;
    const result = { ...row };
    if (result.content) {
        result.content = decrypt(result.content);
    }
    if (result.meta) {
        result.meta = decrypt(result.meta);
    }
    if (result.summary) {
        result.summary = decrypt(result.summary);
    }
    if (result.object) {
        result.object = decrypt(result.object);
    }
    if (result.metadata) {
        result.metadata = decrypt(result.metadata);
    }
    return result;
};

const mapRows = (rows: any[]) => rows.map(mapRow);

let txStmts: InStatement[] | null = null;

/**
 * Executes a SQL query directly against the client without buffering.
 */
const _exec_direct = async (sql: string, args: any[] = []) => {
    return await client.execute({ sql, args });
};

/**
 * Internal executor that respects transaction buffering.
 */
const exec = async (sql: string, args: any[] = []): Promise<void> => {
    if (txStmts) {
        txStmts.push({ sql, args });
        return;
    }
    await _exec_direct(sql, args);
};

export const run_async = exec;
export const run_async_direct = async (sql: string, args: any[] = []) => {
    await _exec_direct(sql, args);
};

export const run_affected_async = async (sql: string, args: any[] = []): Promise<number> => {
    if (txStmts) {
        txStmts.push({ sql, args });
        return 0;
    }
    const result = await _exec_direct(sql, args);
    return result.rowsAffected ?? 0;
};

export const get_async = async (sql: string, args: any[] = []) => {
    const result = await _exec_direct(sql, args);
    if (result.rows.length === 0) return undefined;
    return mapRow(result.rows[0]);
};

export const get_async_direct = get_async;

export const all_async = async (sql: string, args: any[] = []) => {
    if (txStmts) {
        txStmts.push({ sql, args });
        return [];
    }
    const result = await _exec_direct(sql, args);
    return mapRows(result.rows);
};

export const all_async_direct = async (sql: string, args: any[] = []) => {
    const result = await _exec_direct(sql, args);
    return mapRows(result.rows);
};

export interface TxContext {
    stmts: InStatement[];
    exec: (sql: string, args?: any[]) => void;
    commit: () => Promise<any[]>;
}

export const begin_tx = (): TxContext => {
    const ctx: TxContext = {
        stmts: [],
        exec(sql: string, args: any[] = []) {
            const encryptedP = [...args];
            ctx.stmts.push({ sql, args: encryptedP });
        },
        async commit() {
            const stmts = ctx.stmts;
            ctx.stmts = [];
            if (stmts.length === 0) return [];
            return await client.batch(stmts, "write");
        },
    };
    return ctx;
};

export const transaction = {
    begin: async () => {
        if (txStmts) {
            throw new Error("Transaction already active");
        }
        txStmts = [];
    },
    commit: async () => {
        if (!txStmts) return [];
        const stmts = txStmts;
        txStmts = null;
        return await client.batch(stmts, "write");
    },
    rollback: async () => {
        txStmts = null;
    },
};

export const memories_table = "memories";

export const vector_store: VectorStore =
    env.vector_store === "valkey"
        ? new ValkeyVectorStore()
        : new PostgresVectorStore(
              { run_async, get_async, all_async },
              sqlite_vector_table,
              !!env.OM_POSTGRES_URL,
          );

export const init_db = async () => {
    // Migration check for waypoints table primary key change
    try {
        const info = await all_async_direct("PRAGMA table_info(waypoints)");
        if (info && info.length > 0) {
            const pkCols = info.filter((c) => c.pk > 0);
            const has_dst_id_pk = pkCols.some((c) => c.name === "dst_id");
            if (!has_dst_id_pk) {
                console.warn(
                    "[DB] Migrating waypoints table to new schema with preserved data...",
                );
                try {
                    // Create new table with corrected schema
                    await _exec_direct(`
                        create table waypoints_new(
                            src_id text,
                            dst_id text not null,
                            user_id text,
                            project_id text,
                            weight real not null,
                            created_at integer,
                            updated_at integer,
                            primary key(src_id,dst_id,user_id)
                        )
                    `);

                    // Backfill compatible waypoint relations from old table
                    await _exec_direct(`
                        insert into waypoints_new(src_id,dst_id,user_id,project_id,weight,created_at,updated_at)
                        select src_id,dst_id,user_id,project_id,weight,created_at,updated_at from waypoints
                        where dst_id is not null
                    `);

                    // Replace old table
                    await _exec_direct("drop table waypoints");
                    await _exec_direct(
                        "alter table waypoints_new rename to waypoints",
                    );

                    console.log(
                        "[DB] Waypoints migration completed successfully",
                    );
                } catch (migrationError: any) {
                    console.error(
                        "[DB] Waypoints migration failed:",
                        migrationError.message,
                    );
                    // Attempt cleanup if migration partially completed
                    try {
                        await _exec_direct(
                            "drop table if exists waypoints_new",
                        );
                    } catch (cleanupError) {
                        // Cleanup failed, but log original error
                    }
                    throw new DbInitError(
                        `Waypoints migration failed: ${migrationError.message}`,
                    );
                }
            }
        }
    } catch (e: any) {
        // If table doesn't exist yet, that's fine - schema creation will handle it
        // But if it's a migration error, rethrow it
        if (e instanceof DbInitError) {
            throw e;
        }
        // Otherwise ignore (table might not exist yet)
    }

    try {
        const outboxInfo = await all_async_direct("PRAGMA table_info(vector_outbox)");
        if (outboxInfo && outboxInfo.length > 0) {
            const has_job_id = outboxInfo.some((c: any) => c.name === "job_id");
            const has_owner_token = outboxInfo.some((c: any) => c.name === "owner_token");
            if (!has_job_id || !has_owner_token) {
                console.warn("[DB] Migrating vector_outbox table to new schema with preserved data...");
                try {
                    const oldRows = await all_async_direct("select * from vector_outbox");
                    const migrationStmts: InStatement[] = [
                        {
                            sql: `create table vector_outbox_new(
                                job_id text primary key,
                                id text not null,
                                user_id text not null,
                                action text not null,
                                sectors text,
                                status text not null default 'pending',
                                attempts integer default 0,
                                version integer default 1,
                                owner_token text,
                                lease_expires_at integer default 0,
                                last_error text,
                                created_at integer not null,
                                updated_at integer not null
                            )`,
                            args: [],
                        },
                    ];

                    migrationStmts.push({
                        sql: `create table if not exists vector_outbox_quarantine(
                            job_id text primary key,
                            id text,
                            user_id text,
                            action text,
                            sectors text,
                            status text,
                            attempts integer,
                            last_error text,
                            created_at integer,
                            updated_at integer
                        )`,
                        args: [],
                    });

                    const valid_statuses = new Set(["pending", "processing", "completed", "failed", "dead_letter"]);

                    for (const r of oldRows) {
                        const valid_id = r.id && typeof r.id === "string" && r.id.trim();
                        const valid_user = r.user_id && typeof r.user_id === "string" && r.user_id.trim();
                        const valid_action = r.action === "create" || r.action === "delete" || r.action === "reindex";
                        const valid_status = typeof r.status === "string" && valid_statuses.has(r.status);

                        if (!valid_id || !valid_user || !valid_action || !valid_status) {
                            const q_job_id = r.job_id || crypto.randomUUID();
                            migrationStmts.push({
                                sql: "insert or replace into vector_outbox_quarantine(job_id, id, user_id, action, sectors, status, attempts, last_error, created_at, updated_at) values(?, ?, ?, ?, ?, 'quarantined', ?, ?, ?, ?)",
                                args: [
                                    q_job_id,
                                    r.id || null,
                                    r.user_id || null,
                                    r.action || null,
                                    r.sectors || null,
                                    typeof r.attempts === "number" ? r.attempts : 0,
                                    "invalid_schema_migration_row",
                                    r.created_at || Date.now(),
                                    Date.now(),
                                ],
                            });
                            continue;
                        }

                        const job_id = r.job_id || crypto.randomUUID();
                        const id = valid_id;
                        const user_id = valid_user;
                        const action = r.action;
                        const sectors = r.sectors || null;
                        const status = r.status;
                        const attempts = typeof r.attempts === "number" ? r.attempts : 0;
                        const version = typeof r.version === "number" ? r.version : 1;
                        const owner_token = r.owner_token || null;
                        const lease_expires_at = typeof r.lease_expires_at === "number" ? r.lease_expires_at : 0;
                        const last_error = r.last_error || null;
                        const created_at = r.created_at || Date.now();
                        const updated_at = r.updated_at || Date.now();

                        migrationStmts.push({
                            sql: "insert into vector_outbox_new(job_id, id, user_id, action, sectors, status, attempts, version, owner_token, lease_expires_at, last_error, created_at, updated_at) values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                            args: [job_id, id, user_id, action, sectors, status, attempts, version, owner_token, lease_expires_at, last_error, created_at, updated_at],
                        });
                    }

                    migrationStmts.push({ sql: "drop table vector_outbox", args: [] });
                    migrationStmts.push({ sql: "alter table vector_outbox_new rename to vector_outbox", args: [] });

                    // Execute migration statements in chunks of 50 to prevent unbounded single client.batch payloads
                    const CHUNK_SIZE = 50;
                    for (let i = 0; i < migrationStmts.length; i += CHUNK_SIZE) {
                        const chunk = migrationStmts.slice(i, i + CHUNK_SIZE);
                        await client.batch(chunk, "write");
                    }
                    console.log("[DB] vector_outbox migration completed successfully");
                } catch (migrationError: any) {
                    console.error("[DB] vector_outbox migration failed:", migrationError.message);
                    try {
                        await _exec_direct("drop table if exists vector_outbox_new");
                    } catch {}
                    throw new DbInitError(`vector_outbox migration failed: ${migrationError.message}`);
                }
            }
        }
    } catch (e: any) {
        if (e instanceof DbInitError) throw e;
    }

    const SCHEMA_TABLES = [
        "create table if not exists memories(id text primary key,user_id text,project_id text,segment integer default 0,content text not null,summary text,simhash text,primary_sector text not null,tags text,meta text,created_at integer,updated_at integer,last_seen_at integer,salience real,decay_lambda real,version integer default 1,mean_dim integer,mean_vec blob,compressed_vec blob,feedback_score real default 0,coactivations integer default 0)",
        "create index if not exists idx_mem_user_id on memories(user_id)",
        "create index if not exists idx_mem_simhash on memories(simhash)",
        "create table if not exists openmemory_vectors(id text not null,project_id text,sector text not null,user_id text,v blob not null,dim integer not null,primary key(id,sector))",
        "create index if not exists idx_vectors_user_id on openmemory_vectors(user_id)",
        "create index if not exists idx_vectors_sector on openmemory_vectors(sector)",
        "create table if not exists waypoints(src_id text,dst_id text not null,user_id text,project_id text,weight real not null,created_at integer,updated_at integer,primary key(src_id,dst_id,user_id))",
        "create table if not exists embed_logs(id text primary key,model text,status text,ts integer,err text)",
        "create table if not exists users(user_id text primary key,summary text,reflection_count integer default 0,created_at integer,updated_at integer)",
        "create table if not exists stats(id integer primary key autoincrement,type text not null,count integer default 1,ts integer not null)",
        "create table if not exists temporal_facts(id text primary key,user_id text,project_id text,subject text not null,predicate text not null,object text not null,valid_from integer not null,valid_to integer,confidence real not null check(confidence >= 0 and confidence <= 1),last_updated integer not null,metadata text,unique(subject,predicate,object,valid_from))",
        "create table if not exists temporal_edges(id text primary key,source_id text not null,target_id text not null,relation_type text not null,valid_from integer not null,valid_to integer,weight real not null,metadata text,foreign key(source_id) references temporal_facts(id),foreign key(target_id) references temporal_facts(id))",
        "create table if not exists vector_outbox(job_id text primary key, id text not null, user_id text not null, action text not null, sectors text, status text not null default 'pending', attempts integer default 0, version integer default 1, owner_token text, lease_expires_at integer default 0, last_error text, created_at integer not null, updated_at integer not null)",
        "create index if not exists idx_outbox_status on vector_outbox(status, attempts, lease_expires_at)",
        "create index if not exists idx_outbox_mem_user on vector_outbox(id, user_id)",
    ];
    for (const sql of SCHEMA_TABLES) {
        await exec(sql);
    }
};

export const q: q_type = {
    ins_mem: {
        run: (...p) => {
            const encryptedP = [...p];
            if (encryptedP[4] !== undefined && encryptedP[4] !== null) {
                encryptedP[4] = encrypt(encryptedP[4]);
            }
            if (encryptedP[8] !== undefined && encryptedP[8] !== null) {
                encryptedP[8] = encrypt(encryptedP[8]);
            }
            return exec(
                "insert into memories(id,user_id,project_id,segment,content,simhash,primary_sector,tags,meta,created_at,updated_at,last_seen_at,salience,decay_lambda,version,mean_dim,mean_vec,compressed_vec,feedback_score) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) on conflict(id) do update set user_id=excluded.user_id, project_id=excluded.project_id, content=excluded.content, simhash=excluded.simhash, primary_sector=excluded.primary_sector, tags=excluded.tags, meta=excluded.meta, updated_at=excluded.updated_at, last_seen_at=excluded.last_seen_at, salience=excluded.salience, decay_lambda=excluded.decay_lambda, version=excluded.version, mean_dim=excluded.mean_dim, mean_vec=excluded.mean_vec, compressed_vec=excluded.compressed_vec, feedback_score=excluded.feedback_score where memories.user_id = excluded.user_id and excluded.version > memories.version",
                encryptedP,
            );
        },
    },
    upd_mean_vec: {
        run: (mean_dim: number, mean_vec: Buffer, id: string, user_id: string) => {
            const active_user = user_id?.trim();
            if (!active_user) return Promise.resolve(0);
            return run_affected_async(
                "update memories set mean_dim=?,mean_vec=? where id=? and user_id=?",
                [mean_dim, mean_vec, id, active_user],
            );
        },
    },
    upd_compressed_vec: {
        run: (compressed_vec: Buffer, id: string, user_id: string) => {
            const active_user = user_id?.trim();
            if (!active_user) return Promise.resolve(0);
            return run_affected_async(
                "update memories set compressed_vec=? where id=? and user_id=?",
                [compressed_vec, id, active_user],
            );
        },
    },
    upd_feedback: {
        run: (feedback_score: number, updated_at: number, id: string, user_id: string) => {
            const active_user = user_id?.trim();
            if (!active_user) return Promise.resolve(0);
            return run_affected_async(
                "update memories set feedback_score=?,coactivations=coactivations+1,updated_at=? where id=? and user_id=?",
                [feedback_score, updated_at, id, active_user],
            );
        },
    },
    upd_seen: {
        run: (last_seen_at: number, salience: number, updated_at: number, id: string, user_id: string) => {
            const active_user = user_id?.trim();
            if (!active_user) return Promise.resolve(0);
            return run_affected_async(
                "update memories set last_seen_at=?,salience=?,updated_at=? where id=? and user_id=?",
                [last_seen_at, salience, updated_at, id, active_user],
            );
        },
    },
    upd_mem: {
        run: (content: string, tags: string, meta: string, updated_at: number, id: string, user_id: string) => {
            const active_user = user_id?.trim();
            if (!active_user) return Promise.resolve(0);
            const encryptedP: any[] = [content, tags, meta, updated_at, id, active_user];
            if (encryptedP[0] !== undefined && encryptedP[0] !== null) {
                encryptedP[0] = encrypt(encryptedP[0]);
            }
            if (encryptedP[2] !== undefined && encryptedP[2] !== null) {
                encryptedP[2] = encrypt(encryptedP[2]);
            }
            return run_affected_async(
                "update memories set content=?,tags=?,meta=?,updated_at=?,version=version+1 where id=? and user_id=?",
                encryptedP,
            );
        },
    },
    upd_mem_with_sector: {
        run: (content: string, primary_sector: string, tags: string, meta: string, updated_at: number, id: string, user_id: string) => {
            const active_user = user_id?.trim();
            if (!active_user) return Promise.resolve(0);
            const encryptedP: any[] = [content, primary_sector, tags, meta, updated_at, id, active_user];
            if (encryptedP[0] !== undefined && encryptedP[0] !== null) {
                encryptedP[0] = encrypt(encryptedP[0]);
            }
            if (encryptedP[3] !== undefined && encryptedP[3] !== null) {
                encryptedP[3] = encrypt(encryptedP[3]);
            }
            return run_affected_async(
                "update memories set content=?,primary_sector=?,tags=?,meta=?,updated_at=?,version=version+1 where id=? and user_id=?",
                encryptedP,
            );
        },
    },
    del_mem: {
        run: async (...p) => {
            const id = p[0];
            const user_id = p[1];
            const project_id = p[2];
            const in_tx = txStmts !== null;
            try {
                if (!in_tx) await transaction.begin();
                let sql = "delete from memories where id=?";
                const params: any[] = [id];
                if (user_id) {
                    sql += " and user_id=?";
                    params.push(user_id);
                }
                if (project_id) {
                    sql += " and project_id=?";
                    params.push(project_id);
                }
                await exec(sql, params);

                let factSql =
                    "delete from temporal_facts where metadata like ?";
                const factParams: any[] = [`%"source_memory_id":"${id}"%`];
                if (user_id) {
                    factSql += " and user_id=?";
                    factParams.push(user_id);
                }
                if (project_id) {
                    factSql += " and project_id=?";
                    factParams.push(project_id);
                }
                await exec(factSql, factParams);

                if (!in_tx) await transaction.commit();
            } catch (err) {
                if (!in_tx) await transaction.rollback();
                throw err;
            }
        },
    },
    get_mem: {
        get: (id) => get_async("select * from memories where id=?", [id]),
    },
    get_mem_by_simhash: {
        get: (simhash, user_id) => {
            const active_user = user_id?.trim();
            if (!active_user) return Promise.resolve(undefined);
            return get_async(
                "select * from memories where simhash=? and user_id=? order by salience desc limit 1",
                [simhash, active_user],
            );
        },
    },
    all_mem: {
        all: (limit, offset) =>
            all_async(
                "select * from memories order by created_at desc limit ? offset ?",
                [limit, offset],
            ),
    },
    all_mem_by_sector: {
        all: (sector, limit, offset) =>
            all_async(
                "select * from memories where primary_sector=? order by created_at desc limit ? offset ?",
                [sector, limit, offset],
            ),
    },
    get_segment_count: {
        get: (segment, user_id, project_id) => {
            let sql = "select count(*) as c from memories where segment=?";
            const params: any[] = [segment];
            if (user_id) {
                sql += " and user_id=?";
                params.push(user_id);
            }
            if (project_id) {
                sql += " and project_id=?";
                params.push(project_id);
            }
            return get_async(sql, params);
        },
    },
    get_max_segment: {
        get: (user_id?: string, project_id?: string, is_system?: boolean) => {
            let sql =
                "select coalesce(max(segment), 0) as max_seg from memories where 1=1";
            const params: any[] = [];
            if (!is_system) {
                if (user_id) {
                    sql += " and user_id=?";
                    params.push(user_id);
                }
                if (project_id) {
                    sql += " and project_id=?";
                    params.push(project_id);
                }
            }
            return get_async(sql, params);
        },
    },
    get_segments: {
        all: (user_id?: string, project_id?: string, is_system?: boolean) => {
            let sql = "select distinct segment from memories where 1=1";
            const params: any[] = [];
            if (!is_system) {
                if (user_id) {
                    sql += " and user_id=?";
                    params.push(user_id);
                }
                if (project_id) {
                    sql += " and project_id=?";
                    params.push(project_id);
                }
            }
            sql += " order by segment desc";
            return all_async(sql, params);
        },
    },
    get_mem_by_segment: {
        all: (
            segment: number,
            user_id?: string,
            project_id?: string,
            is_system?: boolean,
        ) => {
            let sql = "select * from memories where segment=?";
            const params: any[] = [segment];
            if (!is_system) {
                if (user_id) {
                    sql += " and user_id=?";
                    params.push(user_id);
                }
                if (project_id) {
                    sql += " and project_id=?";
                    params.push(project_id);
                }
            }
            sql += " order by created_at desc";
            return all_async(sql, params);
        },
    },

    ins_waypoint: {
        run: (...p) =>
            exec(
                "insert into waypoints(src_id,dst_id,user_id,project_id,weight,created_at,updated_at) values(?,?,?,?,?,?,?) on conflict(src_id, dst_id, user_id) do update set dst_id=excluded.dst_id,project_id=excluded.project_id, weight=excluded.weight, created_at=excluded.created_at, updated_at=excluded.updated_at",
                p,
            ),
    },
    enqueue_outbox: {
        run: (job_id: string, id: string, user_id: string, action: "create" | "delete" | "reindex", sectors: string | null) => {
            const active_user = user_id?.trim();
            if (!active_user) return Promise.resolve(0);
            const now_ts = Date.now();
            return run_affected_async(
                "insert into vector_outbox(job_id, id, user_id, action, sectors, status, created_at, updated_at) values(?, ?, ?, ?, ?, 'pending', ?, ?)",
                [job_id, id, active_user, action, sectors, now_ts, now_ts],
            );
        },
    },
    claim_outbox_job: {
        run: (job_id: string, owner_token: string, lease_duration_ms: number = 60000) => {
            const now_ts = Date.now();
            const lease_expires = now_ts + lease_duration_ms;
            return run_affected_async(
                "update vector_outbox set status='processing', owner_token=?, lease_expires_at=?, updated_at=? where job_id=? and (status='pending' or (status='failed' and attempts < 5) or (status='processing' and lease_expires_at < ?))",
                [owner_token, lease_expires, now_ts, job_id, now_ts],
            );
        },
    },
    mark_outbox_completed: {
        run: (job_id: string, owner_token: string) => {
            return run_affected_async(
                "update vector_outbox set status='completed', updated_at=? where job_id=? and owner_token=? and status='processing'",
                [Date.now(), job_id, owner_token],
            );
        },
    },
    mark_outbox_failed: {
        run: (job_id: string, owner_token: string, err_msg?: string) => {
            const safe_msg = String(err_msg || "Vector operation failed").substring(0, 500);
            return run_affected_async(
                "update vector_outbox set status = case when attempts + 1 >= 5 then 'dead_letter' else 'failed' end, attempts = attempts + 1, last_error = ?, updated_at = ? where job_id = ? and owner_token = ? and status = 'processing'",
                [safe_msg, Date.now(), job_id, owner_token],
            );
        },
    },
    retry_dead_letter_job: {
        run: (job_id: string, user_id: string) => {
            const active_user = user_id?.trim();
            if (!active_user) return Promise.resolve(0);
            return run_affected_async(
                "update vector_outbox set status='pending', attempts=0, lease_expires_at=0, updated_at=? where job_id=? and user_id=? and status='dead_letter'",
                [Date.now(), job_id, active_user],
            );
        },
    },
    get_neighbors: {
        all: (src, user_id) => {
            const active_user = user_id?.trim();
            if (!active_user) return Promise.resolve([]);
            return all_async(
                "select dst_id,weight from waypoints where src_id=? and user_id=? order by weight desc",
                [src, active_user],
            );
        },
    },
    get_waypoints_by_src: {
        all: (src, user_id) => {
            const active_user = user_id?.trim();
            if (!active_user) return Promise.resolve([]);
            return all_async(
                "select src_id,dst_id,weight,created_at,updated_at from waypoints where src_id=? and user_id=?",
                [src, active_user],
            );
        },
    },
    get_waypoint: {
        get: (src, dst, user_id) => {
            const active_user = user_id?.trim();
            if (!active_user) return Promise.resolve(undefined);
            return get_async(
                "select weight from waypoints where src_id=? and dst_id=? and user_id=?",
                [src, dst, active_user],
            );
        },
    },
    upd_waypoint: {
        run: (weight: number, updated_at: number, src_id: string, dst_id: string, user_id: string) => {
            const active_user = user_id?.trim();
            if (!active_user) return Promise.resolve(0);
            return run_affected_async(
                "update waypoints set weight=?,updated_at=? where src_id=? and dst_id=? and user_id=?",
                [weight, updated_at, src_id, dst_id, active_user],
            );
        },
    },
    del_waypoints: {
        run: (...p) => {
            const src_id = p[0];
            const dst_id = p[1];
            const user_id = p[2];
            if (user_id) {
                return exec(
                    "delete from waypoints where (src_id=? or dst_id=?) and user_id=?",
                    [src_id, dst_id, user_id],
                );
            }
            return exec("delete from waypoints where src_id=? or dst_id=?", [
                src_id,
                dst_id,
            ]);
        },
    },
    prune_waypoints: {
        run: (t) => exec("delete from waypoints where weight<?", [t]),
    },
    ins_log: {
        run: (...p) =>
            exec(
                "insert into embed_logs(id,model,status,ts,err) values(?,?,?,?,?) on conflict (id) do update set model=excluded.model, status=excluded.status, ts=excluded.ts, err=excluded.err",
                p,
            ),
    },
    upd_log: {
        run: (...p) =>
            exec("update embed_logs set status=?,err=? where id=?", p),
    },
    get_pending_logs: {
        all: () =>
            all_async("select * from embed_logs where status=?", ["pending"]),
    },
    get_failed_logs: {
        all: () =>
            all_async(
                "select * from embed_logs where status=? order by ts desc limit 100",
                ["failed"],
            ),
    },
    all_mem_by_user: {
        all: (user_id, limit, offset) =>
            all_async(
                "select * from memories where user_id=? order by created_at desc limit ? offset ?",
                [user_id, limit, offset],
            ),
    },
    all_mem_by_user_sector: {
        all: (user_id, sector, limit, offset) =>
            all_async(
                "select * from memories where user_id=? and primary_sector=? order by created_at desc limit ? offset ?",
                [user_id, sector, limit, offset],
            ),
    },
    ins_user: {
        run: (...p) =>
            exec(
                "insert into users(user_id,summary,reflection_count,created_at,updated_at) values(?,?,?,?,?) on conflict(user_id) do update set summary=excluded.summary,reflection_count=excluded.reflection_count,updated_at=excluded.updated_at",
                p,
            ),
    },
    get_user: {
        get: (user_id) =>
            get_async("select * from users where user_id=?", [user_id]),
    },
    upd_user_summary: {
        run: (...p) =>
            exec(
                "update users set summary=?,reflection_count=reflection_count+1,updated_at=? where user_id=?",
                p,
            ),
    },
    clear_all: {
        run: async () => {
            await exec("delete from memories");
            await exec("delete from waypoints");
            await exec("delete from users");
            await exec(`delete from ${sqlite_vector_table}`);
        },
    },
};

export const log_maint_op = async (
    type: "decay" | "reflect" | "consolidate",
    cnt = 1,
) => {
    try {
        const sql = "insert into stats(type,count,ts) values(?,?,?)";
        await run_async(sql, [type, cnt, Date.now()]);
    } catch (e) {
        console.error("[DB] Maintenance log error:", e);
    }
};
