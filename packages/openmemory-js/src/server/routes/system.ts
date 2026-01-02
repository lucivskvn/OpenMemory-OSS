import { q } from "../../core/db";
import { sector_configs } from "../../memory/hsg";
import { getEmbeddingInfo } from "../../memory/embed";
import { tier, env } from "../../core/cfg";
import { sendError } from "../errors";
import { AdvancedRequest, AdvancedResponse } from "../index";

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

export const get_health = async (req: AdvancedRequest, res: AdvancedResponse) => {
    res.json({
        ok: true,
        version: "2.1.0",
        embedding: getEmbeddingInfo(),
        tier,
        dim: env.vec_dim,
        cache: env.cache_segments,
        expected: (TIER_BENEFITS as any)[tier],
    });
};

export const get_sectors = async (req: AdvancedRequest, res: AdvancedResponse) => {
    try {
        const user_id = req.user?.id;
        const stats = await q.get_sector_stats.all(user_id);
        res.json({
            sectors: Object.keys(sector_configs),
            configs: sector_configs,
            stats,
        });
    } catch (err: unknown) {
        sendError(res, err);
    }
};

export function sys(app: any) {
    app.get("/health", get_health);
    app.get("/api/system/health", get_health);
    app.get("/api/system/sectors", get_sectors);
    app.get("/sectors", get_sectors);
}
