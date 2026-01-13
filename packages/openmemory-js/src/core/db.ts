/**
 * @file Core Database Layer for OpenMemory.
 * Provides a unified API for SQLite and Postgres backends with transactional support and batching.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { threadId } from "node:worker_threads";

import { Database } from "bun:sqlite";
import { Pool, PoolClient } from "pg";

import { normalizeUserId } from "../utils";
import { logger } from "../utils/logger";
import { env } from "./cfg";
import type { SqlParams, SqlValue } from "./db_utils";
// Imported from db_utils to avoid circular dependencies
import { applySqlUser, pUser, sqlUser } from "./db_utils";
import {
    BatchMemoryInsertItem,
    BatchWaypointInsertItem,
    LogEntry,
    MaintLogEntry,
    MemoryRow,
    SectorStat,
    Waypoint,
} from "./types";
import { SqlVectorStore } from "./vector/sql";
import { ValkeyVectorStore } from "./vector/valkey";
import { VectorStore } from "./vector_store";
import { MemoryRepository } from "./repository/memory";
import { WaypointRepository } from "./repository/waypoint";
import { LogRepository } from "./repository/log";
import { UserRepository } from "./repository/user";
import { ConfigRepository } from "./repository/config";
import { TemporalRepository } from "./repository/temporal";

export { pUser, sqlUser };
export { toVectorString } from "../utils/vectors";
export type { SqlParams, SqlValue };

export interface QType {
    insMem: { run: MemoryRepository["insMem"] };
    insMems: { run: MemoryRepository["insMems"] };
    updMeanVec: { run: MemoryRepository["updMeanVec"] };
    updCompressedVec: { run: MemoryRepository["updCompressedVec"] };
    updFeedback: { run: MemoryRepository["updFeedback"] };
    updSeen: { run: MemoryRepository["updSeen"] };
    updSaliences: { run: MemoryRepository["updSaliences"] };
    updSummary: { run: MemoryRepository["updSummary"] };
    updMem: { run: MemoryRepository["updMem"] };
    updSector: { run: MemoryRepository["updSector"] };
    delMem: { run: MemoryRepository["delMem"] };
    delMems: { run: MemoryRepository["delMems"] };
    getMem: { get: MemoryRepository["getMem"] };
    getMems: { all: MemoryRepository["getMems"] };
    getMemBySimhash: { get: MemoryRepository["getMemBySimhash"] };
    getStats: { get: MemoryRepository["getStats"] };
    getSegmentCount: { get: MemoryRepository["getSegmentCount"] };
    getMemCount: { get: MemoryRepository["getMemCount"] };
    allMem: { all: MemoryRepository["allMem"] };
    allMemByUser: { all: MemoryRepository["allMemByUser"] };
    allMemStable: { all: MemoryRepository["allMemStable"] };
    allMemCursor: { all: MemoryRepository["allMemCursor"] };
    allMemBySector: { all: MemoryRepository["allMemBySector"] };
    allMemBySectorAndTag: { all: MemoryRepository["allMemBySectorAndTag"] };
    searchMemsByKeyword: { all: MemoryRepository["searchByKeyword"] };
    hsgSearch: { all: MemoryRepository["hsgSearch"] };
    getSegments: { all: MemoryRepository["getSegments"] };

    // Temporal Repo
    findActiveFact: { get: TemporalRepository["findActiveFact"] };
    updateFactConfidence: { run: TemporalRepository["updateFactConfidence"] };
    getOverlappingFacts: { all: TemporalRepository["getOverlappingFacts"] };
    closeFact: { run: TemporalRepository["closeFact"] };
    insertFactRaw: { run: TemporalRepository["insertFactRaw"] };
    updateFactRaw: { run: TemporalRepository["updateFactRaw"] };
    findActiveEdge: { get: TemporalRepository["findActiveEdge"] };
    updateEdgeWeight: { run: TemporalRepository["updateEdgeWeight"] };
    getOverlappingEdges: { all: TemporalRepository["getOverlappingEdges"] };
    closeEdge: { run: TemporalRepository["closeEdge"] };
    insertEdgeRaw: { run: TemporalRepository["insertEdgeRaw"] };
    updateEdgeRaw: { run: TemporalRepository["updateEdgeRaw"] };
    deleteEdgeRaw: { run: TemporalRepository["deleteEdgeRaw"] };
    applyConfidenceDecay: { run: TemporalRepository["applyConfidenceDecay"] };
    getFact: { get: TemporalRepository["getFact"] };
    getEdge: { get: TemporalRepository["getEdge"] };
    getActiveFactCount: { get: TemporalRepository["getActiveFactCount"] };
    getActiveEdgeCount: { get: TemporalRepository["getActiveEdgeCount"] };

    // Temporal Queries
    queryFactsAtTime: { all: TemporalRepository["queryFactsAtTime"] };
    getCurrentFact: { get: TemporalRepository["getCurrentFact"] };
    queryFactsInRange: { all: TemporalRepository["queryFactsInRange"] };
    findConflictingFacts: { all: TemporalRepository["findConflictingFacts"] };
    getFactsBySubject: { all: TemporalRepository["getFactsBySubject"] };
    searchFacts: { all: TemporalRepository["searchFacts"] };
    getRelatedFacts: { all: TemporalRepository["getRelatedFacts"] };
    queryEdges: { all: TemporalRepository["queryEdges"] };
    getFactsByPredicate: { all: TemporalRepository["getFactsByPredicate"] };
    getChangesInWindow: { all: TemporalRepository["getChangesInWindow"] };
    getVolatileFacts: { all: TemporalRepository["getVolatileFacts"] };

    insWaypoint: { run: WaypointRepository["insWaypoint"] };
    insWaypoints: { run: WaypointRepository["insWaypoints"] };
    getWaypoint: { get: WaypointRepository["getWaypoint"] };
    getWaypointsBySrc: { all: WaypointRepository["getWaypointsBySrc"] };
    getNeighbors: { all: WaypointRepository["getNeighbors"] };
    updWaypoint: { run: WaypointRepository["updWaypoint"] };
    pruneWaypoints: { run: WaypointRepository["pruneWaypoints"] };
    getLowSalienceMemories: { all: WaypointRepository["getLowSalienceMemories"] };
    delOrphanWaypoints: { run: WaypointRepository["delOrphanWaypoints"] };

    insLog: { run: LogRepository["insLog"] };
    updLog: { run: LogRepository["updLog"] };
    getPendingLogs: { all: LogRepository["getPendingLogs"] };
    getFailedLogs: { all: LogRepository["getFailedLogs"] };
    insMaintLog: { run: LogRepository["insMaintLog"] };
    logMaintOp: { run: LogRepository["logMaintOp"] };
    getMaintenanceLogs: { all: LogRepository["getMaintenanceLogs"] };

    insUser: { run: UserRepository["insUser"] };
    getUser: { get: (userId: string | null | undefined) => Promise<any> };
    updUserSummary: { run: UserRepository["updUserSummary"] };
    delUser: { run: UserRepository["delUser"] };
    getActiveUsers: { all: UserRepository["getActiveUsers"] };
    getUsers: { all: UserRepository["getUsers"] };

    insSourceConfig: { run: ConfigRepository["insSourceConfig"] };
    updSourceConfig: { run: ConfigRepository["updSourceConfig"] };
    getSourceConfig: { get: ConfigRepository["getSourceConfig"] };
    getSourceConfigsByUser: { all: ConfigRepository["getSourceConfigsByUser"] };
    delSourceConfig: { run: ConfigRepository["delSourceConfig"] };
    insApiKey: { run: ConfigRepository["insApiKey"] };
    getApiKey: { get: ConfigRepository["getApiKey"] };
    delApiKey: { run: ConfigRepository["delApiKey"] };
    getApiKeysByUser: { all: ConfigRepository["getApiKeysByUser"] };
    getAllApiKeys: { all: ConfigRepository["getAllApiKeys"] };

    // Common/Specialized
    clearAll: { run: () => Promise<number> };
    getSectorStats: { all: (userId?: string | null) => Promise<SectorStat[]> };
    getRecentActivity: { all: (limit?: number, userId?: string | null) => Promise<any[]> };
    getTopMemories: { all: (limit?: number, userId?: string | null) => Promise<any[]> };
    getSectorTimeline: { all: (sec: string, limit?: number, userId?: string | null) => Promise<any[]> };
    getVecCount: { get: (userId?: string | null) => Promise<{ c: number }> };
    getFactCount: { get: (userId?: string | null) => Promise<{ c: number }> };
    getEdgeCount: { get: (userId?: string | null) => Promise<{ c: number }> };
    getMemByMetadataLike: { all: (pattern: string, userId?: string | null) => Promise<MemoryRow[]> };
    getTrainingData: { all: (userId: string | null | undefined, limit: number) => Promise<Array<{ meanVec: Buffer | Uint8Array; primarySector: string }>> };
    getClassifierModel: { get: (userId: string | null | undefined) => Promise<any> };
    insClassifierModel: { run: (uid: string | null | undefined, w: string, b: string, v: number, ua: number) => Promise<number> };
    getAdminCount: { get: () => Promise<{ count: number } | undefined> };
    getTables: { all: () => Promise<any[]> };

    // Deletion Helpers
    delFactsByUser: { run: (userId: string) => Promise<number> };
    delEdgesByUser: { run: (userId: string) => Promise<number> };
    delLearnedModel: { run: (userId: string) => Promise<number> };
    delSourceConfigsByUser: { run: (userId: string) => Promise<number> };
    delWaypointsByUser: { run: (userId: string) => Promise<number> };
    delEmbedLogsByUser: { run: (userId: string) => Promise<number> };
    delMaintLogsByUser: { run: (userId: string) => Promise<number> };
    delStatsByUser: { run: (userId: string) => Promise<number> };
    delMemByUser: { run: (userId: string) => Promise<number> };
    pruneMemories: { run: (id: string, userId?: string | null) => Promise<number> };
}

// Global Exports
// Implementation moved to bottom to satisfy prefer-const and no-hoisting issues



export async function waitForDb(timeout = 5000) {
    const start = Date.now();
    while (!q) {
        if (Date.now() - start > timeout) throw new Error("Timeout waiting for DB q object");
        await new Promise(r => setTimeout(r, 100));
    }
    return true;
}


// Thread-local state
const dbs = new Map<string, Database>();
const readyStates = new Map<string, boolean>();
const readyPromises = new Map<string, Promise<void> | null>();
const vectorStores = new Map<string, VectorStore>();
const stmt_cache = new Map<string, ReturnType<Database["prepare"]>>();

const getContextId = () => process.env.TEST_WORKER_ID || threadId.toString();

let lifecycle_lock = Promise.resolve();
let tx_lock = Promise.resolve();
const txStorage = new AsyncLocalStorage<{ depth: number; cli?: PoolClient }>();

export const getIsPg = () =>
    env.metadataBackend === "postgres" || env.vectorBackend === "postgres";

export const TABLES = {
    get memories() {
        return getIsPg() ? `"${env.pgSchema}"."${env.pgTable}"` : "memories";
    },
    get vectors() {
        return getIsPg()
            ? `"${env.pgSchema}"."${env.pgTable}_vectors"`
            : env.vectorTable || "vectors";
    },
    get waypoints() {
        return getIsPg()
            ? `"${env.pgSchema}"."${env.pgTable}_waypoints"`
            : "waypoints";
    },
    get users() {
        return getIsPg()
            ? `"${env.pgSchema}"."${env.usersTable || "users"}"`
            : "users";
    },
    get stats() {
        return getIsPg() ? `"${env.pgSchema}"."${env.pgTable}_stats"` : "stats";
    },
    get maint_logs() {
        return getIsPg()
            ? `"${env.pgSchema}"."${env.pgTable}_maint_logs"`
            : "maint_logs";
    },
    get embed_logs() {
        return getIsPg()
            ? `"${env.pgSchema}"."${env.pgTable}_embed_logs"`
            : "embed_logs";
    },
    get temporal_facts() {
        return getIsPg()
            ? `"${env.pgSchema}"."${env.pgTable}_temporal_facts"`
            : "temporal_facts";
    },
    get temporal_edges() {
        return getIsPg()
            ? `"${env.pgSchema}"."${env.pgTable}_temporal_edges"`
            : "temporal_edges";
    },
    get learned_models() {
        return getIsPg()
            ? `"${env.pgSchema}"."${env.pgTable}_learned_models"`
            : "learned_models";
    },
    get source_configs() {
        return getIsPg()
            ? `"${env.pgSchema}"."${env.pgTable}_source_configs"`
            : "source_configs";
    },
    get api_keys() {
        return getIsPg()
            ? `"${env.pgSchema}"."${env.pgTable}_api_keys"`
            : "api_keys";
    },
};

export const getVectorStore = (): VectorStore => {
    let vs = vectorStores.get(getContextId());
    if (!vs) {
        if (env.vectorBackend === "valkey") {
            vs = new ValkeyVectorStore();
        } else {
            vs = new SqlVectorStore(
                {
                    runAsync,
                    getAsync,
                    allAsync,
                    transaction: transaction.run,
                    iterateAsync,
                },
                TABLES.vectors,
            );
        }
        vectorStores.set(getContextId(), vs);
    }
    return vs;
};

export const vectorStore: VectorStore = {
    getVectorsById: (id, userId) => getVectorStore().getVectorsById(id, userId),
    getVectorsByIds: (ids, userId) =>
        getVectorStore().getVectorsByIds(ids, userId),
    getVector: (id, sector, userId) =>
        getVectorStore().getVector(id, sector, userId),
    searchSimilar: (sector, queryVec, topK, userId, filter) =>
        getVectorStore().searchSimilar(sector, queryVec, topK, userId, filter),
    storeVector: (id, sector, vec, dim, userId, metadata) =>
        getVectorStore().storeVector(id, sector, vec, dim, userId, metadata),
    storeVectors: (items, userId) =>
        getVectorStore().storeVectors(items, userId),
    deleteVector: (id, sector, userId) =>
        getVectorStore().deleteVector(id, sector, userId),
    deleteVectors: (ids, userId) => getVectorStore().deleteVectors(ids, userId),
    deleteVectorsByUser: (userId) => getVectorStore().deleteVectorsByUser(userId),
    getVectorsBySector: (sector, userId) =>
        getVectorStore().getVectorsBySector(sector, userId),
    getAllVectorIds: (userId) => getVectorStore().getAllVectorIds(userId),
    disconnect: async () => {
        await getVectorStore().disconnect?.();
    },
};

let pg: Pool | null = null;
export let hasVector = false;

const pool = (dbOverride?: string) =>
    new Pool({
        user: env.pgUser,
        host: env.pgHost,
        database: dbOverride || env.pgDb,
        password: env.pgPassword,
        port: env.pgPort,
        ssl:
            env.pgSsl === "require"
                ? { rejectUnauthorized: false }
                : env.pgSsl === "disable"
                    ? false
                    : undefined,
        max: env.pgMax,
        idleTimeoutMillis: env.pgIdleTimeout,
        connectionTimeoutMillis: env.pgConnTimeout,
    });

if (getIsPg()) {
    pg = pool();
    pg.on("error", (err) =>
        logger.error("[DB] Unexpected PG error", { error: err }),
    );
}

export const get_sq_db = () => {
    const db_path = env.dbPath || ":memory:";
    // Force shared instance for in-memory DBs to avoid split-brain in tests
    const cacheKey = `${db_path}_${getContextId()}`;

    let d = dbs.get(cacheKey);
    if (d) return d;
    if (db_path !== ":memory:") {
        const dir = path.dirname(db_path);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }
    d = new Database(db_path, { create: true });
    if (db_path !== ":memory:") {
        d.exec("PRAGMA journal_mode=WAL");
        d.exec("PRAGMA synchronous=NORMAL");
        d.exec("PRAGMA foreign_keys = ON;");
    }
    dbs.set(cacheKey, d);
    return d;
};

const init = async () => {
    const release = await (async () => {
        let r: () => void;
        const p = new Promise<void>((resolve) => {
            r = resolve;
        });
        const old = lifecycle_lock;
        lifecycle_lock = p;
        await old;
        return r!;
    })();

    try {
        if (readyStates.get(getContextId())) return;
        if (getIsPg()) {
            try {
                await pg!.query("SELECT 1");
            } catch (err: unknown) {
                if ((err as { code?: string }).code === "3D000") {
                    const admin = pool("postgres");
                    try {
                        await admin.query(`CREATE DATABASE ${env.pgDb} `);
                    } catch (e: unknown) {
                        if ((e as { code?: string }).code !== "42P04") throw e;
                    } finally {
                        await admin.end();
                    }
                    await pg!.query("SELECT 1");
                } else throw err;
            }
            await pg!.query("CREATE EXTENSION IF NOT EXISTS vector");
            hasVector =
                (
                    await pg!.query(
                        "SELECT 1 FROM pg_extension WHERE extname='vector'",
                    )
                ).rowCount! > 0;
            const vt = hasVector ? "vector" : "bytea";
            const sc = env.pgSchema;
            await pg!.query(`CREATE SCHEMA IF NOT EXISTS "${sc}"`);
            await pg!.query(`SET search_path TO "${sc}", public`);

            // Parallel Table Creation
            await Promise.all([
                pg!.query(`create table if not exists ${TABLES.memories} (id uuid primary key, user_id text, segment integer default 0, content text not null, simhash text, primary_sector text not null, tags text, metadata text, created_at bigint, updated_at bigint, last_seen_at bigint, salience double precision, decay_lambda double precision, version integer default 1, mean_dim integer, mean_vec ${vt},compressed_vec bytea, feedback_score double precision default 0, generated_summary text, coactivations integer default 0)`),
                pg!.query(`create table if not exists ${TABLES.vectors} (id uuid, sector text, user_id text, v ${vt},dim integer not null, metadata text, primary key(id, sector))`),
                pg!.query(`create table if not exists ${TABLES.waypoints} (src_id text, dst_id text not null, user_id text, weight double precision not null, created_at bigint, updated_at bigint, primary key(src_id, dst_id, user_id))`),
                pg!.query(`create table if not exists ${TABLES.embed_logs} (id text primary key, user_id text, model text, status text, ts bigint, err text)`),
                pg!.query(`create table if not exists ${TABLES.users} (user_id text primary key, summary text, reflection_count integer default 0, created_at bigint, updated_at bigint)`),
                pg!.query(`create table if not exists ${TABLES.stats} (id serial primary key, type text not null, count integer default 1, ts bigint not null, user_id text)`),
                pg!.query(`create table if not exists ${TABLES.maint_logs} (id serial primary key, op text not null, status text not null, details text, ts bigint not null, user_id text)`),
                pg!.query(`create table if not exists ${TABLES.temporal_facts} (id text primary key, user_id text, subject text not null, predicate text not null, object text not null, valid_from bigint not null, valid_to bigint, confidence double precision not null, last_updated bigint not null, metadata text)`),
                pg!.query(`create table if not exists ${TABLES.temporal_edges} (id text primary key, user_id text, source_id text not null, target_id text not null, relation_type text not null, valid_from bigint not null, valid_to bigint, weight double precision not null, metadata text, last_updated bigint)`),
                pg!.query(`create table if not exists ${TABLES.learned_models} (user_id text primary key, weights text, biases text, version integer default 1, updated_at bigint)`),
                pg!.query(`create table if not exists ${TABLES.source_configs} (user_id text, type text, config text not null, status text default 'enabled', created_at bigint, updated_at bigint, primary key(user_id, type))`),
                pg!.query(`create table if not exists ${TABLES.api_keys} (key_hash text primary key, user_id text not null, role text not null default 'user', note text, created_at bigint, updated_at bigint, expires_at bigint)`),
            ]);

            // Auto-Migration for coactivations
            await pg!.query(`ALTER TABLE ${TABLES.memories} ADD COLUMN IF NOT EXISTS coactivations integer DEFAULT 0`).catch(() => { });

            // Parallel Index Creation
            const indices = [
                `create index if not exists idx_mem_user on ${TABLES.memories} (user_id)`,
                `create index if not exists idx_mem_sector on ${TABLES.memories} (primary_sector)`,
                `create index if not exists idx_tf_subj on ${TABLES.temporal_facts} (subject)`,
                `create index if not exists idx_tf_obj on ${TABLES.temporal_facts} (object)`,
                `create index if not exists idx_tf_subj_pred on ${TABLES.temporal_facts} (subject, predicate)`,
                `create index if not exists idx_tf_user_pred on ${TABLES.temporal_facts} (user_id, predicate)`,
                `create index if not exists idx_tf_user_subj_pred on ${TABLES.temporal_facts} (user_id, subject, predicate)`,
                `create index if not exists idx_tf_temporal on ${TABLES.temporal_facts} (valid_from, valid_to)`,
                `create index if not exists idx_te_src on ${TABLES.temporal_edges} (source_id)`,
                `create index if not exists idx_te_tgt on ${TABLES.temporal_edges} (target_id)`,
                `create index if not exists idx_te_full on ${TABLES.temporal_edges} (source_id, target_id, relation_type)`,
                `create index if not exists idx_te_user_rel on ${TABLES.temporal_edges} (user_id, relation_type)`,
            ];
            await Promise.all(indices.map(sql => pg!.query(sql)));

            // Optimization Indices
            await pg!.query(
                `create index if not exists idx_mem_user_created on ${TABLES.memories} (user_id, created_at DESC)`,
            );
            await pg!.query(
                `create index if not exists idx_mem_user_lastseen on ${TABLES.memories} (user_id, last_seen_at DESC)`,
            );
            await pg!.query(
                `create index if not exists idx_mem_user_segment on ${TABLES.memories} (user_id, segment DESC)`,
            );
            await pg!.query(
                `create index if not exists idx_vec_user on ${TABLES.vectors} (user_id)`,
            );
            await pg!.query(
                `create index if not exists idx_vec_user_sector on ${TABLES.vectors} (user_id, sector)`,
            );
            await pg!.query(
                `create index if not exists idx_mem_user_salience on ${TABLES.memories} (user_id, salience DESC)`,
            );
            await pg!.query(
                `create index if not exists idx_mem_simhash on ${TABLES.memories} (simhash)`,
            );

            if (hasVector && env.vectorBackend === "postgres") {
                await pg!
                    .query(
                        `create index if not exists idx_vec_hnsw on ${TABLES.vectors} using hnsw (v vector_cosine_ops) WITH(m = 16, ef_construction = 64)`,
                    )
                    .catch((e) => {
                        logger.warn(
                            "[DB] HNSW index creation failed (might be expected if not enough rows or old pgvector):",
                            { error: e },
                        );
                    });
            }
            if (env.vectorBackend === "valkey") {
                vectorStores.set(getContextId(), new ValkeyVectorStore());
            } else {
                vectorStores.set(
                    getContextId(),
                    new SqlVectorStore(
                        {
                            runAsync,
                            getAsync,
                            allAsync,
                            transaction: transaction.run,
                            iterateAsync,
                        },
                        TABLES.vectors,
                    ),
                );
            }
        } else {
            const d = get_sq_db();
            d.exec(
                `create table if not exists ${TABLES.memories} (id text primary key, segment integer default 0, content text not null, simhash text, primary_sector text not null, tags text, metadata text, created_at integer, updated_at integer, last_seen_at integer, salience real, decay_lambda real, version integer default 1, user_id text, mean_dim integer, mean_vec blob, compressed_vec blob, feedback_score real default 0, generated_summary text, coactivations integer default 0)`,
            );
            d.exec(
                `create table if not exists ${TABLES.vectors} (id text, sector text, user_id text, v blob, dim integer not null, metadata text, primary key(id, sector))`,
            );
            d.exec(
                `create table if not exists ${TABLES.waypoints}(src_id text, dst_id text not null, user_id text, weight real not null, created_at integer, updated_at integer, primary key(src_id, dst_id, user_id))`,
            );
            d.exec(
                `create table if not exists ${TABLES.embed_logs}(id text primary key, user_id text, model text, status text, ts integer, err text)`,
            );
            d.exec(
                `create table if not exists ${TABLES.users}(user_id text primary key, summary text, reflection_count integer default 0, created_at integer, updated_at integer)`,
            );
            d.exec(
                `create table if not exists ${TABLES.stats}(id integer primary key autoincrement, type text not null, count integer default 1, ts integer not null, user_id text)`,
            );
            d.exec(
                `create table if not exists ${TABLES.maint_logs}(id integer primary key autoincrement, op text not null, status text not null, details text, ts integer not null, user_id text)`,
            );
            d.exec(
                `create table if not exists ${TABLES.temporal_facts}(id text primary key, user_id text, subject text not null, predicate text not null, object text not null, valid_from integer not null, valid_to integer, confidence real not null, last_updated integer not null, metadata text)`,
            );
            d.exec(
                `create table if not exists ${TABLES.temporal_edges}(id text primary key, user_id text, source_id text not null, target_id text not null, relation_type text not null, valid_from integer not null, valid_to integer, weight real not null, metadata text, last_updated integer)`,
            );
            d.exec(
                `create table if not exists ${TABLES.learned_models}(user_id text primary key, weights text, biases text, version integer default 1, updated_at integer)`,
            );
            d.exec(
                `create table if not exists ${TABLES.source_configs} (user_id text, type text, config text not null, status text default 'enabled', created_at integer, updated_at integer, primary key(user_id, type))`,
            );
            d.exec(
                `create table if not exists ${TABLES.api_keys} (key_hash text primary key, user_id text not null, role text not null default 'user', note text, created_at integer, updated_at integer, expires_at integer)`,
            );

            // SQLite Auto-Migration for coactivations
            try { d.exec(`ALTER TABLE memories ADD COLUMN coactivations integer DEFAULT 0`); } catch (e) { }

            d.exec(`create index if not exists idx_mem_user on memories(user_id)`);
            d.exec(`create index if not exists idx_vec_user_sector on vectors(user_id, sector)`);
            d.exec(`create index if not exists idx_tf_subj on temporal_facts(subject)`);
            d.exec(`create index if not exists idx_tf_obj on temporal_facts(object)`);
            d.exec(`create index if not exists idx_tf_subj_pred on temporal_facts(subject, predicate)`);
            d.exec(`create index if not exists idx_tf_user_pred on temporal_facts(user_id, predicate)`);
            d.exec(`create index if not exists idx_tf_user_subj_pred on temporal_facts(user_id, subject, predicate)`);
            d.exec(`create index if not exists idx_tf_temporal on temporal_facts(valid_from, valid_to)`);
            d.exec(`create index if not exists idx_te_src on temporal_edges(source_id)`);
            d.exec(`create index if not exists idx_te_tgt on temporal_edges(target_id)`);
            d.exec(`create index if not exists idx_te_full on temporal_edges(source_id, target_id, relation_type)`);
            d.exec(`create index if not exists idx_te_user_rel on temporal_edges(user_id, relation_type)`);

            // Optimization Indices
            d.exec(
                `create index if not exists idx_mem_user_created on memories(user_id, created_at DESC)`,
            );
            d.exec(
                `create index if not exists idx_mem_user_lastseen on memories(user_id, last_seen_at DESC)`,
            );
            d.exec(
                `create index if not exists idx_mem_user_segment on memories(user_id, segment DESC)`,
            );
            d.exec(
                `create index if not exists idx_vec_user on vectors(user_id)`,
            );
            d.exec(
                `create index if not exists idx_mem_user_salience on memories(user_id, salience DESC)`,
            );
            d.exec(
                `create index if not exists idx_mem_simhash on memories(simhash)`,
            );

            if (env.vectorBackend === "valkey") {
                vectorStores.set(getContextId(), new ValkeyVectorStore());
            } else {
                vectorStores.set(
                    getContextId(),
                    new SqlVectorStore(
                        { runAsync, getAsync, allAsync, iterateAsync },
                        TABLES.vectors,
                    ),
                );
            }
        }
        readyStates.set(getContextId(), true);
    } finally {
        release();
    }
};

export const waitReady = async () => {
    if (readyStates.get(getContextId())) return;
    let p = readyPromises.get(getContextId());
    if (!p) {
        p = init();
        readyPromises.set(getContextId(), p);
    }
    await p;
    readyPromises.set(getContextId(), null);
};

export async function closeDb() {
    const release = await (async () => {
        let r: () => void;
        const p = new Promise<void>((resolve) => {
            r = resolve;
        });
        const old = lifecycle_lock;
        lifecycle_lock = p;
        await old;
        return r!;
    })();
    try {
        const d = dbs.get(getContextId());
        if (d) {
            d.close();
            dbs.delete(getContextId());
        }
        if (pg) {
            await pg.end();
            pg = null;
        }
        readyStates.delete(getContextId());
        readyPromises.delete(getContextId());
        vectorStores.delete(getContextId());
        stmt_cache.clear();
    } finally {
        release();
    }
};

/**
 * Converts `? ` placeholders to `$N` for PostgreSQL compatibility.
 * Safely ignores `? ` (and strings containing ` ? `) inside single/double quotes.
 */
