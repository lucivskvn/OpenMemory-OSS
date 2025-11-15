import fs from "fs";
import path from "path";
import { test, expect, afterAll } from "bun:test";

// Use isolated temp DB per-run
const tmpDir = path.resolve(process.cwd(), "tmp");
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
process.env.OM_DB_PATH = path.join(tmpDir, `openmemory-tenant-${process.pid}-${Date.now()}.sqlite`);
process.env.OM_METADATA_BACKEND = "sqlite";

import { initDb, q, run_async, closeDb } from "../../backend/src/core/db.test-entry";
import { env } from "../../backend/src/core/cfg";

test("tenant isolation: vectors and waypoints are scoped by user_id", async () => {
    await initDb();

    const now = Date.now();
    const userA = `userA-${Date.now()}`;
    const userB = `userB-${Date.now()}`;

    // Create two memories, one per user
    const memA = `memA-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const memB = `memB-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    // Use legacy ins_mem ordering as used in other tests (ins_mem handles mapping)
    await q.ins_mem.run(
        memA,
        "content A",
        "semantic",
        JSON.stringify([]),
        JSON.stringify({}),
        now,
        now,
        now,
        1.0,
        0.0,
        1,
        userA,
        null,
        null,
        null,
    );
    await q.ins_mem.run(
        memB,
        "content B",
        "semantic",
        JSON.stringify([]),
        JSON.stringify({}),
        now,
        now,
        now,
        1.0,
        0.0,
        1,
        userB,
        null,
        null,
        null,
    );

    // Insert vectors for each memory in same sector
    const dim = env.vec_dim || 256;
    const bufA = Buffer.from(new Float32Array(dim).buffer);
    const bufB = Buffer.from(new Float32Array(dim).buffer);
    await q.ins_vec.run(memA, "semantic", userA, bufA, dim);
    await q.ins_vec.run(memB, "semantic", userB, bufB, dim);

    // Query vectors by sector scoped to userA
    const vecsA = await q.get_vecs_by_sector.all("semantic", userA);
    const vecsB = await q.get_vecs_by_sector.all("semantic", userB);
    expect(vecsA.length).toBeGreaterThanOrEqual(1);
    expect(vecsB.length).toBeGreaterThanOrEqual(1);
    // Ensure returned ids match the expected owners
    expect(vecsA.some((r: any) => r.id === memA)).toBe(true);
    expect(vecsA.some((r: any) => r.id === memB)).toBe(false);
    expect(vecsB.some((r: any) => r.id === memB)).toBe(true);

    // get_vecs_by_id scoped
    const gA_forA = await q.get_vecs_by_id.all(memA, userA);
    const gA_forB = await q.get_vecs_by_id.all(memA, userB);
    expect(gA_forA.length).toBeGreaterThanOrEqual(1);
    expect(gA_forB.length).toBe(0);

    // Insert waypoints for each user
    await q.ins_waypoint.run(memA, memB, userA, 0.9, now, now);
    await q.ins_waypoint.run(memB, memA, userB, 0.8, now, now);

    const wA = await q.get_waypoints_by_src.all(memA, userA);
    const wA_b = await q.get_waypoints_by_src.all(memA, userB);
    expect(wA.length).toBeGreaterThanOrEqual(1);
    expect(wA_b.length).toBe(0);
    expect(wA.some((r: any) => r.dst_id === memB)).toBe(true);

    // Deletion should be scoped
    // Attempt to delete memA's waypoints as userB (should be no-op)
    await q.del_waypoints.run(memA, memA, userB);
    const wA_after = await q.get_waypoints_by_src.all(memA, userA);
    expect(wA_after.length).toBeGreaterThanOrEqual(1);

    // Now delete as correct user
    await q.del_waypoints.run(memA, memA, userA);
    const wA_after2 = await q.get_waypoints_by_src.all(memA, userA);
    expect(wA_after2.length).toBe(0);
});

afterAll(async () => {
    try {
        await closeDb();
    } catch (e) {
        // best-effort cleanup
    }
});

