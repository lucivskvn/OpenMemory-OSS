process.env.OM_EMBEDDINGS = "synthetic";
process.env.OM_EMBEDDING_FALLBACK = "synthetic";
process.env.OM_METADATA_BACKEND = process.env.OM_METADATA_BACKEND || "sqlite";
process.env.OM_VECTOR_BACKEND = process.env.OM_VECTOR_BACKEND || "sqlite";

import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import { run_async, q } from "../src/core/db";
import {
    store_node_mem,
    retrieve_node_mems,
    get_graph_ctx,
    create_refl,
} from "../src/ai/graph";
import * as graphModule from "../src/ai/graph";
import { lg } from "../src/server/routes/langgraph";

const T_ALICE = "tenant-alice-lg";
const T_BOB = "tenant-bob-lg";

async function cleanup() {
    await run_async(`DELETE FROM memories`);
    try {
        await run_async(`DELETE FROM vectors`);
    } catch {
        /* schema variant */
    }
    try {
        await run_async(`DELETE FROM openmemory_vectors`);
    } catch {
        /* schema variant */
    }
    try {
        await run_async(`DELETE FROM waypoints`);
    } catch {
        /* schema variant */
    }
}

describe("LangGraph per-tenant scoping", () => {
    beforeEach(async () => {
        await cleanup();
    });

    it("store_node_mem binds writes to the specified user_id", async () => {
        const res = await store_node_mem({
            node: "act",
            content: "Alice action notes",
            user_id: T_ALICE,
        });

        const id = res.memory.id;
        expect(id).toBeTruthy();

        const row = await q.get_mem.get(id);
        expect(row).toBeTruthy();
        expect(row.user_id).toBe(T_ALICE);
    }, 25000);

    it("retrieve_node_mems isolates tenants without query", async () => {
        // Store for Alice
        await store_node_mem({
            node: "observe",
            content: "Alice's observation notes",
            user_id: T_ALICE,
        });

        // Store for Bob
        await store_node_mem({
            node: "observe",
            content: "Bob's observation notes",
            user_id: T_BOB,
        });

        // Retrieve for Alice
        const alice_res = await retrieve_node_mems({
            node: "observe",
            user_id: T_ALICE,
        });
        expect(alice_res.count).toBe(1);
        expect(alice_res.items[0].content).toContain("Alice");

        // Retrieve for Bob
        const bob_res = await retrieve_node_mems({
            node: "observe",
            user_id: T_BOB,
        });
        expect(bob_res.count).toBe(1);
        expect(bob_res.items[0].content).toContain("Bob");
    }, 25000);

    it("retrieve_node_mems isolates tenants with query", async () => {
        // Store for Alice
        await store_node_mem({
            node: "plan",
            content: "Alice's secret plans for project alpha",
            user_id: T_ALICE,
        });

        // Store for Bob
        await store_node_mem({
            node: "plan",
            content: "Bob's secret plans for project alpha",
            user_id: T_BOB,
        });

        // Query for Alice
        const alice_res = await retrieve_node_mems({
            node: "plan",
            query: "plans for project alpha",
            user_id: T_ALICE,
        });
        expect(alice_res.count).toBe(1);
        expect(alice_res.items[0].content).toContain("Alice");

        // Query for Bob
        const bob_res = await retrieve_node_mems({
            node: "plan",
            query: "plans for project alpha",
            user_id: T_BOB,
        });
        expect(bob_res.count).toBe(1);
        expect(bob_res.items[0].content).toContain("Bob");
    }, 25000);

    it("get_graph_ctx aggregates only the tenant's own memories", async () => {
        // Store for Alice in act node
        await store_node_mem({
            node: "act",
            content: "Alice's action notes",
            user_id: T_ALICE,
        });

        // Store for Bob in act node
        await store_node_mem({
            node: "act",
            content: "Bob's action notes",
            user_id: T_BOB,
        });

        // Get context for Alice
        const alice_ctx = await get_graph_ctx({
            user_id: T_ALICE,
        });
        expect(alice_ctx.summary).toContain("Alice");
        expect(alice_ctx.summary).not.toContain("Bob");

        // Get context for Bob
        const bob_ctx = await get_graph_ctx({
            user_id: T_BOB,
        });
        expect(bob_ctx.summary).toContain("Bob");
        expect(bob_ctx.summary).not.toContain("Alice");
    }, 25000);

    it("create_refl generates reflection only from the tenant's memories", async () => {
        // Store for Alice in act node
        await store_node_mem({
            node: "act",
            content: "Alice's action notes",
            user_id: T_ALICE,
        });

        // Store for Bob in act node
        await store_node_mem({
            node: "act",
            content: "Bob's action notes",
            user_id: T_BOB,
        });

        // Create reflection for Alice
        const alice_refl = await create_refl({
            user_id: T_ALICE,
        });

        // Verify the DB record has the correct user_id and content
        const row = await q.get_mem.get(alice_refl.memory.id);
        expect(row).toBeTruthy();
        expect(row.user_id).toBe(T_ALICE);
        expect(row.content).toContain("Alice");
        expect(row.content).not.toContain("Bob");
    }, 25000);

    it("sanitizes exception responses and returns 500 on internal errors, and 400 on Zod validation errors", async () => {
        const handlers: Record<string, any> = {};
        const app_mock = {
            post: (path: string, handler: any) => {
                handlers[path] = handler;
            },
            get: () => {},
        };

        lg(app_mock);
        expect(handlers["/lgm/store"]).toBeTruthy();
        expect(handlers["/lgm/retrieve"]).toBeTruthy();

        // 1. Internal error on /lgm/store should return 500 and sanitized message "internal"
        const spyStore = spyOn(graphModule, "store_node_mem").mockImplementationOnce(() =>
            Promise.reject(new Error("Database column error or sensitive path trace")),
        );

        let store_status = 0;
        let store_json: any = null;
        const res_store = {
            status: (code: number) => {
                store_status = code;
                return res_store;
            },
            json: (data: any) => {
                store_json = data;
            },
        };
        const req_store = {
            tenant: T_ALICE,
            body: { content: "Valid test content" },
        };

        try {
            await handlers["/lgm/store"](req_store, res_store);
        } finally {
            spyStore.mockRestore();
        }

        expect(store_status).toBe(500);
        expect(store_json).toEqual({
            err: "lgm_store_failed",
            message: "internal",
        });

        // 2. Zod validation error (invalid parameter type) should return 400 Bad Request
        let val_status = 0;
        let val_json: any = null;
        const res_val = {
            status: (code: number) => {
                val_status = code;
                return res_val;
            },
            json: (data: any) => {
                val_json = data;
            },
        };
        const req_val = {
            tenant: T_ALICE,
            body: { limit: "invalid_number_type" },
        };

        await handlers["/lgm/retrieve"](req_val, res_val);
        expect(val_status).toBe(400);
        expect(val_json).toEqual({
            err: "invalid_payload",
            message: "Validation failed",
        });
    });
});
