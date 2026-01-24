import { Elysia } from "elysia";
import { z } from "zod";
import { VERSION, env } from "../../core/cfg";
import { q } from "../../core/db";
import { sectorConfigs } from "../../core/hsgConfig";
import { getRunningIntervals } from "../../core/scheduler";
import { getEmbeddingInfo } from "../../memory/embed";
import { AppError } from "../errors";
import { normalizeUserId } from "../../utils";
import { getUser } from "../middleware/auth";
import type { UserContext } from "../middleware/auth";
import { metricsCollector } from "../../utils/metricsCollector";
import { healthChecker } from "../../utils/healthChecker";
import { logger, traceOperation } from "../../utils/logger";
import { traceOperation as middlewareTraceOperation } from "../middleware/tracing";

function ensureAdmin(user: UserContext | undefined): void {
    if (!user || !(user.scopes || []).includes("admin:all")) {
        throw new AppError(403, "FORBIDDEN", "Admin access required");
    }
}

const SectorQuerySchema = z.object({
    userId: z.string().optional(),
});

const LogsQuerySchema = z.object({
    limit: z.coerce.number().default(50),
    userId: z.string().optional(),
});

const TIER_BENEFITS = {
    hybrid: {
        recall: 98,
        qps: "700-800",
        ram: "0.5gb/10k",
        use: "For high accuracy",
    },
    fast: {
        recall: 70,
        qps: "700-850",
        ram: "0.6GB/10k",
        use: "Local apps, extensions",
    },
    smart: {
        recall: 85,
        qps: "500-600",
        ram: "0.9GB/10k",
        use: "Production servers",
    },
    deep: {
        recall: 94,
        qps: "350-400",
        ram: "1.6GB/10k",
        use: "Cloud, high-accuracy",
    },
};

export const systemRoutes = (app: Elysia) => app
    /**
     * GET /health
     * GET /api/system/health
     * Basic health check endpoint
     */
    .get("/health", () => getHealthHandler())
    .get("/api/system/health", () => getHealthHandler())

    /**
     * GET /health/detailed
     * GET /api/system/health/detailed
     * Comprehensive health check with all components
     * (Admin Only)
     */
    .get("/health/detailed", async (ctx) => {
        const user = getUser(ctx);
        ensureAdmin(user);
        return getDetailedHealthHandler();
    })
    .get("/api/system/health/detailed", async (ctx) => {
        const user = getUser(ctx);
        ensureAdmin(user);
        return getDetailedHealthHandler();
    })

    /**
     * GET /sectors
     * GET /api/system/sectors
     */
    .get("/sectors", async ({ query, ...ctx }) => {
        const qParams = SectorQuerySchema.parse(query);
        const user = getUser(ctx);
        return getSectorsHandler(user, qParams.userId);
    })
    .get("/api/system/sectors", async ({ query, ...ctx }) => {
        const qParams = SectorQuerySchema.parse(query);
        const user = getUser(ctx);
        return getSectorsHandler(user, qParams.userId);
    })

    /**
     * GET /system/metrics
     * GET /api/system/metrics
     * (Admin Only)
     */
    .get("/system/metrics", async (ctx) => {
        const user = getUser(ctx);
        ensureAdmin(user);
        return getSystemMetricsHandler();
    })
    .get("/api/system/metrics", async (ctx) => {
        const user = getUser(ctx);
        ensureAdmin(user);
        return getSystemMetricsHandler();
    })

    /**
     * GET /system/metrics/prometheus
     * GET /api/system/metrics/prometheus
     * Returns Prometheus-compatible metrics format
     * (Admin Only)
     */
    .get("/system/metrics/prometheus", async (ctx) => {
        const user = getUser(ctx);
        ensureAdmin(user);
        
        ctx.set.headers['Content-Type'] = 'text/plain; version=0.0.4; charset=utf-8';
        return metricsCollector.generatePrometheusMetrics();
    })
    .get("/api/system/metrics/prometheus", async (ctx) => {
        const user = getUser(ctx);
        ensureAdmin(user);
        
        ctx.set.headers['Content-Type'] = 'text/plain; version=0.0.4; charset=utf-8';
        return metricsCollector.generatePrometheusMetrics();
    })

    /**
     * GET /api/system/maintenance
     * (Admin Only)
     */
    .get("/api/system/maintenance", async (ctx) => {
        const user = getUser(ctx);
        ensureAdmin(user);
        return getMaintenanceStatusHandler();
    })

    /**
     * GET /api/system/maintenance/logs
     * (Admin Only)
     */
    .get("/api/system/maintenance/logs", async ({ query, ...ctx }) => {
        const qParams = LogsQuerySchema.parse(query);
        const user = getUser(ctx);
        ensureAdmin(user);
        return getMaintenanceLogsHandler(user, qParams.limit, qParams.userId);
    });

// --- Handlers ---

function checkGpu() {
    try {
        const proc = Bun.spawnSync(["nvidia-smi"], { stderr: "ignore" });
        return proc.success;
    } catch {
        return false;
    }
}

async function getHealthHandler() {
    // Quick health check for basic endpoint
    const quickCheck = await healthChecker.quickHealthCheck();
    
    return {
        success: quickCheck.healthy,
        status: quickCheck.healthy ? 'healthy' : 'unhealthy',
        message: quickCheck.message,
        version: VERSION,
        timestamp: Date.now(),
        uptime: process.uptime(),
        // Basic system info for compatibility
        gpu: checkGpu(),
        model: env.ollamaModel,
        embedding: getEmbeddingInfo(),
        tier: env.tier,
        dim: env.vecDim,
        cache: env.cacheSegments,
        expected: (TIER_BENEFITS as Record<string, unknown>)[env.tier],
    };
}

