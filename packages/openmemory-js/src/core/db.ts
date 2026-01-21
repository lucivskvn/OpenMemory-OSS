/**
 * @file Core Database Layer for OpenMemory.
 * Coordinator module that aggregates database primitives, repositories, and vector stores.
 * Refactored to avoid circular dependencies.
 */
import { SectorStat, MemoryRow } from "./types";
import { logger as dbLogger } from "../utils/logger";
import { env } from "./cfg";
import { resetSecurity } from "./security";
import { q, runAsync, getAsync, allAsync, iterateAsync, transaction, closeDb as closeDbAccess, getContextId } from "./db_access";
export { q, runAsync, getAsync, allAsync, iterateAsync, transaction, closeDbAccess, getContextId };
import { closeRedis } from "./redis";
import { cleanupVectorStores } from "./vector/manager";

// Re-export everything from access layer
export * from "./db_access";
export * from "./db_utils";
export { toVectorString } from "../utils/vectors";
export { vectorStore, getVectorStore, cleanupVectorStores } from "./vector/manager";

// Import Repositories Types
import type { MemoryRepository } from "./repository/memory";
import type { WaypointRepository } from "./repository/waypoint";
import type { LogRepository } from "./repository/log";
import type { UserRepository } from "./repository/user";
import type { ConfigRepository } from "./repository/config";
import type { TemporalRepository } from "./repository/temporal";
import type { AuditRepository } from "./repository/audit";
import type { WebhookRepository } from "./repository/webhook";
import type { RateLimitRepository } from "./repository/rate_limit";
import type { EncryptionRepository } from "./repository/encryption";
import type { IdeRepository } from "./repository/ide";
import { TABLES } from "./db_access";

export interface QType {
    transaction: { run: <T>(fn: () => Promise<T>) => Promise<T> };
    insMem: { run: MemoryRepository["insMem"] };
    insMems: { run: MemoryRepository["insMems"] };
    updMeanVec: { run: MemoryRepository["updMeanVec"] };
    updCompressedVec: { run: MemoryRepository["updCompressedVec"] };
    updEncryption: { run: MemoryRepository["updEncryption"] };
    updFeedback: { run: MemoryRepository["updFeedback"] };
    updSeen: { run: MemoryRepository["updSeen"] };
    updSaliences: { run: MemoryRepository["updSaliences"] };
    updSummary: { run: MemoryRepository["updSummary"] };
    updSummaries: { run: MemoryRepository["updSummaries"] };
    updMem: { run: MemoryRepository["updMem"] };
    updMems: { run: MemoryRepository["updMems"] };

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
    allMemIds: { all: MemoryRepository["allMemIds"] };
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
    delFactsByUser: { run: (userId: string) => Promise<number> };

    insWaypoint: { run: WaypointRepository["insWaypoint"] };
    insWaypoints: { run: WaypointRepository["insWaypoints"] };
    getWaypoint: { get: WaypointRepository["getWaypoint"] };
    getWaypointsBySrc: { all: WaypointRepository["getWaypointsBySrc"] };
    getWaypointsBySrcs: { all: WaypointRepository["getWaypointsBySrcs"] };
    getNeighbors: { all: WaypointRepository["getNeighbors"] };
    updWaypoint: { run: WaypointRepository["updWaypoint"] };
    pruneWaypoints: { run: WaypointRepository["pruneWaypoints"] };
    getLowSalienceMemories: { all: WaypointRepository["getLowSalienceMemories"] };
    getWaypointsForPairs: { all: WaypointRepository["getWaypointsForPairs"] };
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
    delApiKeysByUser: { run: ConfigRepository["delApiKeysByUser"] };
    setSystemConfig: { run: ConfigRepository["setSystemConfig"] };
    getSystemConfig: { get: ConfigRepository["getSystemConfig"] };
    getAllSystemConfigs: { all: ConfigRepository["getAllSystemConfigs"] };
    setFeatureFlag: { run: ConfigRepository["setFeatureFlag"] };
    getFeatureFlag: { get: ConfigRepository["getFeatureFlag"] };
    getAllFeatureFlags: { all: ConfigRepository["getAllFeatureFlags"] };

