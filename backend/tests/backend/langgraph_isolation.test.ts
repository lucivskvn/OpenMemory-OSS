import { describe, expect, it, beforeAll } from "bun:test";
import { Elysia } from "elysia";
import { lg } from "../../src/server/routes/langgraph";
import { q, run_async } from "../../src/core/db";
import { env } from "../../src/core/cfg";

const BASE_URL = "http://localhost:8080/api/lg";

describe("LangGraph Isolation", () => {
    let app: Elysia;
    const userA = "lg_user_a_" + Date.now();
    const userB = "lg_user_b_" + Date.now();
    const namespace = "isolation_test";

    beforeAll(() => {
        env.mode = "langgraph"; // Ensure route is active
        app = new Elysia();
        app.use(lg);
    });

    it("should store memories isolated by user_id", async () => {
        // User A
        const resA = await app.handle(new Request(`${BASE_URL}/store`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                node: "observe",
                content: "User A Observation",
                namespace: namespace,
                user_id: userA
            })
        }));
        expect(resA.status).toBe(200);

        // User B
        const resB = await app.handle(new Request(`${BASE_URL}/store`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                node: "observe",
                content: "User B Observation",
                namespace: namespace,
                user_id: userB
            })
        }));
        expect(resB.status).toBe(200);

        // Debug: Check DB state
        const all = await q.all_mem.all(10, 0);
        console.log("DB Memories:", all.map(m => ({ id: m.id, user: m.user_id, tags: m.tags })));
    });

    it("should retrieve only User A memories when requesting as User A", async () => {
        const res = await app.handle(new Request(`${BASE_URL}/retrieve`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                node: "observe",
                namespace: namespace,
                user_id: userA
            })
        }));

        expect(res.status).toBe(200);
        const data = await res.json();

        expect(data.results.length).toBeGreaterThan(0);
        const contents = data.results.map((r: any) => r.content).join(" ");
        expect(contents).toContain("User A Observation");
        expect(contents).not.toContain("User B Observation");
    });

    it("should retrieve only User B memories when requesting as User B", async () => {
        const res = await app.handle(new Request(`${BASE_URL}/retrieve`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                node: "observe",
                namespace: namespace,
                user_id: userB
            })
        }));

        expect(res.status).toBe(200);
        const data = await res.json();

        const contents = data.results.map((r: any) => r.content).join(" ");
        expect(contents).toContain("User B Observation");
        expect(contents).not.toContain("User A Observation");
    });

    it("should use user_id in context retrieval", async () => {
        const res = await app.handle(new Request(`${BASE_URL}/context?namespace=${namespace}&user_id=${userA}`, {
            method: "GET"
        }));

        expect(res.status).toBe(200);
        const data = await res.json();

        expect(data.summary).toContain("User A Observation");
        expect(data.summary).not.toContain("User B Observation");
    });
});