export function convertPlaceholders(sql: string): string {
    if (!getIsPg()) return sql;
    let index = 1;
    // Regex matches single-quoted strings, double-quoted strings, or the placeholder ?
    return sql.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|\?/g, (match) => {
        if (match === "?") {
            return `$${index++}`;
        }
        return match;
    });
}

const execRes = async (sql: string, p: SqlParams = []) => {
    const ctx = txStorage.getStore();
    // Sanitize parameters for SQLite/PG strictness
    const safeP = p.map((v) => {
        if (v === undefined) return null;
        if (Array.isArray(v) && !((v as unknown) instanceof Uint8Array))
            return null;
        return v;
    });

    if (getIsPg()) {
        const c = ctx?.cli || pg;
        if (!c) throw new Error("PG not initialized");
        return await c.query(convertPlaceholders(sql), safeP);
    } else {
        const d = get_sq_db();
        // Use stmt_cache for sustainability
        let stmt = stmt_cache.get(sql);
        if (!stmt) {
            stmt = d.prepare(sql);
            stmt_cache.set(sql, stmt);
        }
        const res = stmt.run(...(safeP as (string | number | boolean | Buffer | null)[]));
        return { rows: [], rowCount: res.changes };
    }
};

/**
 * Maps a database row to its camelCase TypeScript equivalent.
 */
