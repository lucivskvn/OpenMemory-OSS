
import { describe, expect, test, mock, beforeEach } from "bun:test";
import { MemoryClient } from "../src/client";

// Global fetch mock
const originalFetch = global.fetch;

describe("MemoryClient (Mocked)", () => {
    let client: MemoryClient;
    let fetchMock: any;

    beforeEach(() => {
        fetchMock = mock(async (url: string | URL | Request, options: any) => {
            return new Response(JSON.stringify({ success: true, keys: [], facts: [] }), {
                status: 200,
                headers: { "Content-Type": "application/json" }
            });
        });
        global.fetch = fetchMock;
        client = new MemoryClient({ baseUrl: "http://test-api", token: "test-token" });
    });

    test("registerUser sends correct payload", async () => {
        await client.registerUser("u1", "admin");

        expect(fetchMock).toHaveBeenCalled();
        const call = fetchMock.mock.calls[0];
        const url = call[0];
        const opts = call[1];

        expect(url).toBe("http://test-api/users/register");
        expect(opts.method).toBe("POST");
        expect(JSON.parse(opts.body)).toEqual({ userId: "u1", scope: "admin" });
        expect(opts.headers["Authorization"]).toBe("Bearer test-token");
    });

    test("startIdeSession sends correct payload", async () => {
        await client.startIdeSession({ projectName: "p1", ideName: "vim", userId: "u1" });

        const call = fetchMock.mock.calls[0];
        const opts = call[1];
        expect(JSON.parse(opts.body)).toEqual({
            projectName: "p1",
            ideName: "vim",
            userId: "u1"
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
