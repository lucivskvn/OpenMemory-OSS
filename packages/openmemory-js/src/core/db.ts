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
export { pUser, sqlUser };
export type { SqlParams, SqlValue };

export interface QType {
    insMem: {
        run: (
            id: string,
            content: string,
            primarySector: string,
            tags: string | null,
            metadata: string | null,
            userId: string | null | undefined,
            segment: number,
            simhash: string | null,
            createdAt: number,
            updatedAt: number,
            lastSeenAt: number,
            salience: number,
            decayLambda: number,
            version: number,
            meanDim: number,
            meanVec: Buffer | Uint8Array,
            compressedVec: Buffer | Uint8Array,
            feedbackScore: number,
            generatedSummary: string | null,
        ) => Promise<number>;
    };
    insMems: {
        run: (items: BatchMemoryInsertItem[]) => Promise<number>;
    };
    updMeanVec: {
        run: (
            id: string,
            dim: number,
            vec: Buffer | Uint8Array,
            userId?: string | null,
        ) => Promise<number>;
    };
    updCompressedVec: {
        run: (
            id: string,
            vec: Buffer | Uint8Array,
            userId?: string | null,
        ) => Promise<number>;
    };
    updFeedback: {
        run: (
            id: string,
            feedbackScore: number,
            userId?: string | null,
        ) => Promise<number>;
    };
    updSeen: {
        run: (
            id: string,
            lastSeenAt: number,
            salience: number,
            updatedAt: number,
            userId?: string | null,
        ) => Promise<number>;
    };
    updSummary: {
        run: (
            id: string,
            summary: string,
            userId?: string | null,
        ) => Promise<number>;
    };
    updMem: {
        run: (
            content: string,
            primarySector: string,
            tags: string | null,
            metadata: string | null,
            updatedAt: number,
            id: string,
            userId?: string | null,
        ) => Promise<number>;
    };
    updSector: {
        run: (
            id: string,
            sector: string,
            userId?: string | null,
        ) => Promise<number>;
    };
    delMem: { run: (id: string, userId?: string | null) => Promise<number> };
    delMems: {
        run: (ids: string[], userId?: string | null) => Promise<number>;
    };
    getMem: {
        get: (
            id: string,
            userId?: string | null,
        ) => Promise<MemoryRow | undefined>;
    };
    getMems: {
        all: (ids: string[], userId?: string | null) => Promise<MemoryRow[]>;
    };
    getMemRaw: {
        get: (
            id: string,
            userId?: string | null,
        ) => Promise<MemoryRow | undefined>;
    };
    getMemBySimhash: {
        get: (
            simhash: string,
            userId?: string | null,
        ) => Promise<MemoryRow | undefined>;
    };
    clearAll: { run: () => Promise<number> };
    getStats: {
        get: (
            userId?: string | null,
        ) => Promise<{ count: number; avgSalience: number } | undefined>;
    };
    getSectorStats: {
        all: (
            userId?: string | null,
        ) => Promise<
            Array<{ sector: string; count: number; avgSalience: number }>
        >;
    };
    getRecentActivity: {
        all: (
            limit?: number,
            userId?: string | null,
        ) => Promise<
            Array<{
                id: string;
                content: string;
                lastSeenAt: number;
                primarySector: string;
            }>
        >;
    };
    getTopMemories: {
        all: (
            limit?: number,
            userId?: string | null,
        ) => Promise<
            Array<{
                id: string;
                content: string;
                salience: number;
                primarySector: string;
            }>
        >;
    };
    getSectorTimeline: {
        all: (
            sector: string,
            limit?: number,
            userId?: string | null,
        ) => Promise<Array<{ lastSeenAt: number; salience: number }>>;
    };
    getMaintenanceLogs: {
        all: (
            limit?: number,
            userId?: string | null,
        ) => Promise<
            Array<{ op: string; status: string; details: string; ts: number }>
        >;
    };
    getMemBySegment: {
        all: (segment: number, userId?: string | null) => Promise<MemoryRow[]>;
    };
    getSegments: {
        all: (userId?: string | null) => Promise<Array<{ segment: number }>>;
    };
    getMaxSegment: {
        get: (
            userId?: string | null,
        ) => Promise<{ maxSeg: number } | undefined>;
    };
    getSegmentCount: {
        get: (
            segment: number,
            userId?: string | null,
        ) => Promise<{ c: number } | undefined>;
    };
    getMemCount: {
        get: (userId?: string | null) => Promise<{ c: number } | undefined>;
    };
    getVecCount: {
        get: (userId?: string | null) => Promise<{ c: number } | undefined>;
    };
    getFactCount: {
        get: (userId?: string | null) => Promise<{ c: number } | undefined>;
    };
    getEdgeCount: {
        get: (userId?: string | null) => Promise<{ c: number } | undefined>;
    };
    allMemByUser: {
        all: (
            userId: string | null | undefined,
            limit: number,
            offset: number,
        ) => Promise<MemoryRow[]>;
    };
    allMem: {
        all: (
            limit: number,
            offset: number,
            userId?: string | null,
        ) => Promise<MemoryRow[]>;
    };
    allMemStable: {
        all: (
            limit: number,
            offset: number,
            userId?: string | null,
        ) => Promise<MemoryRow[]>;
    };
    allMemCursor: {
        all: (
            limit: number,
            cursor: { createdAt: number; id: string } | null,
            userId?: string | null,
        ) => Promise<MemoryRow[]>;
    };
    allMemBySector: {
        all: (
            sector: string,
            limit: number,
            offset: number,
            userId?: string | null,
        ) => Promise<MemoryRow[]>;
    };
    allMemBySectorAndTag: {
        all: (
            sector: string,
            tag: string,
            limit: number,
            offset: number,
            userId?: string | null,
        ) => Promise<MemoryRow[]>;
    };
    insWaypoint: {
        run: (
            srcId: string,
            dstId: string,
            userId: string | null | undefined,
            weight: number,
            createdAt: number,
            updatedAt: number,
        ) => Promise<number>;
    };
    insWaypoints: { run: (items: BatchWaypointInsertItem[]) => Promise<number> };
    getWaypoint: {
        get: (
            srcId: string,
            dstId: string,
            userId?: string | null,
        ) => Promise<Waypoint | undefined>;
    };
    getWaypointsBySrc: {
        all: (srcId: string, userId?: string | null) => Promise<Waypoint[]>;
    };
    getNeighbors: {
        all: (
            srcId: string,
            userId?: string | null,
        ) => Promise<Array<{ dstId: string; weight: number }>>;
    };
    updWaypoint: {
        run: (
            srcId: string,
            weight: number,
            updatedAt: number,
            dstId: string,
            userId?: string | null,
        ) => Promise<number>;
    };
    pruneWaypoints: {
        run: (threshold: number, userId?: string | null) => Promise<number>;
    };
    getLowSalienceMemories: {
        all: (
            threshold: number,
            limit: number,
            userId?: string | null,
        ) => Promise<Array<{ id: string; userId: string }>>;
    };
    pruneMemories: {
        run: (threshold: number, userId?: string | null) => Promise<number>;
    };
    updSaliences: {
        run: (
            items: Array<{
                id: string;
                salience: number;
                lastSeenAt: number;
                updatedAt: number;
            }>,
            userId?: string | null,
        ) => Promise<number>;
    };
    insMaintLog: {
        run: (
            userId: string | null | undefined,
            status: string,
            details: string,
            ts: number,
        ) => Promise<number>;
    };
    logMaintOp: {
        run: (
            op: string,
            status: string,
            details: string,
            ts: number,
            userId?: string | null,
        ) => Promise<number>;
    };
    insLog: {
        run: (
            id: string,
            userId: string | null | undefined,
            model: string,
            status: string,
            ts: number,
            err: string | null,
        ) => Promise<number>;
    };
    updLog: {
        run: (
            id: string,
            status: string,
            err: string | null,
        ) => Promise<number>;
    };
    getPendingLogs: { all: (userId?: string | null) => Promise<LogEntry[]> };
    getFailedLogs: { all: (userId?: string | null) => Promise<LogEntry[]> };
    insUser: {
        run: (
            userId: string | null | undefined,
            summary: string,
            reflectionCount: number,
            createdAt: number,
            updatedAt: number,
        ) => Promise<number>;
    };
    getUser: {
        get: (userId: string | null | undefined) => Promise<
            | {
                userId: string;
                summary: string;
                reflectionCount: number;
                createdAt: number;
                updatedAt: number;
            }
            | undefined
        >;
    };
    updUserSummary: {
        run: (
            userId: string | null | undefined,
            summary: string,
            updatedAt: number,
        ) => Promise<number>;
    };
    delMemByUser: {
        run: (userId: string | null | undefined) => Promise<number>;
    };
    delUser: { run: (userId: string | null | undefined) => Promise<number> };
    getMemByMetadataLike: {
        all: (
            pattern: string,
            userId?: string | null | undefined,
        ) => Promise<MemoryRow[]>;
    };
    getTrainingData: {
        all: (
            userId: string | null | undefined,
            limit: number,
        ) => Promise<
            Array<{ meanVec: Buffer | Uint8Array; primarySector: string }>
        >;
    };
    getClassifierModel: {
        get: (userId: string) => Promise<
            | {
                weights: string;
                biases: string;
                version: number;
                updatedAt: number;
            }
            | undefined
        >;
    };
    insClassifierModel: {
        run: (
            userId: string | null | undefined,
            weights: string,
            biases: string,
            version: number,
            updatedAt: number,
        ) => Promise<number>;
    };
    getActiveUsers: { all: () => Promise<Array<{ userId: string }>> };
    getUsers: {
        all: (
            limit: number,
            offset: number,
        ) => Promise<
            Array<{
                userId: string;
                summary: string;
                reflectionCount: number;
                createdAt: number;
                updatedAt: number;
            }>
        >;
    };
    getTables: { all: () => Promise<{ name: string }[]> };
    insSourceConfig: {
        run: (
            userId: string | null,
            type: string,
            config: string,
            status: string,
            createdAt: number,
            updatedAt: number,
        ) => Promise<number>;
    };
    updSourceConfig: {
        run: (
            userId: string | null,
            type: string,
            config: string,
            status: string,
            updatedAt: number,
        ) => Promise<number>;
    };
    getSourceConfig: {
        get: (
            userId: string | null,
            type: string,
        ) => Promise<
            | {
                userId: string | null;
                type: string;
                config: string;
                status: string;
                createdAt: number;
                updatedAt: number;
            }
            | undefined
        >;
    };
    getSourceConfigsByUser: {
        all: (userId: string | null) => Promise<
            Array<{
                userId: string | null;
                type: string;
                config: string;
                status: string;
                createdAt: number;
                updatedAt: number;
            }>
        >;
    };
    delSourceConfig: {
        run: (userId: string | null, type: string) => Promise<number>;
    };

