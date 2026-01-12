import { env, tier } from "../../core/cfg";
import { q } from "../../core/db";
import { sectorConfigs } from "../../core/hsg_config";
import { getRunningIntervals } from "../../core/scheduler";
import { getEmbeddingInfo } from "../../memory/embed";
import { AppError, sendError } from "../errors";

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

import { z } from "zod";

import { validateQuery } from "../middleware/validate";

const SectorQuerySchema = z.object({
    userId: z.string().optional(),
});

export const getHealth = async (
    _req: AdvancedRequest,
    res: AdvancedResponse,
) => {
    // Check GPU Status (basic check for Nvidia inside container)
    let gpu = false;
    try {
        const { execSync } = await import("node:child_process");
        execSync("nvidia-smi", { stdio: "ignore" });
        gpu = true;
    } catch { }

    res.json({
        ok: true,
        version: "2.3.0",
        gpu,
        model: env.ollamaModel,
        embedding: getEmbeddingInfo(),
        tier,
        dim: env.vecDim,
        cache: env.cacheSegments,
        expected: (TIER_BENEFITS as Record<string, unknown>)[tier],
    });
};

export const getSectors = async (
    req: AdvancedRequest,
    res: AdvancedResponse,
) => {
    try {
        const isAdmin = (req.user?.scopes || []).includes("admin:all");
        let userId = req.user?.id;

        if (isAdmin) {
            const { userId: queryUserId } = req.query as unknown as z.infer<
                typeof SectorQuerySchema
            >;
            if (queryUserId) userId = queryUserId;
        }

        const stats = await q.getSectorStats.all(userId);
        res.json({
            sectors: Object.keys(sectorConfigs),
            configs: sectorConfigs,
            stats,
        });
    } catch (err: unknown) {
        sendError(res, err);
    }
};

export const getMaintenanceStatus = async (
    _req: AdvancedRequest,
    res: AdvancedResponse,
) => {
    try {
        const running = getRunningIntervals();
        res.json({
            ok: true,
            active_jobs: running,
            count: running.length,
        });
    } catch (err: unknown) {
        sendError(res, err);
    }
};

export const getMaintenanceLogs = async (
    req: AdvancedRequest,
    res: AdvancedResponse,
) => {
    try {
        const limitStr = req.query.limit as string;
        const limit = parseInt(limitStr || "50");

        const isAdmin = (req.user?.scopes || []).includes("admin:all");
        let userId = req.user?.id;

        if (isAdmin) {
            // Admin can see system logs (userId=undefined/null) or specific user
            const queryUser = req.query.userId as string;
            userId = queryUser || undefined;
        }

        const logs = await q.getMaintenanceLogs.all(limit, userId);
        res.json({ logs });
    } catch (err: unknown) {
        sendError(res, err);
    }
};

import type { AdvancedRequest, AdvancedResponse, ServerApp } from "../server";

export function systemRoutes(app: ServerApp) {
    app.get("/health", getHealth);
    app.get("/api/system/health", getHealth);
    app.get("/api/system/maintenance", getMaintenanceStatus);
    app.get("/api/system/maintenance/logs", getMaintenanceLogs);
    app.get("/api/system/sectors", validateQuery(SectorQuerySchema), getSectors);
    app.get("/sectors", validateQuery(SectorQuerySchema), getSectors);
    app.get("/api/system/metrics", getSystemMetrics); // Admin only (enforced by logic or middleware if applied)
    app.get("/system/metrics", getSystemMetrics);
}

export const getSystemMetrics = async (
    req: AdvancedRequest,
    res: AdvancedResponse,
) => {
    try {
        // Strict Admin check for metrics
        const isAdmin = (req.user?.scopes || []).includes("admin:all");
        if (!isAdmin) {
            return sendError(res, new AppError(403, "FORBIDDEN", "Admin access required"));
        }

        const memUsage = process.memoryUsage();

        let poolStats = {};
        if (env.metadataBackend === 'postgres') {
            // If we had pool access exposed we could show it, currently DB is encapsulated.
            // We can check `pg.totalCount` if we exported it from `db.ts` or just leave generic.
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
            version: "2.3.0"
        };

        res.json({
            success: true,
            metrics
        });
    } catch (err) {
        sendError(res, err);
    }
};
