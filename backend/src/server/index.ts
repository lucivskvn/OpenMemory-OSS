import { createServer } from "./server";
import { env, tier } from "../core/cfg";
import { initDb } from "../core/db";
import logger from "../core/logger";
import { run_decay_process, prune_weak_waypoints } from "../memory/hsg";
import { mcp } from "../ai/mcp";
import { routes } from "./routes";
import {
    authenticate_api_request,
    log_authenticated_request,
} from "./middleware/auth";
import { start_reflection } from "../memory/reflect";
import { start_user_summary_reflection } from "../memory/user_summary";
import { req_tracker_mw } from "./routes/dashboard";

const ASC = `   ____                   __  __                                 
  / __ \\                 |  \\/  |                                
 | |  | |_ __   ___ _ __ | \\  / | ___ _ __ ___   ___  _ __ _   _ 
 | |  | | '_ \\ / _ \\ '_ \\| |\\/| |/ _ \\ '_ \` _ \\ / _ \\| '__| | | |
 | |__| | |_) |  __/ | | | |  | |  __/ | | | | | (_) | |  | |_| |
  \\____/| .__/ \\___|_| |_|_|  |_|\\___|_| |_| |_|\\___/|_|   \\__, |
        | |                                                 __/ |
        |_|                                                |___/ `;

initDb();

const app = createServer({ max_payload_size: env.max_payload_size });

logger.info(ASC);
logger.info({ component: "SERVER", runtime: `Bun v${Bun.version}` }, "Server starting...");
logger.info({ component: "CONFIG", tier: tier, vector_dim: env.vec_dim, cache_segments: env.cache_segments, max_active_queries: env.max_active }, "Configuration loaded");


app.use(req_tracker_mw());

app.use((req: any, res: any, next: any) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader(
        "Access-Control-Allow-Methods",
        "GET,POST,PUT,DELETE,OPTIONS",
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
    logger.info({ component: "MODE", mode: "langgraph" }, "LangGraph integration enabled");
}

const decayIntervalMs = env.decay_interval_minutes * 60 * 1000;
logger.info({ component: "DECAY", interval_minutes: env.decay_interval_minutes, interval_ms: decayIntervalMs }, "Decay process configured");

setInterval(async () => {
    logger.info({ component: "DECAY" }, "Running HSG decay process...");
    try {
        const result = await run_decay_process();
        logger.info({ component: "DECAY", decayed: result.decayed, processed: result.processed }, "Decay process completed");
    } catch (error) {
        logger.error({ component: "DECAY", err: error }, "Decay process failed");
    }
}, decayIntervalMs);
setInterval(
    async () => {
        logger.info({ component: "PRUNE" }, "Pruning weak waypoints...");
        try {
            const pruned = await prune_weak_waypoints();
            logger.info({ component: "PRUNE", pruned_count: pruned }, "Pruning completed");
        } catch (error) {
            logger.error({ component: "PRUNE", err: error }, "Pruning failed");
        }
    },
    7 * 24 * 60 * 60 * 1000,
);
run_decay_process()
    .then((result: any) => {
        logger.info({ component: "INIT", decayed: result.decayed, processed: result.processed }, "Initial decay process completed");
    })
    .catch((err) => logger.error({ component: "INIT", err }, "Initial decay failed"));

start_reflection();
start_user_summary_reflection();

logger.info({ component: "SERVER", port: env.port }, `Starting server...`);
app.listen(env.port, () => {
    logger.info({ component: "SERVER", url: `http://localhost:${env.port}` }, "Server running");
});
