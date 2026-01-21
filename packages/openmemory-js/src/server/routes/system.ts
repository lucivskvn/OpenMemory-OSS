import { Elysia } from "elysia";
import { z } from "zod";
import { VERSION, env, tier } from "../../core/cfg";
import { q } from "../../core/db";
import { sectorConfigs } from "../../core/hsg_config";
import { getRunningIntervals } from "../../core/scheduler";
import { getEmbeddingInfo } from "../../memory/embed";
import { AppError } from "../errors";
import { normalizeUserId } from "../../utils";
import { getUser } from "../middleware/auth";
import type { UserContext } from "../middleware/auth";

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
     */
    .get("/health", () => getHealthHandler())
    .get("/api/system/health", () => getHealthHandler())

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

function getHealthHandler() {
    return {
        success: true,
        version: VERSION,
        gpu: checkGpu(),
        model: env.ollamaModel,
        embedding: getEmbeddingInfo(),
        tier,
        dim: env.vecDim,
        cache: env.cacheSegments,
        expected: (TIER_BENEFITS as Record<string, unknown>)[tier],
    };
}

async function getSectorsHandler(user: UserContext | undefined, queryUserId?: string) {
    const isAdmin = (user?.scopes || []).includes("admin:all");
    let userId = user?.id;

    if (isAdmin) {
        if (queryUserId) userId = queryUserId;
    }

    const stats = await q.getSectorStats.all(userId);
    return {
        sectors: Object.keys(sectorConfigs),
        configs: sectorConfigs,
        stats,
    };
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

    const metrics = {
        memory: {
            rss: Math.round(memUsage.rss / 1024 / 1024),
            heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
            heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
            external: Math.round(memUsage.external / 1024 / 1024),
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
        version: VERSION
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
