import { apply_decay } from "../src/memory/decay";
import { run_migrations } from "../src/core/migrate";
import { q, all_async, run_async } from "../src/core/db";
import { compressionEngine } from "../src/ops/compress";

async function run_worker() {
    console.log("[WORKER] Starting background maintenance...");

    const startTime = Date.now();

    // 1. Run migrations first to ensure schema is up to date
    try {
        console.log("[WORKER] Running migrations...");
        await run_migrations();
    } catch (e) {
        console.error("[WORKER] Migration failed:", e);
    }

    // 2. Memory Decay & Compression
    try {
        console.log("[WORKER] Applying memory decay and compression...");
        await apply_decay();
    } catch (e) {
        console.error("[WORKER] Decay process failed:", e);
    }

    // 3. Optional: Graph Fact confidence decay
    try {
        console.log("[WORKER] Applying confidence decay to temporal graph...");
        const { apply_confidence_decay } = await import("../src/temporal_graph/store");
        await apply_confidence_decay(0.01);
    } catch (e) {
        console.error("[WORKER] Confidence decay failed:", e);
    }

    const duration = (Date.now() - startTime) / 1000;
    console.log(`[WORKER] Maintenance completed in ${duration.toFixed(2)}s`);
    process.exit(0);
}

run_worker().catch(err => {
    console.error("[WORKER] Fatal error:", err);
    process.exit(1);
});
