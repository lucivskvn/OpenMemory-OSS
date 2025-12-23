import { describe, test, expect, beforeAll } from "bun:test";
import { Elysia } from "elysia";
import { lg } from "../../src/server/routes/langgraph";
import { env } from "../../src/core/cfg";

// Force enable langgraph mode
env.mode = "langgraph";

describe("LangGraph API", () => {
    let app: Elysia;

    beforeAll(() => {
        app = new Elysia();
        app.use(lg);
    });

    test("Store Memory", async () => {
        const res = await app.handle(new Request("http://localhost/api/lg/store", {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                node: "observe",
                content: "LangGraph test memory",
                metadata: { thread_id: "t1" }
            })
        }));

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data).toHaveProperty('ok', true);
    });

    test("Retrieve Memory", async () => {
        const res = await app.handle(new Request("http://localhost/api/lg/retrieve", {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                node: "observe",
                query: "test",
                namespace: "default"
            })
        }));

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(Array.isArray(data.results)).toBe(true);
    });
});
