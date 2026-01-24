/**
 * @file Database Query Object Population
 * Populates the q object with repository methods for the modular database structure.
 */
import { logger as dbLogger } from "../../utils/logger";
import { env } from "../cfg";
import { q, type RepositoryMap } from "./connection";
import { runAsync, allAsync } from "./operations";
import { transaction } from "./transactions";
import { TABLES } from "./tables";

// ======================================
// Helper for lazy repository access
// ======================================
const repos = new Map<string, any>();

function getRepo<T>(Class: new (...args: any[]) => T): T {
    const key = Class.name;
    let repo = repos.get(key);
    if (!repo) {
        repo = new Class({
            runAsync,
            getAsync: async (sql: string, params: any[] = []) => {
                const { getAsync } = await import("./operations");
                return await getAsync(sql, params);
            },
            allAsync,
            transaction,
        });
        repos.set(key, repo);
    }
    return repo;
}

// Lazy repository getters
// NOTE: Using dynamic imports to avoid circular dependencies (DB -> Repo -> DB)
const getMemRepo = async () => getRepo((await import("../repository/memory")).MemoryRepository);
const getWaypointRepo = async () => getRepo((await import("../repository/waypoint")).WaypointRepository);
const getLogRepo = async () => getRepo((await import("../repository/log")).LogRepository);
const getUserRepo = async () => getRepo((await import("../repository/user")).UserRepository);
const getConfigRepo = async () => getRepo((await import("../repository/config")).ConfigRepository);
const getTemporalRepo = async () => getRepo((await import("../repository/temporal")).TemporalRepository);
const getAuditRepo = async () => getRepo((await import("../repository/audit")).AuditRepository);
const getWebhookRepo = async () => getRepo((await import("../repository/webhook")).WebhookRepository);
const getRateLimitRepo = async () => getRepo((await import("../repository/rateLimit")).RateLimitRepository);
const getEncryptionRepo = async () => getRepo((await import("../repository/encryption")).EncryptionRepository);
const getIdeRepo = async () => getRepo((await import("../repository/ide")).IdeRepository);

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
    if (isQPopulated && q && (q as any).insMem) return; // Already populated
    dbLogger.info("[DB] Populating q object...");
    
    const mapping: any = {
        transaction: { run: (fn: () => Promise<any>) => transaction.run(fn) },

        // Memory
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
        getStats: { get: lazyRepo(getMemRepo, "getStats") },
        getSectorStats: { all: lazyRepo(getMemRepo, "getSectorStats") },
        getRecentActivity: { all: lazyRepo(getMemRepo, "getRecentActivity") },
        getTopMemories: { all: lazyRepo(getMemRepo, "getTopMemories") },
        getSectorTimeline: { all: lazyRepo(getMemRepo, "getSectorTimeline") },
        getSegmentCount: { get: lazyRepo(getMemRepo, "getSegmentCount") },
        getSegments: { all: lazyRepo(getMemRepo, "getSegments") },
        getMemCount: { get: lazyRepo(getMemRepo, "getMemCount") },
        getVecCount: { get: lazyRepo(getMemRepo, "getVecCount") },
        allMemByUser: { all: lazyRepo(getMemRepo, "allMemByUser") },
        allMem: { all: lazyRepo(getMemRepo, "allMem") },
        allMemStable: { all: lazyRepo(getMemRepo, "allMemStable") },
        allMemCursor: { all: lazyRepo(getMemRepo, "allMemCursor") },
        allMemBySector: { all: lazyRepo(getMemRepo, "allMemBySector") },
        allMemBySectorAndTag: { all: lazyRepo(getMemRepo, "allMemBySectorAndTag") },
        searchMemsByKeyword: { all: lazyRepo(getMemRepo, "searchByKeyword") },
        hsgSearch: { all: lazyRepo(getMemRepo, "hsgSearch") },
        findMems: { all: lazyRepo(getMemRepo, "findMems") },
        allMemIds: { all: lazyRepo(getMemRepo, "allMemIds") },
        getMemByMetadataLike: { all: lazyRepo(getMemRepo, "getMemByMetadataLike") },
        getTrainingData: { all: lazyRepo(getMemRepo, "getTrainingData") },
        delMemByUser: { run: lazyRepo(getMemRepo, "delMemByUser") },
        pruneMemories: { run: lazyRepo(getMemRepo, "delMem") },

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
        getFactCount: { get: lazyRepo(getTemporalRepo, "getFactCount") },
        getEdgeCount: { get: lazyRepo(getTemporalRepo, "getEdgeCount") },
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
        delEdgesByUser: { run: lazyRepo(getTemporalRepo, "delEdgesByUser") },

        // Waypoints
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
        delOrphanWaypoints: { run: lazyRepo(getWaypointRepo, "delOrphanWaypoints") },
        delWaypointsByUser: { run: lazyRepo(getWaypointRepo, "delWaypointsByUser") },
        list: { all: lazyRepo(getWaypointRepo, "list") },

        // User & Config
        getUser: { get: lazyRepo(getUserRepo, "getById") },
        insUser: { run: lazyRepo(getUserRepo, "insUser") },
        updUserSummary: { run: lazyRepo(getUserRepo, "updUserSummary") },
        getUserById: { get: lazyRepo(getUserRepo, "getById") },
        getAllUsers: { all: lazyRepo(getUserRepo, "getUsers") },
        getActiveUsers: { all: lazyRepo(getUserRepo, "getActiveUsers") },
        getUsers: { all: lazyRepo(getUserRepo, "getUsers") },
        delUser: { run: lazyRepo(getUserRepo, "delUser") },
        delStatsByUser: { run: lazyRepo(getUserRepo, "delStatsByUser") },
        delUserCascade: { run: lazyRepo(getUserRepo, "deleteUserCascade") },

        insSourceConfig: { run: lazyRepo(getConfigRepo, "insSourceConfig") },
        updSourceConfig: { run: lazyRepo(getConfigRepo, "updSourceConfig") },
        getSourceConfig: { get: lazyRepo(getConfigRepo, "getSourceConfig") },
        getSourceConfigsByUser: { all: lazyRepo(getConfigRepo, "getSourceConfigsByUser") },
        delSourceConfig: { run: lazyRepo(getConfigRepo, "delSourceConfig") },
        delSourceConfigsByUser: { run: lazyRepo(getConfigRepo, "delSourceConfigsByUser") },
        insApiKey: { run: lazyRepo(getConfigRepo, "insApiKey") },
        getApiKey: { get: lazyRepo(getConfigRepo, "getApiKey") },
        getAdminCount: { get: lazyRepo(getConfigRepo, "getAdminCount") },
        delApiKey: { run: lazyRepo(getConfigRepo, "delApiKey") },
        getApiKeysByUser: { all: lazyRepo(getConfigRepo, "getApiKeysByUser") },
        getAllApiKeys: { all: lazyRepo(getConfigRepo, "getAllApiKeys") },
        delApiKeysByUser: { run: lazyRepo(getConfigRepo, "delApiKeysByUser") },
        getClassifierModel: { get: lazyRepo(getConfigRepo, "getClassifierModel") },
        insClassifierModel: { run: lazyRepo(getConfigRepo, "insClassifierModel") },
        delLearnedModel: { run: lazyRepo(getConfigRepo, "delLearnedModelByUser") },
        setSystemConfig: { run: lazyRepo(getConfigRepo, "setSystemConfig") },
        getSystemConfig: { get: lazyRepo(getConfigRepo, "getSystemConfig") },
        getAllSystemConfigs: { all: lazyRepo(getConfigRepo, "getAllSystemConfigs") },
        setFeatureFlag: { run: lazyRepo(getConfigRepo, "setFeatureFlag") },
        getFeatureFlag: { get: lazyRepo(getConfigRepo, "getFeatureFlag") },
        getAllFeatureFlags: { all: lazyRepo(getConfigRepo, "getAllFeatureFlags") },

        // Logs & Audit
        insLog: { run: lazyRepo(getLogRepo, "insLog") },
        updLog: { run: lazyRepo(getLogRepo, "updLog") },
        getPendingLogs: { all: lazyRepo(getLogRepo, "getPendingLogs") },
        getFailedLogs: { all: lazyRepo(getLogRepo, "getFailedLogs") },
        insMaintLog: { run: lazyRepo(getLogRepo, "insMaintLog") },
        logMaintOp: { run: lazyRepo(getLogRepo, "logMaintOp") },
        getMaintenanceLogs: { all: lazyRepo(getLogRepo, "getMaintenanceLogs") },
        delEmbedLogsByUser: { run: lazyRepo(getLogRepo, "delEmbedLogsByUser") },
        delMaintLogsByUser: { run: lazyRepo(getLogRepo, "delMaintLogsByUser") },
        auditLog: { run: lazyRepo(getAuditRepo, "log") },
        auditQuery: { all: lazyRepo(getAuditRepo, "query") },

        // Webhooks & Rate Limits
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

        // Security & IDE
        logEncryptionRotation: { run: lazyRepo(getEncryptionRepo, "logRotation") },
        updateEncryptionStatus: { run: lazyRepo(getEncryptionRepo, "updateStatus") },
        getLatestEncryptionRotation: { get: lazyRepo(getEncryptionRepo, "getLatestRotation") },
        ideQuery: { getActiveSession: lazyRepo(getIdeRepo, "getActiveSession") },

        // Specialized
        clearAll: {
            run: async () => {
                const tables = [TABLES.memories, TABLES.vectors, TABLES.waypoints, TABLES.users, TABLES.temporal_facts, TABLES.temporal_edges, TABLES.source_configs, TABLES.embed_logs, TABLES.maint_logs, TABLES.stats, TABLES.learned_models];
                for (const t of tables) await runAsync(`delete from ${t}`);
                return 1;
            },
        },
        getTables: {
            all: () => allAsync(env.metadataBackend === "postgres"
                ? `SELECT table_name as name FROM information_schema.tables WHERE table_schema='${env.pgSchema}'`
                : "SELECT name FROM sqlite_master WHERE type='table'")
        },
    };

    Object.assign(q, mapping);
    isQPopulated = true;
    dbLogger.info("[DB] q populated.");
}

/**
 * Waits for the database to be ready and ensures q is populated
 */
export async function waitForDb(timeout = 5000) {
    // Ensure q is populated
    populateQ();

    const start = Date.now();
    while (!q || !(q as any).insMem) {
        if (Date.now() - start > timeout) {
            dbLogger.error("[DB] Timeout waiting for DB q object population. Keys:", { keys: q ? Object.keys(q) : [] });
            throw new Error("Timeout waiting for DB q object");
        }
        await new Promise(r => setTimeout(r, 100));
    }
    return true;
}

// Only call at module load if q is available and defined
// Note: Removed automatic population to avoid circular dependency issues
// populateQ() will be called by waitForDb() when needed