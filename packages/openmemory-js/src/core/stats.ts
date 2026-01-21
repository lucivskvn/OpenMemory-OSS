/**
 * System Statistics Module for OpenMemory.
 * Provides deep insights into memory counts, salience distribution, and system health.
 */
import * as path from "node:path";

import { logger } from "../utils/logger";
import { env } from "./cfg";
import { allAsync, TABLES } from "./db";

const isPg = env.metadataBackend === "postgres";

const getMemTable = () => {
    if (isPg) {
        const sc = env.pgSchema || "public";
        const tbl = env.pgTable || "openmemory_memories";
        return `"${sc}"."${tbl}"`;
    }
    return TABLES.memories;
};

// Types corresponding to DB results
interface DBCount {
    count: number;
}
interface DBSize {
    size: number;
}
interface SectorCount {
    primarySector: string;
    count: number;
}
interface AvgSalience {
    avg: number;
}
interface DecayStats {
    total: number;
    avgLambda: number;
    minSalience: number;
    maxSalience: number;
}
interface StatEntry {
    count: number;
    ts: number;
}
interface StatTotal {
    total: number;
}

export interface SystemStats {
    totalMemories: number;
    recentMemories: number;
    sectorCounts: Record<string, number>;
    avgSalience: string;
    decayStats: {
        total: number;
        avgLambda: string;
        minSalience: string;
        maxSalience: string;
    };
    requests: {
        total: number;
        errors: number;
        errorRate: string;
        lastHour: number;
    };
    qps: {
        peak: number;
        average: number;
        cacheHitRate: number;
    };
    system: {
        memoryUsage: number;
        heapUsed: number;
        heapTotal: number;
        uptime: {
            seconds: number;
            days: number;
            hours: number;
        };
    };
    config: {
        port: number;
        vecDim: number;
        cacheSegments: number;
        maxActive: number;
        decayInterval: number;
        embedProvider: string;
        embedModel: string;
        embedKind: string;
    };
    classifier?: {
        version?: number;
        updatedAt?: number;
        status: string;
    };
    counts: {
        memories: number;
        vectors: number;
        facts: number;
        edges: number;
        activeFacts: number;
        activeEdges: number;
    };
}

const getDbSz = async (): Promise<number> => {
    try {
        if (isPg) {
            const dbName = env.pgDb || "openmemory";
            const result = await allAsync<DBSize>(
                `SELECT pg_database_size('${dbName}') as size`,
            );
            const sizeBytes = result?.[0]?.size ? Number(result[0].size) : 0;
            return Math.round(sizeBytes / 1024 / 1024);
        } else {
            const dbp =
                env.dbPath.startsWith("/") || env.dbPath.includes(":")
                    ? env.dbPath
                    : path.resolve(process.cwd(), env.dbPath);

            const file = Bun.file(dbp);
            if (await file.exists()) {
                return Math.round(file.size / 1024 / 1024);
            }
            return 0;
        }
    } catch (e) {
        logger.error("[DB_SIZE] Failed to get database size:", { error: e });
        return 0;
    }
};

/**
 * Aggregates system-wide statistics for monitoring and dashboard display.
 * 
 * **Performance Note**: This function executes distinct COUNT/AVG queries across large tables. 
 * While optimized with indices, it should be cached or called infrequently (e.g., dashboard polling).
 * 
 * @param userId - Optional user ID to scope statistics to a single tenant.
 * @param qpsHist - A history of QPS values for calculating averages.
 * @returns {Promise<SystemStats>} A comprehensive object containing memory counts, vector store stats, and system health metrics.
 */
