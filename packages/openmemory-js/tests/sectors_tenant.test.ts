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
