import { describe, test, expect, beforeAll } from "bun:test";
import { Elysia } from "elysia";
import { dash } from "../../src/server/routes/dashboard";

describe('Dashboard API', () => {
    let app: Elysia;

    beforeAll(() => {
        app = new Elysia();
        app.use(dash);
    });

    test('Get Stats', async () => {
        const res = await app.handle(new Request("http://localhost/api/dashboard/stats"));
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data).toHaveProperty('overview');
        expect(data.overview).toHaveProperty('active_segments');
    });

    test('Get Memories', async () => {
        const res = await app.handle(new Request("http://localhost/api/dashboard/memories?limit=5"));
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data).toHaveProperty('memories');
        expect(Array.isArray(data.memories)).toBe(true);
    });

    test('Get Activity', async () => {
        const res = await app.handle(new Request("http://localhost/api/dashboard/activity?limit=5"));
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data).toHaveProperty('activities');
        expect(Array.isArray(data.activities)).toBe(true);
        if (data.activities.length > 0) {
            expect(data.activities[0]).toHaveProperty('type');
            expect(data.activities[0]).toHaveProperty('timestamp');
        }
    });
});
