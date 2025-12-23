import { describe, test, expect, beforeAll } from "bun:test";
import { Elysia } from "elysia";
import { ide } from "../../src/server/routes/ide";
import { env } from "../../src/core/cfg";

// Force enable IDE mode for testing
env.ide_mode = true;

describe('IDE Integration Real', () => {
    let app: Elysia;

    beforeAll(() => {
        app = new Elysia().use(ide);
    });

    test('Store IDE Event', async () => {
        const res = await app.handle(new Request("http://localhost/api/ide/events", {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                event: "save",
                metadata: { file: "test.ts" },
                session_id: "test-sess"
            })
        }));

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data).toHaveProperty('ok', true);
        expect(data).toHaveProperty('id');
    });

    test('Query Context', async () => {
        // First create an event to have something in context
        await app.handle(new Request("http://localhost/api/ide/events", {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                event: "edit",
                content: "function test() {}",
                metadata: { file: "test.ts" },
                session_id: "test-sess"
            })
        }));

        const res = await app.handle(new Request("http://localhost/api/ide/context", {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                query: "test function",
                session_id: "test-sess"
            })
        }));

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data).toHaveProperty('memories');
        expect(Array.isArray(data.memories)).toBe(true);
    });
});
