// E2E server helper: starts a small server in a separate process for E2E tests.
// Usage: bun tests/backend/e2e_server.mjs
import path from 'path';
import fs from 'fs';
(async () => {
    // ensure a writable tmp db path unique per process
    const tmpDir = path.resolve(process.cwd(), 'tmp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const tmpDb = path.join(tmpDir, `openmemory-e2e-${process.pid}-${Date.now()}.sqlite`);

    // Resolve the helper's own directory and import the backend server module
    // relative to the script file so this works regardless of cwd used by the
    // test harness. Use import via file:// URL to avoid module resolution issues.
    const scriptDir = path.dirname(new URL(import.meta.url).pathname);
    // repo root is two levels up from tests/backend
    const repoRoot = path.resolve(scriptDir, '..', '..');
    const serverPath = path.join(repoRoot, 'backend/src/server/server.ts');
    const mod = await import('file://' + serverPath);
    const app = mod.createServer();

    app.ws('/ws/:room', {
        open(ws) {
            try {
                const params = ws.data?.params || {};
                ws.send(JSON.stringify({ params }));
                // give a tiny moment for the message to flush
                try { setTimeout(() => { try { ws.close(); } catch { } }, 20); } catch (e) { try { ws.close(); } catch { } }
            } catch (e) {
                try { ws.close(); } catch (e) { }
            }
        }
    });

    // Provide a minimal health endpoint so tests can poll readiness
    app.get('/health', (req, ctx) => {
        return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
    });

    // Listen on fixed port for E2E tests
    const PORT = Number(process.env.E2E_PORT || 18082);
    const srv = app.listen(PORT);

    // Print ready marker to stdout so tests that spawn this process can detect readiness.
    // Note: tests should also poll /health to be robust against race.
    console.log('E2E_SERVER_READY', PORT);

    // Keep process alive until terminated
    process.on('SIGTERM', async () => {
        try { await srv.stop(); } catch (e) { }
        process.exit(0);
    });
    process.on('SIGINT', async () => {
        try { await srv.stop(); } catch (e) { }
        process.exit(0);
    });
})();
