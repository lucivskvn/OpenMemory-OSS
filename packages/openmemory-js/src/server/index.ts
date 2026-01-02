import server from "./server";
import { env, tier } from "../core/cfg";
import { run_decay_process, prune_weak_waypoints } from "../memory/hsg";
import { mcp } from "../ai/mcp";
import { routes } from "./routes";
import {
    authenticate_api_request,
    log_authenticated_request,
} from "./middleware/auth";
import { start_reflection } from "../memory/reflect";
import { start_user_summary_reflection } from "../memory/user_summary";
import { sendTelemetry } from "../core/telemetry";
import { req_tracker_mw } from "./routes/dashboard";
import { close_db } from "../core/db";
import { maintenanceRetrainAll } from "../ops/maintenance";

export * from "./server";
// Explicitly import for local usage
import { AdvancedRequest, AdvancedResponse } from "./server";

const ASC = `   ____                   __  __                                 
  / __ \\                 |  \\/  |                                
 | |  | |_ __   ___ _ __ | \\  / | ___ _ __ ___   ___  _ __ _   _ 
 | |  | | '_ \\ / _ \\ '_ \\| |\\/| |/ _ \\ '_ \` _ \\ / _ \\| '__| | | |
 | |__| | |_) |  __/ | | | |  | |  __/ | | | | | (_) | |  | |_| |
  \\____/| .__/ \\___|_| |_|_|  |_|\\___|_| |_| |_|\\___/|_|   \\__, |
        | |                                                 __/ |
        |_|                                                |___/ `;

const app = server({ max_payload_size: env.max_payload_size });

console.log(ASC);
if (env.verbose) {
    console.log(`[CONFIG] Vector Dimension: ${env.vec_dim}`);
    console.log(`[CONFIG] Cache Segments: ${env.cache_segments}`);
    console.log(`[CONFIG] Max Active Queries: ${env.max_active}`);
}

// Warn about configuration mismatch that causes embedding incompatibility
if (env.emb_kind !== "synthetic" && (tier === "hybrid" || tier === "fast")) {
    console.warn(
        `[CONFIG] ⚠️  WARNING: Embedding configuration mismatch detected!\n` +
        `         OM_EMBEDDINGS=${env.emb_kind} but OM_TIER=${tier}\n` +
        `         Storage will use ${env.emb_kind} embeddings, but queries will use synthetic embeddings.\n` +
        `         This causes semantic search to fail. Set OM_TIER=deep to fix.`
    );
}

// Security Hardening: Ensure API Key is set
if (!env.api_key || env.api_key.trim() === "") {
    console.warn(
        `\n[SECURITY] ⚠️  WARNING: NO API KEY CONFIGURED! (OM_API_KEY)\n` +
        `           The server is running in OPEN mode. Anyone can access your memories.\n` +
        `           Please set OM_API_KEY in your .env file for production usage.\n`
    );
    // In strict mode or production, we might want to process.exit(1) here.
    // For now, let's just make it VERY obvious.
}

app.use(req_tracker_mw());

app.use((req: AdvancedRequest, res: AdvancedResponse, next: () => void) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader(
        "Access-Control-Allow-Methods",
        "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    );
    res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type,Authorization,x-api-key",
    );
    if (req.method === "OPTIONS") {
        res.status(200).end();
        return;
    }
    next();
});

app.use(authenticate_api_request);

if (process.env.OM_LOG_AUTH === "true") {
    app.use(log_authenticated_request);
}

routes(app);

mcp(app);
if (env.mode === "langgraph") {
    console.log("[MODE] LangGraph integration enabled");
}

const decayIntervalMs = env.decay_interval_minutes * 60 * 1000;
console.log(
    `[DECAY] Interval: ${env.decay_interval_minutes} minutes (${decayIntervalMs / 1000}s)`,
);

setInterval(async () => {
    if (env.verbose) console.log("[DECAY] Running HSG decay process...");
    try {
        const result = await run_decay_process();
        if (env.verbose) {
            console.log(
                `[DECAY] Completed: ${result.decayed}/${result.processed} memories updated`,
            );
        }
    } catch (error) {
        console.error("[DECAY] Process failed:", error);
    }
}, decayIntervalMs);
setInterval(
    async () => {
        if (env.verbose) console.log("[PRUNE] Pruning weak waypoints...");
        try {
            const pruned = await prune_weak_waypoints();
            if (env.verbose) console.log(`[PRUNE] Completed: ${pruned} waypoints removed`);
        } catch (error) {
            console.error("[PRUNE] Failed:", error);
        }
    },
    7 * 24 * 60 * 60 * 1000,
);
setTimeout(() => {
    run_decay_process()
        .then((result: { decayed: number; processed: number }) => {
            if (env.verbose) {
                console.log(
                    `[INIT] Initial decay: ${result.decayed}/${result.processed} memories updated`,
                );
            }
        })
        .catch(console.error);
    maintenanceRetrainAll()
        .then(() => {
            if (env.verbose) console.log("[INIT] Initial classifier training completed");
        })
        .catch(console.error);
}, 3000);

const trainIntervalMs = env.classifier_train_interval * 60 * 1000;
console.log(`[TRAIN] Classifier interval: ${env.classifier_train_interval} minutes`);

setInterval(async () => {
    if (env.verbose) console.log("[TRAIN] Running auto-training process...");
    try {
        await maintenanceRetrainAll();
    } catch (error) {
        console.error("[TRAIN] Process failed:", error);
    }
}, trainIntervalMs);

start_reflection();
start_user_summary_reflection();

console.log(`[SERVER] Starting on port ${env.port}`);
app.listen(env.port, () => {
    console.log(`[SERVER] Running on http://localhost:${env.port}`);
    sendTelemetry().catch(() => {
        // ignore telemetry failures
    });

    const shutdown = async (signal: string) => {
        console.log(`\n[SERVER] ${signal} received. Shutting down gracefully...`);
        try {
            await close_db(); // Close DB connections
            console.log("[SERVER] Database connections closed.");
            process.exit(0);
        } catch (err) {
            console.error("[SERVER] Error during shutdown:", err);
            process.exit(1);
        }
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
});
