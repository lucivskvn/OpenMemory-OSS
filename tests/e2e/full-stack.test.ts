import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { startServer } from '../../backend/src/server/index';

describe('Full stack E2E tests (backend + dashboard integration)', () => {
    let server: any = null;
    let baseUrl = '';

    beforeAll(async () => {
        process.env.OM_TEST_MODE = '1';
        process.env.OM_SKIP_BACKGROUND = 'true';
        process.env.OM_EMBED_KIND = 'synthetic';
        process.env.OM_API_KEYS_ENABLED = 'false';
        process.env.OM_NO_AUTO_START = 'true';

        server = await startServer({ port: 0, dbPath: ':memory:', waitUntilReady: true });
        baseUrl = `http://127.0.0.1:${server.port}`;
        process.env.NEXT_PUBLIC_API_URL = baseUrl;
    }, 60_000);

    afterAll(async () => {
        if (server && server.stop) await server.stop();
    });

    it('memory ingestion -> query retrieval flow', async () => {
        const addStart = performance.now();
        const addRes = await fetch(`${baseUrl}/memory/add`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: 'E2E test memory', metadata: { primary_sector: 'semantic' }, user_id: 'user_e2e_1' }),
        });
        const addTime = performance.now() - addStart;
        expect(addTime).toBeLessThan(100); // P95 ingestion <100ms
        expect(addRes.ok).toBe(true);
        const added = await addRes.json();
        expect(added.id).toBeTruthy();

        const queryStart = performance.now();
        const qRes = await fetch(`${baseUrl}/memory/query`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: 'E2E test memory', k: 5, filters: { user_id: 'user_e2e_1' } }),
        });
        const queryTime = performance.now() - queryStart;
        expect(queryTime).toBeLessThan(50); // P95 query <50ms
        expect(qRes.ok).toBe(true);
        const qBody = await qRes.json();
        expect(Array.isArray(qBody.matches)).toBeTruthy();
        expect(qBody.matches[0].content.includes('E2E test memory')).toBeTruthy();
    });

    it('dashboard API telemetry & settings integration', async () => {
        // Telemetry endpoint
        const tRes = await fetch(`${baseUrl}/dashboard/telemetry`);
        expect(tRes.ok).toBe(true);
        const telemetry = await tRes.json();
        expect(telemetry).toHaveProperty('memory_count');

        // Settings update
        const setRes = await fetch(`${baseUrl}/api/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ emb_mode: 'synthetic' }),
        });
        // Either 200 or 204 depending on auth
        expect([200, 204].includes(setRes.status)).toBe(true);

        const embedConfig = await fetch(`${baseUrl}/embed/config`).then(r => r.json());
        expect(embedConfig).toHaveProperty('embed_kind');
    });

    it('AI SDK streaming / chat (dashboard route import)', async () => {
        // Import dashboard chat route and call it with mocked fetch so the
        // dashboard endpoint hits the backend and returns an SSE stream of messages.
        const mod = await import('../../dashboard/app/api/chat/route');

        // Mock fetch for the dashboard route so that it points to our backend
        const orig = globalThis.fetch;
        globalThis.fetch = async (url: any, opts: any): Promise<Response> => {
            // Rewrite hardcoded localhost:8080 URLs in dashboard code to use our test server
            if (typeof url === 'string' && url.startsWith('http://localhost:8080')) {
                const rewrittenUrl = baseUrl + url.substring(21); // remove 'http://localhost:8080'
                return orig(rewrittenUrl, opts);
            }
            return orig(url, opts);
        };

        // Construct a request object that mimics NextRequest with required properties for chat handler
        // Required properties: method (POST), headers, url, json() method
        const req: any = {
            method: 'POST',
            headers: new Headers({ 'content-type': 'application/json' }),
            url: 'http://localhost/api/chat?q=test', // Simplified URL for routing detection
            json: async () => ({ messages: [{ role: 'user', content: 'Hello OpenMemory' }] }),
            nextUrl: new URL('http://localhost/api/chat?q=test') // Next.js specific property
        };
        try {
            const streamStart = performance.now();
            const res: any = await mod.POST(req);
            const firstChunkTime = performance.now() - streamStart;
            expect(firstChunkTime).toBeLessThan(200); // Streaming first chunk <200ms
            expect(res).toBeDefined();
            const ct = res.headers.get('content-type');
            expect(ct && ct.includes('text/event-stream')).toBeTruthy();

            // Read and parse SSE chunks with simplified parsing logic
            const decoder = new TextDecoder();
            let chunksReceived = 0;
            let memoryContent = '';
            let responseContent = '';

            for await (const chunk of res.body) {
                const s = decoder.decode(chunk);
                // Parse SSE format
                if (s.includes('data: ')) {
                    const jsonData = s.split('data: ')[1]?.split('\n\n')[0];
                    try {
                        const data = JSON.parse(jsonData);
                        if (data.type === 'memory') {
                            memoryContent += data.content || '';
                            chunksReceived++;
                        } else if (data.type === 'response') {
                            responseContent += data.content || '';
                            chunksReceived++;
                        }
                        if (chunksReceived >= 3) break; // Read a few chunks
                    } catch (e) {}
                }
            }
            expect(memoryContent.length).toBeGreaterThan(0);
            expect(responseContent.includes('Hello OpenMemory')).toBeTruthy(); // Content includes query context
        } finally {
            globalThis.fetch = orig;
        }

    });

    it('ollama model management and fallback', async () => {
        const res = await fetch(`${baseUrl}/embed/ollama/status`);
        const j = await res.json();
        expect(res.ok).toBe(true);
        // ollama may be missing; ensure fallback property exists
        expect(j).toHaveProperty('ollama_available');
    });

    it('multi-tenant isolation: different users see only their memories', async () => {
        const users = ['u1', 'u2'];
        const idByUser: Record<string, string> = {};

        for (const u of users) {
            const res = await fetch(`${baseUrl}/memory/add`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: `secret for ${u}`, user_id: u }),
            });
            const j = await res.json();
            idByUser[u] = j.id;
        }

        // Query as user u1
        const q1 = await fetch(`${baseUrl}/memory/query`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: 'secret', filters: { user_id: 'u1' } }),
        });
        const results1 = await q1.json();
        expect(results1.matches.some((m: any) => m.id === idByUser['u1'])).toBe(true);
        expect(results1.matches.some((m: any) => m.id === idByUser['u2'])).toBe(false);

        // Query as user u2
        const q2 = await fetch(`${baseUrl}/memory/query`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: 'secret', filters: { user_id: 'u2' } }),
        });
        const results2 = await q2.json();
        expect(results2.matches.some((m: any) => m.id === idByUser['u2'])).toBe(true);
        expect(results2.matches.some((m: any) => m.id === idByUser['u1'])).toBe(false);
    });

    it('temporal graph integration: facts timeline & queries', async () => {
        // Create fact
        const createRes = await fetch(`${baseUrl}/api/temporal/fact`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ subject: 'test_subject', predicate: 'status', object: 'active', valid_from: new Date().toISOString() }),
        });
        expect(createRes.ok).toBe(true);
        const created = await createRes.json();
        expect(created).toHaveProperty('id');

        // Timeline for the subject
        const timelineRes = await fetch(`${baseUrl}/api/temporal/timeline?subject=test_subject`);
        expect(timelineRes.ok).toBe(true);
        const timeline = await timelineRes.json();
        expect(timeline.count).toBeGreaterThanOrEqual(1);

    });
});