const mapRow = (
    row: Record<string, unknown> | null,
): Record<string, unknown> | null => {
    if (!row) return row;

    // Strict mapping to ensure only camelCase keys exist, preventing ambiguity and memory bloat.
    const mapped: Record<string, unknown> = {};

    // Common Fields (Direct Copy)
    const directKeys = ["id", "content", "tags", "metadata", "segment", "simhash", "salience", "version", "coactivations", "role", "note", "type", "config", "status", "count", "ts", "op", "details", "subject", "predicate", "object", "weights", "biases", "err", "model"];
    for (const k of directKeys) {
        if (row[k] !== undefined) mapped[k] = row[k];
    }

    // Mapped Fields (snake_case -> camelCase)
    // Memories / Vectors
    if (row.user_id !== undefined) mapped.userId = row.user_id;
    if (row.primary_sector !== undefined) {
        mapped.primarySector = row.primary_sector;
    }
    if (row.created_at !== undefined) mapped.createdAt = Number(row.created_at);
    if (row.updated_at !== undefined) mapped.updatedAt = Number(row.updated_at);
    if (row.last_seen_at !== undefined) mapped.lastSeenAt = Number(row.last_seen_at);
    if (row.decay_lambda !== undefined) mapped.decayLambda = row.decay_lambda;
    if (row.feedback_score !== undefined) mapped.feedbackScore = row.feedback_score;
    if (row.generated_summary !== undefined) mapped.generatedSummary = row.generated_summary;
    if (row.mean_dim !== undefined) mapped.meanDim = row.mean_dim;
    if (row.mean_vec !== undefined) mapped.meanVec = row.mean_vec;
    if (row.compressed_vec !== undefined) mapped.compressedVec = row.compressed_vec;

    // Temporal
    if (row.valid_from !== undefined) mapped.validFrom = Number(row.valid_from);
    if (row.valid_to !== undefined) mapped.validTo = row.valid_to ? Number(row.valid_to) : null;
    if (row.last_updated !== undefined) mapped.lastUpdated = Number(row.last_updated);
    if (row.source_id !== undefined) mapped.sourceId = row.source_id;
    if (row.target_id !== undefined) mapped.targetId = row.target_id;
    if (row.relation_type !== undefined) mapped.relationType = row.relation_type;

    // Keys / Users
    if (row.key_hash !== undefined) mapped.keyHash = row.key_hash;
    if (row.expires_at !== undefined) mapped.expiresAt = Number(row.expires_at);
    if (row.reflection_count !== undefined) mapped.reflectionCount = row.reflection_count;

    // Fallback: If we have aliased keys (e.g. "count as cnt"), allow them if they are already camelCase-ish? 
    // Actually, SQL aliases like `as userId` in queries might be used.
    // If the input row ALREADY has a camelCase key, preserve it.
    for (const k of Object.keys(row)) {
        // If it's NOT in our list of mapped snake_keys AND it looks like camelCase (or at least not snake), keep it?
        // Simple heuristic: if it contains `_`, skip it (unless it's a known underscore key we want? NO, we want consistent camel).
        // Exceptions: `app_id` etc if we ever add them.
        // Better: If mapped[k] is set, skip. If not set, and it's not a known snake key...

        // This is risky. Better to just trust the mappings above for CORE tables.
        // But `select count(*) as count` returns `count`. Added to directKeys.
        // `select ... as avgSalience` returns `avgSalience`.

        if (mapped[k] === undefined && !k.includes("_")) {
            mapped[k] = row[k];
        }
    }

    return mapped;
};

