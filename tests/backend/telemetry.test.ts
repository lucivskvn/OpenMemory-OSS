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
        // Update parsed cfg so server uses the admin key
        const cfg: any = await import('../../backend/src/core/cfg');
        (cfg as any).env.admin_api_key = process.env.OM_ADMIN_API_KEY;

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

        // No admin header -> forbidden
        const res = await fetch(`http://127.0.0.1:${port}/dashboard/telemetry/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
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

        // Clear admin key for subsequent tests and restart server
        delete process.env.OM_ADMIN_API_KEY;
        (cfg as any).env.admin_api_key = undefined;
        if (typeof mod.stopServer === 'function') await mod.stopServer();
        if (typeof mod.startServer === 'function') await mod.startServer({ port: 0 });
    });

    it('exports CSV via /dashboard/telemetry/export', async () => {
        // Restart with admin key set so export requires admin
        const cryptoMod: any = await import('../../backend/src/utils/crypto');
        const adminPlain = 'admin-for-export';
        const adminHash = await cryptoMod.hashPassword(adminPlain);
        process.env.OM_ADMIN_API_KEY = adminHash;
        const cfg: any = await import('../../backend/src/core/cfg');
        (cfg as any).env.admin_api_key = process.env.OM_ADMIN_API_KEY;

        const mod: any = await import('../../backend/src/server/index.ts');
        if (typeof mod.stopServer === 'function') await mod.stopServer();
        if (typeof mod.startServer === 'function') await mod.startServer({ port: 0 });
        const port = process.env.OM_PORT || process.env.PORT || '8080';

        // Insert a telemetry row as admin
        const payload = {
            id: 'telemetry-export-1',
            user_id: 'x',
            stream_duration_ms: 5,
            memory_ids: ['m1'],
            embedding_mode: 'router_cpu',
            query: 'export test'
        };

        const res = await fetch(`http://127.0.0.1:${port}/dashboard/telemetry/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-admin-key': adminPlain },
            body: JSON.stringify(payload),
        });
        expect(res.status).toBe(200);

        // Export CSV
        const getRes = await fetch(`http://127.0.0.1:${port}/dashboard/telemetry/export?limit=10`, { headers: { 'x-admin-key': adminPlain } });
        expect(getRes.status).toBe(200);
        const csv = await getRes.text();
        expect(csv).toContain('id,user_id,embedding_mode,duration_ms,memory_ids,query,ts');
        expect(csv).toContain('telemetry-export-1');

        // Cleanup admin key
        delete process.env.OM_ADMIN_API_KEY;
        (cfg as any).env.admin_api_key = undefined;
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

        // With user_id present, should be ok
        const getOk = await fetch(`http://127.0.0.1:${port}/dashboard/telemetry?user_id=test-user`);
        expect(getOk.status).toBe(200);

        // Clear strict setting
        delete process.env.OM_STRICT_TENANT;
    });

    it('integration: embedding_mode flows from query -> telemetry', async () => {
        // Setup admin for telemetry posting
        const cryptoMod: any = await import('../../backend/src/utils/crypto');
        const adminPlain = 'integration-admin';
        const adminHash = await cryptoMod.hashPassword(adminPlain);
        process.env.OM_ADMIN_API_KEY = adminHash;
        const cfg: any = await import('../../backend/src/core/cfg');
        (cfg as any).env.admin_api_key = process.env.OM_ADMIN_API_KEY;

        const mod: any = await import('../../backend/src/server/index.ts');
        if (typeof mod.stopServer === 'function') await mod.stopServer();
        if (typeof mod.startServer === 'function') await mod.startServer({ port: 0 });
        const port = process.env.OM_PORT || process.env.PORT || '8080';

        // Insert memory under user
        const memRes = await fetch(`http://127.0.0.1:${port}/memory/add`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: 'Integration embed memory', user_id: 'embed-user' }),
        });
        expect(memRes.status).toBe(200);
        const mem = await memRes.json();

        // query memory (simulate dashboard memory query) - embedding_mode flagged in metadata but not stored here
        const qRes = await fetch(`http://127.0.0.1:${port}/memory/query`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: 'Integration embed memory', k: 5, filters: { user_id: 'embed-user' } }),
        });
        expect(qRes.status).toBe(200);
        const qData = await qRes.json();
        const memIds = (qData.matches || []).map((m: any) => m.id);

        // Now POST telemetry with embedding_mode and memory ids
        const payload = {
            id: 'telemetry-e2e-1',
            user_id: 'embed-user',
            stream_duration_ms: 10,
            memory_ids: memIds,
            query: 'Integration embed memory',
            embedding_mode: 'router_cpu',
        };

        const tRes = await fetch(`http://127.0.0.1:${port}/dashboard/telemetry/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-admin-key': adminPlain },
            body: JSON.stringify(payload),
        });
        expect(tRes.status).toBe(200);

        // Now confirm get returns this embedding_mode when filtered
        const getRes = await fetch(`http://127.0.0.1:${port}/dashboard/telemetry?limit=10&embedding_mode=router_cpu`, { headers: { 'x-admin-key': adminPlain } });
        expect(getRes.status).toBe(200);
        const j = await getRes.json();
        const found = j.telemetry.find((t: any) => t.id === 'telemetry-e2e-1');
        expect(found).toBeTruthy();

        // cleanup
        delete process.env.OM_ADMIN_API_KEY;
        (cfg as any).env.admin_api_key = undefined;
    });
});
