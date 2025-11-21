import { describe, it, expect } from 'bun:test';
import { startServer } from '../../backend/src/server/index';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

describe('AI SDK streaming benchmark', () => {
    it('measures TTFT, TPS, and total time for dashboard chat endpoint', async () => {
        if (process.env.OM_RUN_PERF_TESTS !== 'true') return;

        // Start backend on port 8080 to match CI env
        process.env.OM_TEST_MODE = '1';
        process.env.OM_SKIP_BACKGROUND = 'true';
        process.env.OM_EMBED_KIND = 'synthetic';
        process.env.OM_API_KEYS_ENABLED = 'false';
        process.env.OM_NO_AUTO_START = 'true';

        const server = await startServer({ port: 8080, dbPath: ':memory:', waitUntilReady: true });

        // Dashboard health check and lifecycle management
        // This test will build and start the dashboard if OM_ALLOW_DASHBOARD_BUILD is set and dashboard is not already running.
        // Otherwise, assumes dashboard is already running on localhost:3000 for faster feedback in dev workflows.
        let dashPid: number | undefined;
        try {
            await fetch('http://localhost:3000');
        } catch {
            const allowBuild = process.env.OM_ALLOW_DASHBOARD_BUILD === 'true';
            if (!allowBuild) {
                console.warn('Dashboard not running on localhost:3000 and OM_ALLOW_DASHBOARD_BUILD not set. Skipping AI SDK benchmark (gated by OM_RUN_PERF_TESTS).');
                console.warn('For local runs, either: (1) start dashboard manually or (2) set OM_ALLOW_DASHBOARD_BUILD=true to let test manage lifecycle');
                return;
            }
            // Dashboard not running but build allowed - start it (resource intensive!)
            console.log('Building dashboard (OM_ALLOW_DASHBOARD_BUILD=true allows this)...');
            const buildProc = spawn('bun', ['run', 'build'], { cwd: path.join(__dirname, '../../dashboard'), stdio: 'inherit' });
            await new Promise<void>((resolve, reject) => {
                buildProc.on('close', (code: number) => code === 0 ? resolve() : reject(new Error('Dashboard build failed')));
            });
            console.log('Starting dashboard...');
            const startProc = spawn('bun', ['run', 'start'], { cwd: path.join(__dirname, '../../dashboard'), stdio: 'inherit', detached: true });
            dashPid = startProc.pid!;
            // Wait for health
            let attempts = 0;
            while (attempts < 20) {
                try {
                    await fetch('http://localhost:3000');
                    break;
                } catch {}
                await new Promise(resolve => setTimeout(resolve, 500));
                attempts++;
            }
            if (attempts === 20) throw new Error('Dashboard failed to start');
        }

        // In CI, dashboard is started separately; for local testing, assume it's running on 3000
        const dashboardUrl = 'http://localhost:3000/api/chat';
        const body = { messages: [{ role: 'user', content: 'Benchmark test message' }] };

        const start = performance.now();
        const res = await fetch(dashboardUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const firstChunkTime = performance.now() - start;
        expect(firstChunkTime).toBeLessThan(500); // TTFT <500ms

        expect(res.ok).toBe(true);
        expect(res.headers.get('content-type')).toContain('text/event-stream');

        let tokens = 0;
        let chunks: Uint8Array[] = [];
        let totalTime = 0;

        if (res.body) {
            const reader = res.body.getReader();
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
                const decoder = new TextDecoder();
                const s = decoder.decode(value);
                if (s.includes('data: ')) {
                    const jsonData = s.split('data: ')[1]?.split('\n\n')[0];
                    try {
                        const data = JSON.parse(jsonData);
                        if (data.content) {
                            // Count tokens (simple word split)
                            tokens += data.content.split(/\s+/).filter((w: string) => w.length > 0).length;
                        }
                    } catch (e) {}
                }
            }
        }
        totalTime = performance.now() - start;

        const tps = tokens / (totalTime / 1000);
        expect(tps).toBeGreaterThan(20); // TPS >20
        expect(totalTime).toBeLessThan(5000); // Total <5s for 100-token response

        const results = {
            ttft: Math.round(firstChunkTime),
            tps,
            totalTime: Math.round(totalTime),
            tokens,
            commit: process.env.GITHUB_SHA || 'local',
            timestamp: new Date().toISOString(),
        };

        // Output JSON to tests/benchmarks/results/ai-sdk-*.json
        const outputDir = path.join(__dirname, 'results');
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }
        const filename = `ai-sdk-${Date.now()}.json`;
        fs.writeFileSync(path.join(outputDir, filename), JSON.stringify(results, null, 2));

        console.log('AI SDK benchmark completed:', results);

        // Cleanup
        if (dashPid) process.kill(-dashPid, 'SIGTERM');
        if (server?.stop) await server.stop();
    });
});