test("tenant isolation: get_mem_by_simhash is scoped by user_id", async () => {
    await initDb();

    const now = Date.now();
    const userA = `userA-${Date.now()}`;
    const userB = `userB-${Date.now()}`;
    const simhashA = `simhashA-${Date.now()}`;
    const simhashB = `simhashB-${Date.now()}`;

    // Create two memories with different simhashes, one per user
    const memA = `memA-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const memB = `memB-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    await q.ins_mem.run(
        memA,
        "content A",
        "semantic",
        JSON.stringify([]),
        JSON.stringify({}),
        now,
        now,
        now,
        1.0,
        0.0,
        1,
        userA,
        null,
        null,
        null,
    );

    await q.ins_mem.run(
        memB,
        "content B",
        "semantic",
        JSON.stringify([]),
        JSON.stringify({}),
        now,
        now,
        now,
        1.0,
        0.0,
        1,
        userB,
        null,
        null,
        null,
    );

    // Update memories with simhashes (set simhash column directly)
    await run_async("update memories set simhash=? where id=?", [simhashA, memA]);
    await run_async("update memories set simhash=? where id=?", [simhashB, memB]);

    // Test simhash lookup with user_id scoping - each user should only see their own memory
    const memA_fromA = await q.get_mem_by_simhash.get(simhashA, userA);
    const memA_fromB = await q.get_mem_by_simhash.get(simhashA, userB);
    const memB_fromB = await q.get_mem_by_simhash.get(simhashB, userB);
    const memB_fromA = await q.get_mem_by_simhash.get(simhashB, userA);

    // User A should find their own memory but not B's
    expect(memA_fromA).toBeTruthy();
    expect(memA_fromA.id).toBe(memA);
    expect(memA_fromB).toBeNull();

    // User B should find their own memory but not A's  
    expect(memB_fromB).toBeTruthy();
    expect(memB_fromB.id).toBe(memB);
    expect(memB_fromA).toBeNull();
});

test("tenant isolation: all_mem methods respect user_id scoping", async () => {
    await initDb();

    const now = Date.now();
    const userA = `userA-${Date.now()}`;
    const userB = `userB-${Date.now()}`;

    // Create memories for each user
    const memA1 = `memA1-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const memA2 = `memA2-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const memB1 = `memB1-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    await q.ins_mem.run(memA1, "content A1", "semantic", JSON.stringify([]), JSON.stringify({}), now, now, now, 1.0, 0.0, 1, userA, null, null, null);
    await q.ins_mem.run(memA2, "content A2", "other", JSON.stringify([]), JSON.stringify({}), now, now, now, 1.0, 0.0, 1, userA, null, null, null);
    await q.ins_mem.run(memB1, "content B1", "semantic", JSON.stringify([]), JSON.stringify({}), now, now, now, 1.0, 0.0, 1, userB, null, null, null);

    // Test all_mem with user scoping
    const allA = await q.all_mem.all(100, 0, userA);
    const allB = await q.all_mem.all(100, 0, userB);

    expect(allA.length).toBe(2);
    expect(allA.every((m: any) => m.user_id === userA)).toBe(true);
    expect(allB.length).toBe(1);
    expect(allB[0].user_id).toBe(userB);

    // Test all_mem_by_sector with user scoping
    const semanticA = await q.all_mem_by_sector.all("semantic", 100, 0, userA);
    const semanticB = await q.all_mem_by_sector.all("semantic", 100, 0, userB);
    const otherA = await q.all_mem_by_sector.all("other", 100, 0, userA);
    const otherB = await q.all_mem_by_sector.all("other", 100, 0, userB);

    expect(semanticA.length).toBe(1);
    expect(semanticA[0].id).toBe(memA1);
    expect(semanticB.length).toBe(1);
    expect(semanticB[0].id).toBe(memB1);
    expect(otherA.length).toBe(1);
    expect(otherA[0].id).toBe(memA2);
    expect(otherB.length).toBe(0);
});

test("tenant isolation: OM_STRICT_TENANT mode enforces user_id requirement", async () => {
    // Set strict tenant mode
    const originalStrict = process.env.OM_STRICT_TENANT;
    process.env.OM_STRICT_TENANT = "true";

    try {
        await initDb();

        // Test that methods throw when user_id is missing in strict mode
        expect(async () => {
            await q.all_mem.all(100, 0);
        }).toThrow();

        expect(async () => {
            await q.all_mem_by_sector.all("semantic", 100, 0);
        }).toThrow();

        expect(async () => {
            await q.get_mem_by_simhash.get("test-simhash");
        }).toThrow();

        expect(async () => {
            await q.get_mem.get("test-id");
        }).toThrow();

    } finally {
        // Restore original setting
        if (originalStrict !== undefined) {
            process.env.OM_STRICT_TENANT = originalStrict;
        } else {
            delete process.env.OM_STRICT_TENANT;
        }
    }
});
