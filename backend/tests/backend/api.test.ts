import { describe, test, expect, beforeAll } from "bun:test";
import { Elysia } from "elysia";
import { mem } from "../../src/server/routes/memory";
import { sys } from "../../src/server/routes/system";
import { req_tracker_plugin } from "../../src/server/routes/dashboard";

describe('OpenMemory Backend API', () => {
    let app: Elysia;

    beforeAll(() => {
        app = new Elysia()
            .use(req_tracker_plugin)
            .use(mem)
            .use(sys);
    });

    test('Health Check', async () => {
        const response = await app.handle(new Request("http://localhost/api/system/health"));
        expect(response.status).toBe(200);
        const data = await response.json();
        expect(data).toHaveProperty('status');
        expect(data).toHaveProperty('version');
    });

    test('Memory Operations (Add, List, Query, Update, Delete)', async () => {
        // Add
        const testContent = 'This is a test memory for backend API testing ' + Date.now();
        const addRes = await app.handle(new Request("http://localhost/api/memory/add", {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: testContent }),
        }));
        expect(addRes.status).toBe(200);
        const addData = await addRes.json();
        expect(addData).toHaveProperty('id');
        expect(addData).toHaveProperty('primary_sector');

        const memoryId = addData.id;

        // List
        const listRes = await app.handle(new Request("http://localhost/api/memory/all?l=10"));
        expect(listRes.status).toBe(200);
        const listData = await listRes.json();
        expect(Array.isArray(listData.items)).toBe(true);
        const found = listData.items.find((m: any) => m.id === memoryId);
        expect(found).toBeDefined();

        // Query
        const queryRes = await app.handle(new Request("http://localhost/api/memory/query", {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: 'test memory', k: 5 }),
        }));
        expect(queryRes.status).toBe(200);
        const queryData = await queryRes.json();
        expect(Array.isArray(queryData.matches)).toBe(true);

        // Update
        const updateRes = await app.handle(new Request(`http://localhost/api/memory/${memoryId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                content: 'Updated content ' + Date.now(),
                tags: ['test', 'updated'],
                metadata: { updated: true },
            }),
        }));
        expect(updateRes.status).toBe(200);
        const updateData = await updateRes.json();
        expect(updateData.updated).toBe(true);

        // Delete
        const delRes = await app.handle(new Request(`http://localhost/api/memory/${memoryId}`, {
            method: 'DELETE',
        }));
        expect(delRes.status).toBe(200);
        const delData = await delRes.json();
        expect(delData.ok).toBe(true);

        // Verify Delete
        const getRes = await app.handle(new Request(`http://localhost/api/memory/${memoryId}`));
        expect(getRes.status).toBe(404);
    });

    test('Sector Operations', async () => {
        const response = await app.handle(new Request("http://localhost/api/memory/sectors"));
        expect(response.status).toBe(200);
        const data = await response.json();
        expect(Array.isArray(data.sectors)).toBe(true);
        expect(data.sectors).toContain('episodic');
        expect(data.sectors).toContain('semantic');
    });

    test('Error Handling', async () => {
        const response = await app.handle(new Request("http://localhost/api/memory/invalid-id-12345"));
        expect(response.status).toBe(404);
    });
});
