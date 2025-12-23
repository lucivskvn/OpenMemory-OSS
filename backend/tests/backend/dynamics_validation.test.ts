import { describe, test, expect, beforeAll } from "bun:test";
import { Elysia } from "elysia";
import { dynroutes } from "../../src/server/routes/dynamics";

describe('Dynamics Validation', () => {
    let app: Elysia;

    beforeAll(() => {
        app = new Elysia()
            .onError(({ code, set }) => {
                if (code === 'VALIDATION') {
                    set.status = 400;
                    return { err: "invalid_params" };
                }
            });
        app.use(dynroutes);
    });

    test('Resonance: Invalid Payload', async () => {
        const res = await app.handle(new Request("http://localhost/api/dynamics/resonance", {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                source_sector: "semantic",
                // missing target_sector
            })
        }));
        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.err).toBe("invalid_params");
    });

    test('Propagate: Invalid Payload', async () => {
        const res = await app.handle(new Request("http://localhost/api/dynamics/propagate", {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                source_id: "123",
                reinforcement_value: "high" // should be number
            })
        }));
        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.err).toBe("invalid_params");
    });
});
