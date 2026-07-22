import { describe, it, expect, beforeEach } from "bun:test";
import { sys } from "../src/server/routes/system";
import { run_async, q, all_async } from "../src/core/db";

async function cleanup() {
    await run_async(`DELETE FROM memories`);
}

describe("Sectors route tenant scoping", () => {
    beforeEach(async () => {
        await cleanup();
    });

    it("requires tenant and filters statistics to only the authenticated tenant", async () => {
        // 1. Setup route handler mock
        let sectors_handler: any = null;
        const app_mock = {
            post: () => {},
            get: (path: string, handler: any) => {
                if (path === "/sectors") {
                    sectors_handler = handler;
                }
            },
        };

        // Register routes to capture /sectors handler
        sys(app_mock);
        expect(sectors_handler).toBeTruthy();

        // 2. Populate memories for Alice and Bob
        const t_alice = "tenant-alice";
        const t_bob = "tenant-bob";

        await q.ins_mem.run(
            "mem1",
            t_alice,
            null,
            0,
            "Alice episodic memory",
            null,
            "episodic",
            null,
            null,
            Date.now(),
            Date.now(),
            Date.now(),
            0.8,
            0.01,
            1,
            null,
            null,
            null,
            0
        );

        await q.ins_mem.run(
            "mem2",
            t_bob,
            null,
            0,
            "Bob semantic memory",
            null,
            "semantic",
            null,
            null,
            Date.now(),
            Date.now(),
            Date.now(),
            0.9,
            0.01,
            1,
            null,
            null,
            null,
            0
        );

        // 3. Request /sectors as Alice
        const alice_req = {
            tenant: t_alice,
        };

        let alice_res_json: any = null;
        const alice_res = {
            status: function() { return this; },
            json: (data: any) => {
                alice_res_json = data;
            },
        };

        await sectors_handler(alice_req, alice_res);

        expect(alice_res_json).toBeTruthy();
        expect(alice_res_json.stats).toBeArray();

        // Alice should only see her "episodic" memory statistics and NOT Bob's "semantic" memory
        const alice_stats = alice_res_json.stats;
        expect(alice_stats).toHaveLength(1);
        expect(alice_stats[0].sector).toBe("episodic");

        // 4. Request /sectors as Bob
        const bob_req = {
            tenant: t_bob,
        };

        let bob_res_json: any = null;
        const bob_res = {
            status: function() { return this; },
            json: (data: any) => {
                bob_res_json = data;
            },
        };

        await sectors_handler(bob_req, bob_res);

        expect(bob_res_json).toBeTruthy();
        expect(bob_res_json.stats).toBeArray();

        // Bob should only see his "semantic" memory statistics and NOT Alice's "episodic" memory
        const bob_stats = bob_res_json.stats;
        expect(bob_stats).toHaveLength(1);
        expect(bob_stats[0].sector).toBe("semantic");
    });
});

describe("Cluster sync tenant scoping", () => {
    beforeEach(async () => {
        await cleanup();
    });

    it("enforces tenant boundaries on /api/cluster/sync", async () => {
        let sync_handler: any = null;
        const app_mock = {
            post: (path: string, handler: any) => {
                if (path === "/api/cluster/sync") {
                    sync_handler = handler;
                }
            },
            get: () => {},
        };

        sys(app_mock);
        expect(sync_handler).toBeTruthy();

        // 1. Missing tenant
        const req_no_tenant = {
            body: {
                event: "memory_sync",
                data: {
                    id: "sync-mem-1",
                    content: "Hello from sync",
                    primary_sector: "semantic",
                },
            },
        };
        let status_code = 200;
        let res_json: any = null;
        const res_no_tenant = {
            status: function(code: number) {
                status_code = code;
                return this;
            },
            json: (data: any) => {
                res_json = data;
            },
        };

        await sync_handler(req_no_tenant, res_no_tenant);
        expect(status_code).toBe(401);
        expect(res_json.error).toBe("authentication_required");

        // 2. Matching/missing user_id with valid tenant
        const t_alice = "tenant-alice";
        const req_alice_ok = {
            tenant: t_alice,
            body: {
                event: "memory_sync",
                data: {
                    id: "sync-mem-1",
                    content: "Hello from sync",
                    primary_sector: "semantic",
                },
            },
        };

        let alice_status = 200;
        let alice_json: any = null;
        const res_alice = {
            status: function(code: number) {
                alice_status = code;
                return this;
            },
            json: (data: any) => {
                alice_json = data;
            },
        };

        await sync_handler(req_alice_ok, res_alice);
        expect(alice_status).toBe(200);
        expect(alice_json.ok).toBe(true);
        expect(alice_json.message).toBe("Synced");

        // Verify it was saved as Alice's memory
        const saved_mem = await q.get_mem.get("sync-mem-1");
        expect(saved_mem).toBeTruthy();
        expect(saved_mem.user_id).toBe(t_alice);

        // 3. Mismatched user_id
        const req_alice_mismatch = {
            tenant: t_alice,
            body: {
                event: "memory_sync",
                data: {
                    id: "sync-mem-2",
                    user_id: "tenant-bob",
                    content: "Hello from Bob?",
                    primary_sector: "semantic",
                },
            },
        };

        let mismatch_status = 200;
        let mismatch_json: any = null;
        const res_mismatch = {
            status: function(code: number) {
                mismatch_status = code;
                return this;
            },
            json: (data: any) => {
                mismatch_json = data;
            },
        };

        await sync_handler(req_alice_mismatch, res_mismatch);
        expect(mismatch_status).toBe(403);
        expect(mismatch_json.error).toBe("tenant_mismatch");

        // 4. Overwrite attempt on another tenant's existing memory ID
        const t_bob = "tenant-bob";
        // Pre-create mem3 belonging to Bob
        await q.ins_mem.run(
            "sync-mem-3",
            t_bob,
            null,
            0,
            "Bob private memory",
            null,
            "semantic",
            null,
            null,
            Date.now(),
            Date.now(),
            Date.now(),
            0.5,
            0.01,
            1,
            null,
            null,
            null,
            0
        );

        // Alice tries to sync/overwrite sync-mem-3
        const req_alice_hijack = {
            tenant: t_alice,
            body: {
                event: "memory_sync",
                data: {
                    id: "sync-mem-3",
                    user_id: t_alice,
                    content: "Alice hijacking Bob's memory ID",
                    primary_sector: "semantic",
                },
            },
        };

        let hijack_status = 200;
        let hijack_json: any = null;
        const res_hijack = {
            status: function(code: number) {
                hijack_status = code;
                return this;
            },
            json: (data: any) => {
                hijack_json = data;
            },
        };

        await sync_handler(req_alice_hijack, res_hijack);
        expect(hijack_status).toBe(403);
        expect(hijack_json.error).toBe("tenant_mismatch");

        // Verify Bob's memory was NOT overwritten
        const unchanged_mem = await q.get_mem.get("sync-mem-3");
        expect(unchanged_mem).toBeTruthy();
        expect(unchanged_mem.user_id).toBe(t_bob);
        expect(unchanged_mem.content).toContain("Bob private memory");
    });
});
