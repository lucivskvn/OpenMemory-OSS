import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { verifyUserAccess } from "../../src/server/middleware/auth";

describe("Phase 4 Verification: User Identity & DB Portability", () => {
    let app: any;
    let runAsync: any;
    let upsertAsync: any;
    let TABLES: any;

    beforeAll(async () => {
        // Use a temporary file instead of :memory: to allow shared access across connections
        const tempDb = `test_phase4_${Date.now()}.sqlite`;
        process.env.OM_DB_PATH = tempDb;
        process.env.OM_API_KEY = ""; // Ensure not picking up system key
        process.env.OM_ADMIN_KEY = "";
        process.env.OM_NO_AUTH = "false"; // Ensure auth is enabled

        // Dynamically import to ensure env vars are applied
        const { reloadConfig } = await import("../../src/core/cfg");
        reloadConfig();

        const coreDb = await import("../../src/core/db");
        runAsync = coreDb.runAsync;
        upsertAsync = coreDb.upsertAsync;
        TABLES = coreDb.TABLES;

        const serverIndex = await import("../../src/server/index");
        app = serverIndex.app;
    });

    afterAll(async () => {
        const { stopAllMaintenance } = await import("../../src/core/scheduler");
        const { closeDb } = await import("../../src/core/db");
        await stopAllMaintenance();
        await closeDb();
        try {
            const fs = await import("node:fs");
            if (process.env.OM_DB_PATH && fs.existsSync(process.env.OM_DB_PATH)) {
                fs.unlinkSync(process.env.OM_DB_PATH);
            }
        } catch { }
    });

    const getHash = async (key: string) => {
        const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
        return Buffer.from(hashBuffer).toString("hex");
    };

    describe("verifyUserAccess ('me' alias)", () => {
        it("resolves 'me' to the authenticated user ID", () => {
            const req = {
                user: { id: "user_789", scopes: ["memory:read"] }
            } as any;

            const resolvedId = verifyUserAccess(req, "me");
            expect(resolvedId).toBe("user_789");
        });

        it("allows admin to resolve 'me' to their own ID", () => {
            const req = {
                user: { id: "admin_root", scopes: ["admin:all"] }
            } as any;

            const resolvedId = verifyUserAccess(req, "me");
            expect(resolvedId).toBe("admin_root");
        });

        it("returns original ID if it is not 'me'", () => {
            const req = {
                user: { id: "admin_root", scopes: ["admin:all"] }
            } as any;

            const resolvedId = verifyUserAccess(req, "other_user");
            expect(resolvedId).toBe("other_user");
        });

        it("throws 403 when non-admin tries to access other user", () => {
            const req = {
                user: { id: "user_1", scopes: ["memory:read"] }
            } as any;

            expect(() => verifyUserAccess(req, "user_2")).toThrow();
        });
    });

    describe("upsertAsync (SQLite)", () => {
        it("successfully performs an upsert in SQLite", async () => {
            const testId = "hook_" + Date.now();
            const data = {
                id: testId,
                user_id: "system",
                url: "http://example.com",
                events: "[]",
                secret: "test_secret",
                created_at: Date.now(),
                updated_at: Date.now()
            };

            // First insert
            const rows1 = await upsertAsync(TABLES.webhooks, ["id"], data);
            expect(rows1).toBeGreaterThanOrEqual(0);

            // Update same ID
            const updatedData = { ...data, url: "http://updated.com" };
            const rows2 = await upsertAsync(TABLES.webhooks, ["id"], updatedData);
            expect(rows2).toBeGreaterThanOrEqual(0);

            // Verify content
            const { getAsync } = await import("../../src/core/db");
            const row = await getAsync<any>(`SELECT url FROM ${TABLES.webhooks} WHERE id = ?`, [testId]);
            expect(row?.url).toBe("http://updated.com");
        });
    });

    describe("API Integration: /users/me", () => {
        it("GET /users/me resolves to the calling user profile", async () => {
            const apiKey = "test-key-me";
            const userId = "me-user-1";

            // Setup user in DB
            const now = Date.now();
            await runAsync(`INSERT OR IGNORE INTO ${TABLES.users} (user_id, summary, reflection_count, created_at, updated_at) VALUES (?,?,?,?,?)`,
                [userId, "Me User", 0, now, now]);

            // Setup API Key
            const hash = await getHash(apiKey);
            await runAsync(`INSERT OR IGNORE INTO ${TABLES.api_keys} (key_hash, user_id, role, note, created_at, updated_at, expires_at) VALUES (?,?,?,?,?,?,?)`,
                [hash, userId, "user", "Test Key", now, now, 0]);

            const url = `http://localhost:8080/users/me`;
            const res = await app.fetch(new Request(url, {
                headers: { "x-api-key": apiKey }
            }));

            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body.userId).toBe(userId);
        });

        it("GET /users/not-me returns 403 for standard user", async () => {
            const apiKey = "test-key-me-2";
            const userId = "me-user-2";

            // Setup API Key
            const hash = await getHash(apiKey);
            await runAsync(`INSERT OR IGNORE INTO ${TABLES.api_keys} (key_hash, user_id, role, note, created_at, updated_at, expires_at) VALUES (?,?,?,?,?,?,?)`,
                [hash, userId, "user", "Test Key", Date.now(), Date.now(), 0]);

            const url = `http://localhost:8080/users/other-one`;
            const req = new Request(url, {
                headers: { "x-api-key": apiKey }
            });
            const res = await app.fetch(req);

            expect(res.status).toBe(403);
        });
    });
});
