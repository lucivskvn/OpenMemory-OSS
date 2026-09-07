// Force synthetic embeddings + sqlite backend BEFORE importing anything
// that loads cfg/db. bun:test.config.ts already sets these via env, but keep
// this guard for standalone tsx runs.
process.env.OM_EMBEDDINGS = "synthetic";
process.env.OM_EMBEDDING_FALLBACK = "synthetic";
process.env.OM_METADATA_BACKEND = process.env.OM_METADATA_BACKEND || "sqlite";
process.env.OM_VECTOR_BACKEND = process.env.OM_VECTOR_BACKEND || "sqlite";

import { beforeEach, describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { create_mcp_srv, start_mcp_stdio, derive_mcp_tenant_id } from "../src/ai/mcp";
import { reinforce_memory, add_hsg_memory, hsg_query, update_memory, delete_memory, expand_via_waypoints, process_pending_vector_outbox } from "../src/memory/hsg";
import { run_reflection } from "../src/memory/reflect";
import { run_async, q, vector_store, all_async, init_db } from "../src/core/db";
import { spyOn } from "bun:test";

const T_ALICE = "tenant-alice-mcp";
const T_BOB = "tenant-bob-mcp";

async function cleanup() {
    await init_db();
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
    try {
        await run_async(`DELETE FROM vector_outbox`);
    } catch {
        /* schema variant */
    }
}

async function connect_client(tenant?: string) {
    const srv = create_mcp_srv(tenant);
    const [client_transport, server_transport] =
        InMemoryTransport.createLinkedPair();
    await srv.connect(server_transport);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(client_transport);
    return { client, srv };
}

function parse_items(result: any): Array<{ id: string; user_id?: string }> {
    // openmemory_list returns two text blocks; the second is a JSON dump.
    const blocks = (result?.content ?? []) as Array<{
        type: string;
        text: string;
    }>;
    const jsonBlock = blocks
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .find((t) => t.trim().startsWith("{"));
    if (!jsonBlock) return [];
    const parsed = JSON.parse(jsonBlock);
    return parsed.items ?? [];
}

function parse_store(result: any): { id?: string; project_id?: string } {
    const blocks = (result?.content ?? []) as Array<{
        type: string;
        text: string;
    }>;
    const jsonBlock = blocks
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .find((t) => t.trim().startsWith("{"));
    if (!jsonBlock) return {};
    const parsed = JSON.parse(jsonBlock);
    return { id: parsed?.hsg?.id, project_id: parsed?.project_id };
}

describe("MCP per-tenant scoping", () => {
    beforeEach(async () => {
        await cleanup();
    });

    it("openmemory_store binds writes to the authenticated tenant", async () => {
        const { client } = await connect_client(T_ALICE);
        const stored = await client.callTool({
            name: "openmemory_store",
            arguments: {
                content:
                    "Nginx 502 on a fresh VM: check that the upstream service is actually running before looking at nginx config.",
                tags: ["nginx", "sysadmin"],
            },
        });
        const { id } = parse_store(stored);
        expect(id).toBeTruthy();

        // The DB row must carry the tenant as user_id — without this fix
        // it would have been "anonymous" and invisible to REST /memory/all.
        const row = await q.get_mem.get(id!);
        expect(row).toBeTruthy();
        expect(row.user_id).toBe(T_ALICE);
        expect(row.project_id).toBe("system_global");
    }, 30000);

    it("openmemory_list returns the tenant's own MCP-stored memories (regression)", async () => {
        // Reproduces the symptom from the bug report: a memory stored via
        // MCP openmemory_store must appear in MCP openmemory_list on the
        // same authenticated session.
        const { client } = await connect_client(T_ALICE);

        await client.callTool({
            name: "openmemory_store",
            arguments: {
                content:
                    "Nginx 502 on a fresh VM: check the upstream service is running before touching nginx config.",
                tags: ["nginx"],
            },
        });

        const listed = await client.callTool({
            name: "openmemory_list",
            arguments: { limit: 50 },
        });
        const items = parse_items(listed);
        expect(items.length).toBeGreaterThan(0);
        expect(items.every((i) => i.user_id === T_ALICE)).toBe(true);
    }, 30000);

    it("openmemory_list isolates tenants from each other", async () => {
        const alice = await connect_client(T_ALICE);
        const bob = await connect_client(T_BOB);

        await alice.client.callTool({
            name: "openmemory_store",
            arguments: { content: "Alice's private dev notes about nginx." },
        });
        await bob.client.callTool({
            name: "openmemory_store",
            arguments: { content: "Bob's private dev notes about postgres." },
        });

        const bob_list = parse_items(
            await bob.client.callTool({
                name: "openmemory_list",
                arguments: { limit: 50 },
            }),
        );
        // Bob must not see Alice's memories.
        expect(bob_list.every((i) => i.user_id === T_BOB)).toBe(true);
        expect(bob_list.length).toBe(1);

        const alice_list = parse_items(
            await alice.client.callTool({
                name: "openmemory_list",
                arguments: { limit: 50 },
            }),
        );
        expect(alice_list.every((i) => i.user_id === T_ALICE)).toBe(true);
        expect(alice_list.length).toBe(1);
    }, 30000);

    it("openmemory_store rejects a user_id arg that disagrees with the tenant", async () => {
        const { client } = await connect_client(T_ALICE);
        const result: any = await client.callTool({
            name: "openmemory_store",
            arguments: {
                content: "attempt to forge another tenant's identity",
                user_id: T_BOB,
            },
        });
        // ToolRegistry catches errors and turns them into an isError result
        // with a textual "Error: ..." block.
        expect(result.isError).toBe(true);
        const text = (result.content ?? [])
            .map((b: any) => b.text ?? "")
            .join("\n");
        expect(text).toMatch(/tenant_mismatch/);
    });

    it("stdio-style server without tenant fails closed on ALL tool calls regardless of input user_id", async () => {
        const { client } = await connect_client(undefined);

        // 1. openmemory_store
        const store_res: any = await client.callTool({
            name: "openmemory_store",
            arguments: { content: "unbound store content", user_id: T_ALICE },
        });
        expect(store_res.isError).toBe(true);

        // 2. openmemory_query
        const query_res: any = await client.callTool({
            name: "openmemory_query",
            arguments: { query: "unbound query", user_id: T_ALICE },
        });
        expect(query_res.isError).toBe(true);

        // 3. openmemory_list
        const list_res: any = await client.callTool({
            name: "openmemory_list",
            arguments: { limit: 10, user_id: T_ALICE },
        });
        expect(list_res.isError).toBe(true);

        // 4. openmemory_get
        const get_res: any = await client.callTool({
            name: "openmemory_get",
            arguments: { id: "some-id", user_id: T_ALICE },
        });
        expect(get_res.isError).toBe(true);

        // 5. openmemory_delete
        const del_res: any = await client.callTool({
            name: "openmemory_delete",
            arguments: { id: "some-id", user_id: T_ALICE },
        });
        expect(del_res.isError).toBe(true);

        // 6. openmemory_reinforce
        const reinf_res: any = await client.callTool({
            name: "openmemory_reinforce",
            arguments: { id: "some-id", boost: 0.1, user_id: T_ALICE },
        });
        expect(reinf_res.isError).toBe(true);
    });

    it("verifies update_memory and delete_memory tenant boundaries across all branches", async () => {
        // 1. Setup Alice memory
        const mem_alice = await add_hsg_memory("Initial Alice memory content", JSON.stringify(["v1"]), { rev: 1 }, T_ALICE);

        // 2. update_memory metadata-only branch (tags/metadata)
        const meta_upd = await update_memory(mem_alice.id, undefined, ["v2"], { rev: 2 }, T_ALICE);
        expect(meta_upd.updated).toBe(true);
        const row_v2 = await q.get_mem.get(mem_alice.id);
        expect(row_v2.tags).toMatch(/v2/);

        // 3. update_memory content-change branch (sector/embedding re-index)
        const content_upd = await update_memory(mem_alice.id, "Updated Alice memory content with new text", ["v3"], { rev: 3 }, T_ALICE);
        expect(content_upd.updated).toBe(true);
        const row_v3 = await q.get_mem.get(mem_alice.id);
        expect(row_v3.content).toBe("Updated Alice memory content with new text");

        // 4. update_memory fails closed on missing user_id or mismatched user_id
        await expect(update_memory(mem_alice.id, "Hacked text", undefined, undefined, "")).rejects.toThrow(/tenant_required/);
        await expect(update_memory(mem_alice.id, "Hacked text", undefined, undefined, T_BOB)).rejects.toThrow(/not found/);

        // 5. delete_memory failure boundaries
        await expect(delete_memory(mem_alice.id, "")).rejects.toThrow(/tenant_required/);
        expect(await delete_memory(mem_alice.id, T_BOB)).toBe(false);

        // Verify Alice record is intact after failed deletion attempt by Bob
        const row_still_exists = await q.get_mem.get(mem_alice.id);
        expect(row_still_exists).toBeTruthy();

        // Ownerless (NULL) record deletion fails closed
        const null_id = "null-owner-del-test";
        await run_async(
            "insert into memories(id, user_id, primary_sector, content, created_at, updated_at, last_seen_at, salience) values(?, ?, ?, ?, ?, ?, ?, ?)",
            [null_id, null, "semantic", "Null owner delete content", Date.now(), Date.now(), Date.now(), 0.4],
        );
        expect(await delete_memory(null_id, T_ALICE)).toBe(false);

        // 6. Authorized delete_memory by Alice succeeds
        expect(await delete_memory(mem_alice.id, T_ALICE)).toBe(true);
        expect(await q.get_mem.get(mem_alice.id)).toBeUndefined();

        // 7. Fault-injection & Outbox recovery: simulate vector_store failure during delete_memory
        const mem_outbox = await add_hsg_memory("Memory for outbox recovery test", undefined, undefined, T_ALICE);
        const spyDel = spyOn(vector_store, "deleteVectors").mockImplementationOnce(() =>
            Promise.reject(new Error("Simulated Valkey vector network disconnect")),
        );

        // Relational deletion commits and outbox tombstone is logged
        expect(await delete_memory(mem_outbox.id, T_ALICE)).toBe(true);
        expect(await q.get_mem.get(mem_outbox.id)).toBeUndefined();

        const outbox_failed = await all_async("select * from vector_outbox where id=? and user_id=? and action='delete'", [mem_outbox.id, T_ALICE]);
        expect(outbox_failed.length).toBeGreaterThan(0);
        expect(outbox_failed[0].status).toBe("failed");
        spyDel.mockRestore();

        // Outbox retry worker processes outbox item and converges to completed
        const recovered = await process_pending_vector_outbox();
        expect(recovered).toBeGreaterThan(0);
        const outbox_done = await all_async("select * from vector_outbox where id=? and user_id=? and action='delete'", [mem_outbox.id, T_ALICE]);
        expect(outbox_done[0].status).toBe("completed");

        // 8. Dead-letter threshold: items with attempts >= 5 are skipped by retry worker
        await run_async("insert into vector_outbox(job_id, id, user_id, action, status, attempts, created_at, updated_at) values(?, ?, ?, 'delete', 'failed', 5, ?, ?)", ["dead-letter-job-1", "mem-dead-1", T_ALICE, Date.now(), Date.now()]);
        const deadLetterProcessed = await process_pending_vector_outbox();
        expect(deadLetterProcessed).toBe(0);
    }, 30000);

    it("isolates cross-tenant waypoints and path expansion in expand_via_waypoints", async () => {
        const mem_alice_src = await add_hsg_memory("Alice source node", undefined, undefined, T_ALICE);
        const mem_alice_dst = await add_hsg_memory("Alice target node", undefined, undefined, T_ALICE);
        await q.ins_waypoint.run(mem_alice_src.id, mem_alice_dst.id, T_ALICE, null, 0.9, Date.now(), Date.now());

        const mem_bob_src = await add_hsg_memory("Bob source node", undefined, undefined, T_BOB);
        const mem_bob_dst = await add_hsg_memory("Bob target node", undefined, undefined, T_BOB);
        await q.ins_waypoint.run(mem_bob_src.id, mem_bob_dst.id, T_BOB, null, 0.9, Date.now(), Date.now());

        // Alice expanding via waypoints must NOT see Bob's waypoints or nodes
        const alice_exp = await expand_via_waypoints([mem_alice_src.id], T_ALICE, 5);
        expect(alice_exp.some((item) => item.id === mem_alice_dst.id)).toBe(true);
        expect(alice_exp.some((item) => item.id === mem_bob_src.id || item.id === mem_bob_dst.id)).toBe(false);

        // Bob expanding via waypoints must NOT see Alice's waypoints or nodes
        const bob_exp = await expand_via_waypoints([mem_bob_src.id], T_BOB, 5);
        expect(bob_exp.some((item) => item.id === mem_bob_dst.id)).toBe(true);
        expect(bob_exp.some((item) => item.id === mem_alice_src.id || item.id === mem_alice_dst.id)).toBe(false);
    }, 20000);

    it("requires tenant identity across exported contract boundaries and DB query helpers", async () => {
        // 1. add_hsg_memory fails closed on missing/blank user_id
        await expect(add_hsg_memory("test content", undefined, undefined, "")).rejects.toThrow(/tenant_required/);
        await expect(add_hsg_memory("test content", undefined, undefined, "   ")).rejects.toThrow(/tenant_required/);
        await expect(add_hsg_memory("test content", undefined, undefined, undefined)).rejects.toThrow(/tenant_required/);

        // 2. hsg_query fails closed on missing/blank user_id
        await expect(hsg_query("test query", 5, { user_id: "" })).rejects.toThrow(/tenant_required/);
        await expect(hsg_query("test query", 5, { user_id: "   " })).rejects.toThrow(/tenant_required/);
        await expect(hsg_query("test query", 5, undefined)).rejects.toThrow(/tenant_required/);

        // 3. run_reflection fails closed on missing/blank user_id
        await expect(run_reflection("")).rejects.toThrow(/tenant_required/);
        await expect(run_reflection("   ")).rejects.toThrow(/tenant_required/);
        await expect(run_reflection(undefined as any)).rejects.toThrow(/tenant_required/);

        // 4. DB helper contracts return 0 / undefined on missing, blank, or wrong tenant
        const simhash = "a1b2c3d4e5f67890";
        expect(await q.get_mem_by_simhash.get(simhash, "")).toBeUndefined();
        expect(await q.get_mem_by_simhash.get(simhash, "   ")).toBeUndefined();
        expect(await q.get_waypoint.get("src1", "dst1", "")).toBeUndefined();
        expect(await q.get_waypoint.get("src1", "dst1", "   ")).toBeUndefined();

        expect(await q.upd_feedback.run(0.8, Date.now(), "mem-1", "")).toBe(0);
        expect(await q.upd_feedback.run(0.8, Date.now(), "mem-1", "   ")).toBe(0);
        expect(await q.upd_seen.run(Date.now(), 0.9, Date.now(), "mem-1", "")).toBe(0);
        expect(await q.upd_seen.run(Date.now(), 0.9, Date.now(), "mem-1", "   ")).toBe(0);
        expect(await q.upd_mem.run("new text", "[]", "{}", Date.now(), "mem-1", "")).toBe(0);
        expect(await q.upd_mem.run("new text", "[]", "{}", Date.now(), "mem-1", "   ")).toBe(0);
        expect(await q.upd_waypoint.run(0.5, Date.now(), "src1", "dst1", "")).toBe(0);
        expect(await q.upd_waypoint.run(0.5, Date.now(), "src1", "dst1", "   ")).toBe(0);

        // 5. Zero affected rows on wrong tenant, ownerless (NULL/empty string), or ownership change
        const mem_alice = await add_hsg_memory("Alice test memory content for DB updates", undefined, undefined, T_ALICE);
        expect(await q.upd_seen.run(Date.now(), 0.9, Date.now(), mem_alice.id, T_BOB)).toBe(0);
        expect(await q.upd_mem.run("Tampered text", "[]", "{}", Date.now(), mem_alice.id, T_BOB)).toBe(0);
        expect(await q.upd_feedback.run(0.9, Date.now(), mem_alice.id, T_BOB)).toBe(0);

        // Ownerless (NULL) record
        const null_id = "null-owner-db-test";
        await run_async(
            "insert into memories(id, user_id, primary_sector, content, created_at, updated_at, last_seen_at, salience) values(?, ?, ?, ?, ?, ?, ?, ?)",
            [null_id, null, "semantic", "Null owner DB test content", Date.now(), Date.now(), Date.now(), 0.4],
        );
        expect(await q.upd_seen.run(Date.now(), 0.9, Date.now(), null_id, T_ALICE)).toBe(0);
        expect(await q.upd_mem.run("Tampered text", "[]", "{}", Date.now(), null_id, T_ALICE)).toBe(0);

        // Ownership change mid-flight
        await run_async("update memories set user_id=? where id=?", [T_BOB, mem_alice.id]);
        expect(await q.upd_seen.run(Date.now(), 0.95, Date.now(), mem_alice.id, T_ALICE)).toBe(0);
        expect(await q.upd_mem.run("Re-tampered text", "[]", "{}", Date.now(), mem_alice.id, T_ALICE)).toBe(0);
    }, 30000);

    it("openmemory-config resource isolates stats per tenant", async () => {
        const alice = await connect_client(T_ALICE);
        const bob = await connect_client(T_BOB);

        // Store one memory for Alice in "semantic" primary_sector (default)
        await alice.client.callTool({
            name: "openmemory_store",
            arguments: { content: "Alice's semantic data." },
        });

        // Store two memories for Bob
        await bob.client.callTool({
            name: "openmemory_store",
            arguments: { content: "Bob's first memory." },
        });
        await bob.client.callTool({
            name: "openmemory_store",
            arguments: { content: "Bob's second memory." },
        });

        // Read configuration resource for Alice
        const alice_res = await alice.client.readResource({ uri: "openmemory://config" });
        const alice_cfg = JSON.parse(alice_res.contents[0].text as string);
        expect(alice_cfg.stats).toBeDefined();
        // Alice should only see her 1 memory in the stats
        const alice_count = alice_cfg.stats.reduce((acc: number, item: any) => acc + item.count, 0);
        expect(alice_count).toBe(1);

        // Read configuration resource for Bob
        const bob_res = await bob.client.readResource({ uri: "openmemory://config" });
        const bob_cfg = JSON.parse(bob_res.contents[0].text as string);
        expect(bob_cfg.stats).toBeDefined();
        // Bob should only see his 2 memories in the stats
        const bob_count = bob_cfg.stats.reduce((acc: number, item: any) => acc + item.count, 0);
        expect(bob_count).toBe(2);
    }, 30000);

    it("openmemory_reinforce fails closed on unauthenticated, mismatched, or ownerless sessions", async () => {
        const alice = await connect_client(T_ALICE);
        const bob = await connect_client(T_BOB);
        const unauthenticated = await connect_client(undefined);

        // Store a memory for Alice
        const alice_stored = await alice.client.callTool({
            name: "openmemory_store",
            arguments: { content: "Alice's memory for reinforcement security tests" },
        });
        const { id: alice_mem_id } = parse_store(alice_stored);
        expect(alice_mem_id).toBeTruthy();

        // Store true NULL and empty-string ownerless records directly in DB
        const null_owner_id = "null-owner-memory-123";
        const empty_owner_id = "empty-owner-memory-123";
        await run_async(
            "insert into memories(id, user_id, primary_sector, content, created_at, updated_at, last_seen_at, salience) values(?, ?, ?, ?, ?, ?, ?, ?)",
            [null_owner_id, null, "semantic", "Null owner content", Date.now(), Date.now(), Date.now(), 0.4],
        );
        await run_async(
            "insert into memories(id, user_id, primary_sector, content, created_at, updated_at, last_seen_at, salience) values(?, ?, ?, ?, ?, ?, ?, ?)",
            [empty_owner_id, "", "semantic", "Empty owner content", Date.now(), Date.now(), Date.now(), 0.4],
        );

        const row_initial = await q.get_mem.get(alice_mem_id!);
        const initial_salience = row_initial.salience;

        // 1. Unauthenticated stdio server (missing tenant) with omitted user_id must fail closed
        const unauth_no_uid: any = await unauthenticated.client.callTool({
            name: "openmemory_reinforce",
            arguments: { id: alice_mem_id!, boost: 0.2 },
        });
        expect(unauth_no_uid.isError).toBe(true);
        const unauth_text = (unauth_no_uid.content ?? []).map((b: any) => b.text).join("\n");
        expect(unauth_text).toMatch(/Unauthenticated MCP session/);

        // 2. Unauthenticated stdio server (missing tenant) with caller-supplied user_id must fail closed
        const unauth_with_uid: any = await unauthenticated.client.callTool({
            name: "openmemory_reinforce",
            arguments: { id: alice_mem_id!, boost: 0.2, user_id: T_ALICE },
        });
        expect(unauth_with_uid.isError).toBe(true);

        // 3. Authenticated session (Bob) trying to reinforce Alice's memory must fail without leaking identities
        const bob_reinforce_alice: any = await bob.client.callTool({
            name: "openmemory_reinforce",
            arguments: { id: alice_mem_id!, boost: 0.2 },
        });
        expect(bob_reinforce_alice.isError).toBe(true);
        const bob_text = (bob_reinforce_alice.content ?? []).map((b: any) => b.text).join("\n");
        expect(bob_text).not.toMatch(T_ALICE);
        expect(bob_text).not.toMatch(T_BOB);

        // 4. Authenticated session (Alice) trying to reinforce NULL and empty ownerless memories must fail
        const alice_reinforce_null: any = await alice.client.callTool({
            name: "openmemory_reinforce",
            arguments: { id: null_owner_id, boost: 0.2 },
        });
        expect(alice_reinforce_null.isError).toBe(true);

        const alice_reinforce_empty: any = await alice.client.callTool({
            name: "openmemory_reinforce",
            arguments: { id: empty_owner_id, boost: 0.2 },
        });
        expect(alice_reinforce_empty.isError).toBe(true);

        // 4b. Direct helper call boundary: reinforce_memory fails closed on missing/empty/wrong tenant identity
        expect(await reinforce_memory(alice_mem_id!, 0.2, "")).toBe(false);
        expect(await reinforce_memory(alice_mem_id!, 0.2, "   ")).toBe(false);
        expect(await reinforce_memory(alice_mem_id!, 0.2, T_BOB)).toBe(false);
        expect(await reinforce_memory(null_owner_id, 0.2, T_ALICE)).toBe(false);
        expect(await reinforce_memory(empty_owner_id, 0.2, T_ALICE)).toBe(false);

        // 5. Authenticated session (Alice) with mismatched user_id must fail with tenant_mismatch without leaking
        const alice_mismatch: any = await alice.client.callTool({
            name: "openmemory_reinforce",
            arguments: { id: alice_mem_id!, boost: 0.2, user_id: T_BOB },
        });
        expect(alice_mismatch.isError).toBe(true);
        const mismatch_text = (alice_mismatch.content ?? []).map((b: any) => b.text).join("\n");
        expect(mismatch_text).toMatch(/tenant_mismatch/);
        expect(mismatch_text).not.toMatch(T_ALICE);
        expect(mismatch_text).not.toMatch(T_BOB);

        // 6. Authenticated session (Alice) reinforcing non-existent / missing memory ID must fail
        const alice_missing_id: any = await alice.client.callTool({
            name: "openmemory_reinforce",
            arguments: { id: "non-existent-memory-id", boost: 0.2 },
        });
        expect(alice_missing_id.isError).toBe(true);

        // Verify salience in database was NOT altered during any rejected attempt
        const row_after_rejections = await q.get_mem.get(alice_mem_id!);
        expect(row_after_rejections.salience).toBe(initial_salience);

        // 7. Alice reinforcing her own memory with matching tenant context must succeed
        const alice_ok: any = await alice.client.callTool({
            name: "openmemory_reinforce",
            arguments: { id: alice_mem_id!, boost: 0.2, user_id: T_ALICE },
        });
        expect(alice_ok.isError).toBeFalsy();

        // Verify salience in database WAS boosted after successful reinforcement
        const row_after_success = await q.get_mem.get(alice_mem_id!);
        expect(row_after_success.salience).toBeGreaterThan(initial_salience);
    }, 30000);

    it("start_mcp_stdio fails startup closed when missing tenant and binds configured tenant when present", async () => {
        const old_tenant = process.env.OM_TENANT;
        const old_uid = process.env.OM_USER_ID;
        const old_key = process.env.OM_API_KEY;

        delete process.env.OM_TENANT;
        delete process.env.OM_USER_ID;
        process.env.OM_API_KEY = "sk_live_secret_key_123456789";

        // 1. Missing OM_TENANT or OM_USER_ID must fail startup closed, even if OM_API_KEY is present
        await expect(start_mcp_stdio()).rejects.toThrow(/Missing trusted server tenant configuration/);
        expect(derive_mcp_tenant_id()).toBeUndefined();

        // 2. Empty string OM_TENANT must fail startup closed
        process.env.OM_TENANT = "   ";
        await expect(start_mcp_stdio()).rejects.toThrow(/Missing trusted server tenant configuration/);
        expect(derive_mcp_tenant_id()).toBeUndefined();

        // 3. Valid OM_TENANT binds exact tenant string
        process.env.OM_TENANT = "tenant-stdio-canonical";
        expect(derive_mcp_tenant_id()).toBe("tenant-stdio-canonical");

        // 4. Valid OM_USER_ID binds exact user string
        delete process.env.OM_TENANT;
        process.env.OM_USER_ID = "user-mcp-456";
        expect(derive_mcp_tenant_id()).toBe("user-mcp-456");

        // 5. Configured stdio startup passes server-bound tenant to handler and enables reinforcement
        process.env.OM_TENANT = "tenant-stdio-canonical";
        const [stdio_client_trans, stdio_server_trans] = InMemoryTransport.createLinkedPair();
        const stdio_res = await start_mcp_stdio(stdio_server_trans);
        expect(stdio_res.tenant).toBe("tenant-stdio-canonical");

        const stdio_client = new Client({ name: "stdio-test-client", version: "0.0.0" });
        await stdio_client.connect(stdio_client_trans);

        const stdio_store = await stdio_client.callTool({
            name: "openmemory_store",
            arguments: { content: "Stored memory via stdio canonical tenant" },
        });
        const { id: stdio_mem_id } = parse_store(stdio_store);
        expect(stdio_mem_id).toBeTruthy();

        const stdio_row_before = await q.get_mem.get(stdio_mem_id!);
        expect(stdio_row_before.user_id).toBe("tenant-stdio-canonical");

        const stdio_reinforce: any = await stdio_client.callTool({
            name: "openmemory_reinforce",
            arguments: { id: stdio_mem_id!, boost: 0.2 },
        });
        expect(stdio_reinforce.isError).toBeFalsy();

        const stdio_row_after = await q.get_mem.get(stdio_mem_id!);
        expect(stdio_row_after.salience).toBeGreaterThan(stdio_row_before.salience);

        // Restore env vars
        if (old_tenant) process.env.OM_TENANT = old_tenant; else delete process.env.OM_TENANT;
        if (old_uid) process.env.OM_USER_ID = old_uid; else delete process.env.OM_USER_ID;
        if (old_key) process.env.OM_API_KEY = old_key; else delete process.env.OM_API_KEY;
    }, 30000);

    it("add_hsg_memory isolates same-content dedup across different tenants", async () => {
        const content = "Unique same content for cross-tenant dedup test";

        // 1. Alice adds memory
        const alice_res = await add_hsg_memory(content, undefined, undefined, T_ALICE);
        expect(alice_res.id).toBeTruthy();
        expect(alice_res.deduplicated).toBeFalsy();

        // 2. Bob adds same memory -> Bob must NOT get Alice's memory as deduplicated
        const bob_res = await add_hsg_memory(content, undefined, undefined, T_BOB);
        expect(bob_res.id).toBeTruthy();
        expect(bob_res.id).not.toBe(alice_res.id);
        expect(bob_res.deduplicated).toBeFalsy();

        const alice_row = await q.get_mem.get(alice_res.id);
        const bob_row = await q.get_mem.get(bob_res.id);
        expect(alice_row.user_id).toBe(T_ALICE);
        expect(bob_row.user_id).toBe(T_BOB);

        // 3. Alice adding same memory again SHOULD deduplicate against Alice's own record
        const alice_dup = await add_hsg_memory(content, undefined, undefined, T_ALICE);
        expect(alice_dup.id).toBe(alice_res.id);
        expect(alice_dup.deduplicated).toBe(true);
    }, 30000);

    it("hsg_query isolates trace reinforcement and search results per tenant", async () => {
        const alice_res = await add_hsg_memory("Semantic recall query test text", undefined, undefined, T_ALICE);
        const row_before = await q.get_mem.get(alice_res.id);
        const salience_before = row_before.salience;

        // Bob querying for Alice's memory -> 0 results returned, Alice's salience is NOT mutated
        const bob_results = await hsg_query("Semantic recall query test text", 5, { user_id: T_BOB });
        expect(bob_results.length).toBe(0);

        const row_after_bob = await q.get_mem.get(alice_res.id);
        expect(row_after_bob.salience).toBe(salience_before);

        // Alice querying her own memory -> result returned and salience reinforced for T_ALICE
        const alice_results = await hsg_query("Semantic recall query test text", 5, { user_id: T_ALICE });
        expect(alice_results.length).toBeGreaterThan(0);

        const row_after_alice = await q.get_mem.get(alice_res.id);
        expect(row_after_alice.salience).toBeGreaterThan(salience_before);
    }, 20000);

    it("run_reflection requires tenant context and reinforces only trusted tenant memories", async () => {
        // 1. Untrusted/tenantless call fails closed
        await expect(run_reflection(undefined as any)).rejects.toThrow(/tenant_required/);

        // 2. Add memories for Alice to form a cluster (min 2 memories with sim > 0.8)
        const m1 = await add_hsg_memory("Docker container network bridge interface setup step by step configuration guide", undefined, undefined, T_ALICE);
        const m2 = await add_hsg_memory("Docker container network bridge interface setup step by step configuration instructions", undefined, undefined, T_ALICE);

        const old_min = process.env.OM_REFLECT_MIN;
        process.env.OM_REFLECT_MIN = "2";

        const m1_before = await q.get_mem.get(m1.id);
        const reflect_res = await run_reflection(T_ALICE, 2);
        expect(reflect_res.created).toBeGreaterThan(0);

        if (old_min) process.env.OM_REFLECT_MIN = old_min; else delete process.env.OM_REFLECT_MIN;

        const m1_after = await q.get_mem.get(m1.id);
        expect(m1_after.salience).toBeGreaterThan(m1_before.salience);
    }, 30000);
});
