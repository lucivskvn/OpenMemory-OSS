import { env, tier } from "../core/cfg";
import { run_decay_process, prune_weak_waypoints } from "../memory/hsg";
import { mcp } from "../ai/mcp";
import {
    authPlugin,
    logAuthPlugin,
} from "./middleware/auth";
import { start_reflection } from "../memory/reflect";
import { start_user_summary_reflection } from "../memory/user_summary";
import { sendTelemetry } from "../core/telemetry";
import { req_tracker_plugin, dash } from "./routes/dashboard";
import { mem } from "./routes/memory";
import { sys } from "./routes/system";
import { dynroutes } from "./routes/dynamics";
import { ide } from "./routes/ide";
import { compression } from "./routes/compression";
import { lg } from "./routes/langgraph";
import { usr } from "./routes/users";
import { temporal } from "./routes/temporal";
import { vercel } from "./routes/vercel";
import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { log } from "../core/log";

const ASC = `   ____                   __  __                                 
  / __ \\                 |  \\/  |                                
 | |  | |_ __   ___ _ __ | \\  / | ___ _ __ ___   ___  _ __ _   _ 
 | |  | | '_ \\ / _ \\ '_ \\| |\\/| |/ _ \\ '_ \` _ \\ / _ \\| '__| | | |
 | |__| | |_) |  __/ | | | |  | |  __/ | | | | | (_) | |  | |_| |
  \\____/| .__/ \\___|_| |_|_|  |_|\\___|_| |_| |_|\\___/|_|   \\__, |
        | |                                                 __/ |
        |_|                                                |___/ `;

const app = new Elysia()
    .use(cors({
        origin: env.ide_allowed_origins,
        methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization", "x-api-key"],
    }))
    .use(req_tracker_plugin)
    .use(authPlugin);

if (process.env.OM_LOG_AUTH === "true") {
    app.use(logAuthPlugin);
}

// Register all route plugins
app.use(mem);
app.use(sys);
app.use(dynroutes);
app.use(ide);
app.use(compression);
app.use(lg);
app.use(usr);
app.use(temporal);
app.use(dash);
app.use(vercel);

log.info("[SERVER] Registering MCP plugin...");
if (typeof mcp === 'function') {
    app.use(mcp);
    log.info("[SERVER] MCP plugin registered.");
} else {
    log.error("[SERVER] MCP plugin is NOT a function", { mcp });
}

console.log(ASC); // Keep banner raw
log.info(`[CONFIG] Vector Dimension: ${env.vec_dim}`);
log.info(`[CONFIG] Cache Segments: ${env.cache_segments}`);
log.info(`[CONFIG] Max Active Queries: ${env.max_active}`);

if (env.emb_kind !== "synthetic" && (tier === "hybrid" || tier === "fast")) {
    log.warn(
        `[CONFIG] ⚠️  WARNING: Embedding configuration mismatch detected!\n` +
        `         OM_EMBEDDINGS=${env.emb_kind} but OM_TIER=${tier}\n` +
        `         Storage will use ${env.emb_kind} embeddings, but queries will use synthetic embeddings.\n` +
        `         This causes semantic search to fail. Set OM_TIER=deep to fix.`
    );
}

if (env.mode === "langgraph") {
    log.info("[MODE] LangGraph integration enabled");
}

const decayIntervalMs = env.decay_interval_minutes * 60 * 1000;
log.info(
    `[DECAY] Interval: ${env.decay_interval_minutes} minutes (${decayIntervalMs / 1000}s)`,
);

setInterval(async () => {
    log.info("[DECAY] Running HSG decay process...");
    try {
        const result = await run_decay_process();
        log.info(
            `[DECAY] Completed: ${result.decayed}/${result.processed} memories updated`,
        );
    } catch (error) {
        log.error("[DECAY] Process failed", { error });
    }
}, decayIntervalMs);

setInterval(
    async () => {
        log.info("[PRUNE] Pruning weak waypoints...");
        try {
            const pruned = await prune_weak_waypoints();
            log.info(`[PRUNE] Completed: ${pruned} waypoints removed`);
        } catch (error) {
            log.error("[PRUNE] Failed", { error });
        }
    },
    7 * 24 * 60 * 60 * 1000,
);

setTimeout(() => {
    run_decay_process()
        .then((result: any) => {
            log.info(
                `[INIT] Initial decay: ${result.decayed}/${result.processed} memories updated`,
            );
        })
        .catch((e) => log.error("[INIT] Initial decay failed", { error: e }));
}, 3000);

start_reflection();
start_user_summary_reflection();

log.info(`[SERVER] Starting on port ${env.port}`);
app.listen(env.port, () => {
    log.info(`[SERVER] Running on http://localhost:${env.port}`);
    sendTelemetry().catch(() => {
        // ignore telemetry failures
    });
});
