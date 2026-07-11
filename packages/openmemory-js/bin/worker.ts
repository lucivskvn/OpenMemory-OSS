import { apply_decay } from "../src/memory/decay";
import { run_migrations } from "../src/core/migrate";
import { client } from "../src/core/db";

async function run_worker() {
    console.log("[WORKER] Starting background maintenance...");

    const startTime = Date.now();
    let hasFailed = false;

    // 1. Run migrations first to ensure schema is up to date
    try {
        console.log("[WORKER] Running migrations...");
        await run_migrations();
    } catch (e) {
        console.error("[WORKER] Migration failed:", e);
        hasFailed = true;
    }

    // 2. Memory Decay & Compression
    try {
        console.log("[WORKER] Applying memory decay and compression...");
        await apply_decay();
    } catch (e) {
        console.error("[WORKER] Decay process failed:", e);
        hasFailed = true;
    }

    // 3. Optional: Graph Fact confidence decay
    try {
        console.log("[WORKER] Applying confidence decay to temporal graph...");
        const { apply_confidence_decay } = await import("../src/temporal_graph/store");
        await apply_confidence_decay(0.01);
    } catch (e) {
        console.error("[WORKER] Confidence decay failed:", e);
        hasFailed = true;
    }

    // Explicitly close the shared client at the end of all stages
    try {
        client.close();
    } catch (e) {
        console.warn("[WORKER] Error closing DB client:", e);
    }

    const duration = (Date.now() - startTime) / 1000;
    console.log(`[WORKER] Maintenance completed in ${duration.toFixed(2)}s`);

    if (hasFailed) {
        console.error("[WORKER] One or more maintenance stages failed.");
        process.exit(1);
    }

    process.exit(0);
}

run_worker().catch(err => {
    console.error("[WORKER] Fatal error:", err);
    process.exit(1);
});
