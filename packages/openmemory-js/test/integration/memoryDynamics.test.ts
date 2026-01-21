import { describe, expect, beforeAll, afterAll, it } from "bun:test";
import { cleanupIfSuccess, waitForDb, getUniqueDbPath } from "../test_utils";
import { q, transaction, closeDb } from "../../src/core/db";
import { reloadConfig } from "../../src/core/cfg";
import { addMemory, hsgQuery } from "../../src/memory/hsg";
import { applyDecay } from "../../src/memory/consolidation";
import { calculateDualPhaseDecayMemoryRetention } from "../../src/ops/dynamics";
import { sleep } from "../../src/utils";

import path from "node:path";
import fs from "node:fs";

describe("Memory Dynamics & Decay Verification", () => {
    const userId = "test-dynamics-user";
    const DB_PATH = getUniqueDbPath("dynamics");

    beforeAll(async () => {
        process.env.OM_KEEP_DB = "true";
        await closeDb();
        process.env.OM_DB_PATH = DB_PATH;
        reloadConfig();

        await waitForDb();
    }, 10000);

    afterAll(async () => {
        await cleanupIfSuccess(DB_PATH);
    });

    it("should correctly apply standardized dual-phase decay", async () => {
        const initialSalience = 0.8;
        const days = 10;

        // Lambda defaults: k1=0.015, k2=0.002, theta=0.4
        const expected = calculateDualPhaseDecayMemoryRetention(initialSalience, days);

        // fastDecay = exp(-0.015 * 10) = exp(-0.15) ~= 0.860
        // slowDecay = exp(-0.002 * 10) = exp(-0.02) ~= 0.980
        // retentionFactor = (1-0.4)*0.860 + 0.4*0.980 = 0.6*0.86 + 0.4*0.98 = 0.516 + 0.392 = 0.908
        // expectedValue = 0.8 * 0.908 = 0.726

        expect(expected).toBeGreaterThan(0.7);
        expect(expected).toBeLessThan(0.75);
    });

    it("should perform bulk salience updates during decay maintenance", async () => {
        // 1. Add multiple memories to satisfy decay ratio (default 0.03)
        // Adding 100 memories so at least 3 are processed (100 * 0.03 = 3)
        const ids: string[] = [];
        const updates: any[] = [];
        for (let i = 0; i < 100; i++) {
            const m = await addMemory(`Memory ${i} `, userId);
            ids.push(m.id);
            updates.push({
                id: m.id,
                salience: 0.9,
                lastSeenAt: Date.now() - 86400000 * 30, // 30 days ago to ensure decay triggers
                updatedAt: Date.now()
            });
        }

        // Set specific salience for testing
        await q.updSaliences.run(updates, userId);

        // 2. Run decay process
        const result = await applyDecay(userId);
        console.log("Decay Result:", result);

        expect(result.processed).toBeGreaterThanOrEqual(3);
        // 3. Verify salience decreased for the processed memories
        const allMems = await q.getMems.all(ids, userId);
        const decreased = allMems.filter((m: { salience?: number }) => m.salience! < 0.9).length;

        expect(decreased).toBeGreaterThanOrEqual(result.processed);
    });

    it("should respect thundering herd mitigation (skip insignificant updates)", async () => {
        const m3 = await addMemory("Very recent memory", userId);
        const initialSal = 0.7;
        await q.updSaliences.run([{
            id: m3.id,
            salience: initialSal,
            lastSeenAt: Date.now() - 1000, // 1 second ago
            updatedAt: Date.now()
        }], userId);

        // Run decay - 1 second shouldn't change salience > 0.001
        const result = await applyDecay(userId);

        const mem3 = await q.getMem.get(m3.id, userId);
        // It might still be "processed" but not "decayed" (changed in DB)
        // Note: applyDecay returns total changed count as 'decayed'
        // If dt is very small, exp(-lam * dt) ~ 1.0, so change is small.

        // Verify salience is still exactly what it was if change < 0.001
        // (Or very close)
        expect(Math.abs(mem3!.salience - initialSal)).toBeLessThan(0.002);
    });
});
