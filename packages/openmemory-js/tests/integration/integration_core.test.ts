import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { app } from "../../src/server/index";
import { q, closeDb, runAsync } from "../../src/core/db";
import { reloadConfig } from "../../src/core/cfg";
import { env } from "../../src/core/cfg";
import { Memory } from "../../src/core/memory";
import { stopAllMaintenance } from "../../src/core/scheduler";

const sha256 = async (str: string) => {
    const hash = await crypto.subtle.digest("SHA-256", Buffer.from(str));
    return Buffer.from(hash).toString("hex").slice(0, 16);
};

describe("Core Integration Suite (Merged)", () => {
    // API Server State
    let server: any;
    let baseUrl: string;
    const stdKey = "user-key-merged";
    const adminKey = "admin-key-merged";
    let stdUserId: string;

    // SDK State
    let mem: Memory;

    beforeAll(async () => {
        process.env.OM_DB_PATH = ":memory:";
        process.env.OM_API_KEY = stdKey;
        process.env.OM_ADMIN_KEY = adminKey;
        reloadConfig();
        // --- Setup Env ---
        // env.apiKey = stdKey; // Handled by reloadConfig
        // env.adminKey = adminKey;
        env.rateLimitEnabled = false;
        env.verbose = true;

        // --- Setup DB Users ---
        const { waitForDb } = await import("../test_utils");
        await waitForDb();
        stdUserId = await sha256(stdKey);
        await q.insUser.run(stdUserId, "Merged User", 0, Date.now(), Date.now());

        // --- Clean State (Scoped) ---
        const targetIds = `'${stdUserId}', 'other_user_merged'`;
        await runAsync(`DELETE FROM memories WHERE user_id IN (${targetIds})`);
        await runAsync(`DELETE FROM temporal_facts WHERE user_id IN (${targetIds})`);
        await runAsync(`DELETE FROM temporal_edges WHERE user_id IN (${targetIds})`);

        // --- Start Server ---
        server = app.listen(0);
        baseUrl = `http://127.0.0.1:${server.port}`;

        // --- Init SDK ---
        mem = new Memory(stdUserId);
    });

    afterAll(async () => {
        if (server) server.stop();
        await stopAllMaintenance();
        await closeDb();
        try {
            const fs = await import("node:fs");
            const p = process.cwd() + "/test_integration.db";
            if (fs.existsSync(p)) fs.unlinkSync(p);
            if (fs.existsSync(p + "-shm")) fs.unlinkSync(p + "-shm");
            if (fs.existsSync(p + "-wal")) fs.unlinkSync(p + "-wal");
        } catch { }
    });

    const request = async (path: string, options: any = {}) => {
        const headers = { "Content-Type": "application/json", ...options.headers };
        if (!options.body && options.method !== "POST" && options.method !== "PUT" && options.method !== "PATCH") {
            delete headers["Content-Type"];
        }
        return fetch(`${baseUrl}${path}`, {
            ...options,
            headers
        });
    };

    describe("Part 1: API Hardening", () => {
        test("RBAC: Standard User Profile Access", async () => {
            const res = await request(`/users/${stdUserId}`, { headers: { "x-api-key": stdKey } });
            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body.userId).toBe(stdUserId);
        });

        test("Batch Deletion", async () => {
            // Create memories
            for (let i = 0; i < 3; i++) {
                await mem.add(`batch mem ${i}`);
            }

            // Admin delete
            const delRes = await request(`/users/${stdUserId}/memories`, {
                method: "DELETE",
                headers: { "x-api-key": adminKey }
            });
            expect([200, 204]).toContain(delRes.status);

            // Verification
            const list = await mem.list();
            expect(list.length).toBe(0);
        }, 30000);
    });

    describe("Part 2: Client DX & Temporal", () => {
        test("Memory.temporal (Graph) - Scoped", async () => {
            await mem.temporal.add("Alice", "knows", "MergedBob");

            // Immediate retrieval
            const fact = await mem.temporal.get("Alice", "knows");
            expect(fact).toBeDefined();
            expect(fact?.object).toBe("MergedBob");

            // Isolation check
            const otherMem = new Memory("other_user_merged");
            const stolen = await otherMem.temporal.get("Alice", "knows");
            expect(stolen).toBeNull();
        });

        test("Memory.add & get (Scoped)", async () => {
            const res = await mem.add("Scoped Content");
            expect(res.id).toBeDefined();
            const fetched = await mem.get(res.id);
            expect(fetched?.content).toBe("Scoped Content");
        });

        test("Memory.deleteAll (Safety)", async () => {
            await mem.add("To be deleted");
            await mem.deleteAll();
            const search = await mem.search("deleted");
            expect(search.length).toBe(0);
        });
    });

    describe("Part 3: Robustness & Validation", () => {
        test("Date Parsing (Temporal)", async () => {
            const res = await request(`/api/temporal/fact?subject=test&at=invalid-date-string`, {
                headers: { "x-api-key": stdKey }
            });
            if (res.status !== 400) console.log("Date Parsing Status:", res.status, await res.text());
            expect(res.status).toBe(400);
            const body = await res.json();
            if (body.error) {
                expect(body.error.code).toBe("INVALID_DATE");
            }
        });

        test("Validation: Memory Max Length", async () => {
            // First create a memory
            const res = await request(`/memory/add`, {
                method: "POST",
                body: JSON.stringify({ content: "valid" }),
                headers: { "x-api-key": stdKey }
            });
            if (res.status !== 200) {
                console.log("Memory Create Status:", res.status, await res.text());
                throw new Error(`Memory Create Failed: ${res.status}`);
            }
            const memItem = await res.json();
            if (!memItem || !memItem.id) console.error("Memory Create Failed - Response:", memItem);
            expect(memItem).toHaveProperty("id");

            // Now try to update with huge content
            const largeContent = "a".repeat(100001);
            const updateRes = await request(`/memory/${memItem.id}`, {
                method: "PATCH",
                body: JSON.stringify({ content: largeContent }),
                headers: { "x-api-key": stdKey }
            });

            if (![400, 413].includes(updateRes.status)) {
                console.log("Memory Max Length Status:", updateRes.status);
            }
            expect([400, 413]).toContain(updateRes.status);
        });

    });
});