const execAll = async <T>(sql: string, p: SqlParams = []) => {
    let rows: Record<string, unknown>[];
    if (getIsPg()) {
        rows = (await execRes(sql, p)).rows;
    } else {
        const d = get_sq_db();
        let stmt = stmt_cache.get(sql);
        if (!stmt) {
            stmt = d.prepare(sql);
            stmt_cache.set(sql, stmt);
        }
        rows = stmt.all(...(p as (string | number | boolean | Buffer | null)[])) as Record<string, unknown>[];
    }
    return rows.map(mapRow) as T[];
};

export async function runAsync(sql: string, p: SqlParams = []) {
    await waitReady();
    return (await execRes(sql, p)).rowCount || 0;
}

export async function getAsync<T = unknown>(sql: string, p: SqlParams = []): Promise<T | undefined> {
    await waitReady();
    const rows = await execAll(sql, p);

    return rows[0] as T | undefined;
}
export async function allAsync<T = unknown>(sql: string, p: SqlParams = []): Promise<T[]> {
    await waitReady();
    return (await execAll(sql, p)) as T[];
}

export async function* iterateAsync<T = unknown>(
    sql: string,
    p: SqlParams = [],
): AsyncIterable<T> {
    await waitReady();

    // Sanitize parameters
    const safeP = p.map((v) => {
        if (v === undefined) return null;
        if (Array.isArray(v) && !((v as unknown) instanceof Uint8Array))
            return null;
        return v;
    });

    if (getIsPg()) {
        // PG Fallback: Load all (since we lack pg-cursor dependency)
        // Note: For PG vector search, we rely on server-side pgvector anyway.
        const rows = (await execAll(sql, p)) as T[];
        for (const row of rows) yield row;
    } else {
        // SQLite Streaming
        const d = get_sq_db();
        let stmt = stmt_cache.get(sql);
        if (!stmt) {
            stmt = d.prepare(sql);
            stmt_cache.set(sql, stmt);
        }

        // Bun SQLite iterate returns an Iterable, which we yield from asynchronously
        // Cast params safely for Bun's strict typing
        const iterator = stmt.iterate(...(safeP as any[]));
        for (const row of iterator) {
            yield mapRow(row as Record<string, unknown>) as T;
        }
    }
}

