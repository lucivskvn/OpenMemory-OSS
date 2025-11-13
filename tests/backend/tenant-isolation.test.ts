import fs from "fs";
import path from "path";
import { test, expect } from "bun:test";

// Use isolated temp DB per-run
const tmpDir = path.resolve(process.cwd(), "tmp");
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
process.env.OM_DB_PATH = path.join(tmpDir, `openmemory-tenant-${process.pid}-${Date.now()}.sqlite`);
process.env.OM_METADATA_BACKEND = "sqlite";

import { initDb, q } from "../../backend/src/core/db";
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
