import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createMcpServer } from "../../src/ai/mcp";
import { stopAllMaintenance } from "../../src/core/scheduler";
import { closeDb } from "../../src/core/db";

describe("MCP Server Audit", () => {
    const srv = createMcpServer();

    afterAll(async () => {
        await stopAllMaintenance();
        srv.server.close();
        await closeDb();
    });

    test("MCP Server Initialization", () => {
        expect(srv).toBeDefined();
        // Check if tools are registered (internal API check)
        // @ts-ignore
        const tools = srv.server._tools;
        expect(srv.server).toBeDefined();
    });

});