export const transaction = {
    run: async <T>(fn: () => Promise<T>): Promise<T> => {
        const ctx = txStorage.getStore();
        if (ctx) {
            ctx.depth++;
            try {
                return await fn();
            } finally {
                ctx.depth--;
            }
        }

        const txId = Math.random().toString(36).substring(7);
        const { getContext } = await import("./context");
        const sysCtx = getContext();
        const currentDepth = (ctx as any)?.depth || 0;

        if (getIsPg()) {
            if (!pg) {
                // If we are in "PG Mode" but PG is not initialized (e.g. tests switched env vars mid-process),
                // we must fail gracefully or fallback. Since this is likely a test artifact or startup race, throw clear error.
                throw new Error("DB Connection Error: Postgres enabled but client not initialized. Restart required on config change.");
            }
            const client = await pg.connect();
            logger.debug(`[DB][TX:${txId}]BEGIN(PG), depth: ${currentDepth + 1}, rid: ${sysCtx?.requestId} `);
            try {
                return await txStorage.run(
                    { depth: currentDepth + 1, cli: client },
                    async () => {
                        await client.query("BEGIN");
                        try {
                            const res = await fn();
                            await client.query("COMMIT");
                            logger.debug(`[DB][TX:${txId}]COMMIT(PG)`);
                            return res;
                        } catch (e) {
                            await client.query("ROLLBACK");
                            logger.warn(`[DB][TX:${txId}]ROLLBACK(PG)`, { error: e });
                            throw e;
                        }
                    },
                );
            } finally {
                client.release();
            }
        } else {
            const d = get_sq_db();
            const release = await (async () => {
                let r: () => void;
                const p = new Promise<void>((resolve) => {
                    r = resolve;
                });
                const old = tx_lock;
                tx_lock = p;
                await old;
                return r!;
            })();
            logger.debug(`[DB][TX:${txId}]BEGIN(SQLite), depth: ${currentDepth + 1}, rid: ${sysCtx?.requestId} `);
            try {
                return await txStorage.run({ depth: currentDepth + 1 }, async () => {
                    try {
                        d.exec("BEGIN IMMEDIATE TRANSACTION");
                        const res = await fn();
                        d.exec("COMMIT");
                        logger.debug(`[DB][TX:${txId}]COMMIT(SQLite)`);
                        return res;
                    } catch (e) {
                        try {
                            d.exec("ROLLBACK");
                            logger.warn(`[DB][TX:${txId}]ROLLBACK(SQLite)`, { error: e });
                        } catch { }
                        throw e;
                    }
                });
            } finally {
                release();
            }
        }
    },
};