    // New Repositories
    auditLog: { run: AuditRepository["log"] };
    auditQuery: { all: AuditRepository["query"] };

    createWebhook: { run: WebhookRepository["create"] };
    listWebhooks: { all: WebhookRepository["list"] };
    deleteWebhook: { run: WebhookRepository["delete"] };
    getWebhook: { get: WebhookRepository["get"] };
    logWebhookDelivery: { run: WebhookRepository["logDelivery"] };
    updateWebhookLog: { run: WebhookRepository["updateLog"] };
    delWebhooksByUser: { run: WebhookRepository["delWebhooksByUser"] };

    getRateLimit: { get: RateLimitRepository["get"] };
    updateRateLimit: { run: RateLimitRepository["update"] };
    cleanupRateLimits: { run: RateLimitRepository["cleanup"] };

    logEncryptionRotation: { run: EncryptionRepository["logRotation"] };
    updateEncryptionStatus: { run: EncryptionRepository["updateStatus"] };
    getLatestEncryptionRotation: { get: EncryptionRepository["getLatestRotation"] };

    // Ide Repo
    ideQuery: { getActiveSession: IdeRepository["getActiveSession"] };

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
    delEdgesByUser: { run: (userId: string) => Promise<number> };
    delLearnedModel: { run: (userId: string) => Promise<number> };
    delSourceConfigsByUser: { run: (userId: string) => Promise<number> };
    delWaypointsByUser: { run: (userId: string) => Promise<number> };
    delEmbedLogsByUser: { run: (userId: string) => Promise<number> };
    delMaintLogsByUser: { run: (userId: string) => Promise<number> };
    delStatsByUser: { run: (userId: string) => Promise<number> };
    delMemByUser: { run: (userId: string) => Promise<number> };
    delUserCascade: { run: (userId: string) => Promise<any> };
    pruneMemories: { run: (id: string, userId?: string | null) => Promise<number> };
}

/**
 * Logs a maintenance operation to the stats table.
 * Exported here for backward compatibility/utilities usage.
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
        dbLogger.error("[DB] logMaintOp error", { error: e });
    }
};

// ======================================
// Helper for lazy repository access
// ======================================
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

// Lazy repository getters
// NOTE: Using dynamic imports to avoid circular dependencies (DB -> Repo -> DB)
const getMemRepo = async () => getRepo((await import("./repository/memory")).MemoryRepository);
const getWaypointRepo = async () => getRepo((await import("./repository/waypoint")).WaypointRepository);
const getLogRepo = async () => getRepo((await import("./repository/log")).LogRepository);
const getUserRepo = async () => getRepo((await import("./repository/user")).UserRepository);
const getConfigRepo = async () => getRepo((await import("./repository/config")).ConfigRepository);
const getTemporalRepo = async () => getRepo((await import("./repository/temporal")).TemporalRepository);
const getAuditRepo = async () => getRepo((await import("./repository/audit")).AuditRepository);
const getWebhookRepo = async () => getRepo((await import("./repository/webhook")).WebhookRepository);
const getRateLimitRepo = async () => getRepo((await import("./repository/rate_limit")).RateLimitRepository);
const getEncryptionRepo = async () => getRepo((await import("./repository/encryption")).EncryptionRepository);
const getIdeRepo = async () => getRepo((await import("./repository/ide")).IdeRepository);

const lazyRepo = (repoGetter: () => Promise<any>, method: string) => async (...args: any[]) => {
    const repo = await repoGetter();
    return (repo[method] as any)(...args);
};

// ======================================
// Populate 'q' object (callable function for test reset)
// ======================================
let isQPopulated = false;

/**
 * Populates the `q` object with repository methods.
 * Idempotent - can be called multiple times safely.
 * @internal Exported for test setup to ensure q is populated after closeDb().
 */
