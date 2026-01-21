import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { q, waitForDb, closeDb, getContextId, vectorStore } from "../../src/core/db";
import { addMemory, hsgQuery, stopHsgMaintenance, startHsgMaintenance } from "../../src/memory/hsg";
import { getUniqueDbPath } from "../test_utils";
import { reloadConfig } from "../../src/core/cfg";
import fs from "node:fs";

describe("HSG Coactivation Integration", () => {
    const userId = "coact-user";
    const DB_PATH = getUniqueDbPath("hsg_coact");

    beforeAll(async () => {
        // Reset environment
        process.env.OM_DB_PATH = DB_PATH;
        process.env.OM_EMBEDDING_PROVIDER = "synthetic";

        // Ensure all components are closed and state is cleared
        await closeDb();
        const { cleanupVectorStores } = await import("../../src/core/vector/manager");
        await cleanupVectorStores(getContextId());

        reloadConfig();
        await waitForDb();
        startHsgMaintenance();
    });

    afterAll(async () => {
        await stopHsgMaintenance();
        await closeDb();
        if (fs.existsSync(DB_PATH)) {
            try {
                fs.unlinkSync(DB_PATH);
                if (fs.existsSync(DB_PATH + "-shm")) fs.unlinkSync(DB_PATH + "-shm");
                if (fs.existsSync(DB_PATH + "-wal")) fs.unlinkSync(DB_PATH + "-wal");
            } catch (e) { }
        }
    });

    test("should persist coactivations on flush", async () => {
        // 1. Add two related memories
        const id1 = "mem_coact_1";
        const id2 = "mem_coact_2";

        await addMemory("I love coding in Python.", userId, { sector: "procedural" }, { id: id1 });
        await addMemory("I love coding in TypeScript.", userId, { sector: "procedural" }, { id: id2 });

        // Verify exist in DB
        const check1 = await q.getMem.get(id1, userId);
        expect(check1).toBeTruthy();

        // 2. Query that should retrieve both (high K)
        // We explicitly search 'procedural' to match inserted data
        const results = await hsgQuery("coding", 5, { userId: userId, sectors: ["procedural"] });

        expect(results.length).toBeGreaterThanOrEqual(2);
        const ids = results.map(r => r.id);
        expect(ids).toContain(id1);
        expect(ids).toContain(id2);

        // Coactivation buffer should now be populated (internal state).
        // We trigger a flush by stopping maintenance.
        await stopHsgMaintenance();

        // 3. Verify Waypoint creation
        const wp1 = await q.getWaypoint.get(id1, id2, userId);
        const wp2 = await q.getWaypoint.get(id2, id1, userId);

        expect(wp1 || wp2).toBeTruthy();
        if (wp1) expect(wp1.weight).toBeGreaterThan(0);
    });
});
