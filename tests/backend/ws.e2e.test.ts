import { describe, it, expect } from 'bun:test';
import { spawn } from 'child_process';
import path from 'node:path';
import fs from 'node:fs';

// E2E test: spawn a separate process running the server helper, wait for /health, then connect via websocket.
function waitForHealth(url: string, timeout = 5000): Promise<void> {
    const start = Date.now();
    return new Promise<void>(async (resolve, reject) => {
        while (Date.now() - start < timeout) {
            try {
                const res = await fetch(url, { method: 'GET' } as any);
                if (res && (res as any).ok) return resolve();
            } catch (e) {
                // ignore and retry
            }
            await new Promise(r => setTimeout(r, 200));
        }
        reject(new Error('timed out waiting for health'));
    });
}

async function waitForProcessOutput(proc: any, marker: string, timeout = 5000): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const stderrBuf: string[] = [];
        const onErr = (chunk: any) => { stderrBuf.push(String(chunk)); };
        if (proc.stderr) proc.stderr.on('data', onErr);
        const onData = (chunk: any) => {
            const s = String(chunk);
            if (s.includes(marker)) {
                proc.stdout.off('data', onData);
                if (proc.stderr) proc.stderr.off('data', onErr);
                return resolve(s);
            }
        };
        proc.stdout.on('data', onData);
        const t = setTimeout(() => {
            proc.stdout.off('data', onData);
            if (proc.stderr) proc.stderr.off('data', onErr);
            reject(new Error('timeout waiting for process output'));
        }, timeout);
        proc.on('exit', () => {
            clearTimeout(t);
            proc.stdout.off('data', onData);
            if (proc.stderr) proc.stderr.off('data', onErr);
            const stderr = stderrBuf.join('');
            const msg = stderr ? `server process exited prematurely; helper stderr: ${stderr}` : 'server process exited prematurely';
            reject(new Error(msg));
        });
    });
}

describe('ws e2e', () => {
    it('server process upgrades websocket and sends params', async () => {
        // Spawn Bun to run the helper script from backend directory.
        const bunCmd = 'bun';
        // Resolve the helper script path robustly so the test works when the
        // test runner's cwd is either the repository root or the `backend`
        // subdirectory. Try the common locations and pick the first that exists.
        const cand1 = path.resolve(process.cwd(), 'tests', 'backend', 'e2e_server.mjs');
        const cand2 = path.resolve(process.cwd(), '..', 'tests', 'backend', 'e2e_server.mjs');
        let script: string | null = null;
        if (fs.existsSync(cand1)) script = cand1;
        else if (fs.existsSync(cand2)) script = cand2;
        else throw new Error(`e2e helper not found (tried: ${cand1}, ${cand2})`);
        const proc = spawn(bunCmd, [script], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });

        try {
            // Wait for the ready marker on stdout
            await waitForProcessOutput(proc, 'E2E_SERVER_READY', 5000);

            const port = 18082;

            // Now open a WebSocket to the separate process
            await new Promise((resolve, reject) => {
                const ws = new WebSocket(`ws://localhost:${port}/ws/testroom`);
                const totalTimeout = setTimeout(() => {
                    try { ws.close(); } catch (e) { }
                    reject(new Error('WS timed out'));
                }, 5000);

                ws.onmessage = (ev) => {
                    clearTimeout(totalTimeout);
                    try {
                        const data = JSON.parse(ev.data);
                        if (data?.params?.room === 'testroom') {
                            resolve(undefined);
                        } else {
                            reject(new Error('unexpected payload'));
                        }
                    } catch (e) { reject(e); }
                    try { ws.close(); } catch (e) { }
                };
                ws.onerror = (e) => { clearTimeout(totalTimeout); reject(e); };
            });

        } finally {
            try {
                // Ensure we capture stderr output if the process exits early for debugging
                if (!proc.killed) proc.kill('SIGTERM');
            } catch (e) { }
        }
    }, 20000);
});