export async function getSystemStats(
    userId: string | undefined,
    qpsHist: number[],
): Promise<SystemStats> {
    const memTable = getMemTable();

    // NOTE: These aggregate queries (COUNT, AVG, MIN, MAX) over the entire table 
    // can be slow on large datasets (>1M rows) without specific indexes or materialized views.
    // Acceptable for Admin Dashboard usage, but avoid calling in hot paths.

    // User-scoped memory stats
    const userClause = userId
        ? isPg
            ? "WHERE user_id = $1"
            : "WHERE user_id = ?"
        : isPg
            ? "WHERE user_id IS NULL"
            : "WHERE user_id IS NULL";
    const p = userId ? [userId] : [];

    // Recent memories (24h)
    const dayago = Date.now() - 24 * 60 * 60 * 1000;
    const recClause = isPg
        ? userId
            ? "WHERE created_at > $1 AND user_id = $2"
            : "WHERE created_at > $1 AND user_id IS NULL"
        : userId
            ? "WHERE created_at > ? AND user_id = ?"
            : "WHERE created_at > ? AND user_id IS NULL";
    const recP = isPg
        ? userId
            ? [dayago, userId]
            : [dayago]
        : userId
            ? [dayago, userId]
            : [dayago];

    // QPS / Errors (last hour)
    const hourAgo = Date.now() - 60 * 60 * 1000;
    const sc = env.pgSchema || "public";

    const [totmem, sectcnt, recmem, avgsal, decst, qpsData, errData, dbsz, vecCnt, factCnt, edgeCnt] =
        await Promise.all([
            allAsync<DBCount>(
                `SELECT COUNT(*) as count FROM ${memTable} ${userClause}`,
                p,
            ),
            allAsync<SectorCount>(
                isPg
                    ? `SELECT primary_sector as "primarySector", COUNT(*) as count FROM ${memTable} ${userClause} GROUP BY primary_sector`
                    : `SELECT primary_sector as "primarySector", COUNT(*) as count FROM ${memTable} ${userClause} GROUP BY primary_sector`,
                p,
            ),
            allAsync<DBCount>(
                `SELECT COUNT(*) as count FROM ${memTable} ${recClause}`,
                recP,
            ),
            allAsync<AvgSalience>(
                `SELECT AVG(salience) as avg FROM ${memTable} ${userClause}`,
                p,
            ),
            allAsync<DecayStats>(
                `
            SELECT
                COUNT(*) as total,
                AVG(decay_lambda) as "avgLambda",
                MIN(salience) as "minSalience",
                MAX(salience) as "maxSalience"
            FROM ${memTable} ${userClause}
        `,
                p,
            ),
            allAsync<StatEntry>(
                isPg
                    ? `SELECT count, ts FROM "${sc}"."stats" WHERE type=$1 AND ts > $2 ORDER BY ts DESC`
                    : "SELECT count, ts FROM stats WHERE type=? AND ts > ? ORDER BY ts DESC",
                ["qps", hourAgo],
            ),
            allAsync<StatTotal>(
                isPg
                    ? `SELECT COUNT(*) as total FROM "${sc}"."stats" WHERE type=$1 AND ts > $2`
                    : "SELECT COUNT(*) as total FROM stats WHERE type=? AND ts > ?",
                ["error", hourAgo],
            ),
            getDbSz(),
            allAsync<DBCount>(
                `SELECT COUNT(*) as count FROM ${TABLES.vectors} ${userClause}`,
                p,
            ),
            allAsync<DBCount>(
                `SELECT COUNT(*) as count FROM ${TABLES.temporal_facts} ${userClause}`,
                p,
            ),
            allAsync<DBCount>(
                `SELECT COUNT(*) as count FROM ${TABLES.temporal_edges} ${userClause}`,
                p,
            ),
        ]);

    const totMemCount = totmem[0]?.count || 0;
    const recMemCount = recmem[0]?.count || 0;
    const avgSalValue = avgsal[0]?.avg || 0;
    const decayStats = decst[0] || {
        total: 0,
        avgLambda: 0,
        minSalience: 0,
        maxSalience: 0,
    };

    const qpsArr = qpsData || [];
    const peakQps =
        qpsArr.length > 0 ? Math.max(...qpsArr.map((d) => d.count)) : 0;
    const avgQps =
        qpsHist.length > 0
            ? Math.round(
                (qpsHist.reduce((a, b) => a + b, 0) / qpsHist.length) * 100,
            ) / 100
            : 0;

    const safeAvgQps = Number.isFinite(avgQps) ? avgQps : 0;

    const totalReqs = qpsArr.reduce((sum, d) => sum + d.count, 0);
    const totalErrs = errData[0]?.total || 0;
    const errRate =
        totalReqs > 0 ? ((totalErrs / totalReqs) * 100).toFixed(1) : "0.0";

    const dbpct = dbsz > 0 ? Math.min(100, Math.round((dbsz / 1024) * 100)) : 0;
    const cachit =
        totMemCount > 0
            ? Math.round((totMemCount / (totMemCount + totalErrs * 2)) * 100)
            : 0;

    // Additional query for active counts if needed, but for now we'll optimize by assuming differentiation later
    // Actually, let's just add active counts query now.
    // We already promised high quality deep dive.
    const [actFacts, actEdges] = await Promise.all([
        allAsync<DBCount>(
            `SELECT COUNT(*) as count FROM ${TABLES.temporal_facts} ${userClause} AND valid_to IS NULL`,
            p,
        ),
        allAsync<DBCount>(
            `SELECT COUNT(*) as count FROM ${TABLES.temporal_edges} ${userClause} AND valid_to IS NULL`,
            p,
        )
    ]);

    return {
        totalMemories: totMemCount,
        recentMemories: recMemCount,
        sectorCounts: sectcnt.reduce(
            (acc, row) => {
                acc[row.primarySector] = row.count;
                return acc;
            },
            {} as Record<string, number>,
        ),
        avgSalience: Number(avgSalValue).toFixed(3),
        decayStats: {
            total: decayStats.total,
            avgLambda: Number(decayStats.avgLambda || 0).toFixed(3),
            minSalience: Number(decayStats.minSalience || 0).toFixed(3),
            maxSalience: Number(decayStats.maxSalience || 0).toFixed(3),
        },
        requests: {
            total: totalReqs,
            errors: totalErrs,
            errorRate: errRate,
            lastHour: qpsArr.length,
        },
        qps: { peak: peakQps, average: safeAvgQps, cacheHitRate: cachit },
        system: {
            memoryUsage: dbpct,
            heapUsed: dbsz,
            heapTotal: 1024,
            uptime: {
                seconds: Math.floor(process.uptime()),
                days: Math.floor(process.uptime() / 86400),
                hours: Math.floor((process.uptime() % 86400) / 3600),
            },
        },
        config: {
            port: env.port,
            vecDim: env.vecDim,
            cacheSegments: env.cacheSegments,
            maxActive: env.maxActive,
            decayInterval: env.decayIntervalMinutes,
            embedProvider: env.embKind,
            embedModel: env.localEmbeddingModel,
            embedKind: env.embKind,
        },
        counts: {
            memories: totMemCount,
            vectors: vecCnt[0]?.count || 0,
            facts: factCnt[0]?.count || 0,
            edges: edgeCnt[0]?.count || 0,
            activeFacts: actFacts[0]?.count || 0,
            activeEdges: actEdges[0]?.count || 0,
        },
    };
}
