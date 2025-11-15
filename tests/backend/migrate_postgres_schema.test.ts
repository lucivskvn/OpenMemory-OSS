import { test, expect } from "bun:test";

async function waitFor(predicate: () => Promise<boolean>, attempts = 40, delayMs = 250) {
    for (let i = 0; i < attempts; i++) {
        try {
            if (await predicate()) return true;
        } catch (e) { }
        await new Promise((r) => setTimeout(r, delayMs));
    }
    return false;
}

test("postgres migration: stats and temporal tables exist", async () => {
    if (process.env.OM_METADATA_BACKEND !== "postgres") return;

    process.env.OM_NO_AUTO_START = "true";
    const mod = await import("../../backend/src/core/db.ts");
    const { initDb } = mod as any;

    await initDb();

    try {
        const ready = await waitFor(async () => {
        try {
            // Try selecting counts from key tables that should be created by initDb
            await (mod.get_async)(`select count(*) as c from stats`);
            await (mod.get_async)(`select count(*) as c from temporal_facts`);
            await (mod.get_async)(`select count(*) as c from temporal_edges`);
            return true;
        } catch (e) {
            return false;
        }
    }, 80, 250);

    expect(ready).toBe(true);

    // Additional sanity: ensure memories table exists and is queryable
    const memTable = mod.memories_table;
        const memOk = await (mod.get_async)(`select count(*) as c from ${memTable}`);
        expect(memOk).toBeDefined();
    } finally {
        if (mod && typeof (mod as any).closeDb === 'function') {
            try { await (mod as any).closeDb(); } catch (e) { /* best-effort */ }
        }
    }
}, { timeout: 120_000 });
