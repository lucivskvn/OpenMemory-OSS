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
import { run_async, q } from "../src/core/db";

const T_ALICE = "tenant-alice-mcp";
const T_BOB = "tenant-bob-mcp";

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
    });

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
    });

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
    });

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

    it("stdio-style server (no tenant) preserves legacy behaviour", async () => {
        // No tenant bound — this is the stdio MCP shape. Stored memories
        // get the "anonymous" fallback from add_hsg_memory and openmemory_list
        // returns everything in the table (the pre-existing local-dev contract).
        const { client } = await connect_client(undefined);
        const stored = await client.callTool({
            name: "openmemory_store",
            arguments: { content: "stdio-mode memory with no tenant binding" },
        });
        const { id } = parse_store(stored);
        expect(id).toBeTruthy();

        const row = await q.get_mem.get(id!);
        expect(row.user_id).toBe("anonymous");

        const items = parse_items(
            await client.callTool({
                name: "openmemory_list",
                arguments: { limit: 50 },
            }),
        );
        expect(items.length).toBe(1);
        expect(items[0].id).toBe(id);
    });

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
    });

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

        // Store an ownerless memory (anonymous user_id) directly in DB
        const ownerless_id = "ownerless-memory-123";
        await run_async(
            "insert into memories(id, user_id, primary_sector, content, created_at, updated_at, last_seen_at, salience) values(?, ?, ?, ?, ?, ?, ?, ?)",
            [ownerless_id, "anonymous", "semantic", "Ownerless content", Date.now(), Date.now(), Date.now(), 0.4],
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

        // 4. Authenticated session (Alice) trying to reinforce ownerless memory must fail
        const alice_reinforce_ownerless: any = await alice.client.callTool({
            name: "openmemory_reinforce",
            arguments: { id: ownerless_id, boost: 0.2 },
        });
        expect(alice_reinforce_ownerless.isError).toBe(true);

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
    });

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

        // Restore env vars
        if (old_tenant) process.env.OM_TENANT = old_tenant; else delete process.env.OM_TENANT;
        if (old_uid) process.env.OM_USER_ID = old_uid; else delete process.env.OM_USER_ID;
        if (old_key) process.env.OM_API_KEY = old_key; else delete process.env.OM_API_KEY;
    });
});