export function populateQ(): void {
    if (isQPopulated && q.insMem) return; // Already populated
    dbLogger.info("[DB] Populating q object...");
    Object.assign(q, {
        transaction: { run: <T>(fn: () => Promise<T>) => transaction.run(fn) },
        insMem: { run: lazyRepo(getMemRepo, "insMem") },
        insMems: { run: lazyRepo(getMemRepo, "insMems") },
        updMeanVec: { run: lazyRepo(getMemRepo, "updMeanVec") },
        updCompressedVec: { run: lazyRepo(getMemRepo, "updCompressedVec") },
        updFeedback: { run: lazyRepo(getMemRepo, "updFeedback") },
        updSeen: { run: lazyRepo(getMemRepo, "updSeen") },
        updSaliences: { run: lazyRepo(getMemRepo, "updSaliences") },
        updSummary: { run: lazyRepo(getMemRepo, "updSummary") },
        updSummaries: { run: lazyRepo(getMemRepo, "updSummaries") },
        updMem: { run: lazyRepo(getMemRepo, "updMem") },
        updMems: { run: lazyRepo(getMemRepo, "updMems") },
        updEncryption: { run: lazyRepo(getMemRepo, "updEncryption") },
        updSector: { run: lazyRepo(getMemRepo, "updSector") },
        delMem: { run: lazyRepo(getMemRepo, "delMem") },
        delMems: { run: lazyRepo(getMemRepo, "delMems") },
        getMem: { get: lazyRepo(getMemRepo, "getMem") },
        getMems: { all: lazyRepo(getMemRepo, "getMems") },
        getMemBySimhash: { get: lazyRepo(getMemRepo, "getMemBySimhash") },
        clearAll: {
            run: async () => {
                const tables = [TABLES.memories, TABLES.vectors, TABLES.waypoints, TABLES.users, TABLES.temporal_facts, TABLES.temporal_edges, TABLES.source_configs, TABLES.embed_logs, TABLES.maint_logs, TABLES.stats, TABLES.learned_models];
                for (const t of tables) await runAsync(`delete from ${t}`);
                return 1;
            },
        },
        getStats: { get: lazyRepo(getMemRepo, "getStats") },
        getSectorStats: { all: lazyRepo(getMemRepo, "getSectorStats") },
        getRecentActivity: { all: lazyRepo(getMemRepo, "getRecentActivity") },
        getTopMemories: { all: lazyRepo(getMemRepo, "getTopMemories") },
        getSectorTimeline: { all: lazyRepo(getMemRepo, "getSectorTimeline") },
        getMaintenanceLogs: { all: lazyRepo(getLogRepo, "getMaintenanceLogs") },
        getSegmentCount: { get: lazyRepo(getMemRepo, "getSegmentCount") },
        getSegments: { all: lazyRepo(getMemRepo, "getSegments") },
        getMemCount: { get: lazyRepo(getMemRepo, "getMemCount") },
        getVecCount: { get: lazyRepo(getMemRepo, "getVecCount") },
        getFactCount: { get: lazyRepo(getTemporalRepo, "getFactCount") },
        getEdgeCount: { get: lazyRepo(getTemporalRepo, "getEdgeCount") },
        allMemByUser: { all: lazyRepo(getMemRepo, "allMemByUser") },
        allMem: { all: lazyRepo(getMemRepo, "allMem") },
        allMemStable: { all: lazyRepo(getMemRepo, "allMemStable") },
        allMemCursor: { all: lazyRepo(getMemRepo, "allMemCursor") },
        allMemBySector: { all: lazyRepo(getMemRepo, "allMemBySector") },
        allMemBySectorAndTag: { all: lazyRepo(getMemRepo, "allMemBySectorAndTag") },
        searchMemsByKeyword: { all: lazyRepo(getMemRepo, "searchByKeyword") },
        waypoints: {
            insWaypoint: { run: lazyRepo(getWaypointRepo, "insWaypoint") },
            insWaypoints: { run: lazyRepo(getWaypointRepo, "insWaypoints") },
            getWaypoint: { get: lazyRepo(getWaypointRepo, "getWaypoint") },
            getWaypointsBySrc: { all: lazyRepo(getWaypointRepo, "getWaypointsBySrc") },
            getWaypointsBySrcs: { all: lazyRepo(getWaypointRepo, "getWaypointsBySrcs") },
            getNeighbors: { all: lazyRepo(getWaypointRepo, "getNeighbors") },
            updWaypoint: { run: lazyRepo(getWaypointRepo, "updWaypoint") },
            pruneWaypoints: { run: lazyRepo(getWaypointRepo, "pruneWaypoints") },
            getLowSalienceMemories: { all: lazyRepo(getWaypointRepo, "getLowSalienceMemories") },
            getWaypointsForPairs: { all: lazyRepo(getWaypointRepo, "getWaypointsForPairs") },
            list: { all: lazyRepo(getWaypointRepo, "list") },
        },
        insWaypoint: { run: lazyRepo(getWaypointRepo, "insWaypoint") },
        insWaypoints: { run: lazyRepo(getWaypointRepo, "insWaypoints") },
        getWaypoint: { get: lazyRepo(getWaypointRepo, "getWaypoint") },
        getWaypointsBySrc: { all: lazyRepo(getWaypointRepo, "getWaypointsBySrc") },
        getWaypointsBySrcs: { all: lazyRepo(getWaypointRepo, "getWaypointsBySrcs") },
        getNeighbors: { all: lazyRepo(getWaypointRepo, "getNeighbors") },
        updWaypoint: { run: lazyRepo(getWaypointRepo, "updWaypoint") },
        pruneWaypoints: { run: lazyRepo(getWaypointRepo, "pruneWaypoints") },
        getLowSalienceMemories: { all: lazyRepo(getWaypointRepo, "getLowSalienceMemories") },
        getWaypointsForPairs: { all: lazyRepo(getWaypointRepo, "getWaypointsForPairs") },
        delMemByUser: { run: lazyRepo(getMemRepo, "delMemByUser") },
        pruneMemories: { run: lazyRepo(getMemRepo, "delMem") },
        insMaintLog: { run: lazyRepo(getLogRepo, "insMaintLog") },
        logMaintOp: { run: lazyRepo(getLogRepo, "logMaintOp") },
        insLog: { run: lazyRepo(getLogRepo, "insLog") },
        updLog: { run: lazyRepo(getLogRepo, "updLog") },
        getPendingLogs: { all: lazyRepo(getLogRepo, "getPendingLogs") },
        getFailedLogs: { all: lazyRepo(getLogRepo, "getFailedLogs") },
        getUser: { get: lazyRepo(getUserRepo, "getById") },
        insUser: { run: lazyRepo(getUserRepo, "insUser") },
        updUserSummary: { run: lazyRepo(getUserRepo, "updUserSummary") },
        getUserById: { get: lazyRepo(getUserRepo, "getById") },
        getAllUsers: { all: lazyRepo(getUserRepo, "getUsers") },
        delEdgesByUser: { run: lazyRepo(getTemporalRepo, "delEdgesByUser") },
        delLearnedModel: { run: lazyRepo(getConfigRepo, "delLearnedModelByUser") },
        delSourceConfigsByUser: { run: lazyRepo(getConfigRepo, "delSourceConfigsByUser") },
        delWaypointsByUser: { run: lazyRepo(getWaypointRepo, "delWaypointsByUser") },
        delEmbedLogsByUser: { run: lazyRepo(getLogRepo, "delEmbedLogsByUser") },
        delMaintLogsByUser: { run: lazyRepo(getLogRepo, "delMaintLogsByUser") },
        delStatsByUser: { run: lazyRepo(getUserRepo, "delStatsByUser") },
        delUserCascade: { run: lazyRepo(getUserRepo, "deleteUserCascade") },
        getMemByMetadataLike: { all: lazyRepo(getMemRepo, "getMemByMetadataLike") },
        getTrainingData: { all: lazyRepo(getMemRepo, "getTrainingData") },
        getClassifierModel: { get: lazyRepo(getConfigRepo, "getClassifierModel") },
        insClassifierModel: { run: lazyRepo(getConfigRepo, "insClassifierModel") },
        getActiveUsers: { all: lazyRepo(getUserRepo, "getActiveUsers") },
        getUsers: { all: lazyRepo(getUserRepo, "getUsers") },
        getTables: { all: () => allAsync(env.metadataBackend === "postgres" ? `SELECT table_name as name FROM information_schema.tables WHERE table_schema='${env.pgSchema}'` : "SELECT name FROM sqlite_master WHERE type='table'") },
        insSourceConfig: { run: lazyRepo(getConfigRepo, "insSourceConfig") },
        updSourceConfig: { run: lazyRepo(getConfigRepo, "updSourceConfig") },
        getSourceConfig: { get: lazyRepo(getConfigRepo, "getSourceConfig") },
        getSourceConfigsByUser: { all: lazyRepo(getConfigRepo, "getSourceConfigsByUser") },
        delSourceConfig: { run: lazyRepo(getConfigRepo, "delSourceConfig") },
        insApiKey: { run: lazyRepo(getConfigRepo, "insApiKey") },
        getApiKey: { get: lazyRepo(getConfigRepo, "getApiKey") },
        getAdminKeysCount: { get: lazyRepo(getConfigRepo, "getAdminCount") },
        delApiKey: { run: lazyRepo(getConfigRepo, "delApiKey") },
        getApiKeysByUser: { all: lazyRepo(getConfigRepo, "getApiKeysByUser") },
        getAllApiKeys: { all: lazyRepo(getConfigRepo, "getAllApiKeys") },
        getAdminCount: { get: lazyRepo(getConfigRepo, "getAdminCount") },
        hsgSearch: { all: lazyRepo(getMemRepo, "hsgSearch") },
        allMemIds: { all: lazyRepo(getMemRepo, "allMemIds") },
        delOrphanWaypoints: { run: lazyRepo(getWaypointRepo, "delOrphanWaypoints") },

        // Temporal
        findActiveFact: { get: lazyRepo(getTemporalRepo, "findActiveFact") },
        updateFactConfidence: { run: lazyRepo(getTemporalRepo, "updateFactConfidence") },
        getOverlappingFacts: { all: lazyRepo(getTemporalRepo, "getOverlappingFacts") },
        closeFact: { run: lazyRepo(getTemporalRepo, "closeFact") },
        insertFactRaw: { run: lazyRepo(getTemporalRepo, "insertFactRaw") },
        updateFactRaw: { run: lazyRepo(getTemporalRepo, "updateFactRaw") },
        findActiveEdge: { get: lazyRepo(getTemporalRepo, "findActiveEdge") },
        updateEdgeWeight: { run: lazyRepo(getTemporalRepo, "updateEdgeWeight") },
        getOverlappingEdges: { all: lazyRepo(getTemporalRepo, "getOverlappingEdges") },
        closeEdge: { run: lazyRepo(getTemporalRepo, "closeEdge") },
        insertEdgeRaw: { run: lazyRepo(getTemporalRepo, "insertEdgeRaw") },
        updateEdgeRaw: { run: lazyRepo(getTemporalRepo, "updateEdgeRaw") },
        deleteEdgeRaw: { run: lazyRepo(getTemporalRepo, "deleteEdgeRaw") },
        applyConfidenceDecay: { run: lazyRepo(getTemporalRepo, "applyConfidenceDecay") },
        getFact: { get: lazyRepo(getTemporalRepo, "getFact") },
        getEdge: { get: lazyRepo(getTemporalRepo, "getEdge") },
        getActiveFactCount: { get: lazyRepo(getTemporalRepo, "getActiveFactCount") },
        getActiveEdgeCount: { get: lazyRepo(getTemporalRepo, "getActiveEdgeCount") },
        queryFactsAtTime: { all: lazyRepo(getTemporalRepo, "queryFactsAtTime") },
        getCurrentFact: { get: lazyRepo(getTemporalRepo, "getCurrentFact") },
        queryFactsInRange: { all: lazyRepo(getTemporalRepo, "queryFactsInRange") },
        findConflictingFacts: { all: lazyRepo(getTemporalRepo, "findConflictingFacts") },
        getFactsBySubject: { all: lazyRepo(getTemporalRepo, "getFactsBySubject") },
        searchFacts: { all: lazyRepo(getTemporalRepo, "searchFacts") },
        getRelatedFacts: { all: lazyRepo(getTemporalRepo, "getRelatedFacts") },
        queryEdges: { all: lazyRepo(getTemporalRepo, "queryEdges") },
        getFactsByPredicate: { all: lazyRepo(getTemporalRepo, "getFactsByPredicate") },
        getChangesInWindow: { all: lazyRepo(getTemporalRepo, "getChangesInWindow") },
        delFactsByUser: { run: lazyRepo(getTemporalRepo, "delFactsByUser") },
        getVolatileFacts: { all: lazyRepo(getTemporalRepo, "getVolatileFacts") },

        delApiKeysByUser: { run: lazyRepo(getConfigRepo, "delApiKeysByUser") },
        setSystemConfig: { run: lazyRepo(getConfigRepo, "setSystemConfig") },
        getSystemConfig: { get: lazyRepo(getConfigRepo, "getSystemConfig") },
        getAllSystemConfigs: { all: lazyRepo(getConfigRepo, "getAllSystemConfigs") },
        setFeatureFlag: { run: lazyRepo(getConfigRepo, "setFeatureFlag") },
        getFeatureFlag: { get: lazyRepo(getConfigRepo, "getFeatureFlag") },
        getAllFeatureFlags: { all: lazyRepo(getConfigRepo, "getAllFeatureFlags") },

        auditLog: { run: lazyRepo(getAuditRepo, "log") },
        auditQuery: { all: lazyRepo(getAuditRepo, "query") },

        createWebhook: { run: lazyRepo(getWebhookRepo, "create") },
        listWebhooks: { all: lazyRepo(getWebhookRepo, "list") },
        deleteWebhook: { run: lazyRepo(getWebhookRepo, "delete") },
        getWebhook: { get: lazyRepo(getWebhookRepo, "get") },
        logWebhookDelivery: { run: lazyRepo(getWebhookRepo, "logDelivery") },
        updateWebhookLog: { run: lazyRepo(getWebhookRepo, "updateLog") },
        delWebhooksByUser: { run: lazyRepo(getWebhookRepo, "delWebhooksByUser") },

        getRateLimit: { get: lazyRepo(getRateLimitRepo, "get") },
        updateRateLimit: { run: lazyRepo(getRateLimitRepo, "update") },
        cleanupRateLimits: { run: lazyRepo(getRateLimitRepo, "cleanup") },

        logEncryptionRotation: { run: lazyRepo(getEncryptionRepo, "logRotation") },
        updateEncryptionStatus: { run: lazyRepo(getEncryptionRepo, "updateStatus") },
        getLatestEncryptionRotation: { get: lazyRepo(getEncryptionRepo, "getLatestRotation") },

        ideQuery: { getActiveSession: lazyRepo(getIdeRepo, "getActiveSession") },
    });
    isQPopulated = true;
    dbLogger.info("[DB] q populated.");
}

// Call at module load
populateQ();

// ======================================
// Lifecycle Management
// ======================================
export async function waitForDb(timeout = 5000) {
    // Ensure q is populated
    populateQ();

    const start = Date.now();
    while (!q.insMem) {
        if (Date.now() - start > timeout) {
            dbLogger.error("[DB] Timeout waiting for DB q object population. Keys:", { keys: Object.keys(q) });
            throw new Error("Timeout waiting for DB q object");
        }
        await new Promise(r => setTimeout(r, 100));
    }
    return true;
}

export async function closeDb() {
    const cid = getContextId();

    // 1. Stop scheduler (dynamic import to avoid cycle)
    try {
        const scheduler = await import("./scheduler");
        await scheduler.stopAllMaintenance();
    } catch (e) {
        dbLogger.warn("[DB] Failed to stop scheduler", { error: e });
    }

    // 2. Disconnect vectors
    await cleanupVectorStores(cid);

    // 3. Close DB primitives
    await closeDbAccess();

    // 4. Close Redis
    await closeRedis();

    // 5. Reset Security (clears cached keys/provider)
    resetSecurity();
}