async function getDetailedHealthHandler() {
    // Comprehensive health check with all components
    const healthReport = await healthChecker.runHealthChecks();
    
    return {
        success: healthReport.overall === 'healthy',
        overall: healthReport.overall,
        checks: healthReport.checks,
        timestamp: healthReport.timestamp,
        uptime: healthReport.uptime,
        version: healthReport.version,
        // Additional system info
        system: {
            gpu: checkGpu(),
            model: env.ollamaModel,
            embedding: getEmbeddingInfo(),
            tier: env.tier,
            dim: env.vecDim,
            cache: env.cacheSegments,
            expected: (TIER_BENEFITS as Record<string, unknown>)[env.tier],
        }
    };
}

async function getSectorsHandler(user: UserContext | undefined, queryUserId?: string) {
    return middlewareTraceOperation("get-sectors", async () => {
        const isAdmin = (user?.scopes || []).includes("admin:all");
        let userId = user?.id;

        if (isAdmin) {
            if (queryUserId) userId = queryUserId;
        }

        logger.debug("Fetching sector statistics", { 
            userId, 
            isAdmin, 
            queryUserId 
        });

        const stats = await q.getSectorStats.all(userId);
        
        logger.info("Sector statistics retrieved", { 
            sectorCount: Object.keys(sectorConfigs).length,
            statsCount: stats.length,
            userId 
        });

        return {
            sectors: Object.keys(sectorConfigs),
            configs: sectorConfigs,
            stats,
        };
    }, { userId: user?.id, isAdmin: (user?.scopes || []).includes("admin:all") });
}

async function getSystemMetricsHandler() {
    const memUsage = process.memoryUsage();

    let poolStats = {};
    if (env.metadataBackend === 'postgres') {
        poolStats = { type: 'postgres' };
    } else {
        poolStats = { type: 'sqlite', mode: env.mode };
    }

    const runningJobs = getRunningIntervals();

    // Get enhanced metrics from the metrics collector
    const enhancedMetrics = metricsCollector.getMetricsSummary(300000); // 5 minutes

    const metrics = {
        memory: {
            rss: Math.round(memUsage.rss / 1024 / 1024),
            heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
            heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
            external: Math.round(memUsage.external / 1024 / 1024),
            arrayBuffers: Math.round((memUsage.arrayBuffers || 0) / 1024 / 1024),
        },
        cpu: process.cpuUsage(),
        uptime: process.uptime(),
        connections: {
            active: 0, // Placeholder
            pool: poolStats
        },
        jobs: {
            active: runningJobs.length,
            names: runningJobs
        },
        version: VERSION,
        // Enhanced performance metrics
        performance: {
            vector: {
                totalOperations: enhancedMetrics.vector.totalOperations,
                averageDuration: Math.round(enhancedMetrics.vector.averageDuration * 100) / 100,
                successRate: Math.round(enhancedMetrics.vector.successRate * 10000) / 100, // Percentage
                operationBreakdown: enhancedMetrics.vector.operationBreakdown,
                slowestOperations: enhancedMetrics.vector.slowestOperations.map(op => ({
                    operation: op.operation,
                    duration: op.duration,
                    vectorCount: op.vectorCount,
                    dimensions: op.dimensions
                }))
            },
            database: {
                totalQueries: enhancedMetrics.database.totalQueries,
                averageDuration: Math.round(enhancedMetrics.database.averageDuration * 100) / 100,
                successRate: Math.round(enhancedMetrics.database.successRate * 10000) / 100, // Percentage
                queryTypeBreakdown: enhancedMetrics.database.queryTypeBreakdown,
                slowestQueries: enhancedMetrics.database.slowestQueries.map(query => ({
                    queryType: query.queryType,
                    duration: query.duration,
                    rowsAffected: query.rowsAffected,
                    query: query.query.substring(0, 100) + (query.query.length > 100 ? '...' : '')
                }))
            },
            api: {
                totalRequests: enhancedMetrics.api.totalRequests,
                averageDuration: Math.round(enhancedMetrics.api.averageDuration * 100) / 100,
                successRate: Math.round(enhancedMetrics.api.successRate * 10000) / 100, // Percentage
                endpointBreakdown: enhancedMetrics.api.endpointBreakdown,
                statusCodeBreakdown: enhancedMetrics.api.statusCodeBreakdown
            }
        }
    };

    return {
        success: true,
        metrics
    };
}

function getMaintenanceStatusHandler() {
    const running = getRunningIntervals();
    return {
        success: true,
        active_jobs: running,
        count: running.length,
    };
}

async function getMaintenanceLogsHandler(user: UserContext | undefined, limit: number, queryUserId?: string) {
    const isAdmin = (user?.scopes || []).includes("admin:all");
    let userId = user?.id;

    if (isAdmin) {
        // Admin can see system logs (userId=undefined/null) or specific user
        userId = queryUserId || undefined;
    }

    const logs = await q.getMaintenanceLogs.all(limit, userId);
    return { success: true, logs };
}

function ensureAdmin(user: UserContext | undefined) {
    const isAdmin = (user?.scopes || []).includes("admin:all");
    if (!isAdmin) {
        throw new AppError(403, "FORBIDDEN", "Admin access required");
    }
}