    insApiKey: {
        run: (
            keyHash: string,
            userId: string,
            role: string,
            note: string | null,
            createdAt: number,
            updatedAt: number,
            expiresAt: number,
        ) => Promise<number>;
    };
    getApiKey: {
        get: (keyHash: string) => Promise<
            | {
                keyHash: string;
                userId: string;
                role: string;
                note: string;
                expiresAt: number;
            }
            | undefined
        >;
    };
    delApiKey: { run: (keyHash: string) => Promise<number> };
    getApiKeysByUser: {
        all: (userId: string) => Promise<
            Array<{
                keyHash: string;
                userId: string;
                role: string;
                note: string;
                createdAt: number;
            }>
        >;
    };
    getAllApiKeys: {
        all: () => Promise<
            Array<{
                keyHash: string;
                userId: string;
                role: string;
                note: string;
                createdAt: number;
            }>
        >;
    };
    getAdminCount: { get: () => Promise<{ count: number } | undefined> };
    // Cascade Delete Helpers
    delFactsByUser: { run: (userId: string) => Promise<number> };
    delEdgesByUser: { run: (userId: string) => Promise<number> };
    delLearnedModel: { run: (userId: string) => Promise<number> };
    delSourceConfigsByUser: { run: (userId: string) => Promise<number> };
    delWaypointsByUser: { run: (userId: string) => Promise<number> };
    delEmbedLogsByUser: { run: (userId: string) => Promise<number> };
    delMaintLogsByUser: { run: (userId: string) => Promise<number> };
    delStatsByUser: { run: (userId: string) => Promise<number> };
    delOrphanWaypoints: { run: () => Promise<number> };
    searchMemsByKeyword: {
        all: (
            keyword: string,
            limit: number,
            userId?: string | null,
        ) => Promise<MemoryRow[]>;
    };
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

export const memoriesTable: string = "memories";

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

const getIsPg = () =>
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
let hasVector = false;

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
                        await admin.query(`CREATE DATABASE ${env.pgDb}`);
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
                pg!.query(`create table if not exists ${TABLES.memories}(id uuid primary key,user_id text,segment integer default 0,content text not null,simhash text,primary_sector text not null,tags text,metadata text,created_at bigint,updated_at bigint,last_seen_at bigint,salience double precision,decay_lambda double precision,version integer default 1,mean_dim integer,mean_vec ${vt},compressed_vec bytea,feedback_score double precision default 0,generated_summary text,coactivations integer default 0)`),
                pg!.query(`create table if not exists ${TABLES.vectors}(id uuid,sector text,user_id text,v ${vt},dim integer not null,metadata text,primary key(id,sector))`),
                pg!.query(`create table if not exists ${TABLES.waypoints}(src_id text,dst_id text not null,user_id text,weight double precision not null,created_at bigint,updated_at bigint,primary key(src_id,dst_id,user_id))`),
                pg!.query(`create table if not exists ${TABLES.embed_logs}(id text primary key,user_id text,model text,status text,ts bigint,err text)`),
                pg!.query(`create table if not exists ${TABLES.users}(user_id text primary key,summary text,reflection_count integer default 0,created_at bigint,updated_at bigint)`),
                pg!.query(`create table if not exists ${TABLES.stats}(id serial primary key,type text not null,count integer default 1,ts bigint not null,user_id text)`),
                pg!.query(`create table if not exists ${TABLES.maint_logs}(id serial primary key,op text not null,status text not null,details text,ts bigint not null,user_id text)`),
                pg!.query(`create table if not exists ${TABLES.temporal_facts}(id text primary key,user_id text,subject text not null,predicate text not null,object text not null,valid_from bigint not null,valid_to bigint,confidence double precision not null,last_updated bigint not null,metadata text)`),
                pg!.query(`create table if not exists ${TABLES.temporal_edges}(id text primary key,user_id text,source_id text not null,target_id text not null,relation_type text not null,valid_from bigint not null,valid_to bigint,weight double precision not null,metadata text,last_updated bigint)`),
                pg!.query(`create table if not exists ${TABLES.learned_models}(user_id text primary key,weights text,biases text,version integer default 1,updated_at bigint)`),
                pg!.query(`create table if not exists ${TABLES.source_configs}(user_id text,type text,config text not null,status text default 'enabled',created_at bigint,updated_at bigint,primary key(user_id,type))`),
                pg!.query(`create table if not exists ${TABLES.api_keys}(key_hash text primary key,user_id text not null,role text not null default 'user',note text,created_at bigint,updated_at bigint,expires_at bigint)`),
            ]);

            // Auto-Migration for coactivations
            await pg!.query(`ALTER TABLE ${TABLES.memories} ADD COLUMN IF NOT EXISTS coactivations integer DEFAULT 0`).catch(() => { });

            // Parallel Index Creation
            const indices = [
                `create index if not exists idx_mem_user on ${TABLES.memories}(user_id)`,
                `create index if not exists idx_mem_sector on ${TABLES.memories}(primary_sector)`,
                `create index if not exists idx_tf_subj on ${TABLES.temporal_facts}(subject)`,
                `create index if not exists idx_tf_obj on ${TABLES.temporal_facts}(object)`,
                `create index if not exists idx_tf_subj_pred on ${TABLES.temporal_facts}(subject, predicate)`,
                `create index if not exists idx_tf_user_pred on ${TABLES.temporal_facts}(user_id, predicate)`,
                `create index if not exists idx_tf_user_subj_pred on ${TABLES.temporal_facts}(user_id, subject, predicate)`,
                `create index if not exists idx_tf_temporal on ${TABLES.temporal_facts}(valid_from, valid_to)`,
                `create index if not exists idx_te_src on ${TABLES.temporal_edges}(source_id)`,
                `create index if not exists idx_te_tgt on ${TABLES.temporal_edges}(target_id)`,
                `create index if not exists idx_te_full on ${TABLES.temporal_edges}(source_id, target_id, relation_type)`,
                `create index if not exists idx_te_user_rel on ${TABLES.temporal_edges}(user_id, relation_type)`,
            ];
            await Promise.all(indices.map(sql => pg!.query(sql)));

            // Optimization Indices
            await pg!.query(
                `create index if not exists idx_mem_user_created on ${TABLES.memories}(user_id, created_at DESC)`,
            );
            await pg!.query(
                `create index if not exists idx_mem_user_lastseen on ${TABLES.memories}(user_id, last_seen_at DESC)`,
            );
            await pg!.query(
                `create index if not exists idx_mem_user_segment on ${TABLES.memories}(user_id, segment DESC)`,
            );
            await pg!.query(
                `create index if not exists idx_vec_user on ${TABLES.vectors}(user_id)`,
            );
            await pg!.query(
                `create index if not exists idx_vec_user_sector on ${TABLES.vectors}(user_id, sector)`,
            );
            await pg!.query(
                `create index if not exists idx_mem_user_salience on ${TABLES.memories}(user_id, salience DESC)`,
            );
            await pg!.query(
                `create index if not exists idx_mem_simhash on ${TABLES.memories}(simhash)`,
            );

            if (hasVector && env.vectorBackend === "postgres") {
                await pg!
                    .query(
                        `create index if not exists idx_vec_hnsw on ${TABLES.vectors} using hnsw (v vector_cosine_ops) WITH (m = 16, ef_construction = 64)`,
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
                `create table if not exists ${TABLES.memories}(id text primary key,segment integer default 0,content text not null,simhash text,primary_sector text not null,tags text,metadata text,created_at integer,updated_at integer,last_seen_at integer,salience real,decay_lambda real,version integer default 1,user_id text,mean_dim integer,mean_vec blob,compressed_vec blob,feedback_score real default 0,generated_summary text,coactivations integer default 0)`,
            );
            d.exec(
                `create table if not exists ${TABLES.vectors}(id text,sector text,user_id text,v blob,dim integer not null,metadata text,primary key(id,sector))`,
            );
            d.exec(
                `create table if not exists waypoints(src_id text,dst_id text not null,user_id text,weight real not null,created_at integer,updated_at integer,primary key(src_id,dst_id,user_id))`,
            );
            d.exec(
                `create table if not exists embed_logs(id text primary key,user_id text,model text,status text,ts integer,err text)`,
            );
            d.exec(
                `create table if not exists users(user_id text primary key,summary text,reflection_count integer default 0,created_at integer,updated_at integer)`,
            );
            d.exec(
                `create table if not exists stats(id integer primary key autoincrement,type text not null,count integer default 1,ts integer not null,user_id text)`,
            );
            d.exec(
                `create table if not exists maint_logs(id integer primary key autoincrement,op text not null,status text not null,details text,ts integer not null,user_id text)`,
            );
            d.exec(
                `create table if not exists temporal_facts(id text primary key,user_id text,subject text not null,predicate text not null,object text not null,valid_from integer not null,valid_to integer,confidence real not null,last_updated integer not null,metadata text)`,
            );
            d.exec(
                `create table if not exists temporal_edges(id text primary key,user_id text,source_id text not null,target_id text not null,relation_type text not null,valid_from integer not null,valid_to integer,weight real not null,metadata text,last_updated integer)`,
            );
            d.exec(
                `create table if not exists learned_models(user_id text primary key,weights text,biases text,version integer default 1,updated_at integer)`,
            );
            d.exec(
                `create table if not exists ${TABLES.source_configs}(user_id text,type text,config text not null,status text default 'enabled',created_at integer,updated_at integer,primary key(user_id,type))`,
            );
            d.exec(
                `create table if not exists ${TABLES.api_keys}(key_hash text primary key,user_id text not null,role text not null default 'user',note text,created_at integer,updated_at integer,expires_at integer)`,
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
 * Converts `?` placeholders to `$N` for PostgreSQL compatibility.
 * Safely ignores `?` (and strings containing `?`) inside single/double quotes.
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
    if (row.primary_sector !== undefined) mapped.primarySector = row.primary_sector;
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
            logger.debug(`[DB] [TX:${txId}] BEGIN (PG), depth: ${currentDepth + 1}, rid: ${sysCtx?.requestId}`);
            try {
                return await txStorage.run(
                    { depth: currentDepth + 1, cli: client },
                    async () => {
                        await client.query("BEGIN");
                        try {
                            const res = await fn();
                            await client.query("COMMIT");
                            logger.debug(`[DB] [TX:${txId}] COMMIT (PG)`);
                            return res;
                        } catch (e) {
                            await client.query("ROLLBACK");
                            logger.warn(`[DB] [TX:${txId}] ROLLBACK (PG)`, { error: e });
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
            logger.debug(`[DB] [TX:${txId}] BEGIN (SQLite), depth: ${currentDepth + 1}, rid: ${sysCtx?.requestId}`);
            try {
                return await txStorage.run({ depth: currentDepth + 1 }, async () => {
                    try {
                        d.exec("BEGIN IMMEDIATE TRANSACTION");
                        const res = await fn();
                        d.exec("COMMIT");
                        logger.debug(`[DB] [TX:${txId}] COMMIT (SQLite)`);
                        return res;
                    } catch (e) {
                        try {
                            d.exec("ROLLBACK");
                            logger.warn(`[DB] [TX:${txId}] ROLLBACK (SQLite)`, { error: e });
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

function toVectorString(
    v: Buffer | Uint8Array | number[] | null,
): string | null {
    if (!v) return null;
    const arr = Array.isArray(v)
        ? v
        : Array.from(
            v instanceof Buffer
                ? new Float32Array(v.buffer, v.byteOffset, v.byteLength / 4)
                : v,
        );
    if (arr.length === 0) return null; // Handle empty vectors as NULL
    return `[${arr.join(",")}]`;
}


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
    insMem: {
        run: async (
            id,
            content,
            sector,
            tags,
            meta,
            userId,
            segment,
            simhash,
            ca,
            ua,
            lsa,
            salience,
            dl,
            version,
            dim,
            mv,
            cv,
            fs,
            summary,
        ) => {
            const p = [
                id,
                content,
                sector,
                tags,
                meta,
                userId ?? null,
                segment,
                simhash,
                ca,
                ua,
                lsa,
                salience,
                dl,
                version,
                dim,
                getIsPg() && hasVector ? toVectorString(mv) : mv,
                cv,
                fs,
                summary,
            ];
            const sql = `insert into ${TABLES.memories}(id,content,primary_sector,tags,metadata,user_id,segment,simhash,created_at,updated_at,last_seen_at,salience,decay_lambda,version,mean_dim,mean_vec,compressed_vec,feedback_score,generated_summary) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) on conflict(id) do update set content=excluded.content,updated_at=excluded.updated_at,last_seen_at=excluded.last_seen_at,salience=excluded.salience`;
            return await runAsync(sql, p);
        },
    },
    insMems: {
        run: async (items) => {
            if (items.length === 0) return 0;

            // Helper to execute a single chunk
            const execChunk = async (chunk: BatchMemoryInsertItem[]) => {
                if (getIsPg()) {
                    // Multi-row INSERT for Postgres
                    const params: unknown[] = [];
                    const rows: string[] = [];
                    let idx = 1;
                    for (const item of chunk) {
                        const rowParams = [
                            item.id,
                            item.content,
                            item.primarySector,
                            item.tags,
                            item.metadata,
                            item.userId,
                            item.segment || 0,
                            item.simhash,
                            item.createdAt,
                            item.updatedAt,
                            item.lastSeenAt,
                            item.salience || 0.5,
                            item.decayLambda || 0.05,
                            item.version || 1,
                            item.meanDim,
                            hasVector
                                ? toVectorString(item.meanVec)
                                : item.meanVec,
                            item.compressedVec,
                            item.feedbackScore || 0,
                            item.generatedSummary || null,
                        ];
                        params.push(...rowParams);
                        const placeholders = rowParams
                            .map(() => `$${idx++}`)
                            .join(",");
                        rows.push(`(${placeholders})`);
                    }
                    const sql = `insert into ${TABLES.memories}(id,content,primary_sector,tags,metadata,user_id,segment,simhash,created_at,updated_at,last_seen_at,salience,decay_lambda,version,mean_dim,mean_vec,compressed_vec,feedback_score,generated_summary) values ${rows.join(",")} on conflict(id) do update set content=excluded.content,updated_at=excluded.updated_at,last_seen_at=excluded.last_seen_at,salience=excluded.salience`;
                    const c = txStorage.getStore()?.cli || pg;
                    if (!c) throw new Error("PG not initialized");
                    return (await c.query(sql, params)).rowCount || 0;
                } else {
                    // Transactional sequential inserts for SQLite
                    return await transaction.run(async () => {
                        let count = 0;
                        for (const item of chunk) {
                            count += await q.insMem.run(
                                item.id,
                                item.content,
                                item.primarySector,
                                item.tags,
                                item.metadata,
                                item.userId,
                                item.segment || 0,
                                item.simhash,
                                item.createdAt,
                                item.updatedAt,
                                item.lastSeenAt,
                                item.salience || 0.5,
                                item.decayLambda || 0.05,
                                item.version || 1,
                                item.meanDim,
                                item.meanVec,
                                item.compressedVec,
                                item.feedbackScore || 0,
                                item.generatedSummary || null,
                            );
                        }
                        return count;
                    });
                }
            };

            // Postgres Parameter Limit ~65535. Each row ~20 params. Safe batch ~3000.
            // SQLite variable limit is also default 999 or 32766. Safe batch ~500.
            // Using strict limit of 500 rows per chunk to be safe for both.
            const BATCH_SIZE = 500;
            let total = 0;
            for (let i = 0; i < items.length; i += BATCH_SIZE) {
                total += await execChunk(items.slice(i, i + BATCH_SIZE));
            }
            return total;
        },
    },
    updMeanVec: {
        run: (id, dim, vec, userId) =>
            runUser(
                `update ${TABLES.memories} set mean_dim=?,mean_vec=? where id=?`,
                [dim, vec, id],
                userId,
            ),
    },
    updCompressedVec: {
        run: (id, vec, userId) =>
            runUser(
                `update ${TABLES.memories} set compressed_vec=? where id=?`,
                [vec, id],
                userId,
            ),
    },
    updFeedback: {
        run: (id, fs, userId) =>
            runUser(
                `update ${TABLES.memories} set feedback_score=? where id=?`,
                [fs, id],
                userId,
            ),
    },
    updSeen: {
        run: (id, lsa, sa, ua, userId) =>
            runUser(
                `update ${TABLES.memories} set last_seen_at=?,salience=?,updated_at=? where id=?`,
                [lsa, sa, ua, id],
                userId,
            ),
    },
    updSaliences: {
        run: async (updates, userId) => {
            if (updates.length === 0) return 0;
            const uid = normalizeUserId(userId);

            if (getIsPg()) {
                const rows = [];
                const params: (string | number | null)[] = [];
                let idx = 1;
                for (const item of updates) {
                    params.push(item.id, item.salience, item.lastSeenAt, item.updatedAt);
                    rows.push(`($${idx++}::uuid, $${idx++}::double precision, $${idx++}::bigint, $${idx++}::bigint)`);
                }

                const sql = `
                    UPDATE ${TABLES.memories} AS m
                    SET 
                        salience = u.new_salience,
                        last_seen_at = u.new_lsa,
                        updated_at = u.new_ua
                    FROM (VALUES ${rows.join(",")}) AS u(id, new_salience, new_lsa, new_ua)
                    WHERE m.id = u.id AND (m.user_id = $${idx} OR (m.user_id IS NULL AND $${idx} IS NULL))
                `;
                params.push(uid ?? null);
                const res = await pg!.query(sql, params);
                return res.rowCount || 0;
            } else {
                return await transaction.run(async () => {
                    let count = 0;
                    for (const item of updates) {
                        count += await q.updSeen.run(
                            item.id,
                            item.lastSeenAt,
                            item.salience,
                            item.updatedAt,
                            uid,
                        );
                    }
                    return count;
                });
            }
        },
    },
    updSummary: {
        run: (id, sum, userId) =>
            runUser(
                `update ${TABLES.memories} set generated_summary=? where id=?`,
                [sum, id],
                userId,
            ),
    },
    updMem: {
        run: (content, sector, tags, meta, ua, id, userId) =>
            runUser(
                `update ${TABLES.memories} set content=?,primary_sector=?,tags=?,metadata=?,updated_at=?,version=version+1 where id=?`,
                [content, sector, tags, meta, ua, id],
                userId,
            ),
    },
    updSector: {
        run: (id, sector, userId) =>
            runUser(
                `update ${TABLES.memories} set primary_sector=? where id=?`,
                [sector, id],
                userId,
            ),
    },
    getMem: {
        get: (id, userId) =>
            getUser<MemoryRow>(
                `select * from ${TABLES.memories} where id=?`,
                [id],
                userId,
            ),
    },
    getMems: {
        all: (ids, userId) =>
            allUser<MemoryRow>(
                `select * from ${TABLES.memories} where id IN (${ids.map(() => "?").join(",")})`,
                [...ids],
                userId,
            ),
    },
    getMemRaw: {
        get: (id, userId) =>
            getUser<MemoryRow>(
                `select * from ${TABLES.memories} where id=?`,
                [id],
                userId,
            ),
    },
    getMemBySimhash: {
        get: (sh, userId) =>
            getUser<MemoryRow>(
                `select * from ${TABLES.memories} where simhash=? order by salience desc limit 1`,
                [sh],
                userId,
            ),
    },
    delMem: {
        run: async (id, userId) => {
            const res = await transaction.run(async () => {
                // Cascade delete waypoints (src or dst)
                await runUser(
                    `delete from ${TABLES.waypoints} where src_id=? or dst_id=?`,
                    [id, id],
                    userId,
                );
                // Delete memory
                return await runUser(
                    `delete from ${TABLES.memories} where id=?`,
                    [id],
                    userId,
                );
            });

            // Integrity: Delete vectors only after DB transaction succeeds
            try {
                await vectorStore.deleteVectors([id], userId);
            } catch (e) {
                logger.warn(`[DB] Failed to cleanup vectors for memory ${id}:`, { error: e });
            }
            return res;
        },
    },
    delMems: {
        run: async (ids: string[], userId?: string | null) => {
            if (ids.length === 0) return 0;
            return await transaction.run(async () => {
                const placeholders = ids.map(() => "?").join(",");
                // Cascade vectors
                await runUser(
                    `delete from ${TABLES.vectors} where id in (${placeholders})`,
                    [...ids],
                    userId,
                );
                // Cascade waypoints (complex with IN clause for src/dst, might be slow for huge batches but safer)
                // For batch, simpler to just let them be orphaned? No, integrity first.
                // "delete from waypoints where src_id in (...) or dst_id in (...)"
                await runUser(
                    `delete from ${TABLES.waypoints} where src_id in (${placeholders}) or dst_id in (${placeholders})`,
                    [...ids, ...ids],
                    userId,
                );
                // Delete memories
                const res = await execRes(
                    (await applySqlUser(
                        `DELETE FROM ${TABLES.memories} WHERE id IN (${placeholders})`,
                        [...ids],
                        userId,
                    )).sql,
                    (await applySqlUser(
                        `DELETE FROM ${TABLES.memories} WHERE id IN (${placeholders})`,
                        [...ids],
                        userId,
                    )).params,
                );
                return res.rowCount || 0;
            });
        },
    },
    allMemByUser: {
        all: (uid, limit, offset) =>
            allUser<MemoryRow>(
                `select * from ${TABLES.memories} order by created_at desc limit ? offset ?`,
                [limit, offset],
                uid,
            ),
    },
    allMem: {
        all: (limit, offset, userId) =>
            allUser<MemoryRow>(
                `select * from ${TABLES.memories} order by created_at desc limit ? offset ?`,
                [limit, offset],
                userId,
            ),
    },
    allMemStable: {
        all: (limit: number, offset: number, userId?: string | null) =>
            allUser<MemoryRow>(
                `select * from ${TABLES.memories} order by created_at desc, id asc limit ? offset ?`,
                [limit, offset],
                userId,
            ),
    },
    allMemCursor: {
        all: (limit: number, cursor: { createdAt: number; id: string } | null, userId?: string | null) => {
            // Keyset Pagination: (created_at, id) < (cursor.createdAt, cursor.id)
            // Order DESC for "Last Created" first
            if (!cursor) {
                return allUser<MemoryRow>(
                    `select * from ${TABLES.memories} order by created_at desc, id desc limit ?`,
                    [limit],
                    userId,
                );
            }
            // For (A, B) < (a, b) => A < a OR (A = a AND B < b)
            return allUser<MemoryRow>(
                `select * from ${TABLES.memories} where (created_at < ?) OR (created_at = ? AND id < ?) order by created_at desc, id desc limit ?`,
                [cursor.createdAt, cursor.createdAt, cursor.id, limit],
                userId,
            );
        },
    },
    allMemBySector: {
        all: (sec, limit, offset, userId) =>
            allUser<MemoryRow>(
                `select * from ${TABLES.memories} where primary_sector=? order by created_at desc limit ? offset ?`,
                [sec, limit, offset],
                userId,
            ),
    },
    allMemBySectorAndTag: {
        all: (sec, tag, limit, offset, userId) =>
            allUser<MemoryRow>(
                `select * from ${TABLES.memories} where primary_sector=? and tags like ? order by created_at desc limit ? offset ?`,
                [sec, `%${tag}%`, limit, offset],
                userId,
            ),
    },
    getSegmentCount: {
        get: (seg, userId) =>
            getUser(
                `select count(*) as c from ${TABLES.memories} where segment=?`,
                [seg],
                userId,
            ),
    },
    getMemCount: {
        get: (userId) =>
            getUser(
                `select count(*) as c from ${TABLES.memories}`,
                [],
                userId,
            ),
    },
    getVecCount: {
        get: (userId) =>
            getUser(
                `select count(*) as c from ${TABLES.vectors}`,
                [],
                userId,
            ),
    },
    getFactCount: {
        get: (userId) =>
            getUser(
                `select count(*) as c from ${TABLES.temporal_facts}`,
                [],
                userId,
            ),
    },
    getEdgeCount: {
        get: (userId) =>
            getUser(
                `select count(*) as c from ${TABLES.temporal_edges}`,
                [],
                userId,
            ),
    },
    getMaxSegment: {
        get: (userId) =>
            getUser(
                `select coalesce(max(segment), 0) as maxSeg from ${TABLES.memories}`,
                [],
                userId,
            ),
    },
    getSegments: {
        all: (userId) =>
            allUser(
                `select distinct segment from ${TABLES.memories} order by segment desc`,
                [],
                userId,
            ),
    },
    getMemBySegment: {
        all: (seg, userId) =>
            allUser<MemoryRow>(
                `select * from ${TABLES.memories} where segment=? order by created_at desc`,
                [seg],
                userId,
            ),
    },
    insUser: {
        run: (userId, summary, rc, ca, ua) =>
            runAsync(
                `insert into ${TABLES.users}(user_id,summary,reflection_count,created_at,updated_at) values(?,?,?,?,?) on conflict(user_id) do update set summary=excluded.summary,updated_at=excluded.updated_at`,
                [userId ?? null, summary, rc, ca, ua],
            ),
    },
    getUser: {
        get: (userId) =>
            getAsync(`select * from ${TABLES.users} where user_id=?`, [
                userId ?? null,
            ]),
    },
    updUserSummary: {
        run: (userId, summary, ua) =>
            runAsync(
                `update ${TABLES.users} set summary=?,updated_at=?,reflection_count=reflection_count+1 where user_id=?`,
                [summary, ua, userId ?? null],
            ),
    },
    delMemByUser: {
        run: async (uid) => {
            if (!uid) return 0;
            return await transaction.run(async () => {
                const p = [uid];
                await runAsync(`delete from ${TABLES.vectors} where user_id=?`, p);
                await runAsync(`delete from ${TABLES.waypoints} where user_id=?`, p);
                await runAsync(`delete from ${TABLES.temporal_facts} where user_id=?`, p);
                await runAsync(`delete from ${TABLES.temporal_edges} where user_id=?`, p);
                await runAsync(`delete from ${TABLES.learned_models} where user_id=?`, p);
                return runAsync(`delete from ${TABLES.memories} where user_id=?`, p);
            });
        },
    },
    delUser: {
        run: (uid) =>
            runAsync(`delete from ${TABLES.users} where user_id=?`, [
                uid ?? null,
            ]),
    },
    getMemByMetadataLike: {
        all: (pat, userId) =>
            allUser<MemoryRow>(
                `select * from ${TABLES.memories} where metadata like ? order by created_at desc`,
                [`%${pat}%`],
                userId,
            ),
    },
    getTrainingData: {
        all: (uid, limit) =>
            allAsync(
                `select mean_vec as meanVec, primary_sector as primarySector from ${TABLES.memories} where user_id=? and mean_vec is not null limit ?`,
                [uid ?? null, limit],
            ),
    },
    getClassifierModel: {
        get: (uid) =>
            getAsync(`select * from ${TABLES.learned_models} where user_id=?`, [
                uid ?? null,
            ]),
    },
    insClassifierModel: {
        run: (uid, w, b, v, ua) =>
            runAsync(
                `insert into ${TABLES.learned_models}(user_id,weights,biases,version,updated_at) values(?,?,?,?,?) on conflict(user_id) do update set weights=excluded.weights,biases=excluded.biases,version=excluded.version,updated_at=excluded.updated_at`,
                [uid ?? null, w, b, v, ua],
            ),
    },
    getActiveUsers: {
        all: () => allAsync(`select user_id as userId from ${TABLES.users}`),
    },
    getUsers: {
        all: (limit: number, offset: number) =>
            allAsync(
                `select user_id as userId, summary, reflection_count as reflectionCount, created_at as createdAt, updated_at as updatedAt from ${TABLES.users} order by updated_at desc limit ? offset ?`,
                [limit, offset],
            ),
    },
    insWaypoint: {
        run: (src, dst, userId, w, ca, ua) =>
            runAsync(
                `insert into ${TABLES.waypoints}(src_id,dst_id,user_id,weight,created_at,updated_at) values(?,?,?,?,?,?) on conflict(src_id,dst_id,user_id) do update set weight=excluded.weight,updated_at=excluded.updated_at`,
                [src, dst, userId ?? null, w, ca, ua],
            ),
    },
    insWaypoints: {
        run: async (items) => {
            if (items.length === 0) return 0;
            if (getIsPg()) {
                const params: unknown[] = [];
                const rows: string[] = [];
                let idx = 1;
                for (const item of items) {
                    const rowParams = [
                        item.srcId,
                        item.dstId,
                        item.userId ?? null,
                        item.weight,
                        item.createdAt,
                        item.updatedAt,
                    ];
                    params.push(...rowParams);
                    const placeholders = rowParams
                        .map(() => `$${idx++}`)
                        .join(",");
                    rows.push(`(${placeholders})`);
                }
                const sql = `insert into ${TABLES.waypoints}(src_id,dst_id,user_id,weight,created_at,updated_at) values ${rows.join(",")} on conflict(src_id,dst_id,user_id) do update set weight=excluded.weight,updated_at=excluded.updated_at`;
                const c = txStorage.getStore()?.cli || pg;
                if (!c) throw new Error("PG not initialized");
                return (await c.query(sql, params)).rowCount || 0;
            } else {
                return await transaction.run(async () => {
                    let count = 0;
                    for (const item of items) {
                        count += await q.insWaypoint.run(
                            item.srcId,
                            item.dstId,
                            item.userId,
                            item.weight,
                            item.createdAt,
                            item.updatedAt,
                        );
                    }
                    return count;
                });
            }
        },
    },
    getWaypoint: {
        get: (src, dst, userId) =>
            getUser<Waypoint>(
                `select * from ${TABLES.waypoints} where src_id=? and dst_id=?`,
                [src, dst],
                userId,
            ),
    },
    getWaypointsBySrc: {
        all: (src, userId) =>
            allUser<Waypoint>(
                `select * from ${TABLES.waypoints} where src_id=?`,
                [src],
                userId,
            ),
    },
    getNeighbors: {
        all: (src, userId) =>
            allUser<{ dstId: string; weight: number }>(
                `select dst_id as dstId, weight from ${TABLES.waypoints} where src_id=? order by weight desc`,
                [src],
                userId,
            ),
    },
    updWaypoint: {
        run: (src, weight, ua, dst, userId) =>
            runUser(
                `update ${TABLES.waypoints} set weight=?,updated_at=? where src_id=? and dst_id=?`,
                [weight, ua, src, dst],
                userId,
            ),
    },
    pruneWaypoints: {
        run: (t, userId) =>
            runUser(
                `delete from ${TABLES.waypoints} where weight<?`,
                [t],
                userId,
            ),
    },
    getLowSalienceMemories: {
        all: (t, limit, userId) =>
            allUser<{ id: string; userId: string }>(
                `select id, user_id as userId from ${TABLES.memories} where salience<? limit ?`,
                [t, limit],
                userId,
            ),
    },
    pruneMemories: {
        run: async (t, userId) => {
            // Fetch IDs to be pruned first to ensure vector cleanup
            // Limit to 1000 to prevent massive memory usage, caller should loop
            const rows = await allUser<{ id: string }>(
                `select id from ${TABLES.memories} where salience<? limit 1000`,
                [t],
                userId,
            );
            if (rows.length === 0) return 0;
            const ids = rows.map((r) => r.id);

            // Cleanup DB First (Integrity)
            const placeholders = ids.map(() => '?').join(',');
            const count = await runUser(
                `delete from ${TABLES.memories} where id in (${placeholders})`,
                [...ids],
                userId,
            );

            // Cleanup vectors - Only if DB delete succeeded
            try {
                await vectorStore.deleteVectors(ids, userId);
            } catch (e) {
                logger.warn("[DB] Prune vector cleanup failed", { error: e });
            }

            return count;
        },
    },

    insMaintLog: {
        run: (userId, status, details, ts) =>
            runAsync(
                `insert into ${TABLES.maint_logs}(op,user_id,status,details,ts) values('routine',?,?,?,?)`,
                [userId ?? null, status, details, ts],
            ),
    },
    logMaintOp: {
        run: (op, status, details, ts, userId) =>
            runAsync(
                `insert into ${TABLES.maint_logs}(op,status,details,ts,user_id) values(?,?,?,?,?)`,
                [op, status, details, ts, userId ?? null],
            ),
    },
    insLog: {
        run: (id, userId, model, status, ts, err) =>
            runAsync(
                `insert into ${TABLES.embed_logs}(id,user_id,model,status,ts,err) values(?,?,?,?,?,?) on conflict(id) do update set status=excluded.status,err=excluded.err`,
                [id, userId ?? null, model, status, ts, err ?? null],
            ),
    },
    updLog: {
        run: (id, status, err) =>
            runAsync(
                `update ${TABLES.embed_logs} set status=?,err=? where id=?`,
                [status, err ?? null, id],
            ),
    },
    getPendingLogs: {
        all: (userId) =>
            allUser<LogEntry>(
                `select * from ${TABLES.embed_logs} where status='pending'`,
                [],
                userId,
            ),
    },
    getFailedLogs: {
        all: (userId) =>
            allUser<LogEntry>(
                `select * from ${TABLES.embed_logs} where status='failed' order by ts desc limit 100`,
                [],
                userId,
            ),
    },
    clearAll: {
        run: async () => {
            const tables = [
                TABLES.memories,
                TABLES.vectors,
                TABLES.waypoints,
                TABLES.users,
                TABLES.temporal_facts,
                TABLES.temporal_edges,
                TABLES.source_configs,
                TABLES.embed_logs,
                TABLES.maint_logs,
                TABLES.stats,
                TABLES.learned_models,
            ];
            for (const t of tables) await runAsync(`delete from ${t}`);
            return 1;
        },
    },
    getStats: {
        get: (userId) =>
            getUser(
                `select count(*) as count, avg(salience) as avgSalience from ${TABLES.memories}`,
                [],
                userId,
            ),
    },
    getSectorStats: {
        all: (userId) =>
            allUser<SectorStat>(
                `select type as sector, sum(count) as count, 0 as avgSalience from stats where type like 'sector:%' group by type`,
                [],
                userId,
            ),
    },
    getRecentActivity: {
        all: (limit = 10, userId) =>
            allUser<{
                id: string;
                content: string;
                lastSeenAt: number;
                primarySector: string;
            }>(
                `select id, content, last_seen_at as lastSeenAt, primary_sector as primarySector from ${TABLES.memories} order by last_seen_at desc limit ?`,
                [limit],
                userId,
            ),
    },
    getTopMemories: {
        all: (limit = 10, userId) =>
            allUser<{
                id: string;
                content: string;
                salience: number;
                primarySector: string;
            }>(
                `select id, content, salience, primary_sector as primarySector from ${TABLES.memories} order by salience desc limit ?`,
                [limit],
                userId,
            ),
    },
    getSectorTimeline: {
        all: (sec, limit = 50, userId) =>
            allUser<{ lastSeenAt: number; salience: number }>(
                `select last_seen_at as lastSeenAt, salience from ${TABLES.memories} where primary_sector=? order by last_seen_at desc limit ?`,
                [sec, limit],
                userId,
            ),
    },
    getMaintenanceLogs: {
        all: (limit = 50, userId) =>
            allUser<MaintLogEntry>(
                `select * from ${TABLES.maint_logs} order by ts desc limit ?`,
                [limit],
                userId,
            ),
    },
    getTables: {
        all: () =>
            allAsync(
                getIsPg()
                    ? `SELECT table_name as name FROM information_schema.tables WHERE table_schema = '${env.pgSchema}'`
                    : "SELECT name FROM sqlite_master WHERE type='table'",
            ),
    },
    insSourceConfig: {
        run: (userId, type, config, status, ca, ua) =>
            runAsync(
                `insert into ${TABLES.source_configs}(user_id,type,config,status,created_at,updated_at) values(?,?,?,?,?,?) on conflict(user_id,type) do update set config=excluded.config,status=excluded.status,updated_at=excluded.updated_at`,
                [userId ?? null, type, config, status, ca, ua],
            ),
    },
    updSourceConfig: {
        run: (userId, type, config, status, ua) =>
            runAsync(
                `update ${TABLES.source_configs} set config=?,status=?,updated_at=? where user_id ${userId ? "=?" : "is null"} and type=?`,
                userId
                    ? [config, status, ua, userId, type]
                    : [config, status, ua, type],
            ),
    },
    getSourceConfig: {
        get: (userId, type) =>
            getUser(
                `select * from ${TABLES.source_configs} where type=?`,
                [type],
                userId,
            ),
    },
    getSourceConfigsByUser: {
        all: (userId) =>
            allUser(
                `select * from ${TABLES.source_configs}`,
                [],
                userId,
            ),
    },
    delSourceConfig: {
        run: (userId, type) =>
            runAsync(
                `delete from ${TABLES.source_configs} where user_id ${userId ? "=?" : "is null"} and type=?`,
                userId ? [userId, type] : [type],
            ),
    },

    insApiKey: {
        run: (
            kh: string,
            uid: string,
            role: string,
            note: string | null,
            ca: number,
            ua: number,
            ea: number,
        ) =>
            runAsync(
                `insert into ${TABLES.api_keys}(key_hash,user_id,role,note,created_at,updated_at,expires_at) values(?,?,?,?,?,?,?) on conflict(key_hash) do update set role=excluded.role,note=excluded.note,updated_at=excluded.updated_at,expires_at=excluded.expires_at`,
                [kh, uid, role, note, ca, ua, ea],
            ),
    },
    getApiKey: {
        get: (kh: string) =>
            getAsync<{
                keyHash: string;
                userId: string;
                role: string;
                note: string;
                expiresAt: number;
            }>(
                `select key_hash as keyHash, user_id as userId, role, note, expires_at as expiresAt from ${TABLES.api_keys} where key_hash=?`,
                [kh],
            ),
    },
    delApiKey: {
        run: (kh: string) =>
            runAsync(`delete from ${TABLES.api_keys} where key_hash=?`, [kh]),
    },
    getApiKeysByUser: {
        all: (uid: string) =>
            allAsync(
                `select key_hash as keyHash, user_id as userId, role, note, created_at as createdAt from ${TABLES.api_keys} where user_id=?`,
                [uid],
            ),
    },
    getAllApiKeys: {
        all: () =>
            allAsync(
                `select key_hash as keyHash, user_id as userId, role, note, created_at as createdAt from ${TABLES.api_keys}`,
            ),
    },
    getAdminCount: {
        get: () =>
            getAsync<{ count: number }>(
                `select count(*) as count from ${TABLES.api_keys} where role='admin'`,
            ),
    },

    delFactsByUser: {
        run: (uid) =>
            runAsync(`delete from ${TABLES.temporal_facts} where user_id=?`, [
                uid,
            ]),
    },
    delEdgesByUser: {
        run: (uid) =>
            runAsync(`delete from ${TABLES.temporal_edges} where user_id=?`, [
                uid,
            ]),
    },
    delLearnedModel: {
        run: (uid) =>
            runAsync(`delete from ${TABLES.learned_models} where user_id=?`, [
                uid,
            ]),
    },
    delSourceConfigsByUser: {
        run: (uid) =>
            runAsync(`delete from ${TABLES.source_configs} where user_id=?`, [
                uid,
            ]),
    },
    delWaypointsByUser: {
        run: (uid) =>
            runAsync(`delete from ${TABLES.waypoints} where user_id=?`, [uid]),
    },
    delEmbedLogsByUser: {
        run: (uid) =>
            runAsync(`delete from ${TABLES.embed_logs} where user_id=?`, [uid]),
    },
    delMaintLogsByUser: {
        run: (uid) =>
            runAsync(`delete from ${TABLES.maint_logs} where user_id=?`, [uid]),
    },
    delStatsByUser: {
        run: (uid) =>
            runAsync(`delete from ${TABLES.stats} where user_id=?`, [uid]),
    },
    delOrphanWaypoints: {
        run: () =>
            runAsync(
                `delete from ${TABLES.waypoints} where src_id not in (select id from ${TABLES.memories}) or dst_id not in (select id from ${TABLES.memories})`,
            ),
    },
    searchMemsByKeyword: {
        all: (keyword, limit, userId) =>
            allUser<MemoryRow>(
                `select * from ${TABLES.memories} where content like ? or tags like ? order by salience desc limit ?`,
                [`%${keyword}%`, `%${keyword}%`, limit],
                userId,
            ),
    },
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
            `insert into ${TABLES.stats}(type,count,ts,user_id) values(?,?,?,?)`,
            [type, cnt, Date.now(), userId ?? null],
        );
    } catch (e) {
        logger.error("[DB] logMaintOp error", { error: e });
    }
};
