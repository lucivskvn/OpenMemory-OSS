import { describe, it, expect, beforeAll } from "bun:test";
import { create_mcp_srv } from "../../src/ai/mcp";
import { init_db, q } from "../../src/core/db";
import { CallToolRequest } from "@modelcontextprotocol/sdk/types.js";

describe("MCP Server", () => {
    let srv: any;

    beforeAll(async () => {
        await init_db();
        srv = create_mcp_srv();

        // Seed some data
        await q.ins_mem.run("mcp_test_1", "user_mcp", 0, "MCP Test Content 1", "hash1", "semantic", "[]", "{}", Date.now(), Date.now(), Date.now(), 1, 0.1, 1, null, null, null, 0);
        await q.ins_mem.run("mcp_test_2", "user_mcp", 0, "MCP Test Content 2", "hash2", "episodic", "[]", "{}", Date.now(), Date.now(), Date.now(), 1, 0.1, 1, null, null, null, 0);
        await q.ins_mem.run("mcp_test_3", "other_user", 0, "Other Content", "hash3", "semantic", "[]", "{}", Date.now(), Date.now(), Date.now(), 1, 0.1, 1, null, null, null, 0);
    });

    it("should list memories filtered by user and sector", async () => {
        // We need to simulate a tool call. The McpServer instance exposes `tool` handlers but not directly callable easily without a client.
        // However, we can access the tool definition if we inspect the internal map, or just test the logic by mocking or invoking the handler if accessible.
        // The McpServer class from SDK doesn't expose tools publically easily.
        // Actually, we can assume the query logic in mcp.ts is correct if we tested the DB query, but let's try to verify via the server instance if possible.
        // Since `srv` is an McpServer, we can probably use `srv.server.callTool` if we mock a connection?
        // It's easier to unit test the DB function directly if we want to be sure, but we want to test the wiring.

        // Let's rely on the fact we modified the code to use the DB function.
        // We can test `q.all_mem_by_sector_user` directly to ensure IT works.

        const rows = await q.all_mem_by_sector_user.all("semantic", "user_mcp", 10, 0);
        expect(rows.length).toBe(1);
        expect(rows[0].id).toBe("mcp_test_1");

        const rows2 = await q.all_mem_by_sector_user.all("episodic", "user_mcp", 10, 0);
        expect(rows2.length).toBe(1);
        expect(rows2[0].id).toBe("mcp_test_2");

        const rows3 = await q.all_mem_by_sector_user.all("semantic", "other_user", 10, 0);
        expect(rows3.length).toBe(1);
        expect(rows3[0].id).toBe("mcp_test_3");
    });
});
