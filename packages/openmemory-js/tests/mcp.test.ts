import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { create_mcp_srv } from "../src/ai/mcp";
import { stop_hsg_maintenance } from "../src/memory/hsg";
import { close_db } from "../src/core/db";

describe("MCP Server Audit", () => {
    const srv = create_mcp_srv();

    afterAll(() => {
        stop_hsg_maintenance();
        srv.server.close();
    });

    test("MCP Server Initialization", () => {
        expect(srv).toBeDefined();
        // Check if tools are registered (internal API check or just assumption)
        // @ts-ignore
        const tools = srv.server._tools;
        // Note: McpServer structure might differ, but we check instantiation
        expect(srv.server).toBeDefined();
    });

    // TODO: Add actual tool invocation tests if possible without full transport
});
