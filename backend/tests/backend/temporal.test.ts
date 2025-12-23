import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { app } from "../../src/server"; // Import app to test routes

describe("Temporal API", () => {
    test("Create Fact", async () => {
        const res = await app.handle(new Request("http://localhost:8080/api/temporal/fact", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                subject: "TestSub",
                predicate: "is_a",
                object: "TestObj"
            })
        }));
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.ok).toBe(true);
        expect(data.id).toBeString();
    });

    test("Get Facts", async () => {
        const res = await app.handle(new Request("http://localhost:8080/api/temporal/fact?subject=TestSub"));
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.facts).toBeArray();
        expect(data.facts.length).toBeGreaterThan(0);
    });
});