const repos = new Map<string, any>();

function getRepo<T>(Class: new (...args: any[]) => T): T {
    const ctxId = getContextId();
    const key = `${Class.name}:${ctxId}`;
    let repo = repos.get(key);
    if (!repo) {
        repo = new Class({
            runAsync,
            getAsync,
            allAsync,
            transaction,
        });
        repos.set(key, repo);
    }
    return repo;
}

const getMemRepo = () => getRepo(MemoryRepository);
const getWaypointRepo = () => getRepo(WaypointRepository);
const getLogRepo = () => getRepo(LogRepository);
const getUserRepo = () => getRepo(UserRepository);
const getConfigRepo = () => getRepo(ConfigRepository);
const getTemporalRepo = () => getRepo(TemporalRepository);

// Wrapper helpers for safe injection
export const runUser = async (sql: string, params: SqlParams, userId: string | null | undefined): Promise<number> => {
    const { sql: s, params: p } = applySqlUser(sql, params, userId);
    return await runAsync(s, p);
};

export const getUser = async <T = unknown>(sql: string, params: SqlParams, userId: string | null | undefined): Promise<T | undefined> => {
    const { sql: s, params: p } = applySqlUser(sql, params, userId);
    return await getAsync<T>(s, p);
};

export const allUser = async <T = unknown>(sql: string, params: SqlParams, userId: string | null | undefined): Promise<T[]> => {
    const { sql: s, params: p } = applySqlUser(sql, params, userId);
    return await allAsync<T>(s, p);
};

