import { describe, it, expect, beforeEach, afterAll } from 'bun:test';

process.env.OM_TEST_MODE = '1';
process.env.OM_METADATA_BACKEND = 'sqlite';
process.env.OM_DB_PATH = ':memory:';

import { initDb, q, get_async, closeDb } from '../../backend/src/core/db.test-entry';

beforeEach(async () => {
    await initDb();
});

afterAll(async () => {
    try { await closeDb(); } catch (e) { /* ignore */ }
});

describe('Stream telemetry persistence', () => {
    it('persists telemetry via /dashboard/telemetry/stream', async () => {
        const mod: any = await import('../../backend/src/server/index.ts');
        // stop any existing server so we can restart with the admin key set
        if (typeof mod.stopServer === 'function') await mod.stopServer();
        if (typeof mod.startServer === 'function') {
            await mod.startServer({ port: 0 });
        }
        // No runtime admin key set for this test (we're testing unguarded telemetry
        // persistence). Ensure there is no leftover admin key from other tests.
        const cfg: any = await import('../../backend/src/core/cfg');
        cfg.setAdminApiKeyForTests(undefined);
        await new Promise((r) => setTimeout(r, 10));
        // port set by env by startServer
        const port = process.env.OM_PORT || process.env.PORT || '8080';

        const payload = {
            id: 'telemetry-test-1',
            user_id: 'test-user',
            stream_duration_ms: 12,
            memory_ids: ['m1', 'm2'],
            query: 'hello',
            embedding_mode: 'router_cpu'
        };

        const res = await fetch(`http://127.0.0.1:${port}/dashboard/telemetry/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        expect(res.status).toBe(200);

        // Check DB row exists
        const row = await get_async('select id, user_id, embedding_mode, duration_ms, memory_ids, query from stream_telemetry where id=?', ['telemetry-test-1']);
        expect(row).toBeTruthy();
        expect(row.id).toBe('telemetry-test-1');
        expect(row.user_id).toBe('test-user');
        expect(String(row.embedding_mode)).toBe('router_cpu');
        expect(Number(row.duration_ms)).toBe(12);
        expect(typeof row.memory_ids === 'string').toBeTruthy();
        expect(String(row.query)).toBe('hello');

        // Now verify GET /dashboard/telemetry returns the entry
        const getRes = await fetch(`http://127.0.0.1:${port}/dashboard/telemetry?limit=10`);
        expect(getRes.status).toBe(200);
        const data = await getRes.json();
        expect(Array.isArray(data.telemetry)).toBeTruthy();
        const found = data.telemetry.find((t: any) => t.id === 'telemetry-test-1');
        expect(found).toBeTruthy();
        expect(found.embedding_mode).toBe('router_cpu');

        // Server-side filter: non-matching mode should not return this entry
        const notFoundRes = await fetch(`http://127.0.0.1:${port}/dashboard/telemetry?limit=10&embedding_mode=local`);
        expect(notFoundRes.status).toBe(200);
        const notFound = await notFoundRes.json();
        const foundNot = notFound.telemetry.find((t: any) => t.id === 'telemetry-test-1');
        expect(foundNot).toBeFalsy();
    });

    it('requires admin key when OM_ADMIN_API_KEY configured', async () => {
        // Hash an admin key and set it in the env before starting server
        const cryptoMod: any = await import('../../backend/src/utils/crypto');
        const adminPlain = 'super-secret-admin';
        const adminHash = await cryptoMod.hashPassword(adminPlain);
        process.env.OM_ADMIN_API_KEY = adminHash;

        const mod: any = await import('../../backend/src/server/index.ts');
        // Ensure server is restarted so new env config is picked up
        if (typeof mod.stopServer === 'function') await mod.stopServer();
        // Use setAdminApiKeyForTests to properly update admin key at runtime
        const cfg: any = await import('../../backend/src/core/cfg');
        cfg.setAdminApiKeyForTests(adminHash);

        if (typeof mod.startServer === 'function') {
            await mod.startServer({ port: 0 });
        }
        const port = process.env.OM_PORT || process.env.PORT || '8080';

        const payload = {
            id: 'telemetry-test-admin-1',
            user_id: 'admin-user',
            stream_duration_ms: 20,
            memory_ids: [],
            query: 'admin test',
        };

        // Ensure the admin key was set correctly in the runtime config
        expect((cfg as any).env.admin_api_key).toBeTruthy();

        // No admin header -> forbidden (assert admin key is enforced)
        // Add tiny delay to avoid race where server hasn't picked up runtime change
        await new Promise((r) => setTimeout(r, 50));
        // Call the telemetry handler directly (test seam) to avoid flakiness
        const routeMod: any = await import('../../backend/src/server/routes/dashboard');
        const handler = routeMod.__TEST_getTelemetryHandler();
        // Build a minimal context object similar to the router's context
        const ctx: any = { body: payload, query: new URLSearchParams() };
        const res = await handler(new Request('http://localhost/test'), ctx);
        expect(res.status).toBe(403);

        // With admin header -> allowed
        const okRes = await fetch(`http://127.0.0.1:${port}/dashboard/telemetry/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-admin-key': adminPlain },
            body: JSON.stringify(payload),
        });
        expect(okRes.status).toBe(200);

        // GET should require admin header when configured
        const getNo = await fetch(`http://127.0.0.1:${port}/dashboard/telemetry`);
        expect(getNo.status).toBe(403);

        const getOk = await fetch(`http://127.0.0.1:${port}/dashboard/telemetry`, { headers: { 'x-admin-key': adminPlain } });
        expect(getOk.status).toBe(200);
        const data = await getOk.json();
        const found = data.telemetry.find((t: any) => t.id === 'telemetry-test-admin-1');
        expect(found).toBeTruthy();

        // Clear admin key for subsequent tests using the test seam.
        cfg.setAdminApiKeyForTests(undefined);
        if (typeof mod.stopServer === 'function') await mod.stopServer();
        if (typeof mod.startServer === 'function') await mod.startServer({ port: 0 });
    });

    it('enforces OM_STRICT_TENANT on telemetry when not admin', async () => {
        // set strict tenant mode and restart server
        process.env.OM_STRICT_TENANT = 'true';
        const mod: any = await import('../../backend/src/server/index.ts');
        if (typeof mod.stopServer === 'function') await mod.stopServer();
        if (typeof mod.startServer === 'function') await mod.startServer({ port: 0 });
        const port = process.env.OM_PORT || process.env.PORT || '8080';

        // Without user_id query param, should be 400 when strict
        const getRes = await fetch(`http://127.0.0.1:${port}/dashboard/telemetry`);
        expect(getRes.status).toBe(400);

        // Without user_id, POST should also be rejected when strict
        const payload = {
            id: 'telemetry-test-strict-1',
            stream_duration_ms: 5,
            memory_ids: [],
            query: 'strict test',
        };
        const postRes = await fetch(`http://127.0.0.1:${port}/dashboard/telemetry/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        expect(postRes.status).toBe(400);

        // With user_id present, should be ok
        const getOk = await fetch(`http://127.0.0.1:${port}/dashboard/telemetry?user_id=test-user`);
        expect(getOk.status).toBe(200);

        // With explicit user_id, POST should be allowed
        const payload2 = { ...payload, user_id: 'test-user' };
        const postOk = await fetch(`http://127.0.0.1:${port}/dashboard/telemetry/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload2),
        });
        expect(postOk.status).toBe(200);

        // Clear strict setting
        delete process.env.OM_STRICT_TENANT;
    });
});
