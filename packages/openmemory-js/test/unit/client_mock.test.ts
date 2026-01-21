
import { describe, expect, test, mock, beforeEach } from "bun:test";
import { MemoryClient } from "../../src/client";

// Global fetch mock
const originalFetch = global.fetch;

describe("MemoryClient (Mocked)", () => {
    let client: MemoryClient;
    let fetchMock: ReturnType<typeof mock>;

    beforeEach(() => {
        fetchMock = mock(async (url: string | URL | Request, options: any) => {
            return new Response(JSON.stringify({ success: true, keys: [], facts: [] }), {
                status: 200,
                headers: { "Content-Type": "application/json" }
            });
        });
        global.fetch = fetchMock as unknown as typeof fetch;
        client = new MemoryClient({ baseUrl: "http://test-api", token: "test-token" });
    });

    test("admin.createUser sends correct payload", async () => {
        await client.admin.createUser("u1", "test@example.com");

        expect(fetchMock).toHaveBeenCalled();
        const call = fetchMock.mock.calls[0];
        const url = call[0];
        const opts = call[1];

        expect(url).toBe("http://test-api/admin/users");
        expect(opts.method).toBe("POST");
        expect(JSON.parse(opts.body)).toEqual({ id: "u1", email: "test@example.com" });
        expect(opts.headers["Authorization"]).toBe("Bearer test-token");
    });

    test("ide.startSession sends correct payload", async () => {
        await client.ide.startSession({ ide: "vim", version: "1.0", workspace: "/project" });

        const call = fetchMock.mock.calls[0];
        const opts = call[1];
        expect(JSON.parse(opts.body)).toEqual({
            ide: "vim",
            version: "1.0",
            workspace: "/project",
            userId: undefined,
            metadata: undefined
        });
    });

    test("addFact sends correct payload", async () => {
        await client.addFact({ subject: "s", predicate: "p", object: "o" }, "u1");

        const call = fetchMock.mock.calls[0];
        const opts = call[1];
        expect(JSON.parse(opts.body)).toEqual({
            subject: "s",
            predicate: "p",
            object: "o",
            userId: "u1"
        });
    });
});