// Main SQL Interface
export const q: QType = {
    insMem: { run: (...args) => getMemRepo().insMem(...args) },
    insMems: { run: (...args) => getMemRepo().insMems(...args) },
    updMeanVec: { run: (...args) => getMemRepo().updMeanVec(...args) },
    updCompressedVec: { run: (...args) => getMemRepo().updCompressedVec(...args) },
    updFeedback: { run: (...args) => getMemRepo().updFeedback(...args) },
    updSeen: { run: (...args) => getMemRepo().updSeen(...args) },
    updSaliences: { run: (...args) => getMemRepo().updSaliences(...args) },
    updSummary: { run: (...args) => getMemRepo().updSummary(...args) },
    updMem: { run: (...args) => getMemRepo().updMem(...args) },
    updSector: { run: (...args) => getMemRepo().updSector(...args) },
    delMem: { run: (...args) => getMemRepo().delMem(...args) },
    delMems: { run: (...args) => getMemRepo().delMems(...args) },
    getMem: { get: (...args) => getMemRepo().getMem(...args) },
    getMems: { all: (...args) => getMemRepo().getMems(...args) },
    getMemBySimhash: { get: (...args) => getMemRepo().getMemBySimhash(...args) },
    clearAll: {
        run: async () => {
            const tables = [TABLES.memories, TABLES.vectors, TABLES.waypoints, TABLES.users, TABLES.temporal_facts, TABLES.temporal_edges, TABLES.source_configs, TABLES.embed_logs, TABLES.maint_logs, TABLES.stats, TABLES.learned_models];
            for (const t of tables) await runAsync(`delete from ${t}`);
            return 1;
        },
    },
    getStats: { get: (userId?: string | null) => getMemRepo().getStats(userId) },
    getSectorStats: { all: (userId?: string | null) => getMemRepo().getSectorStats(userId) },
    getRecentActivity: { all: (limit = 10, userId?: string | null) => getMemRepo().getRecentActivity(limit, userId) },
    getTopMemories: { all: (limit = 10, userId?: string | null) => getMemRepo().getTopMemories(limit, userId) },
    getSectorTimeline: { all: (sec: string, limit = 50, userId?: string | null) => getMemRepo().getSectorTimeline(sec, limit, userId) },
    getMaintenanceLogs: { all: (limit = 50, userId?: string | null) => getLogRepo().getMaintenanceLogs(limit, userId) },
    getSegmentCount: { get: (seg: number, userId?: string | null) => getMemRepo().getSegmentCount(seg, userId) },
    getSegments: { all: (userId?: string | null) => getMemRepo().getSegments(userId) },
    getMemCount: { get: (userId?: string | null) => getMemRepo().getMemCount(userId) },
    getVecCount: { get: (userId?: string | null) => getMemRepo().getVecCount(userId) },
    getFactCount: { get: (userId?: string | null) => getTemporalRepo().getFactCount(userId) },
    getEdgeCount: { get: (userId?: string | null) => getTemporalRepo().getEdgeCount(userId) },
    allMemByUser: { all: (uid: string, limit: number, offset: number) => getMemRepo().allMemByUser(uid, limit, offset) },
    allMem: { all: (limit: number, offset: number, userId?: string | null) => getMemRepo().allMem(limit, offset, userId) },
    allMemStable: { all: (limit: number, offset: number, userId?: string | null) => getMemRepo().allMemStable(limit, offset, userId) },
    allMemCursor: { all: (limit: number, cursor: { createdAt: number; id: string } | null, userId?: string | null) => getMemRepo().allMemCursor(limit, cursor, userId) },
    allMemBySector: { all: (sec: string, limit: number, offset: number, userId?: string | null) => getMemRepo().allMemBySector(sec, limit, offset, userId) },
    allMemBySectorAndTag: { all: (sec: string, tag: string, limit: number, offset: number, userId?: string | null) => getMemRepo().allMemBySectorAndTag(sec, tag, limit, offset, userId) },
    searchMemsByKeyword: { all: (keyword: string, limit: number, userId?: string | null) => getMemRepo().searchByKeyword(keyword, limit, userId) },
    insWaypoint: { run: (src: string, dst: string, userId: string | null | undefined, w: number, ca: number, ua: number) => getWaypointRepo().insWaypoint(src, dst, userId, w, ca, ua) },
    insWaypoints: { run: (items: import("./types").BatchWaypointInsertItem[]) => getWaypointRepo().insWaypoints(items) },
    getWaypoint: { get: (src: string, dst: string, userId?: string | null) => getWaypointRepo().getWaypoint(src, dst, userId) },
    getWaypointsBySrc: { all: (src: string, userId?: string | null) => getWaypointRepo().getWaypointsBySrc(src, userId) },
    getNeighbors: { all: (src: string, userId?: string | null) => getWaypointRepo().getNeighbors(src, userId) },
    updWaypoint: { run: (src: string, dst: string, userId: string | null | undefined, w: number, ua: number) => getWaypointRepo().updWaypoint(src, dst, userId, w, ua) },
    pruneWaypoints: { run: (threshold: number, userId?: string | null) => getWaypointRepo().pruneWaypoints(threshold, userId) },
    getLowSalienceMemories: { all: (threshold: number, limit: number, userId?: string | null) => getWaypointRepo().getLowSalienceMemories(threshold, limit, userId) },
    pruneMemories: { run: (id: string, userId?: string | null) => getMemRepo().delMem(id, userId) },
    insMaintLog: { run: (userId: string | null | undefined, status: string, details: string, ts: number) => getLogRepo().insMaintLog(userId, status, details, ts) },
    logMaintOp: { run: (op: string, status: string, details: string, ts: number, userId?: string | null) => getLogRepo().logMaintOp(op, status, details, ts, userId) },
    insLog: { run: (id: string, userId: string | null | undefined, model: string, status: string, ts: number, err: string | null) => getLogRepo().insLog(id, userId, model, status, ts, err) },
    updLog: { run: (id: string, status: string, err: string | null) => getLogRepo().updLog(id, status, err) },
    getPendingLogs: { all: (userId?: string | null) => getLogRepo().getPendingLogs(userId) },
    getFailedLogs: { all: (userId?: string | null) => getLogRepo().getFailedLogs(userId) },
    insUser: { run: (userId: string | null | undefined, summary: string, rc: number, ca: number, ua: number) => getUserRepo().insUser(userId, summary, rc, ca, ua) },
    getUser: { get: (userId: string | null | undefined) => getUserRepo().getById(userId) },
    updUserSummary: { run: (userId: string | null | undefined, summary: string, ua: number) => getUserRepo().updUserSummary(userId, summary, ua) },
    delMemByUser: { run: (userId: string) => getMemRepo().delMemByUser(userId) },
    delUser: {
        run: async (userId: string) => {
            return await transaction.run(async () => {
                await getMemRepo().delMemByUser(userId);
                await getWaypointRepo().delWaypointsByUser(userId);
                await getTemporalRepo().delFactsByUser(userId);
                await getTemporalRepo().delEdgesByUser(userId);
                await getConfigRepo().delSourceConfigsByUser(userId);
                await getConfigRepo().delLearnedModelByUser(userId);
                await getConfigRepo().delApiKeysByUser(userId);
                await getLogRepo().delEmbedLogsByUser(userId);
                await getLogRepo().delMaintLogsByUser(userId);
                await getUserRepo().delStatsByUser(userId);
                await vectorStore.deleteVectorsByUser(userId);
                return await getUserRepo().delUser(userId);
            });
        }
    },
    delFactsByUser: { run: (userId: string) => getTemporalRepo().delFactsByUser(userId) },
    delEdgesByUser: { run: (userId: string) => getTemporalRepo().delEdgesByUser(userId) },
    delLearnedModel: { run: (userId: string) => getConfigRepo().delLearnedModelByUser(userId) },
    delSourceConfigsByUser: { run: (userId: string) => getConfigRepo().delSourceConfigsByUser(userId) },
    delWaypointsByUser: { run: (userId: string) => getWaypointRepo().delWaypointsByUser(userId) },
    delEmbedLogsByUser: { run: (userId: string) => getLogRepo().delEmbedLogsByUser(userId) },
    delMaintLogsByUser: { run: (userId: string) => getLogRepo().delMaintLogsByUser(userId) },
    delStatsByUser: { run: (userId: string) => getUserRepo().delStatsByUser(userId) },
    getMemByMetadataLike: { all: (pat: string, userId: string | null | undefined) => allUser<MemoryRow>(`select * from ${TABLES.memories} where metadata like ? order by created_at desc`, [`%${pat}%`], userId) },
    getTrainingData: { all: (uid: string | null | undefined, limit: number) => allAsync(`select mean_vec as meanVec, primary_sector as primarySector from ${TABLES.memories} where user_id=? and mean_vec is not null limit ?`, [uid ?? null, limit]) },
    getClassifierModel: { get: (uid: string | null | undefined) => getAsync(`select * from ${TABLES.learned_models} where user_id=?`, [uid ?? null]) },
    insClassifierModel: { run: (uid: string | null | undefined, w: string, b: string, v: number, ua: number) => runAsync(`insert into ${TABLES.learned_models} (user_id, weights, biases, version, updated_at) values(?,?,?,?,?) on conflict(user_id) do update set weights=excluded.weights, biases=excluded.biases, version=excluded.version, updated_at=excluded.updated_at`, [uid ?? null, w, b, v, ua]) },
    getActiveUsers: { all: () => getUserRepo().getActiveUsers() },
    getUsers: { all: (limit = 100, offset = 0) => getUserRepo().getUsers(limit, offset) },
    getTables: { all: () => allAsync(getIsPg() ? `SELECT table_name as name FROM information_schema.tables WHERE table_schema='${env.pgSchema}'` : "SELECT name FROM sqlite_master WHERE type='table'") },
    insSourceConfig: { run: (userId: string | null | undefined, type: string, config: string, status: string, ca: number, ua: number) => getConfigRepo().insSourceConfig(userId, type, config, status, ca, ua) },
    updSourceConfig: { run: (userId: string | null | undefined, type: string, config: string, status: string, ua: number) => getConfigRepo().updSourceConfig(userId, type, config, status, ua) },
    getSourceConfig: { get: (userId: string | null | undefined, type: string) => getConfigRepo().getSourceConfig(userId, type) },
    getSourceConfigsByUser: { all: (userId: string | null | undefined) => getConfigRepo().getSourceConfigsByUser(userId) },
    delSourceConfig: { run: (userId: string | null | undefined, type: string) => getConfigRepo().delSourceConfig(userId, type) },
    insApiKey: { run: (kh: string, uid: string, role: string, note: string | null, ca: number, ua: number, ea: number) => getConfigRepo().insApiKey(kh, uid, role, note, ca, ua, ea) },
    getApiKey: { get: (kh: string) => getConfigRepo().getApiKey(kh) },
    delApiKey: { run: (kh: string) => getConfigRepo().delApiKey(kh) },
    getApiKeysByUser: { all: (userId: string) => getConfigRepo().getApiKeysByUser(userId) },
    getAllApiKeys: { all: () => getConfigRepo().getAllApiKeys() },
    getAdminCount: { get: () => getConfigRepo().getAdminCount() },
    hsgSearch: { all: (ids: string[], userId: string | null | undefined, limit: number, startTime?: number, endTime?: number, minSalience?: number, tau?: number) => getMemRepo().hsgSearch(ids, userId, limit, startTime, endTime, minSalience, tau || 0.5) },
    delOrphanWaypoints: { run: () => getWaypointRepo().delOrphanWaypoints() },

    // Temporal
    findActiveFact: { get: (...args) => getTemporalRepo().findActiveFact(...args) },
    updateFactConfidence: { run: (...args) => getTemporalRepo().updateFactConfidence(...args) },
    getOverlappingFacts: { all: (...args) => getTemporalRepo().getOverlappingFacts(...args) },
    closeFact: { run: (...args) => getTemporalRepo().closeFact(...args) },
    insertFactRaw: { run: (...args) => getTemporalRepo().insertFactRaw(...args) },
    updateFactRaw: { run: (...args) => getTemporalRepo().updateFactRaw(...args) },
    findActiveEdge: { get: (...args) => getTemporalRepo().findActiveEdge(...args) },
    updateEdgeWeight: { run: (...args) => getTemporalRepo().updateEdgeWeight(...args) },
    getOverlappingEdges: { all: (...args) => getTemporalRepo().getOverlappingEdges(...args) },
    closeEdge: { run: (...args) => getTemporalRepo().closeEdge(...args) },
    insertEdgeRaw: { run: (...args) => getTemporalRepo().insertEdgeRaw(...args) },
    updateEdgeRaw: { run: (...args) => getTemporalRepo().updateEdgeRaw(...args) },
    deleteEdgeRaw: { run: (...args) => getTemporalRepo().deleteEdgeRaw(...args) },
    applyConfidenceDecay: { run: (...args) => getTemporalRepo().applyConfidenceDecay(...args) },
    getFact: { get: (...args) => getTemporalRepo().getFact(...args) },
    getEdge: { get: (...args) => getTemporalRepo().getEdge(...args) },
    getActiveFactCount: { get: (...args) => getTemporalRepo().getActiveFactCount(...args) },
    getActiveEdgeCount: { get: (...args) => getTemporalRepo().getActiveEdgeCount(...args) },
    queryFactsAtTime: { all: (...args) => getTemporalRepo().queryFactsAtTime(...args) },
    getCurrentFact: { get: (...args) => getTemporalRepo().getCurrentFact(...args) },
    queryFactsInRange: { all: (...args) => getTemporalRepo().queryFactsInRange(...args) },
    findConflictingFacts: { all: (...args) => getTemporalRepo().findConflictingFacts(...args) },
    getFactsBySubject: { all: (...args) => getTemporalRepo().getFactsBySubject(...args) },
    searchFacts: { all: (...args) => getTemporalRepo().searchFacts(...args) },
    getRelatedFacts: { all: (...args) => getTemporalRepo().getRelatedFacts(...args) },
    queryEdges: { all: (...args) => getTemporalRepo().queryEdges(...args) },
    getFactsByPredicate: { all: (...args) => getTemporalRepo().getFactsByPredicate(...args) },
    getChangesInWindow: { all: (...args) => getTemporalRepo().getChangesInWindow(...args) },
    getVolatileFacts: { all: (...args) => getTemporalRepo().getVolatileFacts(...args) },
};


/**
 * Logs a maintenance operation to the stats table.
 * @param type The type of operation (decay, reflect, consolidate).
 * @param cnt The count of items processed (default 1).
 * @param userId The user context, if any.
 */
export const logMaintOp = async (
    type: "decay" | "reflect" | "consolidate",
    cnt = 1,
    userId?: string | null,
) => {
    try {
        await runAsync(
            `insert into ${TABLES.stats} (type, count, ts, user_id) values(?,?,?,?)`,
            [type, cnt, Date.now(), userId ?? null],
        );
    } catch (e) {
        logger.error("[DB] logMaintOp error", { error: e });
    }
};
