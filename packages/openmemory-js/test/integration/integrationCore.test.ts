import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { app } from "../../src/server/index";
import { q, closeDb, runAsync } from "../../src/core/db";
import { reloadConfig } from "../../src/core/cfg";
import { env } from "../../src/core/cfg";
import { Memory } from "../../src/core/memory";
import { stopAllMaintenance } from "../../src/core/scheduler";
import { getUniqueDbPath, cleanupIfSuccess, waitForDb, getClientId } from "../test_utils";
import { runMigrations } from "../../src/core/migrate";

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
    const DB_PATH = getUniqueDbPath("int_core");

    beforeAll(async () => {
        process.env.OM_KEEP_DB = "true";
        process.env.OM_DB_PATH = DB_PATH;
        // Force DB Auth by unsetting Env keys
        delete process.env.OM_API_KEY;
        delete process.env.OM_ADMIN_KEY;
        reloadConfig();
        // --- Setup Env ---
        env.rateLimitEnabled = false;
        env.verbose = true;

        // --- Setup DB Users ---
        await waitForDb();
        await runMigrations();

        stdUserId = await sha256(stdKey);
        const keyHash = await getClientId(stdKey);

        await q.insUser.run(stdUserId, "Merged User", 0, Date.now(), Date.now());
        await runAsync(`INSERT INTO api_keys (key_hash, user_id, role) VALUES (?, ?, 'user')`, [keyHash, stdUserId]);

        const adminHash = await getClientId(adminKey);
        await runAsync(`INSERT INTO api_keys (key_hash, user_id, role) VALUES (?, ?, 'admin')`, [adminHash, 'admin_user']);

        // Note: The middleware likely uses a full hash. Let's rely on inserting what we expect.
        // Actually best is to match middleware logic. 
        // But integration_core local sha256 is slice(0, 16). 
        // Middleware usually uses full hash.
        // Let's import getClientId from test_utils to be safe.


        // --- Clean State (Scoped) ---
        const targetIds = `'${stdUserId}', 'other_user_merged'`;
        await runAsync(`DELETE FROM memories WHERE user_id IN (${targetIds})`);
        await runAsync(`DELETE FROM temporal_facts WHERE user_id IN (${targetIds})`);
        await runAsync(`DELETE FROM temporal_edges WHERE user_id IN (${targetIds})`);

        // --- Start Server ---
        // --- Start Server ---
        // Native testing - no need to listen on port
        baseUrl = "http://localhost";

        // --- Init SDK ---
        mem = new Memory(stdUserId);
    });

    afterAll(async () => {
        // if (server) server.stop(); // No server instance needed
        await stopAllMaintenance();
        await closeDb();
        await cleanupIfSuccess(DB_PATH);
    });

    const request = async (path: string, options: any = {}) => {
        const headers = { "Content-Type": "application/json", ...options.headers };
        if (!options.body && options.method !== "POST" && options.method !== "PUT" && options.method !== "PATCH") {
            delete headers["Content-Type"];
        }
        const req = new Request(`${baseUrl}${path}`, {
            ...options,
            headers
        });
        return app.fetch(req);
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
        test("Validation: Date Parsing (Temporal)", async () => {
            // Restore API key if wiped by previous tests
            await runAsync(`INSERT OR IGNORE INTO api_keys (key_hash, user_id, role) VALUES (?, ?, 'user')`, [await getClientId(stdKey), stdUserId]);

            const res = await request(`/temporal/fact?subject=test&at=invalid-date-string`, {
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
            // First create a valid memory
            const memItem = await mem.add("valid content");

            // Now try to update with huge content
            const largeContent = "a".repeat(1000001);
            try {
                const updateRes = await request(`/memory/${memItem.id}`, {
                    method: "PATCH",
                    body: JSON.stringify({ content: largeContent }),
                    headers: { "x-api-key": stdKey }
                });
                expect([400, 413]).toContain(updateRes.status);
            } catch (e: any) {
                // Bun might close the connection (ECONNRESET) if body exceeds maxRequestBodySize
                expect(e.message).toMatch(/closed unexpectedly|ECONNRESET/);
            }
        });

    });
});
